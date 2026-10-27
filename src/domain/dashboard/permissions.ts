/**
 * What a role can be allowed to do.
 *
 * The 93 permission names are the old sites' own, taken from
 * `baseoilreport.permissions` — `article-create`, `price-batch-commit`,
 * `trade-analysis-view` and the rest — so a role someone set up in 2019
 * means the same thing here.
 *
 * They are a code constant and not a table, which is the one real change. A
 * permission is something the code either checks or does not; a row in a
 * table granting `product-delete` when nothing anywhere reads it is not a
 * permission, it is a reassuring piece of furniture. The old estate had 93
 * rows per site and 347 role-permission links, and the three product
 * permissions pointed at a feature that had been removed.
 *
 * `roles` and `role_permissions` are tables because who holds what is data.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { memberships, rolePermissions, roles, sites } from "@/db/schema";

export type PermissionGroup = {
  group: string;
  items: { key: string; label: string }[];
};

const crud = (prefix: string, noun: string) => [
  { key: `${prefix}-list`, label: `See ${noun}` },
  { key: `${prefix}-create`, label: `Add ${noun}` },
  { key: `${prefix}-edit`, label: `Change ${noun}` },
  { key: `${prefix}-delete`, label: `Remove ${noun}` },
];

export const PERMISSIONS: PermissionGroup[] = [
  {
    group: "Prices",
    items: [
      ...crud("location", "locations"),
      ...crud("currency", "currencies"),
      { key: "price-batch-view", label: "See price updates" },
      { key: "price-batch-create", label: "Stage a price update" },
      { key: "price-batch-commit", label: "Commit a price update" },
      { key: "price-batch-rollback", label: "Roll a price update back" },
      { key: "trade-analysis-view", label: "See trade analysis" },
    ],
  },
  {
    group: "Content",
    items: [
      ...crud("article", "articles"),
      ...crud("page", "pages"),
      ...crud("announcement", "announcements"),
      ...crud("report", "reports"),
      ...crud("offer", "offers"),
      ...crud("impex", "impex sheets"),
      ...crud("category", "categories"),
    ],
  },
  {
    group: "Clients",
    items: [...crud("directory", "the directory"), ...crud("user", "people")],
  },
  {
    group: "Subscription",
    items: [...crud("subscription", "plans"), ...crud("coupon", "coupons")],
  },
  {
    group: "Ads",
    items: [...crud("adlocation", "ad placements"), ...crud("ad", "ads")],
  },
  {
    group: "Newsletter",
    items: [...crud("template", "templates"), ...crud("newsletter", "newsletters"), ...crud("mail", "mail")],
  },
  {
    group: "Administration",
    items: [...crud("role", "roles"), ...crud("setting", "settings")],
  },
  {
    // Not on the old sites, because the old sites never checked them: the
    // enquiries had no screen, report sending and uploads had no gate at all.
    group: "Added on the platform",
    items: [
      { key: "enquiry-list", label: "Read enquiries" },
      { key: "enquiry-edit", label: "Mark enquiries handled" },
      { key: "report-send", label: "Send a report or a sample" },
      { key: "file-upload", label: "Upload files" },
      { key: "trade-qty-edit", label: "Enter import and export quantities" },
      { key: "price-note-edit", label: "Correct the published price note" },
    ],
  },
];

/** Every permission key, flat. */
export const PERMISSION_KEYS = PERMISSIONS.flatMap((group) => group.items.map((item) => item.key));

export function labelFor(key: string): string {
  for (const group of PERMISSIONS) {
    for (const item of group.items) {
      if (item.key === key) {
        return item.label;
      }
    }
  }

  return key;
}

export type RoleRow = {
  id: number;
  site: string | null;
  name: string;
  description: string | null;
  permissions: string[];
  /** How many staff memberships point at it. */
  holders: number;
  /** Permissions saved against it that nothing in this codebase checks. */
  unknown: string[];
};

export async function listRoles(
  siteIds: number[],
  database: Database = db(),
): Promise<RoleRow[]> {
  const rows = await database
    .select({
      role: roles,
      slug: sites.slug,
      holders: sql<number>`(select count(*) from ${memberships} where ${memberships.roleId} = ${roles.id})`,
    })
    .from(roles)
    .leftJoin(sites, eq(sites.id, roles.siteId))
    .orderBy(asc(roles.name));

  // A role with no brand is available everywhere, so staff see it; one
  // belonging to a brand they cannot see is not theirs to read.
  const visible = rows.filter(
    ({ role }) => role.siteId === null || siteIds.length === 0 || siteIds.includes(role.siteId),
  );

  if (visible.length === 0) {
    return [];
  }

  const granted = await database
    .select()
    .from(rolePermissions)
    .where(
      inArray(
        rolePermissions.roleId,
        visible.map(({ role }) => role.id),
      ),
    )
    .orderBy(asc(rolePermissions.permission));

  const byRole = new Map<number, string[]>();

  for (const grant of granted) {
    const list = byRole.get(grant.roleId) ?? [];
    list.push(grant.permission);
    byRole.set(grant.roleId, list);
  }

  const known = new Set(PERMISSION_KEYS);

  return visible.map(({ role, slug, holders }) => {
    const permissions = byRole.get(role.id) ?? [];

    return {
      id: role.id,
      site: slug,
      name: role.name,
      description: role.description,
      permissions,
      holders: Number(holders),
      unknown: permissions.filter((permission) => !known.has(permission)),
    };
  });
}
