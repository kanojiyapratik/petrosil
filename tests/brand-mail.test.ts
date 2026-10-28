/**
 * A brand's mail: its sender, the test that confirms it, and the old SMTP
 * login nothing reads.
 *
 * The rule that matters most: a brand's own From address is used only once a
 * test mail from it went through. A provider refuses an unverified sender
 * permanently, so using one untested would fail every mail the brand sends.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, rolePermissions, roles, settings, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { brandMail, deleteOldCredentials, saveSender, sendTest, senderFor } from "@/domain/mail/brand-mail";
import { saveSetting } from "@/domain/dashboard/settings";
import { queueMail } from "@/lib/mail/outbox";
import { deliverPending } from "@/lib/mail/deliver";
import { SendError, type OutgoingMail, type Transport } from "@/lib/mail/transport";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff, email: "editor@petrosil.example" }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

function recorder(fail?: (mail: OutgoingMail) => Error | null): Transport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];

  return {
    name: "recorder",
    sent,
    async send(mail) {
      const error = fail?.(mail) ?? null;

      if (error) {
        throw error;
      }

      sent.push(mail);

      return { messageId: `msg-${sent.length}` };
    },
  };
}

const value = async (brand: Brand, key: string) =>
  (await db().select().from(settings).where(and(eq(settings.siteId, brand.siteId), eq(settings.key, key))))[0]?.value ?? null;

const ENV = { BREVO_API_KEY: "xkeysib-test", MAIL_FROM: "mail@petrosil.example" };

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;

  // What migrate-content carried from baseoil's old settings table.
  await db()
    .insert(settings)
    .values([
      { siteId: baseoil.siteId, key: "mail_from_address", value: "info@baseoilreport.com" },
      { siteId: baseoil.siteId, key: "mail_reply_to", value: "desk@baseoilreport.com" },
      { siteId: baseoil.siteId, key: "mail_transport", value: "smtp" },
      { siteId: baseoil.siteId, key: "smtp_host", value: "smtp.sendgrid.net" },
      { siteId: baseoil.siteId, key: "smtp_username", value: "apikey" },
      { siteId: baseoil.siteId, key: "smtp_password", value: "SG.live-looking-keyyzK4" },
      { siteId: bitumart.siteId, key: "smtp_password", value: "bitumart-secret" },
    ]);
});

describe("the sender", () => {
  it("is not used until a test from it went through", async () => {
    expect(await senderFor(baseoil.siteId)).toEqual({ fromAddress: "info@baseoilreport.com", confirmed: false, replyTo: "desk@baseoilreport.com" });

    const view = await brandMail(guard([]), { site: "baseoil" }, db(), ENV);

    expect(view.sender.sendsFrom).toBe("mail@petrosil.example");
    expect(view.transport.ready).toBe(true);
  });

  it("is confirmed by a test the provider takes, sent from the brand's address", async () => {
    const transport = recorder();
    const sent = await sendTest(guard([]), { site: "baseoil", to: "me@petrosil.example" }, {}, db(), transport);

    expect(sent).toEqual({ from: "info@baseoilreport.com", to: "me@petrosil.example" });
    expect(transport.sent[0]).toMatchObject({ fromEmail: "info@baseoilreport.com", fromName: "baseoil", replyTo: "desk@baseoilreport.com" });
    expect(await senderFor(baseoil.siteId)).toMatchObject({ confirmed: true });

    const audit = await db().select().from(auditLog).where(eq(auditLog.action, "mail.sender_confirmed"));

    expect(audit).toHaveLength(1);
  });

  it("stays unconfirmed when the provider refuses the test", async () => {
    const transport = recorder(() => new SendError("Brevo answered 400: sender is not valid", true));

    await expect(sendTest(guard([]), { site: "baseoil", to: "me@petrosil.example" }, {}, db(), transport)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("sender is not valid"),
    });
    expect(await senderFor(baseoil.siteId)).toMatchObject({ confirmed: false });
  });

  it("needs a From address and a connected provider to test", async () => {
    await expect(sendTest(guard([]), { site: "baseoil", to: "me@petrosil.example" }, {}, db(), null)).rejects.toMatchObject({ status: 409 });
    await expect(sendTest(guard([]), { site: "bitumart", to: "me@petrosil.example" }, {}, db(), recorder())).rejects.toMatchObject({
      field: "fromAddress",
    });
  });

  it("goes back to unconfirmed when the address changes, and refuses one that is not an address", async () => {
    await sendTest(guard([]), { site: "baseoil", to: "me@petrosil.example" }, {}, db(), recorder());

    const changed = await saveSender(guard([]), { site: "baseoil", fromAddress: "news@baseoilreport.com", replyTo: "" });

    expect(changed).toEqual({ fromAddress: "news@baseoilreport.com", confirmed: false, replyTo: null });
    await expect(saveSender(guard([]), { site: "baseoil", fromAddress: "not an address", replyTo: "" })).rejects.toMatchObject({
      field: "fromAddress",
    });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "mail.sender"));

    expect(entry!.detail).toMatchObject({ from: ["info@baseoilreport.com", "news@baseoilreport.com"] });
  });

  it("cannot be confirmed through the general settings form", async () => {
    expect(await saveSetting(baseoil.siteId, "mail_from_confirmed", "info@baseoilreport.com")).toEqual({ ok: false });
    expect(await saveSetting(baseoil.siteId, "mail_from_address", "x@y.example")).toEqual({ ok: false });
    expect(await senderFor(baseoil.siteId)).toMatchObject({ fromAddress: "info@baseoilreport.com", confirmed: false });
  });
});

describe("delivery", () => {
  const queue = (payload: Record<string, unknown> = {}) =>
    queueMail({
      to: "reader@company.example",
      subject: "Confirm your email address for baseoil",
      template: "verify_email",
      payload: { token: "tok123", site: "baseoil", siteName: "Base Oil Report", name: "Asha", ...payload },
      siteId: baseoil.siteId,
    });

  const clock = async () => {
    const [found] = (await db().execute(sql`select clock_timestamp() as now`)) as unknown as { now: Date | string }[];

    return new Date(new Date(found!.now).getTime() + 1000);
  };

  it("sends from the estate's address until the brand's is confirmed, then from the brand's", async () => {
    const transport = recorder();

    await queue();
    await deliverPending(transport, { now: await clock() });

    expect(transport.sent[0]!.fromEmail).toBeUndefined();
    expect(transport.sent[0]!.replyTo).toBe("desk@baseoilreport.com");

    await sendTest(guard([]), { site: "baseoil", to: "me@petrosil.example" }, {}, db(), recorder());
    await queue();
    await deliverPending(transport, { now: await clock() });

    expect(transport.sent[1]!.fromEmail).toBe("info@baseoilreport.com");
  });

  it("keeps a forwarded enquiry's reply-to the member who wrote", async () => {
    const transport = recorder();

    await queue({ reply_to: "member@company.example" });
    await deliverPending(transport, { now: await clock() });

    expect(transport.sent[0]!.replyTo).toBe("member@company.example");
  });
});

describe("the old credentials", () => {
  it("are shown masked, and deleted for this brand alone without their values in the audit", async () => {
    const view = await brandMail(guard([]), { site: "baseoil" }, db(), ENV);

    expect(view.old.map((row) => row.key)).toEqual(["mail_transport", "smtp_host", "smtp_username", "smtp_password"]);
    expect(view.old.find((row) => row.key === "smtp_password")!.value).toBe("••••••••yzK4");

    expect(await deleteOldCredentials(guard([]), { site: "baseoil" })).toEqual({ removed: 4 });
    expect(await value(baseoil, "smtp_password")).toBeNull();
    expect(await value(baseoil, "mail_from_address")).toBe("info@baseoilreport.com");
    expect(await value(bitumart, "smtp_password")).toBe("bitumart-secret");

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "mail.old_credentials_deleted"));

    expect(JSON.stringify(entry!.detail)).not.toContain("SG.");
  });

  it("need the settings delete permission, and are not another brand's staff's", async () => {
    await expect(deleteOldCredentials(guard([bitumart.siteId]), { site: "baseoil" })).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Settings" }).returning();

    await db()
      .insert(rolePermissions)
      .values([
        { roleId: role!.id, permission: "setting-list" },
        { roleId: role!.id, permission: "setting-edit" },
      ]);
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    expect((await brandMail(guard([baseoil.siteId]), { site: "baseoil" }, db(), ENV)).old).toHaveLength(4);
    await expect(deleteOldCredentials(guard([baseoil.siteId]), { site: "baseoil" })).rejects.toBeInstanceOf(AccessError);
  });
});
