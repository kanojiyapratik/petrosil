/**
 * Seeds a usable development database: the nine brands, a superadmin, and one
 * API token per brand for the price module to call with.
 *
 * Safe to re-run: brands are upserted by slug and a token is only minted for a
 * brand that has none. Tokens are printed ONCE, here, because only their hash
 * is stored — there is no way to read one back later, which is the point.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { memberships, siteApiTokens, sites, users } from "@/db/schema";
import { hashToken } from "@/lib/compat/auth";

/** Slug, name, former domain, default currency, publishing cadence. */
const BRANDS: [string, string, string, string, string][] = [
  ["baseoil", "Base Oil Report", "baseoilreport.com", "USD", "Weekly · Friday"],
  ["bitumart", "Bitumart", "bitumart.com", "USD", "1st & 16th"],
  ["waxreport", "Wax Report", "waxreport.com", "USD", "Weekly · Monday"],
  ["titaniumdioxidereport", "Titanium Dioxide Report", "titaniumdioxidereport.com", "USD", "Fortnightly"],
  ["petrosilicon", "PetroSilicon", "petrosilicon.com", "USD", "Fortnightly"],
  ["chemicalexplorer", "Chemical Explorer", "chemicalexplorer.com", "USD", "Weekly · Wednesday"],
  ["fertilizerreport", "Fertilizer Report", "fertilizerreport.com", "USD", "Not started"],
  ["glycerinereport", "Glycerine Report", "glycerinereport.com", "USD", "Not started"],
  ["methanolreport", "Methanol Report", "methanolreport.com", "USD", "Not started"],
];

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "rakesh@tikitech.in";

async function main(): Promise<void> {
  const database = db();
  const minted: [string, string][] = [];

  for (const [slug, name, legacyDomain, currency, cadence] of BRANDS) {
    const [site] = await database
      .insert(sites)
      .values({ slug, name, legacyDomain, defaultCurrency: currency, priceCadence: cadence })
      .onConflictDoUpdate({
        target: sites.slug,
        set: { name, legacyDomain, priceCadence: cadence, updatedAt: new Date() },
      })
      .returning();

    const [existing] = await database
      .select()
      .from(siteApiTokens)
      .where(and(eq(siteApiTokens.siteId, site!.id), isNull(siteApiTokens.revokedAt)))
      .limit(1);

    if (!existing) {
      const token = randomBytes(24).toString("hex");

      await database
        .insert(siteApiTokens)
        .values({ siteId: site!.id, name: "price module", tokenHash: hashToken(token) });

      minted.push([slug, token]);
    }
  }

  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString("base64url");
  const [admin] = await database
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      name: "Rakesh",
      passwordHash: await bcrypt.hash(password, 10),
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (admin) {
    const all = await database.select({ id: sites.id }).from(sites);

    await database
      .insert(memberships)
      .values(all.map((site) => ({ userId: admin.id, siteId: site.id, role: "superadmin" })))
      .onConflictDoNothing();

    console.log(`superadmin ${ADMIN_EMAIL} created with password: ${password}`);
  } else {
    console.log(`superadmin ${ADMIN_EMAIL} already exists — left as it is`);
  }

  if (minted.length > 0) {
    console.log("\nAPI tokens (shown once — only the hash is stored):");
    for (const [slug, token] of minted) {
      console.log(`  ${slug.padEnd(24)} ${token}`);
    }
  } else {
    console.log("every brand already has a token");
  }

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
