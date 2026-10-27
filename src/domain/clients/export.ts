/**
 * The people lists the team downloads, one brand at a time: all, free,
 * premium, expired premium and trial, as the old admin's five Excel exports
 * were, plus lapsed trials, which the old admin could only show on screen.
 *
 * The old exports read `users.premium`, a flag a cron job flipped, so
 * "expired" meant whatever the job had last got round to. Here each reader's
 * standing is worked out from their membership on that brand and today's
 * date, with the same `segmentOf` the Directory screen uses.
 *
 * Staff and closed accounts are left out, as they were. The download is
 * written to the audit log: it is the customer list leaving the building.
 */

import { and, asc, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, sites, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { segmentOf } from "@/domain/dashboard/clients";
import { requirePermission } from "@/domain/staff/permissions";
import { today } from "@/domain/price/dates";

export const EXPORT_SEGMENTS = [
  { key: "all", label: "Everyone", file: "all" },
  { key: "free", label: "Free", file: "free" },
  { key: "premium", label: "Premium", file: "premium" },
  { key: "expired", label: "Expired premium", file: "expired-premium" },
  { key: "trial", label: "On trial", file: "trial" },
  { key: "trial_expired", label: "Expired trial", file: "expired-trial" },
] as const;

const MEMBERSHIP: Record<string, string> = {
  premium: "Premium",
  trial: "Trial",
  expired: "Expired premium",
  trial_expired: "Expired trial",
  free: "Free",
};

const HEADINGS = [
  "Membership",
  "Name",
  "Email",
  "Phone",
  "Company",
  "Designation",
  "Address",
  "City",
  "Country",
  "Postcode",
  "Website",
  "Expires",
  "Joined",
];

/**
 * One CSV cell. Quoted when it has to be, and a leading = + - @ (or a tab or
 * carriage return) is defused with an apostrophe: members type their own
 * company names, and a spreadsheet runs a cell that starts with = as a formula.
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? "";

  // A phone number ("+91 98200 12345") is digits and punctuation: nothing to run.
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-][\d\s().-]*$/.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type PeopleCsv = { filename: string; body: string; rows: number };

export async function peopleCsv(
  guard: Guarded,
  query: { site: string; segment: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<PeopleCsv> {
  const segment = EXPORT_SEGMENTS.find((row) => row.key === query.segment);

  if (!segment) {
    throw new AccountError("Choose one of the lists.", 422, "segment");
  }

  const [brand] = await database.select().from(sites).where(eq(sites.slug, query.site)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "user-list", database);

  const day = today(now);

  const found = await database
    .select({ person: users, tier: memberships.tier, expiresAt: memberships.expiresAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(eq(memberships.siteId, brand.id), eq(memberships.role, "subscriber"), eq(users.status, "active")),
    )
    .orderBy(asc(users.name), asc(users.id));

  const lines = [HEADINGS.join(",")];
  let rows = 0;

  for (const { person, tier, expiresAt } of found) {
    const standing = segmentOf([{ role: "subscriber", tier, expiresAt }], day);

    if (segment.key !== "all" && standing !== segment.key) {
      continue;
    }

    rows += 1;
    lines.push(
      [
        MEMBERSHIP[standing] ?? standing,
        person.name,
        person.email,
        person.phone,
        person.company,
        person.designation,
        person.address,
        person.city,
        person.country,
        person.postcode,
        person.website,
        expiresAt,
        person.createdAt.toISOString().slice(0, 10),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "people.export",
    entity: "site",
    entityId: brand.id,
    detail: { segment: segment.key, rows },
    ip: context.ip ?? null,
  });

  return {
    filename: `${brand.slug}-${segment.file}-${day}.csv`,
    // The byte-order mark is what makes Excel read the file as UTF-8.
    body: `﻿${lines.join("\r\n")}\r\n`,
    rows,
  };
}
