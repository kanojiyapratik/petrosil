/**
 * Sending a report to the people who pay for it, a sample to someone who
 * might, and the log of both.
 *
 * The old sender was two synchronous loops in one web request: whether the
 * back of the list got the report depended on PHP's time limit, everyone from
 * the second recipient on got the first one's personalised subject, and every
 * row in its log said status 400. Here a send is a row, each recipient is a
 * row tied to its queued mail, and the queue does the sending.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { GET as openRoute } from "@/app/api/public/open/[token]/route";
import { db } from "@/db";
import {
  mailOutbox,
  mailSendRecipients,
  mailSends,
  mailTemplates,
  mediaFiles,
  memberships,
  reports,
  settings,
  users,
} from "@/db/schema";
import { diskStore, type FileStore } from "@/lib/files/store";
import { deliverPending } from "@/lib/mail/deliver";
import type { OutgoingMail, Transport } from "@/lib/mail/transport";
import {
  getSend,
  reportSendForm,
  findReaders,
  sendableReports,
  listSends,
  recordOpen,
  reportRecipients,
  sendReport,
  sendSample,
} from "@/domain/reports/sending";
import { addDays } from "@/domain/billing/sweep";
import { today } from "@/domain/price/dates";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let root: string;
let store: FileStore;
let baseoil: Brand;
let bitumart: Brand;
let staff: number;
let reportId: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const TODAY = today();

let people = 0;

async function reader(
  tier: string,
  values: { expiresAt?: string | null; status?: string; country?: string; name?: string; brand?: Brand } = {},
) {
  people++;

  const [row] = await db()
    .insert(users)
    .values({
      email: `reader${people}@company.example`,
      name: values.name ?? `Reader ${people}`,
      status: values.status ?? "active",
      country: values.country ?? null,
    })
    .returning();

  await db()
    .insert(memberships)
    .values({
      userId: row!.id,
      siteId: (values.brand ?? baseoil).siteId,
      role: "subscriber",
      tier,
      expiresAt: values.expiresAt === undefined ? addDays(TODAY, 100) : values.expiresAt,
    });

  return row!;
}

async function report(title: string, file: string | null, brand: Brand = baseoil) {
  const [row] = await db()
    .insert(reports)
    .values({ siteId: brand.siteId, slug: title.toLowerCase().replace(/\W+/g, "-"), title, reportType: "monthly", status: "published", file })
    .returning();

  if (file) {
    const key = `${brand.slug}/reports/files/${file}`;

    await store.put(key, new TextEncoder().encode(`%PDF ${title}`), "application/pdf");
    await db()
      .insert(mediaFiles)
      .values({ siteId: brand.siteId, path: key, folder: "reports/files", name: file, kind: "application/pdf", bytes: 10 });
  }

  return row!.id;
}

function recorder(): Transport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];

  return {
    name: "recorder",
    sent,
    async send(mail) {
      sent.push(mail);

      return { messageId: `m${sent.length}` };
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
  root = await mkdtemp(join(tmpdir(), "petrosil-sends-"));
  store = diskStore(root);
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [row] = await db().insert(users).values({ email: "staff@petrosil.example", name: "Staff" }).returning();

  staff = row!.id;
  reportId = await report("October 2026", "584.pdf");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("who a report goes to", () => {
  it("is every current paying reader, plus the brand's own list", async () => {
    const paying = await reader("premium");
    const open = await reader("premium", { expiresAt: null });
    await reader("premium", { expiresAt: addDays(TODAY, -1) }); // lapsed
    await reader("trial"); // trying, not paying
    await reader("free");
    await reader("premium", { status: "disabled" });
    await reader("premium", { brand: bitumart });
    await db().insert(settings).values({ siteId: baseoil.siteId, key: "report_recipients", value: "riaz@petrosil.com,\n poonam@petrosil.com" });

    const list = await reportRecipients(guard([baseoil.siteId]), "baseoil");

    expect(list.readers.map((r) => r.userId).sort()).toEqual([paying.id, open.id].sort());
    expect(list.extra).toEqual(["riaz@petrosil.com", "poonam@petrosil.com"]);
  });
});

describe("sending a report", () => {
  it("queues one mail per person with the PDF named, each with its own name in it", async () => {
    const asha = await reader("premium", { name: "Asha" });
    const omar = await reader("premium", { name: "Omar" });

    const result = await sendReport(
      guard([baseoil.siteId]),
      {
        site: "baseoil",
        reportId,
        subject: "{site}: October report for {name}",
        body: "<p>Dear {name}, your report is attached.</p>",
        userIds: [asha.id, omar.id],
        extra: ["riaz@petrosil.com"],
      },
      store,
    );

    expect(result).toMatchObject({ ok: true, recipients: 3 });

    const transport = recorder();

    await deliverPending(transport, { store } as never);

    const byTo = Object.fromEntries(transport.sent.map((mail) => [mail.to, mail]));

    // The old loop gave everyone from the second recipient on the first one's subject.
    expect(byTo[asha.email]!.subject).toBe("baseoil: October report for Asha");
    expect(byTo[omar.email]!.subject).toBe("baseoil: October report for Omar");
    expect(byTo[omar.email]!.html).toContain("Dear Omar");
    expect(byTo["riaz@petrosil.com"]).toBeDefined();
    expect(byTo[asha.email]!.attachments).toEqual([
      { name: "584.pdf", content: new TextEncoder().encode("%PDF October 2026") },
    ]);
    // Each carries its own open pixel.
    expect(byTo[asha.email]!.html).toMatch(/\/api\/public\/open\/[A-Za-z0-9_-]{20,}/);
  });

  it("will not send a paid report to someone who has not paid, however the form was edited", async () => {
    const free = await reader("free");

    const result = await sendReport(
      guard([]),
      { site: "baseoil", reportId, subject: "s", body: "b", userIds: [free.id], extra: [] },
      store,
    );

    expect(result.ok).toBe(false);
    expect(await db().select().from(mailOutbox)).toHaveLength(0);
  });

  it("sends each address once", async () => {
    const asha = await reader("premium");

    const result = await sendReport(
      guard([]),
      { site: "baseoil", reportId, subject: "s", body: "b", userIds: [asha.id, asha.id], extra: [asha.email.toUpperCase(), "x@y.example"] },
      store,
    );

    expect(result).toMatchObject({ ok: true, recipients: 2 });
  });

  it("refuses a report with no PDF, another brand's report, or no one to send to", async () => {
    const paying = await reader("premium");
    const noFile = await report("No file", null);
    const theirs = await report("Theirs", "9.pdf", bitumart);

    for (const [id, userIds, extra] of [
      [noFile, [paying.id], []],
      [theirs, [paying.id], []],
      [reportId, [], []],
    ] as [number, number[], string[]][]) {
      const result = await sendReport(
        guard([baseoil.siteId]),
        { site: "baseoil", reportId: id, subject: "s", body: "b", userIds, extra },
        store,
      );

      expect(result.ok).toBe(false);
    }
  });

  it("fails one mail whose PDF has gone, rather than sending it without", async () => {
    const paying = await reader("premium");

    await sendReport(guard([]), { site: "baseoil", reportId, subject: "s", body: "b", userIds: [paying.id], extra: [] }, store);
    await store.delete("baseoil/reports/files/584.pdf");

    const result = await deliverPending(recorder(), { store } as never);

    expect(result.failed).toBe(1);
  });
});

describe("sending a sample", () => {
  beforeEach(async () => {
    for (const [variant, body] of [
      ["default", "<p>Rest of world samples for {name}</p>"],
      ["asia", "<p>Asia samples for {name}</p>"],
    ]) {
      await db().insert(mailTemplates).values({
        siteId: baseoil.siteId,
        key: "sample-reports",
        variant: variant!,
        title: "Samples",
        subject: "Sample reports",
        body: body!,
      });
    }
  });

  it("sends the chosen reports to one reader, in their region's edition", async () => {
    const second = await report("September 2026", "583.pdf");
    const prospect = await reader("free", { name: "Ravi", country: "India" });

    const result = await sendSample(guard([baseoil.siteId]), { site: "baseoil", userId: prospect.id, reportIds: [reportId, second] }, store);

    expect(result).toMatchObject({ ok: true });

    const transport = recorder();

    await deliverPending(transport, { store } as never);

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.html).toContain("Asia samples for Ravi");
    expect(transport.sent[0]!.attachments!.map((a) => a.name)).toEqual(["584.pdf", "583.pdf"]);
  });

  it("uses the rest-of-world edition elsewhere", async () => {
    const prospect = await reader("free", { name: "Jan", country: "Netherlands" });

    await sendSample(guard([]), { site: "baseoil", userId: prospect.id, reportIds: [reportId] }, store);

    const transport = recorder();

    await deliverPending(transport, { store } as never);

    expect(transport.sent[0]!.html).toContain("Rest of world samples for Jan");
  });
});

describe("the delivery log", () => {
  it("shows each send with how many went, failed, and were opened", async () => {
    const asha = await reader("premium");
    const omar = await reader("premium");

    const sent = await sendReport(
      guard([]),
      { site: "baseoil", reportId, subject: "s", body: "b", userIds: [asha.id, omar.id], extra: [] },
      store,
    );

    await deliverPending(recorder(), { store } as never);

    const [first] = await db().select().from(mailSendRecipients).where(eq(mailSendRecipients.email, asha.email));
    const response = await openRoute(new Request("http://localhost/api/public/open/x"), {
      params: Promise.resolve({ token: first!.openToken }),
    });

    expect(response.headers.get("content-type")).toBe("image/gif");

    const sends = await listSends(guard([baseoil.siteId]), "baseoil", {});

    expect(sends.rows[0]).toMatchObject({ kind: "report", about: "October 2026", recipients: 2, sent: 2, failed: 0, opened: 1 });

    const detail = await getSend(guard([baseoil.siteId]), (sent as { id: number }).id);

    expect(detail!.recipients.find((r) => r.email === asha.email)).toMatchObject({ status: "sent" });
    expect(detail!.recipients.find((r) => r.email === asha.email)!.openedAt).not.toBeNull();
    expect(await getSend(guard([bitumart.siteId]), (sent as { id: number }).id)).toBeNull();
  });

  it("records the first open only, and ignores a token it does not know", async () => {
    const asha = await reader("premium");

    await sendReport(guard([]), { site: "baseoil", reportId, subject: "s", body: "b", userIds: [asha.id], extra: [] }, store);

    const [row] = await db().select().from(mailSendRecipients);

    await recordOpen(row!.openToken);
    const [once] = await db().select().from(mailSendRecipients);

    await recordOpen(row!.openToken);
    const [twice] = await db().select().from(mailSendRecipients);

    expect(twice!.openedAt!.getTime()).toBe(once!.openedAt!.getTime());
    await expect(recordOpen("nonsense")).resolves.toBe(false);
  });
});

describe("staff only", () => {
  it("cannot send another brand's report", async () => {
    const paying = await reader("premium", { brand: bitumart });
    const theirs = await report("Theirs", "9.pdf", bitumart);

    const result = await sendReport(
      guard([baseoil.siteId]),
      { site: "bitumart", reportId: theirs, subject: "s", body: "b", userIds: [paying.id], extra: [] },
      store,
    );

    expect(result.ok).toBe(false);
    expect(await db().select().from(mailSends)).toHaveLength(0);
  });
});

describe("the send form", () => {
  it("starts from the brand's send-report template, with every paying reader ticked", async () => {
    await db().insert(mailTemplates).values({
      siteId: baseoil.siteId,
      key: "send-report",
      title: "Send Report",
      subject: "Send Report",
      body: "<p>Dear {name}, please find the report attached.</p>",
    });
    const paying = await reader("premium");

    const form = await reportSendForm(guard([baseoil.siteId]), "baseoil", reportId, store);

    expect(form).toMatchObject({
      report: { id: reportId, title: "October 2026" },
      hasPdf: true,
      // The old template's subject is the useless "Send Report"; the report's title says more.
      subject: "October 2026",
      body: "<p>Dear {name}, please find the report attached.</p>",
    });
    expect(form!.readers.map((r) => r.userId)).toEqual([paying.id]);
  });

  it("says so when the PDF is missing, and refuses another brand's report", async () => {
    const noFile = await report("No file", null);

    expect((await reportSendForm(guard([]), "baseoil", noFile, store))!.hasPdf).toBe(false);
    expect(await reportSendForm(guard([bitumart.siteId]), "baseoil", reportId, store)).toBeNull();
  });
});

describe("finding what to send and to whom", () => {
  it("finds a brand's readers by name or email, whatever they pay", async () => {
    await reader("free", { name: "Ravi Kumar" });
    await reader("premium", { name: "Ravi Shah", brand: bitumart });

    const found = await findReaders(guard([baseoil.siteId]), "baseoil", "ravi");

    expect(found.map((r) => r.name)).toEqual(["Ravi Kumar"]);
  });

  it("lists only reports whose PDF is in the store, newest first", async () => {
    await report("No file", null);
    const later = await report("November 2026", "585.pdf");

    const list = await sendableReports(guard([]), "baseoil", store);

    expect(list.map((r) => r.id)).toEqual([later, reportId]);
  });
});
