/**
 * The company directory on the brand sites.
 *
 * Who is listed: this brand's confirmed, active readers with a company name —
 * never the team. What a reader sees of each follows the brand's field rules,
 * and a hidden detail is absent from the reply. Searching follows the rules
 * too, or a match would give a hidden name away.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { formFields, memberships, users } from "@/db/schema";
import { directory, directoryEntry } from "@/domain/public/directory";
import { GET as listRoute } from "@/app/api/public/[site]/directory/route";
import { GET as entryRoute } from "@/app/api/public/[site]/directory/[id]/route";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;

const anonymous = { entitled: false, tier: "anonymous", reason: "anonymous" } as const;
const paying = { entitled: true, tier: "premium", reason: "premium" } as const;

// baseoil's real rules, as carried.
const rules: [string, boolean, boolean][] = [
  // key, free, paying
  ["company_name", true, true],
  ["person", true, true],
  ["designation", true, true],
  ["country", true, true],
  ["city", true, true],
  ["website", true, true],
  ["address", false, true],
  ["state", false, true],
  ["email", false, false],
  ["phone", false, false],
  ["mobile", false, false],
  ["user_contact", false, true],
];

let people = 0;

async function member(values: Partial<typeof users.$inferInsert> = {}, over: Partial<typeof memberships.$inferInsert> = {}, brand = baseoil) {
  people++;

  const [row] = await db()
    .insert(users)
    .values({
      email: `person${people}@company.example`,
      name: `Person ${people}`,
      company: `Company ${people}`,
      designation: "Buyer",
      country: "India",
      city: "Mumbai",
      website: "https://company.example",
      address: "12 Marine Drive",
      postcode: "400001",
      phone: "+91 22 5550 0100",
      emailVerifiedAt: new Date(),
      createdAt: new Date(Date.UTC(2026, 0, people)),
      ...values,
    })
    .returning();

  await db().insert(memberships).values({ userId: row!.id, siteId: brand.siteId, role: "subscriber", tier: "free", ...over });

  return row!;
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  await db()
    .insert(formFields)
    .values(rules.map(([key, free, premium], at) => ({ siteId: baseoil.siteId, form: "directory" as const, key, label: key, showFree: free, showPremium: premium, sortOrder: at })));
});

describe("who is listed", () => {
  it("lists this brand's confirmed, active readers with a company, newest first", async () => {
    const older = await member({ company: "Gulf Lubes" });
    const newer = await member({ company: "Asia Oils" });

    await member({ company: "  " });
    await member({ company: "Unconfirmed Ltd", emailVerifiedAt: null });
    await member({ company: "Disabled Ltd", status: "disabled" });
    await member({ company: "Staff Co" }, { role: "staff" });
    await member({ company: "Elsewhere Ltd" }, {}, bitumart);

    const page = await directory(baseoil.siteId, anonymous, {});

    expect(page.total).toBe(2);
    expect(page.companies.map((row) => row.id)).toEqual([newer.id, older.id]);
  });

  it("answers null for anyone it does not list, on the list or by number", async () => {
    const staff = await member({}, { role: "staff" });
    const elsewhere = await member({}, {}, bitumart);

    expect(await directoryEntry(baseoil.siteId, staff.id, paying)).toBeNull();
    expect(await directoryEntry(baseoil.siteId, elsewhere.id, paying)).toBeNull();
  });
});

describe("what a reader sees", () => {
  it("gives a visitor the free details and nothing else", async () => {
    const made = await member({ company: "Gulf Lubes", name: "Omar", email: "sales@gulflubes.example" });
    const seen = (await directoryEntry(baseoil.siteId, made.id, anonymous))!;

    expect(seen).toMatchObject({ company: "Gulf Lubes", person: "Omar", designation: "Buyer", country: "India", city: "Mumbai" });
    expect(seen).toMatchObject({ address: null, postcode: null, email: null, phone: null, can_contact: false });
    // Hidden values are absent from the reply, not blanked on a screen.
    expect(JSON.stringify(seen)).not.toContain("gulflubes");
    expect(JSON.stringify(seen)).not.toContain("Marine Drive");
  });

  it("gives a paying reader the paying details, and keeps what is off for everyone off", async () => {
    const made = await member({ email: "sales@gulflubes.example" });
    const seen = (await directoryEntry(baseoil.siteId, made.id, paying))!;

    expect(seen).toMatchObject({ address: "12 Marine Drive", postcode: "400001", can_contact: true });
    expect(seen.email).toBeNull();
    expect(seen.phone).toBeNull();
  });

  it("shows the phone only where both the phone and the mobile rule allow it", async () => {
    const made = await member();

    await db().update(formFields).set({ showPremium: true }).where(eqKey("phone"));
    expect((await directoryEntry(baseoil.siteId, made.id, paying))!.phone).toBeNull();

    await db().update(formFields).set({ showPremium: true }).where(eqKey("mobile"));
    expect((await directoryEntry(baseoil.siteId, made.id, paying))!.phone).toBe("+91 22 5550 0100");
  });

  it("falls back to the defaults on a brand with no rules", async () => {
    const made = await member({ email: "x@co.example" }, {}, bitumart);

    expect((await directoryEntry(bitumart.siteId, made.id, anonymous))!).toMatchObject({ company: "Company " + people, email: null, can_contact: false });
    expect((await directoryEntry(bitumart.siteId, made.id, paying))!).toMatchObject({ email: "x@co.example", can_contact: true });
  });

  it("marks paying members", async () => {
    const made = await member({}, { tier: "trial" });

    expect((await directoryEntry(baseoil.siteId, made.id, anonymous))!.premium_member).toBe(true);
  });
});

describe("finding a company", () => {
  it("searches company, name and designation, by the old tabs, country and letter", async () => {
    await member({ company: "Gulf Lubes", country: "United Arab Emirates" }, { tier: "premium" });
    await member({ company: "Asia Oils", name: "Ravi Menon" });
    await member({ company: "Atlas Trading", designation: "Lubricant trader" });

    const names = async (options: Parameters<typeof directory>[2]) =>
      (await directory(baseoil.siteId, anonymous, options)).companies.map((row) => row.company);

    expect(await names({ search: "gulf" })).toEqual(["Gulf Lubes"]);
    expect(await names({ search: "menon" })).toEqual(["Asia Oils"]);
    expect(await names({ search: "lubri" })).toEqual(["Atlas Trading"]);
    expect(await names({ tier: "premium" })).toEqual(["Gulf Lubes"]);
    expect(await names({ tier: "free" })).toEqual(["Atlas Trading", "Asia Oils"]);
    expect(await names({ country: "united arab emirates" })).toEqual(["Gulf Lubes"]);
    expect(await names({ letter: "a" })).toEqual(["Atlas Trading", "Asia Oils"]);
  });

  it("does not find a member by a detail the reader may not see", async () => {
    await member({ company: "Asia Oils", name: "Ravi Menon" });
    await db().update(formFields).set({ showFree: false }).where(eqKey("person"));

    expect((await directory(baseoil.siteId, anonymous, { search: "menon" })).total).toBe(0);
    expect((await directory(baseoil.siteId, paying, { search: "menon" })).total).toBe(1);
  });

  it("counts the listed companies per country", async () => {
    await member({ country: "India" });
    await member({ country: " India " });
    await member({ country: "Oman" });
    await member({ country: "Oman" }, { role: "staff" });

    expect((await directory(baseoil.siteId, anonymous, {})).countries).toEqual([
      { country: "India", companies: 2 },
      { country: "Oman", companies: 1 },
    ]);
  });
});

describe("over HTTP", () => {
  it("lists and opens a company, and answers 404 for one it does not list", async () => {
    const made = await member({ company: "Gulf Lubes" });
    const staff = await member({}, { role: "staff" });
    const site = { params: Promise.resolve({ site: "baseoil" }) };

    const list = await listRoute(new Request("http://localhost/api/public/baseoil/directory?q=gulf"), site);

    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ total: 1, companies: [{ id: made.id, company: "Gulf Lubes" }] });

    const one = (id: number) =>
      entryRoute(new Request(`http://localhost/api/public/baseoil/directory/${id}`), {
        params: Promise.resolve({ site: "baseoil", id: String(id) }),
      });

    expect((await one(made.id)).status).toBe(200);
    expect((await one(staff.id)).status).toBe(404);
  });
});


function eqKey(key: string) {
  return and(eq(formFields.siteId, baseoil.siteId), eq(formFields.form, "directory"), eq(formFields.key, key));
}
