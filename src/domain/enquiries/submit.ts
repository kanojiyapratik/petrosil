/**
 * A member's enquiry, as it arrives from a brand site.
 *
 * Three kinds, as on the old sites: writing to a company in the directory,
 * replying to an offer, and asking about a plan. What happens is what happened
 * there — the company (or the offer's contact) gets the message with reply-to
 * set to the member, and staff are told at the brand's admin address — with
 * three differences:
 *
 * - The enquiry is kept, with its sender. The old `messages` row had no sender
 *   at all, so the only record of who wrote was in somebody's mailbox.
 * - A plan enquiry records the server's price for the term asked about, not a
 *   number posted by the browser.
 * - Ten in an hour from one member is the limit. The old forms had none, and
 *   each one sent mail to a third party in the brand's name.
 */

import { and, count, eq, gte } from "drizzle-orm";

import { db, type Database } from "@/db";
import { enquiries, mailOutbox, memberships, offers, planPrices, planSites, plans, sites, users } from "@/db/schema";
import { currencyFor } from "@/domain/billing/pricing";
import type { Identity } from "@/lib/auth/session";
import { AccountError } from "@/domain/accounts/register";
import { brandSetting } from "@/domain/dashboard/settings";
import { SYSTEM_PREFIX } from "@/lib/mail/render";

export const HOURLY_LIMIT = 10;

export type EnquiryKind = "company" | "offer" | "plan";

const KINDS: EnquiryKind[] = ["company", "offer", "plan"];

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The details table the staff-alert template's `{content}` expects, every value escaped. */
function detailsTable(rows: [string, unknown][]): string {
  return rows
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(
      ([label, value]) =>
        `<tr><td style="width:30%;padding:8px;border-bottom:1px solid #ddd">${escape(label)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #ddd">${escape(value).replace(/\n/g, "<br />")}</td></tr>`,
    )
    .join("");
}

type Target = { about: string; forwardTo: string | null; toUserId?: number; offerId?: number; planId?: number; detail?: Record<string, unknown> };

async function targetFor(
  database: Database,
  siteId: number,
  kind: EnquiryKind,
  id: number,
  body: Record<string, unknown>,
  /** The member asking, whose country decides which price they are quoted. */
  country: string | null,
): Promise<Target> {
  if (kind === "company") {
    // A company is a member of this brand: the directory is its readers.
    const [company] = await database
      .select({ id: users.id, name: users.name, company: users.company, email: users.email, status: users.status })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.siteId, siteId)))
      .where(eq(users.id, id))
      .limit(1);

    if (!company || company.status !== "active") {
      throw new AccountError("We could not find that company.", 404);
    }

    return { about: company.company || company.name, forwardTo: company.email, toUserId: company.id };
  }

  if (kind === "offer") {
    const [offer] = await database
      .select({ offer: offers, ownerEmail: users.email })
      .from(offers)
      .leftJoin(users, eq(users.id, offers.userId))
      .where(and(eq(offers.id, id), eq(offers.siteId, siteId)))
      .limit(1);

    if (!offer || offer.offer.deletedAt !== null) {
      throw new AccountError("We could not find that offer.", 404);
    }

    return {
      about: offer.offer.subject,
      forwardTo: offer.offer.contactEmail || offer.ownerEmail || null,
      offerId: offer.offer.id,
    };
  }

  const [sold] = await database
    .select({ plan: plans })
    .from(plans)
    .innerJoin(planSites, and(eq(planSites.planId, plans.id), eq(planSites.siteId, siteId)))
    .where(eq(plans.id, id))
    .limit(1);
  const plan = sold?.plan;

  if (!plan) {
    throw new AccountError("We could not find that plan.", 404);
  }

  const years = Math.max(1, Math.trunc(Number(body.years) || 1));
  const members = Math.max(1, Math.trunc(Number(body.members) || 1));
  const terms = await database
    .select({ amount: planPrices.amount, currency: planPrices.currency })
    .from(planPrices)
    .where(and(eq(planPrices.planId, plan.id), eq(planPrices.years, years)));
  // The price as this member would be quoted it.
  const currency = currencyFor(country, terms.map((row) => row.currency));
  const term = terms.find((row) => row.currency === currency);

  return {
    about: plan.name,
    // Plan questions are for the sales team, not anyone else.
    forwardTo: null,
    planId: plan.id,
    detail: { years, members, price: term ? `${term.currency} ${term.amount}` : null },
  };
}

export async function submitEnquiry(
  identity: Identity,
  slug: string,
  body: Record<string, unknown>,
  database: Database = db(),
): Promise<{ id: number }> {
  const [brand] = await database
    .select()
    .from(sites)
    .where(and(eq(sites.slug, slug), eq(sites.enabled, true)))
    .limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 404);
  }

  const kind = String(body.kind ?? "") as EnquiryKind;

  if (!KINDS.includes(kind)) {
    throw new AccountError("Say whether this is for a company, an offer or a plan.", 422, "kind");
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (message === "") {
    throw new AccountError("Write a message first.", 422, "message");
  }

  const [recent] = await database
    .select({ n: count() })
    .from(enquiries)
    .where(and(eq(enquiries.fromUserId, identity.user.id), gte(enquiries.createdAt, new Date(Date.now() - 3_600_000))));

  if (Number(recent?.n ?? 0) >= HOURLY_LIMIT) {
    throw new AccountError("That is a lot of messages in an hour. Please try again later.", 429);
  }

  const target = await targetFor(database, brand.id, kind, Number(body.to), body, identity.user.country);
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim().slice(0, 255) : null;

  const [sender] = await database.select().from(users).where(eq(users.id, identity.user.id)).limit(1);

  const [row] = await database
    .insert(enquiries)
    .values({
      siteId: brand.id,
      kind,
      fromUserId: sender!.id,
      fromName: sender!.name,
      fromEmail: sender!.email,
      fromPhone: sender!.phone,
      fromCompany: sender!.company,
      toUserId: target.toUserId ?? null,
      offerId: target.offerId ?? null,
      planId: target.planId ?? null,
      about: target.about.slice(0, 255),
      subject,
      message: message.slice(0, 5000),
      detail: target.detail ?? null,
    })
    .returning({ id: enquiries.id });

  const table = detailsTable([
    ["Name", sender!.name],
    ["Company", sender!.company],
    ["Email", sender!.email],
    ["Phone", sender!.phone],
    ["City", sender!.city],
    ["Country", sender!.country],
    [kind === "plan" ? "Plan" : kind === "offer" ? "Offer" : "To", target.about],
    ...(target.detail
      ? ([
          ["Years", target.detail.years],
          ["Members", target.detail.members],
          ["Price", target.detail.price],
        ] as [string, unknown][])
      : []),
    ["Subject", subject],
    ["Message", message],
  ]);

  const mails: (typeof mailOutbox.$inferInsert)[] = [];

  if (target.forwardTo) {
    const subjectLine = `${brand.name} - Message from ${sender!.name}`;

    mails.push({
      siteId: brand.id,
      to: target.forwardTo.slice(0, 191),
      subject: subjectLine.slice(0, 255),
      template: `${SYSTEM_PREFIX}staff-alert`,
      payload: {
        subject: subjectLine,
        vars: { heading: `New enquiry from ${sender!.name}`, name: sender!.name, email: sender!.email, site: brand.name },
        html_vars: { content: table },
        // The company answers the member, not the brand.
        reply_to: sender!.email,
        enquiry: row!.id,
      },
    });
  }

  const staff = await brandSetting(brand.id, "site_admin_email", database);

  if (staff) {
    const subjectLine = `${brand.name} - ${kind === "plan" ? "Plan enquiry" : "Message"} from ${sender!.name}${
      target.forwardTo ? ` to ${target.about}` : ""
    }`;

    mails.push({
      siteId: brand.id,
      to: staff.slice(0, 191),
      subject: subjectLine.slice(0, 255),
      template: `${SYSTEM_PREFIX}staff-alert`,
      payload: {
        subject: subjectLine,
        vars: { heading: `New enquiry from ${sender!.name}`, name: sender!.name, email: sender!.email, site: brand.name },
        html_vars: { content: table },
        reply_to: sender!.email,
        enquiry: row!.id,
      },
    });
  }

  if (mails.length > 0) {
    await database.insert(mailOutbox).values(mails);
  }

  return { id: row!.id };
}
