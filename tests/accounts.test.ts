/**
 * Registering, verifying, forgetting a password, and keeping a profile.
 *
 * The rule running through all of it: nothing an unauthenticated caller can
 * do may reveal whether an email address has an account. The old sites had a
 * `checkemail` route that answered that question directly, and the register
 * form said "already taken" — between them, the subscriber list was
 * enumerable by anyone.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as verifyRoute } from "@/app/api/auth/verify-email/route";
import { POST as forgotRoute } from "@/app/api/auth/forgot-password/route";
import { POST as resetRoute } from "@/app/api/auth/reset-password/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { GET as profileRoute, PATCH as patchProfileRoute } from "@/app/api/account/profile/route";
import { POST as passwordRoute } from "@/app/api/account/password/route";

import { db } from "@/db";
import { authTokens, mailOutbox, memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { verifyPassword } from "@/lib/auth/passwords";
import { makeBrand, resetDatabase, type Brand } from "./helpers";
import { desc, eq } from "drizzle-orm";

const PASSWORD = "hunter22!";

let baseoil: Brand;
let bitumart: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB"]);
  bitumart = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
});

const post = (url: string, body: unknown, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const patch = (url: string, body: unknown, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const get = (url: string, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, { headers: cookie ? { cookie } : {} });

async function existing(email: string, brand: Brand = baseoil): Promise<number> {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: "Existing Person",
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    })
    .returning();

  await db()
    .insert(memberships)
    .values({ userId: row!.id, siteId: brand.siteId, role: "subscriber", tier: "free" });

  return row!.id;
}

async function signedIn(email: string): Promise<string> {
  const response = await loginRoute(post("/api/auth/login", { email, password: PASSWORD }));

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

/** The most recent queued mail, which is where a token is handed over. */
async function lastMail() {
  const [row] = await db()
    .select()
    .from(mailOutbox)
    .orderBy(desc(mailOutbox.id))
    .limit(1);

  return row ?? null;
}

const tokenFromMail = async (): Promise<string> => String((await lastMail())!.payload!.token);

/* -------------------------------------------------------------- registering */

describe("registering", () => {
  it("creates the person, a free membership on that brand, and a verification mail", async () => {
    const response = await registerRoute(
      post("/api/auth/register", {
        site: "baseoil",
        email: "New.Person@company.example",
        password: PASSWORD,
        name: "New Person",
        company: "Company Ltd",
      }),
    );

    expect(response.status).toBe(202);

    const [person] = await db().select().from(users);

    // Stored folded: the login path looks up lower(email), and two rows
    // differing only by case is the duplicate the migration had to clean up.
    expect(person!.email).toBe("new.person@company.example");
    expect(person!.name).toBe("New Person");
    expect(person!.emailVerifiedAt).toBeNull();

    const grants = await db().select().from(memberships).where(eq(memberships.userId, person!.id));

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ siteId: baseoil.siteId, role: "subscriber", tier: "free" });

    const mail = await lastMail();

    expect(mail).toMatchObject({ template: "verify_email", to: "new.person@company.example" });
    expect(mail!.sentAt).toBeNull();
  });

  it("answers an address that already has an account exactly as it answers a new one", async () => {
    await existing("known@company.example");

    const fresh = await registerRoute(
      post("/api/auth/register", {
        site: "bitumart",
        email: "brand.new@company.example",
        password: PASSWORD,
        name: "Brand New",
      }),
    );
    const known = await registerRoute(
      post("/api/auth/register", {
        site: "bitumart",
        email: "known@company.example",
        password: PASSWORD,
        name: "Someone Else",
      }),
    );

    expect(known.status).toBe(fresh.status);
    expect(await known.json()).toEqual(await fresh.json());
  });

  it("never overwrites the password of an account that already exists", async () => {
    await existing("known@company.example");

    await registerRoute(
      post("/api/auth/register", {
        site: "baseoil",
        email: "known@company.example",
        password: "attackers-choice-99",
        name: "Someone Else",
      }),
    );

    const [person] = await db().select().from(users).where(eq(users.email, "known@company.example"));

    expect(await verifyPassword(PASSWORD, person!.passwordHash)).toBe(true);
    expect(await verifyPassword("attackers-choice-99", person!.passwordHash)).toBe(false);
    expect(person!.name).toBe("Existing Person");
  });

  it("adds the brand they asked for to an account that already exists, so one login covers both", async () => {
    const id = await existing("known@company.example", baseoil);

    await registerRoute(
      post("/api/auth/register", {
        site: "bitumart",
        email: "known@company.example",
        password: PASSWORD,
        name: "Known",
      }),
    );

    const grants = await db().select().from(memberships).where(eq(memberships.userId, id));

    expect(grants.map((grant) => grant.siteId).sort()).toEqual(
      [baseoil.siteId, bitumart.siteId].sort(),
    );
  });

  it("does not create a second account for the same address", async () => {
    await existing("known@company.example");

    await registerRoute(
      post("/api/auth/register", {
        site: "baseoil",
        email: "KNOWN@company.example",
        password: PASSWORD,
        name: "Known",
      }),
    );

    expect(await db().select().from(users)).toHaveLength(1);
  });

  it("refuses an address that is not one", async () => {
    const response = await registerRoute(
      post("/api/auth/register", { site: "baseoil", email: "not-an-address", password: PASSWORD, name: "X" }),
    );

    expect(response.status).toBe(422);
  });

  it("refuses a password too short to be worth hashing", async () => {
    const response = await registerRoute(
      post("/api/auth/register", { site: "baseoil", email: "x@company.example", password: "short1", name: "X" }),
    );

    expect(response.status).toBe(422);
    expect(await db().select().from(users)).toHaveLength(0);
  });

  it("refuses a password that is just the email address", async () => {
    const response = await registerRoute(
      post("/api/auth/register", {
        site: "baseoil",
        email: "person@company.example",
        password: "person@company.example",
        name: "X",
      }),
    );

    expect(response.status).toBe(422);
  });

  it("refuses a brand that does not exist", async () => {
    const response = await registerRoute(
      post("/api/auth/register", { site: "nosuchbrand", email: "x@company.example", password: PASSWORD, name: "X" }),
    );

    expect(response.status).toBe(422);
  });

  it("requires a name, because every screen that lists people shows one", async () => {
    const response = await registerRoute(
      post("/api/auth/register", { site: "baseoil", email: "x@company.example", password: PASSWORD, name: "  " }),
    );

    expect(response.status).toBe(422);
  });
});

/* ------------------------------------------------------------- verifying */

describe("verifying an email address", () => {
  beforeEach(async () => {
    await registerRoute(
      post("/api/auth/register", {
        site: "baseoil",
        email: "new@company.example",
        password: PASSWORD,
        name: "New Person",
      }),
    );
  });

  it("marks the address verified", async () => {
    const response = await verifyRoute(post("/api/auth/verify-email", { token: await tokenFromMail() }));

    expect(response.status).toBe(200);

    const [person] = await db().select().from(users);

    expect(person!.emailVerifiedAt).not.toBeNull();
  });

  it("will not accept the same link twice", async () => {
    const token = await tokenFromMail();

    await verifyRoute(post("/api/auth/verify-email", { token }));
    const second = await verifyRoute(post("/api/auth/verify-email", { token }));

    expect(second.status).toBe(400);
  });

  it("refuses a link that has expired", async () => {
    const token = await tokenFromMail();

    await db()
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.purpose, "verify_email"));

    const response = await verifyRoute(post("/api/auth/verify-email", { token }));

    expect(response.status).toBe(400);
  });

  it("refuses a token nobody issued", async () => {
    const response = await verifyRoute(post("/api/auth/verify-email", { token: "made-up" }));

    expect(response.status).toBe(400);
  });

  it("will not let a verification link be used to reset a password", async () => {
    const token = await tokenFromMail();

    const response = await resetRoute(post("/api/auth/reset-password", { token, password: "brand-new-pass-1" }));

    expect(response.status).toBe(400);
  });
});

/* --------------------------------------------------------- forgotten password */

describe("asking for a password reset", () => {
  it("answers the same way for an address it knows and one it does not", async () => {
    await existing("known@company.example");

    const known = await forgotRoute(post("/api/auth/forgot-password", { email: "known@company.example" }));
    const unknown = await forgotRoute(post("/api/auth/forgot-password", { email: "stranger@company.example" }));

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("queues a mail only for an address that has an account", async () => {
    await forgotRoute(post("/api/auth/forgot-password", { email: "stranger@company.example" }));

    expect(await db().select().from(mailOutbox)).toHaveLength(0);

    await existing("known@company.example");
    await forgotRoute(post("/api/auth/forgot-password", { email: "known@company.example" }));

    expect(await db().select().from(mailOutbox)).toHaveLength(1);
  });

  it("sets the new password and lets the person in with it", async () => {
    await existing("known@company.example");
    await forgotRoute(post("/api/auth/forgot-password", { email: "known@company.example" }));

    const response = await resetRoute(
      post("/api/auth/reset-password", { token: await tokenFromMail(), password: "a-whole-new-pass-7" }),
    );

    expect(response.status).toBe(200);

    const after = await loginRoute(
      post("/api/auth/login", { email: "known@company.example", password: "a-whole-new-pass-7" }),
    );

    expect(after.status).toBe(200);
  });

  it("throws out every session the account already had", async () => {
    await existing("known@company.example");
    const cookie = await signedIn("known@company.example");

    expect((await meRoute(get("/api/auth/me", cookie))).status).toBe(200);

    await forgotRoute(post("/api/auth/forgot-password", { email: "known@company.example" }));
    await resetRoute(
      post("/api/auth/reset-password", { token: await tokenFromMail(), password: "a-whole-new-pass-7" }),
    );

    // Whoever took the password is also whoever might be holding a stolen
    // cookie; a reset that leaves old sessions alive fixes nothing.
    expect((await meRoute(get("/api/auth/me", cookie))).status).toBe(401);
  });

  it("will not accept the same reset link twice", async () => {
    await existing("known@company.example");
    await forgotRoute(post("/api/auth/forgot-password", { email: "known@company.example" }));
    const token = await tokenFromMail();

    await resetRoute(post("/api/auth/reset-password", { token, password: "a-whole-new-pass-7" }));
    const second = await resetRoute(post("/api/auth/reset-password", { token, password: "another-pass-99" }));

    expect(second.status).toBe(400);
  });

  it("holds a weak new password to the same rule as registration", async () => {
    await existing("known@company.example");
    await forgotRoute(post("/api/auth/forgot-password", { email: "known@company.example" }));

    const response = await resetRoute(
      post("/api/auth/reset-password", { token: await tokenFromMail(), password: "short1" }),
    );

    expect(response.status).toBe(422);
  });
});

/* ---------------------------------------------------------------- profile */

describe("a subscriber's own profile", () => {
  beforeEach(async () => {
    await existing("known@company.example");
  });

  it("is refused to someone not signed in", async () => {
    expect((await profileRoute(get("/api/account/profile"))).status).toBe(401);
  });

  it("gives the person their details and the brands they hold", async () => {
    const cookie = await signedIn("known@company.example");
    const body = await (await profileRoute(get("/api/account/profile", cookie))).json();

    expect(body.user).toMatchObject({ email: "known@company.example", name: "Existing Person" });
    expect(body.memberships).toHaveLength(1);
    expect(body.user.password_hash).toBeUndefined();
  });

  it("updates the details a person is allowed to change", async () => {
    const cookie = await signedIn("known@company.example");

    const response = await patchProfileRoute(
      patch("/api/account/profile", { name: "Renamed Person", company: "New Co", country: "India" }, cookie),
    );

    expect(response.status).toBe(200);

    const [person] = await db().select().from(users);

    expect(person).toMatchObject({ name: "Renamed Person", company: "New Co", country: "India" });
  });

  it("ignores an attempt to change the address or the tier through the profile", async () => {
    const cookie = await signedIn("known@company.example");

    await patchProfileRoute(
      patch("/api/account/profile", { email: "moved@elsewhere.example", status: "admin", tier: "premium" }, cookie),
    );

    const [person] = await db().select().from(users);
    const [grant] = await db().select().from(memberships);

    expect(person!.email).toBe("known@company.example");
    expect(person!.status).toBe("active");
    expect(grant!.tier).toBe("free");
  });

  it("refuses a name wiped to nothing", async () => {
    const cookie = await signedIn("known@company.example");

    const response = await patchProfileRoute(patch("/api/account/profile", { name: "   " }, cookie));

    expect(response.status).toBe(422);
  });
});

/* ------------------------------------------------------- changing a password */

describe("changing a password while signed in", () => {
  beforeEach(async () => {
    await existing("known@company.example");
  });

  it("needs the current one", async () => {
    const cookie = await signedIn("known@company.example");

    const response = await passwordRoute(
      post("/api/account/password", { current: "not-it-at-all", next: "a-whole-new-pass-7" }, cookie),
    );

    expect(response.status).toBe(401);
  });

  it("changes it, and keeps the session that made the change", async () => {
    const cookie = await signedIn("known@company.example");

    const response = await passwordRoute(
      post("/api/account/password", { current: PASSWORD, next: "a-whole-new-pass-7" }, cookie),
    );

    expect(response.status).toBe(200);
    expect((await meRoute(get("/api/auth/me", cookie))).status).toBe(200);

    const after = await loginRoute(
      post("/api/auth/login", { email: "known@company.example", password: "a-whole-new-pass-7" }),
    );

    expect(after.status).toBe(200);
  });

  it("signs out the account's other devices", async () => {
    const elsewhere = await signedIn("known@company.example");
    const here = await signedIn("known@company.example");

    await passwordRoute(post("/api/account/password", { current: PASSWORD, next: "a-whole-new-pass-7" }, here));

    expect((await meRoute(get("/api/auth/me", elsewhere))).status).toBe(401);
    expect((await meRoute(get("/api/auth/me", here))).status).toBe(200);
  });

  it("holds the new password to the same rule as registration", async () => {
    const cookie = await signedIn("known@company.example");

    const response = await passwordRoute(
      post("/api/account/password", { current: PASSWORD, next: "short1" }, cookie),
    );

    expect(response.status).toBe(422);
  });
});
