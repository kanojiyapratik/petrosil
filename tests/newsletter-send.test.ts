/**
 * Sending a newsletter issue to a brand's own subscribers, and the unsubscribe
 * link in every copy.
 *
 * The old screen handed issues to an outside list (Brevo list 9, among four
 * other services) and recorded nothing. Here the list is the brand's active
 * subscribers, minus anyone who unsubscribed; staff confirm by typing the
 * count; the issue becomes "sent" exactly once; and every copy is a queued
 * mail with its own unsubscribe link.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  auditLog,
  mailOutbox,
  mailSendRecipients,
  mailSends,
  memberships,
  newsletterOptOuts,
  newsletters,
  roles,
  rolePermissions,
  users,
} from "@/db/schema";
import {
  audienceCounts,
  lookUpUnsubscribe,
  newsletterDelivery,
  sendNewsletter,
  setUnsubscribed,
} from "@/domain/content/newsletter-send";
import { getSend, recordOpen } from "@/domain/reports/sending";
import { addDays } from "@/domain/billing/sweep";
import { today } from "@/domain/price/dates";
import { deliverPending } from "@/lib/mail/deliver";
import type { OutgoingMail, Transport } from "@/lib/mail/transport";
import { POST as unsubscribePost } from "@/app/api/public/unsubscribe/[token]/route";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let editor: number;
let people = 0;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: editor }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const ENV = { PUBLIC_APP_URL: "https://app.example" };

async function reader(tier: string, values: { status?: string; expiresAt?: string | null; brand?: Brand; role?: string } = {}) {
  people++;

  const [row] = await db()
    .insert(users)
    .values({ email: `Reader${people}@Company.example`, name: `Reader ${people}`, status: values.status ?? "active" })
    .returning();

  await db()
    .insert(memberships)
    .values({
      userId: row!.id,
      siteId: (values.brand ?? baseoil).siteId,
      role: values.role ?? "subscriber",
      tier,
      expiresAt: values.expiresAt === undefined ? addDays(today(), 100) : values.expiresAt,
    });

  return row!;
}

async function draft(values: Partial<typeof newsletters.$inferInsert> = {}) {
  const [row] = await db()
    .insert(newsletters)
    .values({
      siteId: baseoil.siteId,
      title: "Week 46",
      body: "<html><body><p>Prices up</p></body></html>",
      status: "draft",
      ...values,
    })
    .returning();

  return row!;
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
  people = 0;
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [row] = await db()
    .insert(users)
    .values({ email: "editor@petrosil.example", name: "An Editor", passwordHash: "x" })
    .returning();

  editor = row!.id;
});

describe("who it goes to", () => {
  it("counts active subscribers of this brand only, split into paying and free", async () => {
    await reader("premium");
    await reader("premium", { expiresAt: addDays(today(), -1) }); // lapsed: free now
    await reader("free");
    await reader("trial");
    await reader("free", { status: "locked" });
    await reader("free", { role: "staff" });
    await reader("premium", { brand: bitumart });
    const issue = await draft();

    const counts = await audienceCounts(guard([baseoil.siteId]), issue.id);

    expect(counts).toEqual({ everyone: 4, paying: 1, free: 3, optedOut: 0 });
  });

  it("leaves out an address that unsubscribed, whatever its case", async () => {
    const gone = await reader("free");
    await reader("free");
    await db().insert(newsletterOptOuts).values({ siteId: baseoil.siteId, email: gone.email.toLowerCase() });
    const issue = await draft();

    expect(await audienceCounts(guard([baseoil.siteId]), issue.id)).toMatchObject({ everyone: 1, optedOut: 1 });
  });

  it("answers another brand's issue as if it did not exist", async () => {
    const issue = await draft();

    expect(await audienceCounts(guard([bitumart.siteId]), issue.id)).toBeNull();
  });
});

describe("sending", () => {
  it("refuses until the typed number matches the list", async () => {
    await reader("free");
    await reader("premium");
    const issue = await draft();

    const wrong = await sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "everyone", confirm: "1" });

    expect(wrong).toEqual({ ok: false, message: "To send, type the number of people it goes to: 2." });
    expect(await db().select().from(mailOutbox)).toHaveLength(0);
    const [still] = await db().select().from(newsletters).where(eq(newsletters.id, issue.id));
    expect(still!.status).toBe("draft");
  });

  it("queues one copy per reader, marks the issue sent, and records the send", async () => {
    await reader("free");
    await reader("premium");
    await reader("free", { brand: bitumart });
    const issue = await draft();

    const result = await sendNewsletter(
      guard([baseoil.siteId]),
      { id: issue.id, audience: "everyone", confirm: "2" },
      { env: ENV },
    );

    expect(result).toMatchObject({ ok: true, recipients: 2 });

    const [sent] = await db().select().from(newsletters).where(eq(newsletters.id, issue.id));
    expect(sent!.status).toBe("sent");
    expect(sent!.recipients).toBe(2);
    expect(sent!.sentAt).not.toBeNull();

    const mails = await db().select().from(mailOutbox);
    expect(mails).toHaveLength(2);
    expect(mails.every((mail) => mail.template === "newsletter" && mail.subject === "Week 46")).toBe(true);
    // The body is not copied into each row.
    expect(JSON.stringify(mails[0]!.payload)).not.toContain("Prices up");

    const recipients = await db().select().from(mailSendRecipients);
    expect(recipients).toHaveLength(2);
    expect(recipients.every((row) => row.outboxId !== null)).toBe(true);

    const [send] = await db().select().from(mailSends);
    expect(send).toMatchObject({ kind: "newsletter", newsletterId: issue.id, body: issue.body });

    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, "newsletter.send"));
    expect(audit!.detail).toMatchObject({ audience: "everyone", recipients: 2 });
  });

  it("sends to the paying readers alone when asked", async () => {
    const payer = await reader("premium");
    await reader("free");
    const issue = await draft();

    await sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "paying", confirm: "1" });

    const mails = await db().select().from(mailOutbox);
    expect(mails.map((mail) => mail.to)).toEqual([payer.email]);
  });

  it("sends an issue once: a second send finds it already sent", async () => {
    await reader("free");
    const issue = await draft();

    const first = await sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "everyone", confirm: "1" });
    const second = await sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "everyone", confirm: "1" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(await db().select().from(mailOutbox)).toHaveLength(1);
  });

  it("will not send an archived issue carried from an old site", async () => {
    await reader("free");
    const issue = await draft({ status: "archived" });

    const result = await sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "everyone", confirm: "1" });

    expect(result.ok).toBe(false);
  });

  it("refuses a member of staff whose role lacks newsletter-send", async () => {
    await reader("free");
    const issue = await draft();
    const [role] = await db().insert(roles).values({ name: "Writer" }).returning();
    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "newsletter-edit" });
    await db().insert(memberships).values({ userId: editor, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(
      sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "everyone", confirm: "1" }),
    ).rejects.toThrow(/send a newsletter/i);
  });
});

describe("delivery and unsubscribing", () => {
  async function sendOne() {
    await reader("free");
    const issue = await draft();
    await sendNewsletter(guard([baseoil.siteId]), { id: issue.id, audience: "everyone", confirm: "1" }, { env: ENV });
    const [recipient] = await db().select().from(mailSendRecipients);

    return { issue, token: recipient!.openToken, email: recipient!.email };
  }

  it("delivers the issue with an unsubscribe footer, the open pixel and the one-click headers", async () => {
    const { token } = await sendOne();
    const transport = recorder();

    await deliverPending(transport);

    const [mail] = transport.sent;
    expect(mail!.subject).toBe("Week 46");
    expect(mail!.html).toContain("<p>Prices up</p>");
    expect(mail!.html).toContain(`https://app.example/unsubscribe/${token}`);
    expect(mail!.html).toContain(`https://app.example/api/public/open/${token}`);
    // The footer goes inside the document, not after </html>.
    expect(mail!.html.indexOf("Unsubscribe from this newsletter")).toBeLessThan(mail!.html.indexOf("</body>"));
    expect(mail!.text).toContain("Prices up");
    expect(mail!.headers).toEqual({
      "List-Unsubscribe": `<https://app.example/api/public/unsubscribe/${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("reports what became of the copies on the issue and in the delivery log", async () => {
    const { issue, token } = await sendOne();
    await deliverPending(recorder());
    await recordOpen(token);

    const delivery = await newsletterDelivery(guard([baseoil.siteId]), issue.id);
    expect(delivery).toMatchObject({ recipients: 1, sent: 1, failed: 0, waiting: 0, opened: 1, optedOut: 0 });

    const send = await getSend(guard([baseoil.siteId]), delivery!.sendId);
    expect(send).toMatchObject({ kind: "newsletter", total: 1, sent: 1, queued: 0, opened: 1 });
  });

  it("takes the address off the brand's list from the link, and puts it back on request", async () => {
    const { issue, token, email } = await sendOne();

    expect(await lookUpUnsubscribe(token)).toEqual({ email, siteName: expect.any(String), optedOut: false });

    await setUnsubscribed(token, true);
    await setUnsubscribed(token, true); // twice is harmless

    const opted = await db().select().from(newsletterOptOuts);
    expect(opted).toEqual([expect.objectContaining({ siteId: baseoil.siteId, email: email.toLowerCase(), source: "link" })]);
    expect((await lookUpUnsubscribe(token))!.optedOut).toBe(true);
    expect((await newsletterDelivery(guard([baseoil.siteId]), issue.id))!.optedOut).toBe(1);

    // The next issue leaves them out.
    const next = await draft({ title: "Week 47" });
    expect(await audienceCounts(guard([baseoil.siteId]), next.id)).toMatchObject({ everyone: 0, optedOut: 1 });

    await setUnsubscribed(token, false);
    expect(await db().select().from(newsletterOptOuts)).toHaveLength(0);
  });

  it("takes a mail client's one-click POST", async () => {
    const { token } = await sendOne();
    const body = new URLSearchParams({ "List-Unsubscribe": "One-Click" });

    const response = await unsubscribePost(
      new Request(`https://app.example/api/public/unsubscribe/${token}`, { method: "POST", body }),
      { params: Promise.resolve({ token }) },
    );

    expect(response.status).toBe(200);
    expect(await db().select().from(newsletterOptOuts)).toHaveLength(1);
  });

  it("does not let a report mail's open token unsubscribe anyone", async () => {
    const person = await reader("premium");
    const [send] = await db()
      .insert(mailSends)
      .values({ siteId: baseoil.siteId, kind: "report", subject: "Report", body: "<p>r</p>" })
      .returning();
    await db()
      .insert(mailSendRecipients)
      .values({ sendId: send!.id, userId: person.id, email: person.email, openToken: "report-token-0123456789" });

    expect(await lookUpUnsubscribe("report-token-0123456789")).toBeNull();
    expect(await setUnsubscribed("report-token-0123456789", true)).toBeNull();
    expect(await db().select().from(newsletterOptOuts)).toHaveLength(0);
  });
});
