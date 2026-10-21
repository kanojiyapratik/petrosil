/**
 * The gate on one-click sign-in.
 *
 * This is a door with no lock on it, so the only thing that matters is that
 * it cannot exist anywhere but a development machine. The rule is tested
 * rather than inlined, because it is read in two places — the page that
 * draws the buttons and the action behind them — and two copies of a
 * security check is one copy too many.
 */
import { beforeEach, describe, expect, it, test } from "vitest";

import { makeBrand, resetDatabase } from "./helpers";
import { db } from "@/db";
import { loginAttempts, memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { identify, signIn } from "@/lib/auth/session";
import { DEV_PASSWORD, adminAccounts, quickSignInAllowed } from "@/lib/auth/dev-sign-in";

describe("when one-click sign-in is allowed", () => {
  it("is allowed on a development machine", () => {
    expect(quickSignInAllowed({ NODE_ENV: "development" })).toBe(true);
  });

  it("is allowed while running the tests", () => {
    expect(quickSignInAllowed({ NODE_ENV: "test" })).toBe(true);
  });

  it("is refused in production", () => {
    expect(quickSignInAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("is refused in production even when something asks for it", () => {
    expect(quickSignInAllowed({ NODE_ENV: "production", DEV_QUICK_SIGN_IN: "on" })).toBe(false);
    expect(quickSignInAllowed({ NODE_ENV: "production", DEV_QUICK_SIGN_IN: "1" })).toBe(false);
    expect(quickSignInAllowed({ NODE_ENV: "production", DEV_QUICK_SIGN_IN: "true" })).toBe(false);
  });

  it("is refused when NODE_ENV says nothing, because a missing answer is not a safe one", () => {
    expect(quickSignInAllowed({})).toBe(false);
    expect(quickSignInAllowed({ NODE_ENV: "" })).toBe(false);
  });

  it("can be switched off on a development machine too", () => {
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      expect(quickSignInAllowed({ NODE_ENV: "development", DEV_QUICK_SIGN_IN: off })).toBe(false);
    }
  });
});

/**
 * Which accounts get a button.
 *
 * Only the ones that will actually work: a button that fails is worse than
 * no button, because you cannot tell it from a broken sign-in.
 */
describe("the accounts offered as buttons", () => {
  beforeEach(resetDatabase);

  test("offers staff whose password is the development one", async () => {
    const brand = await makeBrand("baseoil", []);

    const [boss] = await db()
      .insert(users)
      .values({
        email: "boss@petrosil.example",
        name: "The Boss",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    const [editor] = await db()
      .insert(users)
      .values({
        email: "editor@petrosil.example",
        name: "An Editor",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    await db()
      .insert(memberships)
      .values([
        { userId: boss!.id, siteId: brand.siteId, role: "superadmin" },
        { userId: editor!.id, siteId: brand.siteId, role: "staff" },
      ]);

    const offered = await adminAccounts();

    // Superadmin first: it is the one wanted nine times out of ten.
    expect(offered.map((account) => [account.email, account.role])).toEqual([
      ["boss@petrosil.example", "superadmin"],
      ["editor@petrosil.example", "staff"],
    ]);
  });

  test("leaves out an account whose password is something else", async () => {
    const brand = await makeBrand("baseoil", []);

    const [real] = await db()
      .insert(users)
      .values({
        email: "real@petrosil.com",
        name: "A Real Person",
        passwordHash: await hashPassword("a password of their own"),
      })
      .returning();

    await db()
      .insert(memberships)
      .values({ userId: real!.id, siteId: brand.siteId, role: "staff" });

    expect(await adminAccounts()).toEqual([]);
  });

  test("leaves out a reader, who has no admin to be let into", async () => {
    const brand = await makeBrand("baseoil", []);

    const [reader] = await db()
      .insert(users)
      .values({
        email: "reader@company.example",
        name: "A Reader",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    await db()
      .insert(memberships)
      .values({ userId: reader!.id, siteId: brand.siteId, role: "subscriber" });

    expect(await adminAccounts()).toEqual([]);
  });

  test("offers nothing at all when one-click sign-in is not allowed here", async () => {
    const brand = await makeBrand("baseoil", []);

    const [boss] = await db()
      .insert(users)
      .values({
        email: "boss@petrosil.example",
        name: "The Boss",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    await db()
      .insert(memberships)
      .values({ userId: boss!.id, siteId: brand.siteId, role: "superadmin" });

    // The gate is the only thing standing between this and a production
    // sign-in page listing everyone who can get in.
    expect(await adminAccounts({ NODE_ENV: "production" })).toEqual([]);
  });
});

/**
 * The contract between the buttons and the action behind them.
 *
 * The panel promises that an offered account will sign in; the action calls
 * the ordinary `signIn` with the development password to do it. If those two
 * ever disagree the buttons become decoration, so the handshake is pinned
 * here rather than left to a click.
 */
describe("the handshake between an offered account and signing in", () => {
  beforeEach(resetDatabase);

  test("an account the panel offers really does sign in, and the attempt is logged", async () => {
    const brand = await makeBrand("baseoil", []);

    const [boss] = await db()
      .insert(users)
      .values({
        email: "boss@petrosil.example",
        name: "The Boss",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    await db()
      .insert(memberships)
      .values({ userId: boss!.id, siteId: brand.siteId, role: "superadmin" });

    const [offered] = await adminAccounts();

    expect(offered).toBeDefined();

    const session = await signIn({ email: offered!.email, password: DEV_PASSWORD });

    // Not the encoding, which is this test's business to leave alone: just
    // that a real opaque token came back with a future expiry on it.
    expect(session.token.length).toBeGreaterThanOrEqual(32);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Not a side door: it goes through the same front one, so it shows up in
    // the login log like every other sign-in.
    const attempts = await db().select().from(loginAttempts);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.succeeded).toBe(true);
    expect(attempts[0]!.email).toBe("boss@petrosil.example");
  });

  test("the session it hands back identifies the person it signed in", async () => {
    const brand = await makeBrand("baseoil", []);

    const [boss] = await db()
      .insert(users)
      .values({
        email: "boss@petrosil.example",
        name: "The Boss",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    await db()
      .insert(memberships)
      .values({ userId: boss!.id, siteId: brand.siteId, role: "superadmin" });

    const { token } = await signIn({ email: "boss@petrosil.example", password: DEV_PASSWORD });
    const identity = await identify(token);

    expect(identity?.user.email).toBe("boss@petrosil.example");
    expect(identity?.memberships.map((m) => m.role)).toEqual(["superadmin"]);
  });
});

describe("what a button can say about an account", () => {
  beforeEach(resetDatabase);

  test("records every brand a grant covers, superadmin included", async () => {
    const baseoil = await makeBrand("baseoil", []);
    const wax = await makeBrand("waxreport", []);

    const [boss] = await db()
      .insert(users)
      .values({
        email: "boss@petrosil.example",
        name: "The Boss",
        passwordHash: await hashPassword(DEV_PASSWORD),
      })
      .returning();

    await db()
      .insert(memberships)
      .values([
        { userId: boss!.id, siteId: baseoil.siteId, role: "superadmin" },
        { userId: boss!.id, siteId: wax.siteId, role: "superadmin" },
      ]);

    const [offered] = await adminAccounts();

    // A superadmin's brands are not narrowing -- they see everything -- but
    // the count is what the button shows, so it has to be there.
    expect(offered!.role).toBe("superadmin");
    expect(offered!.brands).toEqual(["baseoil", "waxreport"]);
  });
});
