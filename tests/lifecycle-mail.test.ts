/**
 * The account and subscription emails wired up on 2026-11-19: Welcome on a
 * confirmed address, Subscription Details on a first look at the plans, and
 * the staff alerts that go with them and with a trial request.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { mailOutbox, mailTemplates, settings, users } from "@/db/schema";
import { confirmEmail } from "@/domain/accounts/register";
import { subscriptionPageOpened, trialRequested, welcomeConfirmedReader } from "@/domain/mail/lifecycle";
import { deliverPending } from "@/lib/mail/deliver";
import type { OutgoingMail, Transport } from "@/lib/mail/transport";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let brand: Brand;
let people = 0;

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", []);
});

async function template(key: string, variant = "default", values: Partial<typeof mailTemplates.$inferInsert> = {}) {
  await db()
    .insert(mailTemplates)
    .values({ siteId: brand.siteId, key, variant, title: key, subject: `${key} for {name}`, body: `<p>${key} {name} {site}</p>`, ...values });
}

async function adminAddress(value = "staff@baseoil.example") {
  await db().insert(settings).values({ siteId: brand.siteId, key: "site_admin_email", value });
}

async function reader(country: string | null = "Germany") {
  people++;

  const [person] = await db()
    .insert(users)
    .values({ email: `reader${people}@company.example`, name: `Reader ${people}`, passwordHash: "x", country })
    .returning();

  return person!;
}

const outbox = () => db().select().from(mailOutbox).orderBy(mailOutbox.id);

function recorder(): Transport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];

  return { name: "recorder", sent, async send(mail) { sent.push(mail); return { messageId: null }; } };
}

describe("welcome on a confirmed address", () => {
  it("welcomes the reader and tells staff, with no password in the mail", async () => {
    await template("welcome", "default", { body: "<p>Hello {name}, sign in with {email} and {password} at {weblink}.</p>" });
    await template("staff-alert", "default", { body: "<h3>{heading}</h3><table>{content}</table>" });
    await adminAddress();
    const person = await reader();

    expect(await welcomeConfirmedReader(person.id, brand.siteId)).toBe(2);

    const rows = await outbox();
    expect(rows.map((row) => [row.to, row.template])).toEqual([
      [person.email, "system:welcome"],
      ["staff@baseoil.example", "system:staff-alert"],
    ]);

    const transport = recorder();
    await deliverPending(transport);
    const welcome = transport.sent.find((mail) => mail.to === person.email)!;
    expect(welcome.html).toContain("the password you chose when you registered");
    expect(welcome.html).not.toContain("{password}");
    const alert = transport.sent.find((mail) => mail.to === "staff@baseoil.example")!;
    expect(alert.subject).toContain("New registration");
    expect(alert.html).toContain(person.email);
  });

  it("confirms an address only once, so the welcome cannot go twice", async () => {
    const person = await reader();

    expect(await confirmEmail(person.id)).toBe(true);
    expect(await confirmEmail(person.id)).toBe(false);
  });

  it("sends nothing the brand has switched off, and no alert without an admin address", async () => {
    await template("welcome", "default", { enabled: false });
    await template("staff-alert");
    const person = await reader();

    expect(await welcomeConfirmedReader(person.id, brand.siteId)).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("subscription details on a first look at the plans", () => {
  it("sends once per reader and brand, with the staff alert", async () => {
    await template("subscription-details");
    await template("staff-alert");
    await adminAddress();
    const person = await reader();

    expect(await subscriptionPageOpened(person.id, brand.siteId)).toBe(2);
    expect(await subscriptionPageOpened(person.id, brand.siteId)).toBe(0);

    const rows = await outbox();
    expect(rows.map((row) => row.template)).toEqual(["system:subscription-details", "system:staff-alert"]);
  });

  it("gives a subcontinent reader the Asia wording, and falls back when a brand has none", async () => {
    await template("subscription-details", "default");
    await template("subscription-details", "asia");
    const indian = await reader("India");
    const german = await reader("Germany");

    await subscriptionPageOpened(indian.id, brand.siteId);
    await subscriptionPageOpened(german.id, brand.siteId);

    const rows = await outbox();
    expect(rows.find((row) => row.userId === indian.id)!.payload).toMatchObject({ variant: "asia" });
    expect(rows.find((row) => row.userId === german.id)!.payload).not.toHaveProperty("variant");

    await db().delete(mailTemplates).where(eq(mailTemplates.variant, "asia"));
    const nepali = await reader("Nepal");
    await subscriptionPageOpened(nepali.id, brand.siteId);
    expect((await outbox()).find((row) => row.userId === nepali.id)!.payload).not.toHaveProperty("variant");
  });

  it("does nothing, staff alert included, when the brand has the email off", async () => {
    await template("subscription-details", "default", { enabled: false });
    await template("staff-alert");
    await adminAddress();
    const person = await reader();

    expect(await subscriptionPageOpened(person.id, brand.siteId)).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("a free trial request", () => {
  it("tells staff, with the reader's note", async () => {
    await template("staff-alert", "default", { body: "<table>{content}</table>" });
    await adminAddress();
    const person = await reader();

    expect(await trialRequested(person.id, brand.siteId, "Evaluating for our refinery")).toBe(1);

    const transport = recorder();
    await deliverPending(transport);
    expect(transport.sent[0]!.subject).toContain("Free trial request");
    expect(transport.sent[0]!.html).toContain("Evaluating for our refinery");
    expect(transport.sent[0]!.replyTo).toBe(person.email);
  });
});
