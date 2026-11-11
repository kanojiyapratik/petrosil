/**
 * A member moving their own sign-in to a new address: asked for with the
 * password, done only by the link mailed to the new address.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as forgotRoute } from "@/app/api/auth/forgot-password/route";
import { POST as resetRoute } from "@/app/api/auth/reset-password/route";
import { POST as verifyRoute } from "@/app/api/auth/verify-email/route";
import { POST as emailRoute } from "@/app/api/account/email/route";
import { POST as confirmRoute } from "@/app/api/auth/confirm-email/route";

import { db } from "@/db";
import { auditLog, authTokens, mailOutbox, memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { pendingEmailChange } from "@/domain/accounts/email-change";
import { renderMail } from "@/lib/mail/render";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

const PASSWORD = "hunter22!";

let baseoil: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB"]);
});

const post = (url: string, body: unknown, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

async function member(email: string): Promise<number> {
  const [row] = await db()
    .insert(users)
    .values({ email, name: "Mira Member", passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() })
    .returning();

  await db().insert(memberships).values({ userId: row!.id, siteId: baseoil.siteId, role: "subscriber", tier: "free" });

  return row!.id;
}

async function signedIn(email: string): Promise<string> {
  const response = await loginRoute(post("/api/auth/login", { email, password: PASSWORD }));

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function mails() {
  return db().select().from(mailOutbox).orderBy(desc(mailOutbox.id));
}

async function ask(cookie: string, email: string, password = PASSWORD) {
  return emailRoute(post("/api/account/email", { email, password, site: "baseoil" }, cookie));
}

const tokenTo = async (to: string): Promise<string> => {
  const found = (await mails()).find((mail) => mail.to === to && mail.template === "change_email");

  return String(found!.payload!.token);
};

const emailOf = async (id: number) => (await db().select().from(users).where(eq(users.id, id)))[0]!;

describe("asking to change my email address", () => {
  it("is refused to someone not signed in", async () => {
    const response = await emailRoute(post("/api/account/email", { email: "new@company.example", password: PASSWORD }));

    expect(response.status).toBe(401);
  });

  it("needs the current password, and mails nothing without it", async () => {
    await member("old@company.example");
    const response = await ask(await signedIn("old@company.example"), "new@company.example", "not-my-password");

    expect(response.status).toBe(401);
    expect(await mails()).toHaveLength(0);
  });

  it("refuses an invalid address and the address it already has", async () => {
    await member("old@company.example");
    const cookie = await signedIn("old@company.example");

    expect((await ask(cookie, "not-an-address")).status).toBe(422);
    expect((await ask(cookie, "OLD@company.example")).status).toBe(422);
  });

  it("mails a link to the new address and changes nothing yet", async () => {
    const id = await member("old@company.example");
    const response = await ask(await signedIn("old@company.example"), "New@Company.example");

    expect(response.status).toBe(202);
    expect((await emailOf(id)).email).toBe("old@company.example");
    expect(await pendingEmailChange(id)).toBe("new@company.example");

    const [mail] = await mails();

    expect(mail).toMatchObject({ to: "new@company.example", template: "change_email", siteId: baseoil.siteId });

    const rendered = renderMail(
      { subject: mail!.subject, template: mail!.template, payload: mail!.payload ?? {} },
      { linkBase: "https://app.test/baseoil" },
    );

    expect(rendered.html).toContain("https://app.test/baseoil/confirm-email?token=");
  });

  it("answers an address that already has an account exactly as a free one, and changes nothing", async () => {
    const id = await member("old@company.example");
    await member("someone.else@company.example");
    const cookie = await signedIn("old@company.example");

    const free = await ask(cookie, "free@company.example");
    const taken = await ask(cookie, "someone.else@company.example");

    expect(taken.status).toBe(free.status);
    expect(await taken.json()).toEqual(await free.json());

    const [note] = await mails();

    // The address's owner is told; no link is issued for it.
    expect(note).toMatchObject({ to: "someone.else@company.example", template: "change_email_taken" });
    expect(note!.payload!.token).toBeUndefined();
    // The earlier, free request is still the one waiting.
    expect(await pendingEmailChange(id)).toBe("free@company.example");
  });
});

describe("confirming the new address", () => {
  it("moves the sign-in, counts the new address as confirmed, and tells the old one", async () => {
    const id = await member("old@company.example");
    await db().update(users).set({ emailVerifiedAt: null }).where(eq(users.id, id));
    await ask(await signedIn("old@company.example"), "new@company.example");

    const response = await confirmRoute(post("/api/auth/confirm-email", { token: await tokenTo("new@company.example") }));

    expect(response.status).toBe(200);

    const after = await emailOf(id);

    expect(after.email).toBe("new@company.example");
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await pendingEmailChange(id)).toBeNull();

    expect((await loginRoute(post("/api/auth/login", { email: "new@company.example", password: PASSWORD }))).status).toBe(200);
    expect((await loginRoute(post("/api/auth/login", { email: "old@company.example", password: PASSWORD }))).status).toBe(401);

    const [notice] = await mails();

    expect(notice).toMatchObject({ to: "old@company.example", template: "email_changed" });
    expect(notice!.payload!.newEmail).toBe("new@company.example");

    const [trail] = await db().select().from(auditLog).where(eq(auditLog.action, "member.email"));

    expect(trail).toMatchObject({ siteId: baseoil.siteId, userId: id, entityId: id });
    expect(trail!.detail).toMatchObject({ changed: { email: { from: "old@company.example", to: "new@company.example" } }, by: "member" });
  });

  it("works once", async () => {
    await member("old@company.example");
    await ask(await signedIn("old@company.example"), "new@company.example");
    const token = await tokenTo("new@company.example");

    expect((await confirmRoute(post("/api/auth/confirm-email", { token }))).status).toBe(200);
    expect((await confirmRoute(post("/api/auth/confirm-email", { token }))).status).toBe(400);
  });

  it("only honours the newest request: asking again kills the earlier link", async () => {
    const id = await member("old@company.example");
    const cookie = await signedIn("old@company.example");

    await ask(cookie, "typo@compnay.example");
    const first = await tokenTo("typo@compnay.example");
    await ask(cookie, "right@company.example");

    expect((await confirmRoute(post("/api/auth/confirm-email", { token: first }))).status).toBe(400);
    expect((await emailOf(id)).email).toBe("old@company.example");

    expect((await confirmRoute(post("/api/auth/confirm-email", { token: await tokenTo("right@company.example") }))).status).toBe(200);
    expect((await emailOf(id)).email).toBe("right@company.example");
  });

  it("refuses when the address was registered by someone else in the meantime", async () => {
    const id = await member("old@company.example");
    await ask(await signedIn("old@company.example"), "new@company.example");
    const token = await tokenTo("new@company.example");

    await member("new@company.example");

    const response = await confirmRoute(post("/api/auth/confirm-email", { token }));

    expect(response.status).toBe(409);
    expect((await emailOf(id)).email).toBe("old@company.example");
  });

  it("stops a reset link already mailed to the old address from working", async () => {
    await member("old@company.example");
    await forgotRoute(post("/api/auth/forgot-password", { email: "old@company.example" }));
    const reset = String((await mails()).find((mail) => mail.template === "reset_password")!.payload!.token);

    await ask(await signedIn("old@company.example"), "new@company.example");
    await confirmRoute(post("/api/auth/confirm-email", { token: await tokenTo("new@company.example") }));

    const response = await resetRoute(post("/api/auth/reset-password", { token: reset, password: "taken-over-pass-1" }));

    expect(response.status).toBe(400);
  });

  it("will not let the link be spent as a confirmation or a password reset", async () => {
    await member("old@company.example");
    await ask(await signedIn("old@company.example"), "new@company.example");
    const token = await tokenTo("new@company.example");

    expect((await verifyRoute(post("/api/auth/verify-email", { token }))).status).toBe(400);
    expect((await resetRoute(post("/api/auth/reset-password", { token, password: "taken-over-pass-1" }))).status).toBe(400);

    const [row] = await db().select().from(authTokens).where(and(eq(authTokens.purpose, "change_email")));

    expect(row!.usedAt).toBeNull();
  });

  it("refuses a link for an account staff have since switched off", async () => {
    const id = await member("old@company.example");
    await ask(await signedIn("old@company.example"), "new@company.example");
    await db().update(users).set({ status: "disabled" }).where(eq(users.id, id));

    const response = await confirmRoute(post("/api/auth/confirm-email", { token: await tokenTo("new@company.example") }));

    expect(response.status).toBe(400);
    expect((await emailOf(id)).email).toBe("old@company.example");
  });
});
