/**
 * The header's brand filter, screen by screen.
 *
 * Each admin list reads either `scope.siteIds` or `viewer.siteIds` plus the
 * chosen brand's slug (see brand-scope.ts). Whichever, a member of staff
 * holding one brand must never see another's rows: not with the filter on
 * "all brands", and not with a cookie forged or left over naming a brand they
 * do not hold. These call the domain exactly the way each page does.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { auditLog, coupons, memberships, orders, planSites, plans, trialRequests, users } from "@/db/schema";
import { narrowTo } from "@/app/(admin)/brand-scope";
import { auditTrail } from "@/domain/dashboard/activity";
import { brandsFor } from "@/domain/dashboard/brands";
import { listCoupons, listPlans, listStaff, listTransactions } from "@/domain/dashboard/catalogue";
import { segmentCounts } from "@/domain/dashboard/clients";
import { listTrials } from "@/domain/billing/trials";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let mine: Brand;
let theirs: Brand;

beforeEach(async () => {
  await resetDatabase();
  mine = await makeBrand("baseoil", []);
  theirs = await makeBrand("waxreport", []);

  // One of everything on each brand, named after the brand.
  for (const brand of [mine, theirs]) {
    const slug = brand.slug;
    const [reader, editor] = await db()
      .insert(users)
      .values([
        { email: `reader@${slug}.example`, name: `Reader ${slug}` },
        { email: `editor@${slug}.example`, name: `Editor ${slug}` },
      ])
      .returning();

    await db()
      .insert(memberships)
      .values([
        { userId: reader!.id, siteId: brand.siteId, role: "subscriber" },
        { userId: editor!.id, siteId: brand.siteId, role: "staff" },
      ]);

    const [plan] = await db().insert(plans).values({ code: `plan-${slug}`, name: `Plan ${slug}` }).returning();
    await db().insert(planSites).values({ planId: plan!.id, siteId: brand.siteId });
    await db().insert(orders).values({
      siteId: brand.siteId,
      userId: reader!.id,
      planId: plan!.id,
      planName: `Plan ${slug}`,
      years: 1,
      currency: "USD",
      listAmount: "100.00",
      amount: "100.00",
      status: "paid",
    });
    await db().insert(coupons).values({ code: `CODE-${slug}`.toUpperCase(), percentOff: 10, siteId: brand.siteId });
    await db().insert(trialRequests).values({ siteId: brand.siteId, userId: reader!.id, note: slug });
    await db().insert(auditLog).values({ siteId: brand.siteId, action: "test.entry", detail: { slug } });
  }
});

/** What a member of staff holding only `mine` reads, with `cookie` in the header. */
async function staffView(cookie: string | undefined) {
  const viewerSiteIds = [mine.siteId];
  const scope = narrowTo(viewerSiteIds, await brandsFor(viewerSiteIds), cookie);
  const site = scope.brand?.slug;

  return {
    scope,
    audit: (await auditTrail(viewerSiteIds, { site })).map((row) => row.site),
    plans: (await listPlans(viewerSiteIds, { site })).map((row) => row.code),
    transactions: (await listTransactions(viewerSiteIds, { site })).rows.map((row) => row.site),
    coupons: (await listCoupons(scope.siteIds)).map((row) => row.code),
    staff: (await listStaff(scope.siteIds)).map((row) => row.email),
    trials: (await listTrials(scope.siteIds, undefined)).map((row) => row.site),
    customers: (await segmentCounts(scope.siteIds)).free,
  };
}

const onlyMine = {
  audit: ["baseoil"],
  plans: ["plan-baseoil"],
  transactions: ["baseoil"],
  coupons: ["CODE-BASEOIL"],
  staff: ["editor@baseoil.example"],
  trials: ["baseoil"],
  customers: 1,
};

describe("staff holding one brand", () => {
  it("see only that brand with the filter on all brands", async () => {
    const view = await staffView(undefined);

    expect(view.scope.brand).toBeNull();
    expect(view).toMatchObject(onlyMine);
  });

  it("see only that brand with their own brand chosen", async () => {
    const view = await staffView("baseoil");

    expect(view.scope.brand?.slug).toBe("baseoil");
    expect(view).toMatchObject(onlyMine);
  });

  it("see only that brand, not the other, with a cookie naming a brand they do not hold", async () => {
    const view = await staffView("waxreport");

    expect(view.scope.brand).toBeNull();
    expect(view).toMatchObject(onlyMine);
  });

  it("are refused the other brand by the lists themselves, whatever slug reaches them", async () => {
    expect(await auditTrail([mine.siteId], { site: "waxreport" })).toEqual([]);
    expect(await listPlans([mine.siteId], { site: "waxreport" })).toEqual([]);
    expect((await listTransactions([mine.siteId], { site: "waxreport" })).rows).toEqual([]);
  });
});

describe("a superadmin", () => {
  it("sees every brand with no choice, and one brand when one is chosen", async () => {
    const all = narrowTo([], await brandsFor([]), undefined);
    const one = narrowTo([], await brandsFor([]), "waxreport");

    expect((await listCoupons(all.siteIds)).map((row) => row.code).sort()).toEqual(["CODE-BASEOIL", "CODE-WAXREPORT"]);
    expect((await listCoupons(one.siteIds)).map((row) => row.code)).toEqual(["CODE-WAXREPORT"]);
    expect((await listStaff(one.siteIds)).map((row) => row.email)).toEqual(["editor@waxreport.example"]);
    expect((await segmentCounts(one.siteIds)).free).toBe(1);
  });
});
