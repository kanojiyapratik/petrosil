/**
 * Offers on the brand sites, and members posting their own.
 *
 * What a reader sees of an offer follows the brand's field rules: a paying
 * reader the "paying" set, everyone else the "free" set, and a switched-off
 * field nobody. The old offer page wired the rules to the wrong fields (the
 * contact person shown by the "value" rule, the phone by the "person" rule);
 * here each rule governs its own field.
 *
 * Members post, change and withdraw their own offers. The old update and
 * delete took any offer's number from any signed-in user.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { formFields, memberships, offers, users } from "@/db/schema";
import { publishedOffer, publishedOffers } from "@/domain/public/offers";
import { myOffers, postOffer, updateMyOffer, withdrawMyOffer } from "@/domain/offers/member";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let member: number;
let other: number;

const anonymous = { entitled: false, tier: "anonymous", reason: "anonymous" } as const;
const paying = { entitled: true, tier: "premium", reason: "premium" } as const;

const rules: [string, boolean, boolean, boolean][] = [
  // key, free, paying, enabled
  ["company_name", true, true, true],
  ["country", true, true, true],
  ["city", true, true, true],
  ["person", false, true, true],
  ["email", false, true, true],
  ["phone", false, false, true],
  ["value", false, true, true],
  ["description", true, true, true],
  ["contact", false, true, true],
];

async function offer(brand: Brand, over: Partial<typeof offers.$inferInsert> = {}) {
  const [row] = await db()
    .insert(offers)
    .values({
      siteId: brand.siteId,
      subject: "SN 500 for sale",
      offerType: "sell",
      description: "Ex-Jebel Ali.",
      companyName: "Gulf Lubes FZE",
      contactPerson: "R. Khan",
      contactEmail: "sales@gulflubes.example",
      contactPhone: "+971 4 555 0100",
      country: "United Arab Emirates",
      city: "Dubai",
      offerValue: "USD 610/MT",
      status: "published",
      ...over,
    })
    .returning();

  return row!;
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  await db()
    .insert(formFields)
    .values(rules.map(([key, free, premium, enabled], at) => ({ siteId: baseoil.siteId, form: "offer" as const, key, label: key, showFree: free, showPremium: premium, enabled, sortOrder: at })));

  const [a] = await db().insert(users).values({ email: "trader@gulf.example", name: "Trader" }).returning();
  const [b] = await db().insert(users).values({ email: "other@x.example", name: "Other" }).returning();

  member = a!.id;
  other = b!.id;
  await db().insert(memberships).values([
    { userId: member, siteId: baseoil.siteId },
    { userId: other, siteId: baseoil.siteId },
  ]);
});

describe("what a reader sees of an offer", () => {
  it("gives a visitor the free fields and nothing else", async () => {
    const made = await offer(baseoil);
    const seen = (await publishedOffer(baseoil.siteId, made.id, anonymous))!;

    expect(seen).toMatchObject({ subject: "SN 500 for sale", offer_type: "sell", company_name: "Gulf Lubes FZE", city: "Dubai" });
    expect(seen.contact_person).toBeNull();
    expect(seen.contact_email).toBeNull();
    expect(seen.offer_value).toBeNull();
    expect(seen.can_contact).toBe(false);
    // The hidden values are absent from the reply, not merely blanked on screen.
    expect(JSON.stringify(seen)).not.toContain("gulflubes");
  });

  it("gives a paying reader the paying fields, each by its own rule", async () => {
    const made = await offer(baseoil);
    const seen = (await publishedOffer(baseoil.siteId, made.id, paying))!;

    expect(seen).toMatchObject({ contact_person: "R. Khan", contact_email: "sales@gulflubes.example", offer_value: "USD 610/MT", can_contact: true });
    // Phone is off for paying readers too, on this brand.
    expect(seen.contact_phone).toBeNull();
  });

  it("lists only published offers of this brand, newest first, by kind and words", async () => {
    await offer(baseoil, { subject: "Old sell", createdAt: new Date("2026-01-01") });
    await offer(baseoil, { subject: "Buying bright stock", offerType: "buy" });
    await offer(baseoil, { subject: "Suspended", status: "suspended" });
    await offer(baseoil, { subject: "Withdrawn", deletedAt: new Date() });
    await offer(bitumart, { subject: "Theirs" });

    const all = await publishedOffers(baseoil.siteId, anonymous, {});

    expect(all.offers.map((row) => row.subject)).toEqual(["Buying bright stock", "Old sell"]);
    expect((await publishedOffers(baseoil.siteId, anonymous, { type: "buy" })).total).toBe(1);
    expect((await publishedOffers(baseoil.siteId, anonymous, { search: "bright" })).total).toBe(1);
  });

  it("answers a suspended offer and another brand's as missing", async () => {
    const suspended = await offer(baseoil, { status: "suspended" });
    const theirs = await offer(bitumart);

    expect(await publishedOffer(baseoil.siteId, suspended.id, paying)).toBeNull();
    expect(await publishedOffer(baseoil.siteId, theirs.id, paying)).toBeNull();
  });
});

describe("a member's own offers", () => {
  const body = { subject: "Bright stock wanted", offer_type: "buy", description: "2,000 MT CIF Mumbai", contact_email: "trader@gulf.example" };

  it("posts an offer that goes live under their name", async () => {
    const made = await postOffer(member, baseoil.siteId, body);

    const [row] = await db().select().from(offers).where(eq(offers.id, made.id));

    expect(row).toMatchObject({ userId: member, status: "published", subject: "Bright stock wanted", offerType: "buy" });
    expect((await myOffers(member, baseoil.siteId)).map((row) => row.id)).toEqual([made.id]);
  });

  it("refuses a post without a subject or kind, and a run of posts in one day", async () => {
    await expect(postOffer(member, baseoil.siteId, { ...body, subject: "" })).rejects.toMatchObject({ field: "subject" });
    await expect(postOffer(member, baseoil.siteId, { ...body, offer_type: "swap" })).rejects.toMatchObject({ field: "offer_type" });

    for (let n = 0; n < 10; n += 1) {
      await postOffer(member, baseoil.siteId, { ...body, subject: `Post ${n}` });
    }

    await expect(postOffer(member, baseoil.siteId, body)).rejects.toMatchObject({ status: 429 });
  });

  it("changes and withdraws only their own", async () => {
    const mine = await postOffer(member, baseoil.siteId, body);
    const staffs = await offer(baseoil);

    expect(await updateMyOffer(member, baseoil.siteId, mine.id, { offer_value: "USD 600/MT" })).toMatchObject({ offer_value: "USD 600/MT" });
    expect(await updateMyOffer(other, baseoil.siteId, mine.id, { subject: "Hijacked" })).toBeNull();
    expect(await updateMyOffer(member, baseoil.siteId, staffs.id, { subject: "Mine now" })).toBeNull();
    // A member cannot set the status: a suspended offer stays suspended until staff say otherwise.
    await updateMyOffer(member, baseoil.siteId, mine.id, { status: "published" } as never);

    expect(await withdrawMyOffer(other, baseoil.siteId, mine.id)).toBe(false);
    expect(await withdrawMyOffer(member, baseoil.siteId, mine.id)).toBe(true);
    expect(await myOffers(member, baseoil.siteId)).toEqual([]);
  });
});
