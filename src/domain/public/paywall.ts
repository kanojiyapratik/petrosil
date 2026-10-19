/**
 * The paywall, in one place.
 *
 * The nine PHP sites decided this in every blade template that showed a
 * price, reading `users.premium` and `expiry_date` inline, and the rule drifted:
 * on two of them a free reader could still reach the price-history link. The
 * rule is simple enough to state once and test on its own, so it lives here
 * and nothing else is allowed to ask the question.
 *
 * The rule: **movement and names are public, figures are paid for.** A visitor
 * sees that Singapore SN 150 rose, and that it was last assessed on Friday,
 * and never what it rose to. That is the same reason the price module builds
 * its AI note from movements only — the published prose is safe for everyone.
 */

export type Viewer = {
  userId: number | null;
  memberships: { siteId: number; role: string; tier: string; expiresAt: string | null }[];
};

export type Tier = "anonymous" | "free" | "premium" | "trial";

export type Entitlement = {
  entitled: boolean;
  tier: Tier;
  /**
   * Why, so a page can say the right thing: an expired subscriber gets
   * "renew", a free reader gets "subscribe", and a visitor gets "sign in".
   */
  reason: "anonymous" | "no_membership" | "free" | "expired" | "premium" | "trial" | "team";
};

const PAID_TIERS = new Set(["premium", "trial"]);
const TEAM_ROLES = new Set(["staff", "superadmin"]);

/**
 * `today` is passed in rather than read from the clock: entitlement is a
 * date comparison, and a function that reads the clock itself cannot be
 * tested at a boundary. Dates are YYYY-MM-DD, which compares correctly as a
 * string and avoids a timezone deciding whether someone's last day counts.
 */
export function entitlementFor(viewer: Viewer, siteId: number, today: string): Entitlement {
  if (viewer.userId === null) {
    return { entitled: false, tier: "anonymous", reason: "anonymous" };
  }

  // A superadmin holds the estate, whichever brand their row happens to sit
  // on; this mirrors isSuperadmin() in the dashboard guard.
  if (viewer.memberships.some((m) => m.role === "superadmin")) {
    return { entitled: true, tier: "premium", reason: "team" };
  }

  const membership = viewer.memberships.find((m) => m.siteId === siteId);

  if (!membership) {
    return { entitled: false, tier: "free", reason: "no_membership" };
  }

  // Staff see what they publish. Without this an editor checking a brand site
  // sees the same locked page a stranger does, and cannot tell whether the
  // figure they just committed came out right.
  if (TEAM_ROLES.has(membership.role)) {
    return { entitled: true, tier: "premium", reason: "team" };
  }

  const tier = (PAID_TIERS.has(membership.tier) ? membership.tier : "free") as Tier;

  if (tier === "free") {
    return { entitled: false, tier: "free", reason: "free" };
  }

  // No end date on a paid tier means open-ended, not lapsed. Some of the
  // oldest premium rows in the dumps have no expiry at all, and reading that
  // as "expired long ago" would lock out the estate's longest-standing
  // subscribers on day one.
  if (membership.expiresAt === null) {
    return { entitled: true, tier, reason: tier };
  }

  // The last day belongs to the reader: a subscription ending today is live
  // today. The old sites used `>= now()` on a datetime at midnight, which
  // quietly cut the final day short.
  if (membership.expiresAt >= today) {
    return { entitled: true, tier, reason: tier };
  }

  return { entitled: false, tier, reason: "expired" };
}

export type TrendRow = {
  id: number;
  title: string;
  currency: string | null;
  unit: string | null;
  price: number | null;
  previous_price: number | null;
  change_pct: number | null;
  price_date: string | null;
  movement: "up" | "down" | "flat" | null;
};

/**
 * What leaves the building. Masking happens here, on the way out, rather than
 * by not selecting the column: the movement is derived from the two figures,
 * so the query needs them either way, and one exit point is far easier to be
 * sure about than a branch in every query.
 */
export function maskTrend(row: TrendRow, entitled: boolean): TrendRow & { locked: boolean } {
  if (entitled) {
    return { ...row, locked: false };
  }

  return {
    ...row,
    price: null,
    previous_price: null,
    change_pct: null,
    locked: true,
  };
}
