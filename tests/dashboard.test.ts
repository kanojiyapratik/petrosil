/**
 * What the dashboard answers, and — more importantly — what it refuses to
 * answer to someone scoped to one brand.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as overviewRoute } from "@/app/api/dashboard/overview/route";
import { GET as clientsRoute } from "@/app/api/dashboard/clients/route";
import { GET as clientRoute } from "@/app/api/dashboard/clients/[id]/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";

import { db } from "@/db";
import { memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { segmentOf } from "@/domain/dashboard/clients";
import { commitBatch, stageRows } from "@/domain/price/batches";
import { makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const NOW = new Date(2026, 9, 16, 9, 0, 0);
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
  extra: { company?: string; name?: string } = {},
): Promise<number> {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: extra.name ?? email.split("@")[0]!,
      company: extra.company ?? null,
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

describe("the estate overview", () => {
  it("counts locations, prices, subscribers and commits per brand", async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);
    await person("payer@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium" },
      { brand: bitumart, role: "subscriber", tier: "premium" },
    ]);
    await person("reader@company.example", [{ brand: baseoil, role: "subscriber" }]);

    await publishPrice(baseoil, "Singapore SN 150 FOB", 1520, "2026-10-16");
    const staged = await stageRows({
      siteId: baseoil.siteId,
      rows: [{ location: "UAE SN 500", price: 1340 }],
      priceDate: "2099-02-02",
      now: NOW,
    });
    await commitBatch(baseoil.siteId, staged.batch.id, {}, db(), NOW);

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await overviewRoute(get("/api/dashboard/overview", cookie))).json();

    const base = body.sites.find((site: { slug: string }) => site.slug === "baseoil");

    expect(base).toMatchObject({
      locations: 2,
      live_locations: 2,
      premium: 1,
      users: 2,
      committed_batches: 1,
    });

    // One person on two brands is one person in the estate total.
    expect(body.totals.users).toBe(3);
    expect(body.totals.premium).toBe(2);
    expect(body.totals.sites).toBe(2);
    expect(body.recent_batches[0]).toMatchObject({ site: "baseoil", status: "committed" });
  });

  it("judges freshness against each brand's own cadence", async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);

    // Ten days old: late for a weekly brand, fine for a fortnightly one.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await publishPrice(baseoil, "Singapore SN 150 FOB", 1520, tenDaysAgo);
    await publishPrice(bitumart, "Bitumen Singapore Drum FOB", 830, tenDaysAgo);

    await db()
      .update((await import("@/db/schema")).sites)
      .set({ priceCadence: "Weekly · Friday" })
      .where((await import("drizzle-orm")).eq((await import("@/db/schema")).sites.id, baseoil.siteId));
    await db()
      .update((await import("@/db/schema")).sites)
      .set({ priceCadence: "1st & 16th" })
      .where((await import("drizzle-orm")).eq((await import("@/db/schema")).sites.id, bitumart.siteId));

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await overviewRoute(get("/api/dashboard/overview", cookie))).json();
    const bySlug = Object.fromEntries(
      body.sites.map((site: { slug: string; freshness: string }) => [site.slug, site.freshness]),
    );

    expect(bySlug).toEqual({ baseoil: "due", bitumart: "fresh" });
  });

  it("counts a lapsed subscription as expired, not as paying", async () => {
    await person("boss@petrosil.example", [{ brand: baseoil, role: "superadmin" }]);
    await person("paying@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium" },
    ]);
    await person("lapsed@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium", expiresAt: "2020-01-01" },
    ]);
    await person("ontrial@company.example", [
      { brand: baseoil, role: "subscriber", tier: "trial", expiresAt: "2099-01-01" },
    ]);

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await overviewRoute(get("/api/dashboard/overview", cookie))).json();

    // The same arithmetic the client list does, so the two screens agree.
    expect(body.totals).toMatchObject({ premium: 1, trial: 1, expired: 1 });
    expect(body.sites[0]).toMatchObject({ premium: 1 });
  });

  it("reports a brand with no prices as never updated rather than stale", async () => {
    await person("boss@petrosil.example", [{ brand: baseoil, role: "superadmin" }]);

    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await overviewRoute(get("/api/dashboard/overview", cookie))).json();

    expect(body.sites[0]).toMatchObject({ freshness: "none", latest_pricedate: null, days_since_update: null });
  });
});

describe("the client list", () => {
  beforeEach(async () => {
    await person("boss@petrosil.example", [
      { brand: baseoil, role: "superadmin" },
      { brand: bitumart, role: "superadmin" },
    ]);
    await person("both@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium" },
      { brand: bitumart, role: "subscriber", tier: "premium" },
    ], { company: "Emirates Base Oils DMCC", name: "Tanvi Sharma" });
    await person("trial@company.example", [
      { brand: bitumart, role: "subscriber", tier: "trial", expiresAt: "2099-01-01" },
    ]);
    await person("lapsed@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium", expiresAt: "2020-01-01" },
    ]);
    await person("free@company.example", [{ brand: baseoil, role: "subscriber" }]);
  });

  it("returns one row per person, with every brand they hold", async () => {
    const cookie = await signedIn("boss@petrosil.example");
    const body = await (await clientsRoute(get("/api/dashboard/clients", cookie))).json();

    const tanvi = body.rows.find((row: { email: string }) => row.email === "both@company.example");

    expect(tanvi.brands.map((brand: { slug: string }) => brand.slug)).toEqual(["baseoil", "bitumart"]);
    expect(tanvi.segment).toBe("premium");
    expect(tanvi.company).toBe("Emirates Base Oils DMCC");

    // The person appears once, not once per brand.
    expect(body.rows.filter((row: { email: string }) => row.email === "both@company.example")).toHaveLength(1);
  });

  it("works out each person's standing from their memberships", () => {
    const today = "2026-10-16";

    expect(segmentOf([{ role: "subscriber", tier: "premium", expiresAt: null }], today)).toBe("premium");
    expect(segmentOf([{ role: "subscriber", tier: "trial", expiresAt: "2026-12-01" }], today)).toBe("trial");
    expect(segmentOf([{ role: "subscriber", tier: "premium", expiresAt: "2020-01-01" }], today)).toBe("expired");
    expect(segmentOf([{ role: "subscriber", tier: "free", expiresAt: null }], today)).toBe("free");
    expect(segmentOf([{ role: "staff", tier: "free", expiresAt: null }], today)).toBe("staff");

    // Paying for one brand outranks a lapsed subscription to another.
    expect(
      segmentOf(
        [
          { role: "subscriber", tier: "premium", expiresAt: "2020-01-01" },
          { role: "subscriber", tier: "premium", expiresAt: null },
        ],
        today,
      ),
    ).toBe("premium");
  });

  it("searches name, email and company", async () => {
    const cookie = await signedIn("boss@petrosil.example");

    const byCompany = await (await clientsRoute(get("/api/dashboard/clients?q=Emirates", cookie))).json();
    expect(byCompany.rows).toHaveLength(1);

    const byName = await (await clientsRoute(get("/api/dashboard/clients?q=tanvi", cookie))).json();
    expect(byName.rows[0].email).toBe("both@company.example");

    const byEmail = await (await clientsRoute(get("/api/dashboard/clients?q=lapsed@", cookie))).json();
    expect(byEmail.rows[0].segment).toBe("expired");
  });

  it("filters by brand and by segment, and counts the segments", async () => {
    const cookie = await signedIn("boss@petrosil.example");

    const bitumartOnly = await (await clientsRoute(get("/api/dashboard/clients?site=bitumart", cookie))).json();
    expect(bitumartOnly.rows.map((row: { email: string }) => row.email).sort()).toEqual([
      "boss@petrosil.example",
      "both@company.example",
      "trial@company.example",
    ]);

    const premium = await (await clientsRoute(get("/api/dashboard/clients?segment=premium", cookie))).json();
    expect(premium.rows.map((row: { email: string }) => row.email)).toEqual(["both@company.example"]);

    expect(premium.counts).toMatchObject({ premium: 1, trial: 1, expired: 1, free: 1, staff: 1 });
  });

  it("opens one client in full, with their recent sign-ins", async () => {
    const id = await person("detail@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium" },
    ]);
    await signedIn("detail@company.example");

    const cookie = await signedIn("boss@petrosil.example");
    const response = await clientRoute(get(`/api/dashboard/clients/${id}`, cookie), {
      params: Promise.resolve({ id: String(id) }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.email).toBe("detail@company.example");
    expect(body.recent_logins[0]).toMatchObject({ ok: true });
  });
});

describe("what one brand's staff may not see", () => {
  let hidden: number;

  beforeEach(async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    hidden = await person("bituclient@company.example", [
      { brand: bitumart, role: "subscriber", tier: "premium" },
    ]);
    await person("baseclient@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium" },
    ]);
    await person("both@company.example", [
      { brand: baseoil, role: "subscriber", tier: "premium" },
      { brand: bitumart, role: "subscriber", tier: "premium" },
    ]);
  });

  it("leaves another brand's clients out of the list", async () => {
    const cookie = await signedIn("editor@petrosil.example");
    const body = await (await clientsRoute(get("/api/dashboard/clients", cookie))).json();

    const emails = body.rows.map((row: { email: string }) => row.email);
    expect(emails).toContain("baseclient@company.example");
    expect(emails).not.toContain("bituclient@company.example");
  });

  it("hides the other brand even on a client who holds both", async () => {
    const cookie = await signedIn("editor@petrosil.example");
    const body = await (await clientsRoute(get("/api/dashboard/clients?q=both@", cookie))).json();

    // The person is theirs to see; what they pay Bitumart is not.
    expect(body.rows[0].brands.map((brand: { slug: string }) => brand.slug)).toEqual(["baseoil"]);
  });

  it("answers 404 for another brand's client, not 403 — the reply must not confirm they exist", async () => {
    const cookie = await signedIn("editor@petrosil.example");
    const response = await clientRoute(get(`/api/dashboard/clients/${hidden}`, cookie), {
      params: Promise.resolve({ id: String(hidden) }),
    });

    expect(response.status).toBe(404);
  });

  it("ignores a brand filter for a brand they cannot see", async () => {
    const cookie = await signedIn("editor@petrosil.example");
    const body = await (await clientsRoute(get("/api/dashboard/clients?site=bitumart", cookie))).json();

    expect(body.rows).toEqual([]);
  });
});
