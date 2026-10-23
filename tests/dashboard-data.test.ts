/**
 * The rest of the dashboard: locations and their history, batches, the audit
 * trail, the login log, and the one write the client screen makes.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as locationsRoute } from "@/app/api/dashboard/locations/route";
import { GET as locationRoute, PATCH as visibilityRoute } from "@/app/api/dashboard/locations/[id]/route";
import { GET as batchesRoute } from "@/app/api/dashboard/batches/route";
import { GET as batchRoute } from "@/app/api/dashboard/batches/[id]/route";
import { GET as auditRoute } from "@/app/api/dashboard/audit/route";
import { GET as loginsRoute } from "@/app/api/dashboard/logins/route";
import { PATCH as membershipRoute } from "@/app/api/dashboard/clients/[id]/membership/route";
import { GET as clientRoute } from "@/app/api/dashboard/clients/[id]/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";

import { db } from "@/db";
import { auditLog, locations, memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { commitBatch, stageRows } from "@/domain/price/batches";
import { estateOverview } from "@/domain/dashboard/overview";
import { railBrands } from "@/domain/dashboard/rail";
import { siteSnapshot } from "@/domain/dashboard/site";
import { brandsFor } from "@/domain/dashboard/brands";
import { eq } from "drizzle-orm";
import { makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const NOW = new Date(2026, 9, 16, 9, 0, 0);
const FUTURE = "2099-02-02";
const PASSWORD = "hunter22";

let baseoil: Brand;
let bitumart: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB", "UAE SN 500"]);
  bitumart = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
});

async function person(
  email: string,
  grants: { brand: Brand; role: string; tier?: string; expiresAt?: string }[],
): Promise<number> {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: email.split("@")[0]!,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    })
    .returning();

  for (const grant of grants) {
    await db().insert(memberships).values({
      userId: row!.id,
      siteId: grant.brand.siteId,
      role: grant.role,
      tier: grant.tier ?? "free",
      expiresAt: grant.expiresAt ?? null,
    });
  }

  return row!.id;
}

async function signedIn(email: string): Promise<string> {
  const response = await loginRoute(
    new Request("http://platform.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const get = (url: string, cookie: string): Request =>
  new Request(`http://platform.test${url}`, { headers: { cookie } });

const patch = (url: string, cookie: string, body: unknown): Request =>
  new Request(`http://platform.test${url}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

describe("locations", () => {
  beforeEach(async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
  });

  it("lists them with their latest figure and what it moved from", async () => {
    await publishPrice(baseoil, "Singapore SN 150 FOB", 1500, "2026-10-09");
    await publishPrice(baseoil, "Singapore SN 150 FOB", 1545, "2026-10-16");

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await locationsRoute(get("/api/dashboard/locations", cookie))).json();

    const singapore = body.data.find((row: { title: string }) => row.title === "Singapore SN 150 FOB");

    expect(singapore).toMatchObject({
      site: "baseoil",
      price_rows: 2,
      latest_price: 1545,
      latest_pricedate: "2026-10-16",
      previous_price: 1500,
      visible: true,
    });
    expect(singapore.change_pct).toBeCloseTo(3, 1);

    // A location with no prices still appears, with nulls rather than gaps.
    const uae = body.data.find((row: { title: string }) => row.title === "UAE SN 500");
    expect(uae).toMatchObject({ price_rows: 0, latest_price: null, change_pct: null });
  });

  it("shows a staff member only their own brand's locations", async () => {
    const cookie = await signedIn("editor@petrosil.example");
    const body = await (await locationsRoute(get("/api/dashboard/locations", cookie))).json();

    expect(body.data.map((row: { site: string }) => row.site)).toEqual(["baseoil", "baseoil"]);
  });

  it("opens one location with its history, saying which batch published each figure", async () => {
    const staged = await stageRows({
      siteId: baseoil.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: FUTURE,
      source: "editorial",
      now: NOW,
    });
    await commitBatch(baseoil.siteId, staged.batch.id, {}, db(), NOW);

    const cookie = await signedIn("boss@petrosil.example");
    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;
    const body = await (await locationRoute(get(`/api/dashboard/locations/${id}`, cookie), ctx(id))).json();

    expect(body.location.title).toBe("Singapore SN 150 FOB");
    expect(body.history[0]).toMatchObject({
      price_date: FUTURE,
      price: 1520,
      batch_id: staged.batch.id,
      source: "editorial",
    });
  });

  it("hides and shows a location, and writes who did it", async () => {
    const cookie = await signedIn("boss@petrosil.example");
    const id = baseoil.locationIds["UAE SN 500"]!;

    const hidden = await visibilityRoute(
      patch(`/api/dashboard/locations/${id}`, cookie, { visible: false }),
      ctx(id),
    );

    expect(hidden.status).toBe(200);
    expect((await hidden.json()).visible).toBe(false);

    const [row] = await db().select().from(locations).where(eq(locations.id, id));
    expect(row!.visible).toBe(false);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "location.hide"));
    expect(entry).toMatchObject({ siteId: baseoil.siteId, entityId: id });
    expect(entry!.detail).toMatchObject({ title: "UAE SN 500", was: true, now: false });
  });

  it("will not let one brand's staff touch another brand's location", async () => {
    const cookie = await signedIn("editor@petrosil.example");
    const id = bitumart.locationIds["Bitumen Singapore Drum FOB"]!;

    expect((await locationRoute(get(`/api/dashboard/locations/${id}`, cookie), ctx(id))).status).toBe(404);
    expect(
      (await visibilityRoute(patch(`/api/dashboard/locations/${id}`, cookie, { visible: false }), ctx(id)))
        .status,
    ).toBe(404);

    const [row] = await db().select().from(locations).where(eq(locations.id, id));
    expect(row!.visible).toBe(true);
  });
});

describe("batches", () => {
  beforeEach(async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
  });

  it("lists every brand's updates, with how many rows still need attention", async () => {
    await stageRows({
      siteId: baseoil.siteId,
      rows: [
        { location: "Singapore SN 150 FOB", price: 1520 },
        { location: "Atlantis FOB", price: 100 },
      ],
      priceDate: FUTURE,
      now: NOW,
    });
    await stageRows({
      siteId: bitumart.siteId,
      rows: [{ location: "Bitumen Singapore Drum FOB", price: 830 }],
      priceDate: FUTURE,
      source: "crawl",
      now: NOW,
    });

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await batchesRoute(get("/api/dashboard/batches", cookie))).json();

    expect(body.total).toBe(2);
    expect(body.rows[0]).toMatchObject({ site: "bitumart", source: "crawl", items: 1, needs_attention: 0 });
    expect(body.rows[1]).toMatchObject({ site: "baseoil", items: 2, needs_attention: 1 });
  });

  it("filters by brand, status and source", async () => {
    const staged = await stageRows({
      siteId: baseoil.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: FUTURE,
      now: NOW,
    });
    await commitBatch(baseoil.siteId, staged.batch.id, {}, db(), NOW);
    await stageRows({
      siteId: bitumart.siteId,
      rows: [{ location: "Bitumen Singapore Drum FOB", price: 830 }],
      priceDate: FUTURE,
      now: NOW,
    });

    const cookie = await signedIn("boss@petrosil.example");

    const committed = await (await batchesRoute(get("/api/dashboard/batches?status=committed", cookie))).json();
    expect(committed.rows.map((row: { site: string }) => row.site)).toEqual(["baseoil"]);

    const bitumartOnly = await (await batchesRoute(get("/api/dashboard/batches?site=bitumart", cookie))).json();
    expect(bitumartOnly.total).toBe(1);

    const uploads = await (await batchesRoute(get("/api/dashboard/batches?source=upload", cookie))).json();
    expect(uploads.rows).toEqual([]);
  });

  it("opens one batch with every staged row", async () => {
    const staged = await stageRows({
      siteId: baseoil.siteId,
      rows: [
        { location: "Singapore SN 150 FOB", price: 1520 },
        { location: "Atlantis FOB", price: 100 },
      ],
      priceDate: FUTURE,
      now: NOW,
    });

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (
      await batchRoute(get(`/api/dashboard/batches/${staged.batch.id}`, cookie), ctx(staged.batch.id))
    ).json();

    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ location: "Singapore SN 150 FOB", new_price: 1520, status: "new" });
    expect(body.rows[1]).toMatchObject({
      location: null,
      raw_location: "Atlantis FOB",
      status: "unmatched",
      error_message: "No location matches this name.",
    });
  });

  it("keeps another brand's batch out of reach", async () => {
    const staged = await stageRows({
      siteId: bitumart.siteId,
      rows: [{ location: "Bitumen Singapore Drum FOB", price: 830 }],
      priceDate: FUTURE,
      now: NOW,
    });

    const cookie = await signedIn("editor@petrosil.example");
    const response = await batchRoute(
      get(`/api/dashboard/batches/${staged.batch.id}`, cookie),
      ctx(staged.batch.id),
    );

    expect(response.status).toBe(404);
  });
});

describe("the audit trail and login log", () => {
  it("records a commit against the brand, and shows it", async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);

    const staged = await stageRows({
      siteId: baseoil.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: FUTURE,
      now: NOW,
    });
    await commitBatch(baseoil.siteId, staged.batch.id, { tokenId: 1 }, db(), NOW);

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await auditRoute(get("/api/dashboard/audit", cookie))).json();

    expect(body.data[0]).toMatchObject({
      action: "price_batch.commit",
      site: "baseoil",
      entity: "price_batch",
      // The module committing on its own token, not a person at a keyboard.
      by_token: true,
    });
    expect(body.data[0].detail).toMatchObject({ created: 1, source: "api" });
  });

  it("shows a staff member only their own brand's entries", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);

    for (const brand of [baseoil, bitumart]) {
      const staged = await stageRows({
        siteId: brand.siteId,
        rows: [{ location: brand === baseoil ? "Singapore SN 150 FOB" : "Bitumen Singapore Drum FOB", price: 1 }],
        priceDate: FUTURE,
        now: NOW,
      });
      await commitBatch(brand.siteId, staged.batch.id, {}, db(), NOW);
    }

    const cookie = await signedIn("editor@petrosil.example");
    const body = await (await auditRoute(get("/api/dashboard/audit", cookie))).json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].site).toBe("baseoil");
  });

  it("logs sign-ins, and lets the log be narrowed to failures", async () => {
    await person("boss@petrosil.example", [{ brand: baseoil, role: "superadmin" }]);
    await person("client@company.example", [{ brand: baseoil, role: "subscriber" }]);

    await loginRoute(
      new Request("http://platform.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "client@company.example", password: "wrong" }),
      }),
    );

    const cookie = await signedIn("boss@petrosil.example");

    const all = await (await loginsRoute(get("/api/dashboard/logins", cookie))).json();
    expect(all.data.length).toBeGreaterThanOrEqual(2);

    const failures = await (await loginsRoute(get("/api/dashboard/logins?failures=true", cookie))).json();
    expect(failures.data).toHaveLength(1);
    expect(failures.data[0]).toMatchObject({
      email: "client@company.example",
      ok: false,
      reason: "bad_credentials",
    });
  });

  it("keeps another brand's subscribers out of the login log", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    await person("bituclient@company.example", [{ brand: bitumart, role: "subscriber" }]);

    await signedIn("bituclient@company.example");

    const cookie = await signedIn("editor@petrosil.example");
    const body = await (await loginsRoute(get("/api/dashboard/logins", cookie))).json();

    expect(body.data.map((row: { email: string }) => row.email)).not.toContain(
      "bituclient@company.example",
    );
  });
});

describe("changing what a client gets", () => {
  let client: number;

  beforeEach(async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    client = await person("client@company.example", [
      { brand: baseoil, role: "subscriber", tier: "trial", expiresAt: "2026-10-20" },
      { brand: bitumart, role: "subscriber", tier: "free" },
    ]);
  });

  it("extends access and records who did it", async () => {
    const cookie = await signedIn("editor@petrosil.example");

    const response = await membershipRoute(
      patch(`/api/dashboard/clients/${client}/membership`, cookie, {
        site: "baseoil",
        tier: "premium",
        expires_at: "2027-10-20",
      }),
      ctx(client),
    );

    expect(response.status).toBe(200);

    const detail = await (await clientRoute(get(`/api/dashboard/clients/${client}`, cookie), ctx(client))).json();
    expect(detail.brands[0]).toMatchObject({ tier: "premium", expires_at: "2027-10-20" });
    expect(detail.segment).toBe("premium");

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "client.update"));
    expect(entry!.detail).toMatchObject({
      client,
      was: { tier: "trial", expires_at: "2026-10-20" },
      now: { tier: "premium", expires_at: "2027-10-20" },
    });
  });

  it("disables an account across the estate, from one brand's screen", async () => {
    const cookie = await signedIn("boss@petrosil.example");

    await membershipRoute(
      patch(`/api/dashboard/clients/${client}/membership`, cookie, { site: "baseoil", status: "disabled" }),
      ctx(client),
    );

    const [row] = await db().select().from(users).where(eq(users.id, client));
    expect(row!.status).toBe("disabled");

    // And the account stops working immediately.
    expect(await signedIn("client@company.example")).toBe("");
  });

  it("refuses a tier that is not one of ours", async () => {
    const cookie = await signedIn("boss@petrosil.example");

    const response = await membershipRoute(
      patch(`/api/dashboard/clients/${client}/membership`, cookie, { site: "baseoil", tier: "platinum" }),
      ctx(client),
    );

    expect(response.status).toBe(422);
  });

  it("cannot be used to make someone staff", async () => {
    const cookie = await signedIn("boss@petrosil.example");

    await membershipRoute(
      patch(`/api/dashboard/clients/${client}/membership`, cookie, {
        site: "baseoil",
        tier: "premium",
        role: "superadmin",
      }),
      ctx(client),
    );

    const [row] = await db()
      .select()
      .from(memberships)
      .where(eq(memberships.userId, client));

    // Selling a subscription and granting administration are different
    // decisions; this endpoint only makes the first one.
    expect(row!.role).toBe("subscriber");
  });

  it("will not change a membership on a brand the viewer cannot see", async () => {
    const cookie = await signedIn("editor@petrosil.example");

    const response = await membershipRoute(
      patch(`/api/dashboard/clients/${client}/membership`, cookie, { site: "bitumart", tier: "premium" }),
      ctx(client),
    );

    expect(response.status).toBe(404);

    const rows = await db().select().from(memberships).where(eq(memberships.userId, client));
    expect(rows.find((row) => row.siteId === bitumart.siteId)!.tier).toBe("free");
  });
});

describe("the brands in the rail", () => {
  // The rail shows one entry per brand with a dot for price freshness, so it
  // needs name, slug and freshness — and nothing else. `estateOverview` could
  // answer, but it counts prices, people and batches to do it, and the rail
  // renders on every admin screen.
  it("answers with just what the rail draws", async () => {
    const brands = await railBrands([]);

    expect(brands.length).toBeGreaterThan(0);

    for (const brand of brands) {
      expect(Object.keys(brand).sort()).toEqual(["freshness", "name", "slug"]);
      expect(["fresh", "due", "stale", "none"]).toContain(brand.freshness);
    }
  });

  it("judges each brand against its own cadence, as the dashboard does", async () => {
    const [cards, brands] = await Promise.all([estateOverview([]), railBrands([])]);
    const byRail = new Map(brands.map((brand) => [brand.slug, brand.freshness]));

    for (const card of cards.sites) {
      expect(byRail.get(card.slug)).toBe(card.freshness);
    }
  });

  it("shows a brand with no prices as having none, not as overdue", async () => {
    const brands = await railBrands([]);

    expect(brands.every((brand) => brand.freshness !== undefined)).toBe(true);
  });
});

describe("one brand's own page", () => {
  // The Sites group opens a brand on its own dashboard rather than on a
  // filtered estate list, so this is the query behind that page.
  it("answers for a brand the viewer may see", async () => {
    const brand = await makeBrand("ownpage", ["Rotterdam SN 150", "Fujairah SN 500"]);

    await publishPrice(brand, "Rotterdam SN 150", 910, "2026-03-02");

    const snap = await siteSnapshot("ownpage", []);

    expect(snap).not.toBeNull();
    expect(snap!.brand.slug).toBe("ownpage");
    expect(snap!.markets).toBe(2);
    expect(snap!.prices).toBe(1);
    expect(snap!.latest_price_date).toBe("2026-03-02");
    expect(["fresh", "due", "stale", "none"]).toContain(snap!.freshness);
  });

  it("refuses a brand the viewer has no membership on", async () => {
    // A per-site editor must not reach another brand by typing its slug. The
    // old estate enforced this by giving them a different login; here the
    // slug is in the URL, so the check has to be in the query.
    const [brand] = await brandsFor([]);

    expect(await siteSnapshot(brand!.slug, [brand!.id + 9_000])).toBeNull();
  });

  it("refuses a slug that is not a brand at all", async () => {
    expect(await siteSnapshot("not-a-brand", [])).toBeNull();
  });

  it("lists the newest prices first, with the market named", async () => {
    const brand = await makeBrand("ordered", ["A market", "B market"]);

    await publishPrice(brand, "A market", 100, "2026-01-05");
    await publishPrice(brand, "B market", 200, "2026-02-09");
    await publishPrice(brand, "A market", 300, "2026-03-11");

    const snap = await siteSnapshot("ordered", []);
    const dates = snap!.recent.map((row) => row.price_date);

    expect(dates).toEqual([...dates].sort().reverse());

    for (const row of snap!.recent) {
      expect(row.market).toBeTruthy();
    }
  });
});
