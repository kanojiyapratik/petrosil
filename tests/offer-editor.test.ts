/**
 * Editing an offer from the admin: the buy and sell notices, 11,000 of them
 * on bitumart.
 *
 * Staff type many of these in for somebody who phoned, so the contact
 * details live on the row; an offer can also be tied to the member it is
 * for, which is what lets the brand site show "your offers" later. The old
 * admin suspended an offer by setting `publish_options` to "Suspend"; here
 * that is a status, and deleting is withdrawing, so every link to it and
 * every enquiry about it still resolve.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, mediaFiles, memberships, offers, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { createOffer, offerForEdit, updateOffer, withdrawOffer } from "@/domain/offers/editor";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const offer = (extra: Record<string, unknown> = {}) => ({
  site: "baseoil",
  subject: "SN 500 for sale, 2,000 MT",
  offer_type: "sell",
  description: "Ex-Jebel Ali.",
  company_name: "Gulf Lubes FZE",
  contact_person: "R. Khan",
  contact_email: "sales@gulflubes.example",
  country: "United Arab Emirates",
  ...extra,
});

async function stored(brand: Brand, folder: string, name: string) {
  await db()
    .insert(mediaFiles)
    .values({ siteId: brand.siteId, path: `${brand.slug}/${folder}/${name}`, folder, name, kind: "image/png", bytes: 10 });
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("a new offer", () => {
  it("is saved with its contact details and an audit entry", async () => {
    const made = await createOffer(guard([]), offer({ status: "published" }));

    const [row] = await db().select().from(offers).where(eq(offers.id, made.id));

    expect(row).toMatchObject({
      siteId: baseoil.siteId,
      subject: "SN 500 for sale, 2,000 MT",
      offerType: "sell",
      companyName: "Gulf Lubes FZE",
      contactEmail: "sales@gulflubes.example",
      status: "published",
      userId: null,
    });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "offer.create"));

    expect(entry).toMatchObject({ entityId: made.id, userId: staff });
  });

  it("is a draft unless told otherwise", async () => {
    expect((await createOffer(guard([]), offer())).status).toBe("draft");
  });

  it("can be tied to the member it was posted for, by their email", async () => {
    const [member] = await db().insert(users).values({ email: "Trader@Gulf.example", name: "Trader" }).returning();

    const made = await createOffer(guard([]), offer({ poster_email: "trader@gulf.example" }));

    const [row] = await db().select().from(offers).where(eq(offers.id, made.id));

    expect(row!.userId).toBe(member!.id);

    await expect(createOffer(guard([]), offer({ poster_email: "nobody@x.example" }))).rejects.toMatchObject({
      field: "poster_email",
    });
  });

  it("refuses a missing subject, an unknown kind or status, and a contact email that is not one", async () => {
    await expect(createOffer(guard([]), offer({ subject: "  " }))).rejects.toMatchObject({ field: "subject" });
    await expect(createOffer(guard([]), offer({ offer_type: "swap" }))).rejects.toMatchObject({ field: "offer_type" });
    await expect(createOffer(guard([]), offer({ status: "premium" }))).rejects.toMatchObject({ field: "status" });
    await expect(createOffer(guard([]), offer({ contact_email: "call me" }))).rejects.toMatchObject({
      field: "contact_email",
    });
  });

  it("takes an image and an attachment only from the brand's offer folders", async () => {
    await stored(baseoil, "offers/images", "drums.png");
    await stored(baseoil, "offers/files", "spec.pdf");
    await stored(bitumart, "offers/images", "theirs.png");

    const made = await createOffer(guard([]), offer({ image: "drums.png", file: "spec.pdf" }));

    expect(made).toMatchObject({ image: "drums.png", file: "spec.pdf" });

    await expect(createOffer(guard([]), offer({ image: "theirs.png" }))).rejects.toMatchObject({ field: "image" });
    await expect(createOffer(guard([]), offer({ file: "drums.png" }))).rejects.toMatchObject({ field: "file" });
  });

  it("is not for another brand's staff, or a role without offer-create", async () => {
    await expect(createOffer(guard([bitumart.siteId]), offer())).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Offer reader" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "offer-list" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(createOffer(guard([baseoil.siteId]), offer())).rejects.toBeInstanceOf(AccessError);
  });
});

describe("changing an offer", () => {
  it("changes what it is given and leaves the rest", async () => {
    const made = await createOffer(guard([]), offer({ status: "published" }));

    const saved = await updateOffer(guard([]), made.id, { offer_value: "USD 610/MT", status: "suspended" });

    expect(saved).toMatchObject({ offer_value: "USD 610/MT", status: "suspended", subject: "SN 500 for sale, 2,000 MT" });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "offer.status"));

    expect(entry!.detail).toMatchObject({ was: "published", now: "suspended" });
  });

  it("can untie it from a member", async () => {
    const [member] = await db().insert(users).values({ email: "m@x.example", name: "M" }).returning();
    const made = await createOffer(guard([]), offer({ poster_email: "m@x.example" }));

    expect((await offerForEdit([], made.id))!.poster_email).toBe("m@x.example");

    await updateOffer(guard([]), made.id, { poster_email: "" });

    const [row] = await db().select().from(offers).where(eq(offers.id, made.id));

    expect(row!.userId).toBeNull();
    void member;
  });

  it("answers another brand's offer as missing", async () => {
    const theirs = await createOffer(guard([]), offer({ site: "bitumart" }));

    expect(await updateOffer(guard([baseoil.siteId]), theirs.id, { subject: "Mine" })).toBeNull();
    expect(await offerForEdit([baseoil.siteId], theirs.id)).toBeNull();
  });
});

describe("withdrawing an offer", () => {
  it("takes it off the lists and keeps the row", async () => {
    const made = await createOffer(guard([]), offer());

    expect(await withdrawOffer(guard([]), made.id)).toBe(true);

    const [row] = await db().select().from(offers).where(eq(offers.id, made.id));

    expect(row!.deletedAt).not.toBeNull();
    expect(await offerForEdit([], made.id)).toBeNull();
  });
});
