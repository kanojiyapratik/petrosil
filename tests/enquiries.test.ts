/**
 * Enquiries: a member writing to a company in the directory, replying to an
 * offer, or asking about a plan — and staff working through them.
 *
 * The old sites saved a message and mailed it on, but kept no sender with it
 * and had no screen to read it: 1,189 on bitumart nobody could see. Here the
 * enquiry is a row with its sender, its recipient and whether staff have dealt
 * with it. The forward to the company (or the offer's contact) still goes, with
 * reply-to set to the member so the two can talk directly, and staff are told
 * at the brand's admin address — as before.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { POST as enquireRoute } from "@/app/api/public/[site]/enquiries/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { db } from "@/db";
import {
  auditLog,
  enquiries,
  mailOutbox,
  mailTemplates,
  memberships,
  offers,
  planPrices,
  plans,
  settings,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { getEnquiry, listEnquiries, setEnquiryStatus } from "@/domain/enquiries/inbox";
import { enquiryKindFor } from "@/domain/migrate/content";
import { deliverPending } from "@/lib/mail/deliver";
import type { OutgoingMail, Transport } from "@/lib/mail/transport";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

const PASSWORD = "hunter22!";

let baseoil: Brand;
let bitumart: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  await db().insert(settings).values({ siteId: baseoil.siteId, key: "site_admin_email", value: "info@baseoilreport.com" });
  await db().insert(mailTemplates).values({
    siteId: baseoil.siteId,
    key: "staff-alert",
    title: "Admin Email",
    subject: "Admin Email",
    body: "<h3>{heading}</h3><table>{content}</table>",
  });
});

let people = 0;

async function person(values: Partial<typeof users.$inferInsert> = {}, brand: Brand = baseoil) {
  people++;

  const [row] = await db()
    .insert(users)
    .values({
      email: `person${people}@company.example`,
      name: `Person ${people}`,
      company: `Company ${people}`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
      ...values,
    })
    .returning();

  await db().insert(memberships).values({ userId: row!.id, siteId: brand.siteId, role: "subscriber", tier: "free" });

  return row!;
}

async function signIn(email: string): Promise<string> {
  const response = await loginRoute(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  // The session travels as a cookie, as it does from a browser.
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function enquire(cookie: string | null, body: Record<string, unknown>, site = "baseoil") {
  return enquireRoute(
    new Request(`http://localhost/api/public/${site}/enquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ site }) },
  );
}

async function outbox() {
  return db().select().from(mailOutbox).orderBy(mailOutbox.id);
}

describe("a member writing to a company", () => {
  it("records who wrote to whom, forwards it, and tells staff", async () => {
    const company = await person({ name: "Omar", company: "Gulf Lubes", email: "sales@gulflubes.example" });
    const member = await person({ name: "Asha", email: "asha@buyer.example", company: "Buyer Ltd" });

    const response = await enquire(await signIn(member.email), {
      kind: "company",
      to: company.id,
      subject: "SN 500 in drums",
      message: "Can you quote 20 MT?",
    });

    expect(response.status).toBe(201);

    const [row] = await db().select().from(enquiries);

    expect(row).toMatchObject({
      siteId: baseoil.siteId,
      kind: "company",
      status: "new",
      fromUserId: member.id,
      fromName: "Asha",
      fromEmail: "asha@buyer.example",
      fromCompany: "Buyer Ltd",
      toUserId: company.id,
      about: "Gulf Lubes",
      subject: "SN 500 in drums",
      message: "Can you quote 20 MT?",
    });

    const mails = await outbox();

    expect(mails.map((mail) => mail.to)).toEqual(["sales@gulflubes.example", "info@baseoilreport.com"]);
    // The company answers the member directly.
    expect(mails[0]!.payload).toMatchObject({ reply_to: "asha@buyer.example" });
  });

  it("refuses a company that is not on this brand", async () => {
    const elsewhere = await person({}, bitumart);
    const member = await person();

    const response = await enquire(await signIn(member.email), { kind: "company", to: elsewhere.id, message: "Hi" });

    expect(response.status).toBe(404);
    expect(await db().select().from(enquiries)).toHaveLength(0);
  });
});

describe("a reply to an offer", () => {
  it("goes to the offer's contact address", async () => {
    const owner = await person({ email: "owner@seller.example" });
    const [offer] = await db()
      .insert(offers)
      .values({
        siteId: baseoil.siteId,
        userId: owner.id,
        subject: "Selling Group II",
        offerType: "sell",
        status: "published",
        contactEmail: "desk@seller.example",
      })
      .returning();
    const member = await person();

    const response = await enquire(await signIn(member.email), { kind: "offer", to: offer!.id, message: "Price?" });

    expect(response.status).toBe(201);

    const [row] = await db().select().from(enquiries);

    expect(row).toMatchObject({ kind: "offer", offerId: offer!.id, about: "Selling Group II" });
    expect((await outbox())[0]!.to).toBe("desk@seller.example");
  });
});

describe("asking about a plan", () => {
  it("records the plan and the server's price, and tells staff only", async () => {
    const [plan] = await db()
      .insert(plans)
      .values({ siteId: baseoil.siteId, code: "annual", name: "Annual", currency: "USD" })
      .returning();
    await db().insert(planPrices).values({ planId: plan!.id, years: 2, amount: "1000.00" });
    const member = await person();

    const response = await enquire(await signIn(member.email), {
      kind: "plan",
      to: plan!.id,
      years: 2,
      members: 3,
      // A price posted by the browser is not the price.
      cost: 1,
      message: "Can we pay by bank transfer?",
    });

    expect(response.status).toBe(201);

    const [row] = await db().select().from(enquiries);

    expect(row).toMatchObject({ kind: "plan", planId: plan!.id, about: "Annual" });
    expect(row!.detail).toEqual({ years: 2, members: 3, price: "USD 1000.00" });
    expect((await outbox()).map((mail) => mail.to)).toEqual(["info@baseoilreport.com"]);
  });
});

describe("the rules on the way in", () => {
  it("needs a signed-in member", async () => {
    expect((await enquire(null, { kind: "company", to: 1, message: "Hi" })).status).toBe(401);
  });

  it("needs something to say", async () => {
    const company = await person();
    const member = await person();

    const response = await enquire(await signIn(member.email), { kind: "company", to: company.id, message: "  " });

    expect(response.status).toBe(422);
  });

  it("slows down someone sending a stream of them", async () => {
    const company = await person();
    const member = await person();
    const token = await signIn(member.email);

    for (let i = 0; i < 10; i++) {
      expect((await enquire(token, { kind: "company", to: company.id, message: `Hello ${i}` })).status).toBe(201);
    }

    expect((await enquire(token, { kind: "company", to: company.id, message: "One more" })).status).toBe(429);
  });

  it("still keeps the enquiry when the brand has no admin address", async () => {
    await db().delete(settings);
    const company = await person();
    const member = await person();

    await enquire(await signIn(member.email), { kind: "company", to: company.id, message: "Hi" });

    expect(await db().select().from(enquiries)).toHaveLength(1);
    expect((await outbox()).map((mail) => mail.to)).toEqual([company.email]);
  });
});

describe("the mail that goes out", () => {
  it("carries the built table unescaped, the member's words escaped, and the reply-to", async () => {
    const company = await person({ email: "sales@gulflubes.example" });
    const member = await person({ name: "<b>Asha</b>", email: "asha@buyer.example" });

    await enquire(await signIn(member.email), { kind: "company", to: company.id, message: "<script>x</script>" });

    const sent: OutgoingMail[] = [];
    const transport: Transport = {
      name: "recorder",
      async send(mail) {
        sent.push(mail);

        return { messageId: null };
      },
    };

    await deliverPending(transport);

    expect(sent[0]!.replyTo).toBe("asha@buyer.example");
    expect(sent[0]!.subject).toContain("Message from <b>Asha</b>");
    expect(sent[0]!.html).toContain("<table><tr>");
    expect(sent[0]!.html).not.toContain("<script>");
    expect(sent[0]!.html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(sent[0]!.html).toContain("&lt;b&gt;Asha&lt;/b&gt;");
  });
});

describe("the inbox", () => {
  let staff: number;

  const guard = (siteIds: number[]) =>
    ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

  async function enquiry(values: Partial<typeof enquiries.$inferInsert> = {}) {
    const [row] = await db()
      .insert(enquiries)
      .values({ siteId: baseoil.siteId, kind: "company", message: "Hello", fromName: "Asha", ...values })
      .returning();

    return row!;
  }

  beforeEach(async () => {
    const [row] = await db().insert(users).values({ email: "staff@petrosil.example", name: "Staff" }).returning();

    staff = row!.id;
  });

  it("lists a brand's enquiries newest first, filtered and searched", async () => {
    await enquiry({ message: "About drums", createdAt: new Date("2026-10-01") });
    await enquiry({ message: "About flexitanks", createdAt: new Date("2026-10-02") });
    await enquiry({ kind: "plan", message: "Bank transfer?", status: "handled" });
    await enquiry({ siteId: bitumart.siteId, message: "Not ours" });

    const all = await listEnquiries(guard([baseoil.siteId]), "baseoil", {});

    expect(all.rows.map((row) => row.message)).toEqual(["Bank transfer?", "About flexitanks", "About drums"]);
    expect((await listEnquiries(guard([]), "baseoil", { status: "new" })).total).toBe(2);
    expect((await listEnquiries(guard([]), "baseoil", { kind: "plan" })).total).toBe(1);
    expect((await listEnquiries(guard([]), "baseoil", { q: "flexi" })).rows[0]!.message).toBe("About flexitanks");
    expect(all.counts).toEqual({ new: 2, handled: 1, archived: 0 });
  });

  it("marks one handled with a note, and can open it again", async () => {
    const row = await enquiry();

    const done = await setEnquiryStatus(guard([baseoil.siteId]), row.id, "handled", "Quoted by phone");

    expect(done.ok).toBe(true);

    const handled = await getEnquiry(guard([baseoil.siteId]), row.id);

    expect(handled).toMatchObject({ status: "handled", note: "Quoted by phone", handledByName: "Staff" });

    await setEnquiryStatus(guard([baseoil.siteId]), row.id, "new", null);

    expect((await getEnquiry(guard([]), row.id))!.status).toBe("new");

    const entries = await db().select().from(auditLog).where(eq(auditLog.entity, "enquiry"));

    expect(entries).toHaveLength(2);
  });

  it("keeps another brand's enquiry out of reach", async () => {
    const theirs = await enquiry({ siteId: bitumart.siteId });

    expect(await getEnquiry(guard([baseoil.siteId]), theirs.id)).toBeNull();
    expect((await setEnquiryStatus(guard([baseoil.siteId]), theirs.id, "handled", null)).ok).toBe(false);
  });
});

describe("carrying the old messages", () => {
  it("knows what an old message was addressed to", () => {
    expect(enquiryKindFor("App\\User")).toBe("company");
    expect(enquiryKindFor("App\\Offer")).toBe("offer");
    expect(enquiryKindFor("App\\Something")).toBeNull();
  });
});
