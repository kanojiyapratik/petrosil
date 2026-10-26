/**
 * Newsletters: finding an issue, reading it, writing the next one, and
 * sending a test.
 *
 * The old screen built a new issue by filling a template's `{articles}`,
 * `{report}`, `{offers}` and `{impex-data}` with the brand's latest published
 * items; staff then edited it and sent it. That is kept. What is not kept: the
 * `{premium_user}` and `{latest_user}` blocks, which printed the newest
 * customers' names and companies into a mail sent to everyone.
 *
 * The 3,000-odd issues carried from the old sites have no send record — the
 * old schema kept none — so they are "archived", not "draft": read-only, and
 * a starting point for a new issue rather than something to edit.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  articles,
  impexSheets,
  mailOutbox,
  newsletterTemplates,
  newsletters,
  offers,
  reports,
  users,
} from "@/db/schema";
import { listNewsletters } from "@/domain/dashboard/promotion";
import {
  composeNewsletter,
  copyNewsletter,
  getNewsletter,
  saveNewsletter,
  sendTestNewsletter,
} from "@/domain/content/newsletters";
import { deliverPending } from "@/lib/mail/deliver";
import type { OutgoingMail, Transport } from "@/lib/mail/transport";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let actor: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: actor }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [editor] = await db()
    .insert(users)
    .values({ email: "editor@petrosil.example", name: "An Editor", passwordHash: "x" })
    .returning();

  actor = editor!.id;
});

async function issue(values: Partial<typeof newsletters.$inferInsert> = {}) {
  const [row] = await db()
    .insert(newsletters)
    .values({ siteId: baseoil.siteId, title: "Week 40", body: "<p>Prices</p>", status: "archived", ...values })
    .returning();

  return row!;
}

describe("the list", () => {
  it("finds an issue by words in its title", async () => {
    await issue({ title: "Singapore exports climb" });
    await issue({ title: "Russia Group I surges" });

    const found = await listNewsletters([], { site: "baseoil", q: "singapore" });

    expect(found.rows.map((row) => row.title)).toEqual(["Singapore exports climb"]);
    expect(found.total).toBe(1);
  });
});

describe("reading an issue", () => {
  it("returns the whole body for the brand's own staff", async () => {
    const row = await issue();

    expect((await getNewsletter(guard([baseoil.siteId]), row.id))?.body).toBe("<p>Prices</p>");
  });

  it("does not show another brand's issue", async () => {
    const row = await issue();

    expect(await getNewsletter(guard([bitumart.siteId]), row.id)).toBeNull();
  });
});

describe("writing a new issue", () => {
  async function templateWith(body: string) {
    const [row] = await db()
      .insert(newsletterTemplates)
      .values({ siteId: baseoil.siteId, title: "Weekly", body })
      .returning();

    return row!;
  }

  it("fills the template with the brand's latest published items", async () => {
    await db().insert(articles).values([
      { siteId: baseoil.siteId, slug: "old", title: "Old news", status: "published", body: "<p>x</p>", publishedAt: new Date("2026-01-01") },
      { siteId: baseoil.siteId, slug: "new", title: "Fresh <news>", status: "published", body: "<p>x</p>", publishedAt: new Date("2026-10-20") },
      { siteId: baseoil.siteId, slug: "draft", title: "Not yet", status: "draft", body: "<p>x</p>" },
      { siteId: bitumart.siteId, slug: "theirs", title: "Bitumen story", status: "published", body: "<p>x</p>", publishedAt: new Date("2026-10-21") },
    ] as never);
    await db().insert(reports).values({ siteId: baseoil.siteId, slug: "r", title: "October report", reportType: "monthly", status: "published" } as never);
    await db().insert(offers).values({ siteId: baseoil.siteId, subject: "Selling SN 500", offerType: "sell", status: "published" } as never);
    await db().insert(impexSheets).values({ siteId: baseoil.siteId, slug: "i", title: "India imports", status: "published" } as never);

    const template = await templateWith(
      "<h1>Weekly</h1>{articles}<h2>Reports</h2>{report}{offers}{impex-data}<div>{premium_user}{latest_user}</div>",
    );

    const made = await composeNewsletter(guard([baseoil.siteId]), { site: "baseoil", templateId: template.id });

    expect(made.ok).toBe(true);

    const [row] = await db().select().from(newsletters).where(eq(newsletters.id, (made as { id: number }).id));

    expect(row!.status).toBe("draft");
    expect(row!.templateId).toBe(template.id);
    // Newest first, escaped, and only this brand's published items.
    expect(row!.body.indexOf("Fresh &lt;news&gt;")).toBeLessThan(row!.body.indexOf("Old news"));
    expect(row!.body).not.toContain("Not yet");
    expect(row!.body).not.toContain("Bitumen story");
    expect(row!.body).toContain("October report");
    expect(row!.body).toContain("Selling SN 500");
    expect(row!.body).toContain("India imports");
    // Every placeholder is gone, including the customer lists that are not filled.
    expect(row!.body).not.toMatch(/\{[a-z_-]+\}/);
  });

  it("refuses a template from another brand", async () => {
    const [theirs] = await db()
      .insert(newsletterTemplates)
      .values({ siteId: bitumart.siteId, title: "Theirs", body: "{articles}" })
      .returning();

    const made = await composeNewsletter(guard([baseoil.siteId]), { site: "baseoil", templateId: theirs!.id });

    expect(made.ok).toBe(false);
  });

  it("starts a new draft from an old issue", async () => {
    const old = await issue({ title: "Week 40", body: "<p>Last week</p>" });

    const made = await copyNewsletter(guard([baseoil.siteId]), old.id);
    const [row] = await db().select().from(newsletters).where(eq(newsletters.id, (made as { id: number }).id));

    expect(row).toMatchObject({ status: "draft", title: "Week 40 (copy)", body: "<p>Last week</p>" });
  });
});

describe("editing", () => {
  it("saves a draft's title and body", async () => {
    const draft = await issue({ status: "draft" });

    const result = await saveNewsletter(guard([baseoil.siteId]), { id: draft.id, title: "Week 41", body: "<p>New</p>" });

    expect(result.ok).toBe(true);

    const [row] = await db().select().from(newsletters).where(eq(newsletters.id, draft.id));

    expect(row).toMatchObject({ title: "Week 41", body: "<p>New</p>" });
  });

  it("will not rewrite an archived or sent issue", async () => {
    for (const status of ["archived", "sent"]) {
      const row = await issue({ status });

      const result = await saveNewsletter(guard([]), { id: row.id, title: "Changed", body: "<p>x</p>" });

      expect(result.ok).toBe(false);
    }
  });

  it("refuses an empty title or body", async () => {
    const draft = await issue({ status: "draft" });

    for (const change of [{ title: " ", body: "<p>x</p>" }, { title: "x", body: " " }]) {
      expect((await saveNewsletter(guard([]), { id: draft.id, ...change })).ok).toBe(false);
    }
  });
});

describe("a test send", () => {
  it("queues the issue to the person who asked, and it goes out as written", async () => {
    const row = await issue({ title: "Week 40", body: "<p>Prices <b>up</b></p>" });

    const result = await sendTestNewsletter(guard([baseoil.siteId]), row.id);

    expect(result).toEqual({ ok: true, to: "editor@petrosil.example" });

    const [mail] = await db().select().from(mailOutbox);

    expect(mail!.to).toBe("editor@petrosil.example");

    const sent: OutgoingMail[] = [];
    const transport: Transport = {
      name: "recorder",
      async send(message) {
        sent.push(message);

        return { messageId: null };
      },
    };

    await deliverPending(transport);

    expect(sent[0]!.subject).toBe("[Test] Week 40");
    expect(sent[0]!.html).toBe("<p>Prices <b>up</b></p>");
    expect(sent[0]!.text).toBe("Prices up");
  });
});
