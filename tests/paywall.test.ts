/**
 * The one rule the whole paid product rests on: a visitor who has not paid
 * sees that a price moved, and never what it moved to.
 *
 * These are pure, so they are cheap and there are a lot of them. The old
 * sites spread this decision across every blade template, which is how the
 * "Price History" link ended up visible to free users on two of the nine.
 */
import { describe, expect, it } from "vitest";

import { entitlementFor, maskTrend, type Viewer } from "@/domain/public/paywall";

const TODAY = "2026-10-19";

const viewer = (memberships: Viewer["memberships"], userId: number | null = 7): Viewer => ({
  userId,
  memberships,
});

const member = (over: Partial<Viewer["memberships"][number]> = {}) => ({
  siteId: 1,
  role: "subscriber",
  tier: "premium",
  expiresAt: null as string | null,
  ...over,
});

describe("who is entitled to figures", () => {
  it("refuses an anonymous visitor", () => {
    const result = entitlementFor(viewer([], null), 1, TODAY);

    expect(result.entitled).toBe(false);
    expect(result.reason).toBe("anonymous");
  });

  it("refuses someone signed in who holds no membership on this brand", () => {
    const result = entitlementFor(viewer([member({ siteId: 2 })]), 1, TODAY);

    expect(result.entitled).toBe(false);
    expect(result.reason).toBe("no_membership");
  });

  it("refuses a free reader", () => {
    const result = entitlementFor(viewer([member({ tier: "free" })]), 1, TODAY);

    expect(result.entitled).toBe(false);
    expect(result.reason).toBe("free");
  });

  it("admits a premium reader with no end date", () => {
    const result = entitlementFor(viewer([member()]), 1, TODAY);

    expect(result.entitled).toBe(true);
    expect(result.reason).toBe("premium");
  });

  it("admits a premium reader whose subscription ends today, because today is still theirs", () => {
    const result = entitlementFor(viewer([member({ expiresAt: TODAY })]), 1, TODAY);

    expect(result.entitled).toBe(true);
  });

  it("refuses a premium reader whose subscription ended yesterday", () => {
    const result = entitlementFor(viewer([member({ expiresAt: "2026-10-18" })]), 1, TODAY);

    expect(result.entitled).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("admits someone on a live trial", () => {
    const result = entitlementFor(viewer([member({ tier: "trial", expiresAt: "2026-10-25" })]), 1, TODAY);

    expect(result.entitled).toBe(true);
    expect(result.reason).toBe("trial");
  });

  it("refuses a lapsed trial", () => {
    const result = entitlementFor(viewer([member({ tier: "trial", expiresAt: "2026-09-30" })]), 1, TODAY);

    expect(result.entitled).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("admits this brand's staff, who have to see what they publish", () => {
    const result = entitlementFor(viewer([member({ role: "staff", tier: "free" })]), 1, TODAY);

    expect(result.entitled).toBe(true);
    expect(result.reason).toBe("team");
  });

  it("admits a superadmin on a brand they hold no subscription to", () => {
    const result = entitlementFor(viewer([member({ siteId: 9, role: "superadmin", tier: "free" })]), 1, TODAY);

    expect(result.entitled).toBe(true);
    expect(result.reason).toBe("team");
  });

  it("does not let another brand's staff role carry over", () => {
    const result = entitlementFor(viewer([member({ siteId: 2, role: "staff" })]), 1, TODAY);

    expect(result.entitled).toBe(false);
    expect(result.reason).toBe("no_membership");
  });

  it("reports the tier it found, so a page can tell a lapsed reader from a new one", () => {
    expect(entitlementFor(viewer([member({ tier: "premium", expiresAt: "2026-01-01" })]), 1, TODAY).tier).toBe(
      "premium",
    );
    expect(entitlementFor(viewer([], null), 1, TODAY).tier).toBe("anonymous");
  });
});

describe("masking a price row", () => {
  const row = {
    id: 3,
    title: "Singapore SN 150 FOB",
    currency: "USD",
    unit: null,
    price: 830,
    previous_price: 820,
    change_pct: 1.22,
    price_date: "2026-10-16",
    movement: "up" as const,
  };

  it("leaves everything in place for a paying reader", () => {
    expect(maskTrend(row, true)).toEqual({ ...row, locked: false });
  });

  it("takes the figures away but keeps the movement and the name", () => {
    const masked = maskTrend(row, false);

    expect(masked.price).toBeNull();
    expect(masked.previous_price).toBeNull();
    expect(masked.change_pct).toBeNull();
    expect(masked.movement).toBe("up");
    expect(masked.title).toBe("Singapore SN 150 FOB");
    expect(masked.locked).toBe(true);
  });

  it("keeps the date, because when it was last assessed is not the figure", () => {
    expect(maskTrend(row, false).price_date).toBe("2026-10-16");
  });
});
