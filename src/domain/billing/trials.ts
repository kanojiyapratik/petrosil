/**
 * Free trials: asked for by a reader, granted by staff.
 *
 * The old sites had a `freetrial` form and an admin who granted it by editing
 * the user row, so there was no record of who had asked, who had said yes, or
 * how many trials one company had had. The request and the decision are both
 * rows here.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, sites, trialRequests, users } from "@/db/schema";
import type { Identity } from "@/lib/auth/session";
import type { Guarded } from "@/lib/auth/guard";
import { requirePermission } from "@/domain/staff/permissions";
import { entitlementFor } from "@/domain/public/paywall";
import { today } from "@/domain/price/dates";
import { addDays } from "./sweep";
import { AccountError } from "@/domain/accounts/register";

export const DEFAULT_TRIAL_DAYS = 14;

export async function requestTrial(
  identity: Identity,
  body: Record<string, unknown>,
  database: Database = db(),
): Promise<{ id: number; status: string }> {
  const [brand] = await database
    .select()
    .from(sites)
    .where(and(eq(sites.slug, String(body.site ?? "")), eq(sites.enabled, true)))
    .limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  // Someone who can already read the figures has nothing to gain from a
  // trial, and granting one would shorten a paid term to the trial's end.
  const entitlement = entitlementFor(
    {
      userId: identity.user.id,
      memberships: identity.memberships.map((m) => ({
        siteId: m.siteId,
        role: m.role,
        tier: m.tier,
        expiresAt: m.expiresAt,
      })),
    },
    brand.id,
    today(),
  );

  if (entitlement.entitled) {
    throw new AccountError("You already have access to this brand.", 409);
  }

  const [pending] = await database
    .select()
    .from(trialRequests)
    .where(
      and(
        eq(trialRequests.userId, identity.user.id),
        eq(trialRequests.siteId, brand.id),
        eq(trialRequests.status, "pending"),
      ),
    )
    .limit(1);

  if (pending) {
    throw new AccountError("Your request is with our team already.", 409);
  }

  const [row] = await database
    .insert(trialRequests)
    .values({
      siteId: brand.id,
      userId: identity.user.id,
      note: typeof body.note === "string" ? body.note.slice(0, 2000) : null,
      days: DEFAULT_TRIAL_DAYS,
    })
    .returning();

  return { id: row!.id, status: row!.status };
}

export type TrialRow = {
  id: number;
  site: string;
  status: string;
  days: number;
  note: string | null;
  name: string;
  email: string;
  company: string | null;
  created_at: string;
  decided_at: string | null;
};

export async function listTrials(
  siteIds: number[],
  status: string | undefined,
  database: Database = db(),
): Promise<TrialRow[]> {
  const rows = await database
    .select({ request: trialRequests, slug: sites.slug, user: users })
    .from(trialRequests)
    .innerJoin(sites, eq(sites.id, trialRequests.siteId))
    .innerJoin(users, eq(users.id, trialRequests.userId))
    .where(
      and(
        // Empty means superadmin: the whole estate.
        siteIds.length > 0 ? inArray(trialRequests.siteId, siteIds) : undefined,
        status ? eq(trialRequests.status, status) : undefined,
      ),
    )
    .orderBy(desc(trialRequests.createdAt), desc(trialRequests.id));

  return rows.map(({ request, slug, user }) => ({
    id: request.id,
    site: slug,
    status: request.status,
    days: request.days,
    note: request.note,
    name: user.name,
    email: user.email,
    company: user.company,
    created_at: request.createdAt.toISOString(),
    decided_at: request.decidedAt?.toISOString() ?? null,
  }));
}

/**
 * Approve or decline. Returns null when this viewer may not see the request,
 * which the route answers as 404 — the same reply as a request that is not
 * there, so an id cannot be used to probe another brand's queue.
 */
export async function decideTrial(
  guard: Guarded,
  requestId: number,
  decision: "approve" | "decline",
  options: { days?: number; ip?: string | null } = {},
  database: Database = db(),
): Promise<{ status: string; expires_at: string | null } | null> {
  const [request] = await database
    .select()
    .from(trialRequests)
    .where(eq(trialRequests.id, requestId))
    .limit(1);

  if (!request || (!guard.isSuperadmin && !guard.siteIds.includes(request.siteId))) {
    return null;
  }

  // Granting a trial grants paid access, so it is the plans permission.
  await requirePermission(guard, request.siteId, "subscription-edit", database);

  if (request.status !== "pending") {
    throw new AccountError("That request has already been decided.", 409);
  }

  const days = Number.isInteger(options.days) && options.days! > 0 ? options.days! : request.days;

  return database.transaction(async (tx) => {
    // Claimed in the WHERE clause, so two editors clicking at once cannot
    // both grant a trial.
    const [claimed] = await tx
      .update(trialRequests)
      .set({
        status: decision === "approve" ? "approved" : "declined",
        days,
        decidedBy: guard.identity.user.id,
        decidedAt: new Date(),
      })
      .where(and(eq(trialRequests.id, requestId), eq(trialRequests.status, "pending")))
      .returning();

    if (!claimed) {
      throw new AccountError("That request has already been decided.", 409);
    }

    let expiresAt: string | null = null;

    if (decision === "approve") {
      expiresAt = addDays(today(), days);

      const [existing] = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.userId, request.userId), eq(memberships.siteId, request.siteId)),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(memberships)
          .set({ tier: "trial", expiresAt, lapsedFrom: null, updatedAt: new Date() })
          .where(eq(memberships.id, existing.id));
      } else {
        await tx.insert(memberships).values({
          userId: request.userId,
          siteId: request.siteId,
          role: "subscriber",
          tier: "trial",
          expiresAt,
        });
      }
    }

    await tx.insert(auditLog).values({
      siteId: request.siteId,
      userId: guard.identity.user.id,
      action: decision === "approve" ? "trial.approve" : "trial.decline",
      entity: "trial_request",
      entityId: requestId,
      detail: { subject: request.userId, days, until: expiresAt },
      ip: options.ip ?? null,
    });

    return { status: claimed.status, expires_at: expiresAt };
  });
}

export { sql };
