/**
 * One-click sign-in, for a development machine only.
 *
 * Typing the same password forty times a day is a waste of a working day, so
 * the sign-in page offers the local accounts as buttons. That is a door with
 * no lock on it, so the whole of the thinking here is about where it is
 * allowed to exist.
 *
 * Two rules, in this order:
 *
 * 1. Never in production. No flag, no environment variable and no header can
 *    turn it back on there — the check looks at `NODE_ENV` first and returns
 *    before it reads anything else.
 * 2. Nowhere that has not said it is development. A missing `NODE_ENV` is
 *    refused rather than assumed to be safe, because the one deployment that
 *    forgets to set it is exactly the one that must not have this.
 *
 * `DEV_QUICK_SIGN_IN=off` switches it off on a development machine too, for
 * when you want to test the real sign-in path.
 *
 * It is not a second way in. The buttons submit a password to the same
 * `signIn` everything else uses, so the throttle still throttles, the
 * attempt is still written to the login log, and the session is an ordinary
 * one. If the account's password is not the development password, the button
 * fails exactly as a typed-in wrong password does.
 */

/** The password `db:dev-data` gives every demo account. */
export const DEV_PASSWORD = process.env.DEV_PASSWORD ?? "petrosil-dev";

const OFF = new Set(["off", "0", "false", "no"]);

export function quickSignInAllowed(env: {
  NODE_ENV?: string;
  DEV_QUICK_SIGN_IN?: string;
}): boolean {
  // First and unconditionally: not in production, whatever else is set.
  if (env.NODE_ENV === "production") {
    return false;
  }

  // A missing answer is not a safe one.
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    return false;
  }

  return !OFF.has((env.DEV_QUICK_SIGN_IN ?? "").trim().toLowerCase());
}

/** The same question, asked of the process this code is running in. */
export function quickSignInHere(): boolean {
  return quickSignInAllowed({
    NODE_ENV: process.env.NODE_ENV,
    DEV_QUICK_SIGN_IN: process.env.DEV_QUICK_SIGN_IN,
  });
}

export type DevAccount = {
  id: number;
  name: string;
  email: string;
  role: "superadmin" | "staff";
  /**
   * Every brand the account holds a grant on. For staff this is the limit;
   * for a superadmin it is not — they see the estate whatever is listed here
   * — but the count is worth showing either way.
   */
  brands: string[];
};

/**
 * The accounts worth offering as a button.
 *
 * Only the ones that will actually work: the development password is
 * verified against each hash, because a button that fails is worse than no
 * button — you cannot tell it from a broken sign-in. Readers are left out;
 * they have no admin to be let into.
 *
 * Returns nothing at all when one-click sign-in is not allowed here, so a
 * production sign-in page cannot become a list of everyone who can get in
 * even if something renders the component by mistake.
 */
export async function adminAccounts(
  env: { NODE_ENV?: string; DEV_QUICK_SIGN_IN?: string } = {
    NODE_ENV: process.env.NODE_ENV,
    DEV_QUICK_SIGN_IN: process.env.DEV_QUICK_SIGN_IN,
  },
): Promise<DevAccount[]> {
  if (!quickSignInAllowed(env)) {
    return [];
  }

  // Imported here rather than at the top: this module is read by the sign-in
  // page, and nothing about the gate should need a database to answer.
  const { db } = await import("@/db");
  const { memberships, sites, users } = await import("@/db/schema");
  const { verifyPassword } = await import("./passwords");
  const { asc, eq, inArray } = await import("drizzle-orm");

  const rows = await db()
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      hash: users.passwordHash,
      role: memberships.role,
      slug: sites.slug,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(sites, eq(sites.id, memberships.siteId))
    .where(inArray(memberships.role, ["superadmin", "staff"]))
    .orderBy(asc(users.name), asc(sites.slug));

  const byUser = new Map<number, DevAccount & { hash: string | null }>();

  for (const row of rows) {
    const held = byUser.get(row.id) ?? {
      id: row.id,
      name: row.name,
      email: row.email,
      hash: row.hash,
      role: "staff" as const,
      brands: [],
    };

    if (row.role === "superadmin") {
      held.role = "superadmin";
    }

    // Recorded for both roles. For staff it is what narrows them; for a
    // superadmin it is not a limit, but the count is what the button shows.
    held.brands.push(row.slug);

    byUser.set(row.id, held);
  }

  const offered: DevAccount[] = [];

  for (const account of byUser.values()) {
    if (await verifyPassword(DEV_PASSWORD, account.hash)) {
      const { hash: _hash, ...rest } = account;
      void _hash;

      offered.push(rest);
    }
  }

  // Superadmin first: it is the one wanted nine times out of ten.
  return offered.sort(
    (a, b) =>
      Number(b.role === "superadmin") - Number(a.role === "superadmin") ||
      a.name.localeCompare(b.name),
  );
}
