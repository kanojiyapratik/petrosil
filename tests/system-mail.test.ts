/**
 * The estate's system mails: the twelve templates staff edit, and the
 * reminders that use them.
 *
 * The old sites picked a template by its numeric id (`findOrFail(5)`), so
 * the id, not the half-filled `mailkey` column, is what says which mail a
 * row is. The reminders follow the old crons' day lists exactly: a trial is
 * reminded 1, 2, 3, 7, 15, 30, 45, 60, 75 and 90 days either side of its
 * end, a subscription the same up to 60. Each reminder goes once, however
 * often the job is run.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, mailOutbox, mailTemplates, memberships, planPrices, planSites, plans, users } from "@/db/schema";
import { listMailTemplates, saveMailTemplate } from "@/domain/content/mail-templates";
import { systemMailFor } from "@/domain/migrate/content";
import { fillPlaceholders } from "@/lib/mail/render";
import { deliverPending } from "@/lib/mail/deliver";
import type { OutgoingMail, Transport } from "@/lib/mail/transport";
import { remindExpiries, REMINDER_DAYS } from "@/domain/billing/reminders";
import { sweepExpiries, addDays } from "@/domain/billing/sweep";
import { updateMembership } from "@/domain/dashboard/clients";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

const TODAY = "2026-10-26";

let baseoil: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
});

function recorder(): Transport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];

  return {
    name: "recorder",
    sent,
    async send(mail) {
      sent.push(mail);

      return { messageId: null };
    },
  };
}

async function template(key: string, values: Partial<typeof mailTemplates.$inferInsert> = {}) {
  const [row] = await db()
    .insert(mailTemplates)
    .values({
      siteId: baseoil.siteId,
      key,
      title: key,
      subject: `${key}: {day} days`,
      body: "<p>Dear {name}, your access ends on {expiry_date}. Renewal is {price}.</p>",
      ...values,
    })
    .returning();

  return row!;
}

let people = 0;

async function member(
  tier: string,
  expiresAt: string | null,
  extra: { role?: string; status?: string; lapsedFrom?: string | null } = {},
) {
  people++;

  const [person] = await db()
    .insert(users)
    .values({
      email: `reader${people}@company.example`,
      name: `Reader ${people}`,
      passwordHash: "x",
      status: extra.status ?? "active",
    })
    .returning();

  const [grant] = await db()
    .insert(memberships)
    .values({
      userId: person!.id,
      siteId: baseoil.siteId,
      role: extra.role ?? "subscriber",
      tier,
      expiresAt,
      lapsedFrom: extra.lapsedFrom ?? null,
    })
    .returning();

  return { person: person!, grant: grant! };
}

async function queued() {
  return db().select().from(mailOutbox).orderBy(mailOutbox.id);
}

describe("which old template is which", () => {
  it("names the twelve by their old ids", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(systemMailFor)).toEqual([
      { key: "welcome", variant: "default" },
      { key: "subscription-details", variant: "asia" },
      { key: "subscription-details", variant: "default" },
      { key: "staff-alert", variant: "default" },
      { key: "trial-expiring", variant: "default" },
      { key: "trial-expired", variant: "default" },
      { key: "trial-exhausted", variant: "default" },
      { key: "subscription-expiring", variant: "default" },
      { key: "subscription-expired", variant: "default" },
      { key: "sample-reports", variant: "default" },
      { key: "sample-reports", variant: "asia" },
      { key: "send-report", variant: "default" },
    ]);
  });

  it("does not guess at an id it has never seen", () => {
    expect(systemMailFor(13)).toBeNull();
  });
});

describe("filling a template", () => {
  it("replaces the placeholders it is given and leaves the rest alone", () => {
    expect(fillPlaceholders("Hi {name}, {unknown} {day}", { name: "Asha", day: 3 }, false)).toBe(
      "Hi Asha, {unknown} 3",
    );
  });

  it("escapes values going into HTML, not the template around them", () => {
    expect(fillPlaceholders("<p>{name}</p>", { name: "<b>A&B</b>" }, true)).toBe(
      "<p>&lt;b&gt;A&amp;B&lt;/b&gt;</p>",
    );
  });
});

describe("sending a stored template", () => {
  it("fills subject and body from the brand's own template", async () => {
    await template("trial-expiring");
    await db()
      .insert(mailOutbox)
      .values({
        siteId: baseoil.siteId,
        to: "reader@company.example",
        subject: "",
        template: "system:trial-expiring",
        payload: { vars: { name: "<i>Asha</i>", day: 3, expiry_date: "29 Oct 2026", price: "USD 600.00" } },
      });

    const transport = recorder();
    const result = await deliverPending(transport);

    expect(result.sent).toBe(1);
    expect(transport.sent[0]!.subject).toBe("trial-expiring: 3 days");
    expect(transport.sent[0]!.html).toContain("Dear &lt;i&gt;Asha&lt;/i&gt;");
    expect(transport.sent[0]!.html).toContain("29 Oct 2026");
    // A plain-text part, so the mail is not HTML-only.
    expect(transport.sent[0]!.text).toContain("Dear <i>Asha</i>, your access ends on 29 Oct 2026.");
    expect(transport.sent[0]!.text).not.toContain("<p>");
  });

  it("fails a mail whose template is missing or switched off, rather than sending a blank", async () => {
    await template("trial-expired", { enabled: false });

    for (const key of ["trial-expired", "nowhere"]) {
      await db()
        .insert(mailOutbox)
        .values({ siteId: baseoil.siteId, to: "r@company.example", subject: "", template: `system:${key}` });
    }

    const transport = recorder();
    const result = await deliverPending(transport);

    expect(result).toEqual({ sent: 0, retrying: 0, failed: 2 });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("expiry reminders", () => {
  beforeEach(async () => {
    for (const key of ["trial-expiring", "trial-expired", "subscription-expiring", "subscription-expired"]) {
      await template(key);
    }
  });

  it("uses the old crons' day lists", () => {
    expect(REMINDER_DAYS.trial).toEqual([1, 2, 3, 7, 15, 30, 45, 60, 75, 90]);
    expect(REMINDER_DAYS.subscription).toEqual([1, 2, 3, 7, 15, 30, 45, 60]);
  });

  it("reminds a trial three days before it ends", async () => {
    const { person } = await member("trial", addDays(TODAY, 3));

    const result = await remindExpiries(db(), TODAY);

    expect(result).toEqual({ queued: 1 });

    const [mail] = await queued();

    expect(mail!.to).toBe(person.email);
    expect(mail!.template).toBe("system:trial-expiring");
    expect(mail!.payload).toMatchObject({
      vars: { name: person.name, email: person.email, day: 3, expiry_date: "29 Oct 2026", site: "baseoil" },
    });
  });

  it("says nothing on a day that is not on the list", async () => {
    await member("trial", addDays(TODAY, 4));
    await member("premium", addDays(TODAY, 0));
    await member("premium", addDays(TODAY, 75)); // 75 is a trial day, not a subscription one

    expect(await remindExpiries(db(), TODAY)).toEqual({ queued: 0 });
  });

  it("reminds a lapsed subscriber whether or not the sweep has reached them yet", async () => {
    // Not yet swept: still premium, ended a week ago.
    await member("premium", addDays(TODAY, -7));
    // Swept: free now, and the row remembers what they had.
    await member("free", addDays(TODAY, -15), { lapsedFrom: "premium" });
    // A lapsed trial.
    await member("free", addDays(TODAY, -1), { lapsedFrom: "trial" });

    await remindExpiries(db(), TODAY);

    expect((await queued()).map((mail) => [mail.template, (mail.payload as any).vars.day])).toEqual([
      ["system:subscription-expired", 7],
      ["system:subscription-expired", 15],
      ["system:trial-expired", 1],
    ]);
  });

  it("leaves alone people who never paid, staff, and switched-off accounts", async () => {
    await member("free", addDays(TODAY, -7));
    await member("premium", addDays(TODAY, 3), { role: "staff" });
    await member("premium", addDays(TODAY, 3), { status: "disabled" });
    await member("premium", null); // open-ended

    expect(await remindExpiries(db(), TODAY)).toEqual({ queued: 0 });
  });

  it("sends nothing for a template the brand has switched off", async () => {
    await db().update(mailTemplates).set({ enabled: false }).where(eq(mailTemplates.key, "trial-expiring"));
    await member("trial", addDays(TODAY, 3));

    expect(await remindExpiries(db(), TODAY)).toEqual({ queued: 0 });
  });

  it("queues each reminder once however often it runs", async () => {
    await member("trial", addDays(TODAY, 3));

    await remindExpiries(db(), TODAY);
    const second = await remindExpiries(db(), TODAY);

    expect(second).toEqual({ queued: 0 });
    expect(await queued()).toHaveLength(1);
  });

  it("quotes the brand's renewal price", async () => {
    const [plan] = await db()
      .insert(plans)
      .values({ code: "annual", name: "Annual", sortOrder: 1 })
      .returning();
    await db().insert(planSites).values({ planId: plan!.id, siteId: baseoil.siteId });
    await db().insert(planPrices).values({ planId: plan!.id, currency: "USD", years: 1, amount: "600.00" });

    await member("premium", addDays(TODAY, 30));
    await remindExpiries(db(), TODAY);

    const [mail] = await queued();

    expect((mail!.payload as any).vars.price).toBe("USD 600.00");
  });

  it("quotes a reader in Nepal the subcontinent plan, not the global one", async () => {
    const values = [
      { code: "global", name: "Global", sortOrder: 1, currency: "USD", amount: "600.00" },
      { code: "india-subcontinent", name: "India Subcontinent", sortOrder: 2, currency: "INR", amount: "50000.00" },
    ];

    for (const { currency, amount, ...row } of values) {
      const [plan] = await db().insert(plans).values(row).returning();

      await db().insert(planSites).values({ planId: plan!.id, siteId: baseoil.siteId });
      await db().insert(planPrices).values({ planId: plan!.id, currency, years: 1, amount });
    }

    const { person } = await member("premium", addDays(TODAY, 30));

    await db().update(users).set({ country: "Nepal" }).where(eq(users.id, person.id));
    await member("premium", addDays(TODAY, 30));
    await remindExpiries(db(), TODAY);

    const prices = (await queued()).map((mail) => (mail.payload as any).vars.price).sort();

    expect(prices).toEqual(["INR 50000.00", "USD 600.00"]);
  });
});

describe("remembering what a lapsed member had", () => {
  it("is written by the sweep", async () => {
    const { grant } = await member("trial", addDays(TODAY, -1));

    await sweepExpiries(db(), TODAY);

    const [after] = await db().select().from(memberships).where(eq(memberships.id, grant.id));

    expect(after!.tier).toBe("free");
    expect(after!.lapsedFrom).toBe("trial");
  });

  it("is cleared when staff set the tier by hand", async () => {
    const { person, grant } = await member("free", addDays(TODAY, -5), { lapsedFrom: "premium" });

    await updateMembership([], person.id, "baseoil", { tier: "premium", expires_at: addDays(TODAY, 365) }, {
      userId: person.id,
    });

    const [after] = await db().select().from(memberships).where(eq(memberships.id, grant.id));

    expect(after!.lapsedFrom).toBeNull();
  });
});

describe("editing a template", () => {
  let actor: number;
  let bitumart: Brand;

  const guard = (siteIds: number[]) =>
    ({ identity: { user: { id: actor }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

  beforeEach(async () => {
    bitumart = await makeBrand("bitumart", []);

    const [editor] = await db()
      .insert(users)
      .values({ email: "editor@petrosil.example", name: "An Editor", passwordHash: "x" })
      .returning();

    actor = editor!.id;
  });

  it("lists a brand's templates with what sends each one", async () => {
    await template("trial-expiring");
    await template("send-report");

    const rows = await listMailTemplates(guard([baseoil.siteId]), "baseoil");

    expect(rows.map((row) => [row.key, row.sentBy])).toEqual([
      ["send-report", null],
      ["trial-expiring", "Trial reminders, daily at 10:00"],
    ]);
  });

  it("saves the wording and the switch, and records who changed it", async () => {
    const row = await template("trial-expiring");

    const result = await saveMailTemplate(guard([baseoil.siteId]), {
      id: row.id,
      subject: "Your trial ends in {day} days",
      body: "<p>Dear {name}</p>",
      enabled: false,
    });

    expect(result).toEqual({ ok: true, unknown: [] });

    const [after] = await db().select().from(mailTemplates).where(eq(mailTemplates.id, row.id));

    expect(after!.subject).toBe("Your trial ends in {day} days");
    expect(after!.enabled).toBe(false);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "mail_template.save"));

    expect(entry!.userId).toBe(actor);
  });

  it("refuses another brand's template", async () => {
    const theirs = await template("trial-expiring");
    await db().update(mailTemplates).set({ siteId: bitumart.siteId }).where(eq(mailTemplates.id, theirs.id));

    const result = await saveMailTemplate(guard([baseoil.siteId]), {
      id: theirs.id,
      subject: "x",
      body: "y",
      enabled: true,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses an empty subject or body", async () => {
    const row = await template("trial-expiring");

    for (const change of [{ subject: " ", body: "<p>x</p>" }, { subject: "x", body: "  " }]) {
      const result = await saveMailTemplate(guard([]), { id: row.id, ...change, enabled: true });

      expect(result).toMatchObject({ ok: false });
    }
  });

  it("saves but points out a placeholder the mail never fills", async () => {
    const row = await template("subscription-expiring");

    const result = await saveMailTemplate(guard([]), {
      id: row.id,
      subject: "Renew for {prise}",
      body: "<p>{name}, {renewal_date}</p>",
      enabled: true,
    });

    expect(result).toEqual({ ok: true, unknown: ["prise", "renewal_date"] });
  });
});
