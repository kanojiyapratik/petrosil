/** Fixtures: a brand, its locations, a token, and a clean slate between tests. */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { locations, prices, siteApiTokens, sites } from "@/db/schema";
import { hashToken } from "@/lib/compat/auth";

export async function resetDatabase(): Promise<void> {
  // One statement, so no ordering problem with the foreign keys.
  await db().execute(sql`
    truncate table
      audit_log, price_summaries, price_crawl_activities, price_crawl_urls,
      site_crawl_settings, price_batch_items, price_batches, prices,
      locations, memberships, site_api_tokens, users, sites
    restart identity cascade
  `);
}

export type Brand = {
  siteId: number;
  slug: string;
  token: string;
  locationIds: Record<string, number>;
};

export async function makeBrand(
  slug = "baseoil",
  titles: string[] = ["Singapore SN 150 FOB", "UAE SN 500"],
  currency = "USD",
): Promise<Brand> {
  const [site] = await db()
    .insert(sites)
    .values({ slug, name: slug, defaultCurrency: currency })
    .returning();

  const token = randomBytes(24).toString("hex");

  await db()
    .insert(siteApiTokens)
    .values({ siteId: site!.id, name: "price module", tokenHash: hashToken(token) });

  const locationIds: Record<string, number> = {};

  for (const title of titles) {
    const [row] = await db()
      .insert(locations)
      .values({ siteId: site!.id, title, currency })
      .returning();

    locationIds[title] = row!.id;
  }

  return { siteId: site!.id, slug, token, locationIds };
}

export async function publishPrice(
  brand: Brand,
  title: string,
  price: number,
  priceDate: string,
): Promise<number> {
  const [row] = await db()
    .insert(prices)
    .values({
      siteId: brand.siteId,
      locationId: brand.locationIds[title]!,
      price: String(price),
      currency: "USD",
      priceDate,
    })
    .returning();

  return row!.id;
}

/** A date relative to a fixed "now", as YYYY-MM-DD. */
export function dayOffset(from: Date, days: number): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A request shaped the way the module's SiteClient sends them. */
export function apiRequest(
  url: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { accept: "application/json" };

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return new Request(`http://platform.test${url}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export const routeContext = (params: { site: string; id?: string }) => ({
  params: Promise.resolve(params),
});
