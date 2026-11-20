/**
 * A setting's value is checked for its kind on the server, not only by the
 * browser's email box: a typo or a list in the Admin address would make every
 * staff alert fail at Brevo with nothing on screen to say why. A bad address
 * already saved is skipped when alerts are queued, rather than queued to fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import { mailOutbox, mailTemplates, settings, users } from "@/db/schema";
import { brandSetting, saveSetting, settingProblem, staffAddress } from "@/domain/dashboard/settings";
import { trialRequested } from "@/domain/mail/lifecycle";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let brand: Brand;

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", []);
});

describe("checking a value for its kind", () => {
  const email = { label: "Admin address", kind: "email" as const };
  const number = { label: "Trial length", kind: "number" as const };

  it("takes one address, and a blank to clear it", () => {
    expect(settingProblem(email, "staff@baseoil.example")).toBeNull();
    expect(settingProblem(email, "  staff@baseoil.example  ")).toBeNull();
    expect(settingProblem(email, "")).toBeNull();
  });

  it("refuses a typo or a list, and names the field", () => {
    expect(settingProblem(email, "staff@baseoil")).toMatch(/^Admin address: "staff@baseoil" is not one email address\.$/);
    expect(settingProblem(email, "a@x.example, b@y.example")).not.toBeNull();
    expect(settingProblem(email, "a@x.example;b@y.example")).not.toBeNull();
    expect(settingProblem(email, "a@x.example,b")).not.toBeNull();
  });

  it("takes a whole number for a number", () => {
    expect(settingProblem(number, "14")).toBeNull();
    expect(settingProblem(number, "two weeks")).toMatch(/not a whole number/);
  });
});

describe("saving", () => {
  it("does not save a bad address, and says why", async () => {
    const result = await saveSetting(brand.siteId, "site_admin_email", "staff@baseoil");

    expect(result).toEqual({ ok: false, error: 'Admin address: "staff@baseoil" is not one email address.' });
    expect(await brandSetting(brand.siteId, "site_admin_email")).toBeNull();
  });

  it("saves a good one without the stray spaces", async () => {
    expect(await saveSetting(brand.siteId, "site_admin_email", " staff@baseoil.example ")).toEqual({ ok: true });

    const [row] = await db().select().from(settings);
    expect(row!.value).toBe("staff@baseoil.example");
  });
});

describe("an address saved before it was checked", () => {
  it("is skipped for staff alerts instead of queued to fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db().insert(settings).values({ siteId: brand.siteId, key: "site_admin_email", value: "a@x.example, b@y.example" });
    await db()
      .insert(mailTemplates)
      .values({ siteId: brand.siteId, key: "staff-alert", variant: "default", title: "Alert", subject: "Alert", body: "<p>{content}</p>" });
    const [person] = await db()
      .insert(users)
      .values({ email: "reader@company.example", name: "Reader", passwordHash: "x" })
      .returning();

    expect(await staffAddress(brand.siteId)).toBeNull();
    expect(await trialRequested(person!.id, brand.siteId, null)).toBe(0);
    expect(await db().select().from(mailOutbox)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
