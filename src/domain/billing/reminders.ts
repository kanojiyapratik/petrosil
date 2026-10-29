/**
 * Trial and renewal reminders: the old `trial:cron` and `subscription:cron`.
 *
 * The days are the old crons' own lists, kept as they were because staff and
 * subscribers are used to that rhythm. What changed is everything around them:
 *
 * - The old crons read `users.premium`, which the every-minute sweep flipped
 *   back and forth, so who got a reminder depended on the minute it ran. This
 *   reads the membership's own end date, and for someone the sweep has
 *   already made free, `lapsed_from` says what they had.
 * - Each reminder is recorded in `membership_reminders` under a unique index
 *   before it is queued, so a re-run cannot send it twice.
 * - The brand's name and link come from the brand, not from a string pasted
 *   into the cron (`'Base Oil Report'` on every site; `beta.baseoilreport.com`
 *   in the trial mails).
 * - A brand that has switched a template off gets no mail of that kind.
 *
 * "Trial usage exhausted" is not here: it depended on per-purchase quotas,
 * which the platform does not carry.
 */

import { and, asc, between, eq, inArray, isNotNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { mailOutbox, mailTemplates, membershipReminders, memberships, planPrices, planSites, plans, sites, users } from "@/db/schema";
import { currencyFor, preferredCurrency } from "./pricing";
import { linkBaseFor } from "@/lib/mail/deliver";
import { fillPlaceholders, SYSTEM_PREFIX } from "@/lib/mail/render";
import { addDays } from "./sweep";

export const REMINDER_DAYS = {
  trial: [1, 2, 3, 7, 15, 30, 45, 60, 75, 90],
  subscription: [1, 2, 3, 7, 15, 30, 45, 60],
} as const;

const FURTHEST = Math.max(...REMINDER_DAYS.trial, ...REMINDER_DAYS.subscription);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", EUR: "€" };

/** "2026-10-29" → "29 Oct 2026", the way the old mails wrote it. */
function readable(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];

  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Which reminder, if any, a membership is due today. */
export function reminderFor(
  membership: { tier: string; expiresAt: string; lapsedFrom: string | null },
  day: string,
): { kind: string; days: number } | null {
  const until = daysBetween(day, membership.expiresAt);

  if (until > 0) {
    const family = membership.tier === "trial" ? "trial" : membership.tier === "premium" ? "subscription" : null;

    return family && (REMINDER_DAYS[family] as readonly number[]).includes(until)
      ? { kind: `${family}-expiring`, days: until }
      : null;
  }

  if (until < 0) {
    // Not swept yet, the tier still says what it was; swept, `lapsed_from` does.
    const had = membership.tier === "free" ? membership.lapsedFrom : membership.tier;
    const family = had === "trial" ? "trial" : had === "premium" ? "subscription" : null;

    return family && (REMINDER_DAYS[family] as readonly number[]).includes(-until)
      ? { kind: `${family}-expired`, days: -until }
      : null;
  }

  // The last day still belongs to the reader; the old lists had no day 0 either.
  return null;
}

/**
 * The brand's renewal price: the first visible plan with a one-year term in
 * the currency the reader would pay (their country decides) — so a reader in
 * Nepal is quoted the subcontinent plan, not the global one. Any first plan
 * when the brand sells nothing in that currency.
 */
async function renewalPrice(
  database: Database,
  siteId: number,
  country: string | null,
): Promise<{ price: string; symbol: string }> {
  const firstIn = (currency: string | null) =>
    database
      .select({ id: plans.id })
      .from(plans)
      .innerJoin(planSites, and(eq(planSites.planId, plans.id), eq(planSites.siteId, siteId)))
      .innerJoin(
        planPrices,
        and(eq(planPrices.planId, plans.id), eq(planPrices.years, 1), currency ? eq(planPrices.currency, currency) : undefined),
      )
      .where(eq(plans.visible, true))
      .orderBy(asc(plans.sortOrder), asc(plans.id))
      .limit(1);

  const own = await firstIn(preferredCurrency(country));
  const [first] = own.length > 0 ? own : await firstIn(null);

  const terms = first
    ? await database
        .select()
        .from(planPrices)
        .where(and(eq(planPrices.planId, first.id), eq(planPrices.years, 1)))
    : [];
  const currency = currencyFor(country, terms.map((term) => term.currency));
  const found = terms.find((term) => term.currency === currency);

  return found
    ? { price: `${found.currency} ${found.amount}`, symbol: SYMBOLS[found.currency] ?? found.currency }
    : { price: "", symbol: "" };
}

export async function remindExpiries(database: Database = db(), day: string): Promise<{ queued: number }> {
  const candidates = await database
    .select({
      membership: memberships,
      person: { email: users.email, name: users.name, country: users.country },
      site: { name: sites.name, domain: sites.legacyDomain },
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(sites, eq(sites.id, memberships.siteId))
    .where(
      and(
        // Readers only: a staff grant has no term to remind anyone about.
        eq(memberships.role, "subscriber"),
        eq(users.status, "active"),
        isNotNull(memberships.expiresAt),
        between(memberships.expiresAt, addDays(day, -FURTHEST), addDays(day, FURTHEST)),
      ),
    )
    .orderBy(asc(memberships.id));

  const due = candidates.flatMap((row) => {
    const reminder = reminderFor({ ...row.membership, expiresAt: row.membership.expiresAt! }, day);

    return reminder ? [{ ...row, reminder }] : [];
  });

  if (due.length === 0) {
    return { queued: 0 };
  }

  // Which templates each brand has switched on, read once.
  const enabled = await database
    .select({ siteId: mailTemplates.siteId, key: mailTemplates.key, subject: mailTemplates.subject })
    .from(mailTemplates)
    .where(
      and(
        inArray(mailTemplates.siteId, [...new Set(due.map((row) => row.membership.siteId))]),
        eq(mailTemplates.variant, "default"),
        eq(mailTemplates.enabled, true),
      ),
    );

  const subjects = new Map(enabled.map((row) => [`${row.siteId}:${row.key}`, row.subject]));
  const prices = new Map<string, { price: string; symbol: string }>();
  let queued = 0;

  for (const { membership, person, site, reminder } of due) {
    const subject = subjects.get(`${membership.siteId}:${reminder.kind}`);

    if (subject === undefined) {
      continue;
    }

    // Per brand and currency rule: a rupee reader and a dollar reader see different prices.
    const priceKey = `${membership.siteId}|${preferredCurrency(person.country)}`;

    if (!prices.has(priceKey)) {
      prices.set(priceKey, await renewalPrice(database, membership.siteId, person.country));
    }

    const { price, symbol } = prices.get(priceKey)!;
    const vars = {
      name: person.name,
      email: person.email,
      site: site.name,
      link: `${linkBaseFor(site.domain)}/subscription`,
      day: reminder.days,
      expiry_date: readable(membership.expiresAt!),
      price,
      currency_symbol: symbol,
    };

    await database.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(membershipReminders)
        .values({
          membershipId: membership.id,
          kind: reminder.kind,
          expiresAt: membership.expiresAt!,
          days: reminder.days,
        })
        .onConflictDoNothing()
        .returning({ id: membershipReminders.id });

      if (!claimed) {
        return;
      }

      await tx.insert(mailOutbox).values({
        siteId: membership.siteId,
        userId: membership.userId,
        to: person.email.slice(0, 191),
        // For the record only; the subject is filled again from the template
        // at send time, so an edit reaches mail still in the queue.
        subject: fillPlaceholders(subject, vars, false).slice(0, 255),
        template: `${SYSTEM_PREFIX}${reminder.kind}`,
        payload: { vars },
      });

      queued++;
    });
  }

  return { queued };
}
