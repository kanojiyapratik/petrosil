/**
 * Points the AI engine (engine/, Python) at this app.
 *
 * The engine reaches a brand the way it always has: a base URL and a bearer
 * token per site, kept in its own `engine.console_sites` table. This gives
 * each live brand a fresh token named "engine" (any earlier engine token for
 * that brand is revoked), and writes the token and this app's compat address
 * straight into the engine's table — so the token is never printed, pasted or
 * stored anywhere but the two places that need it, hashed on this side.
 *
 *   npm run engine:link                       # local: the engine runs in Docker
 *   ENGINE_SITE_API_BASE=http://app:3000/api/compat npm run engine:link
 *
 * Everything else the engine holds for a brand — its model, its instructions,
 * its rules and rounding — is left exactly as it was. Safe to re-run.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { siteApiTokens, sites } from "@/db/schema";
import { hashToken } from "@/lib/compat/auth";

const TOKEN_NAME = "engine";

/** Where the engine finds the app: from inside its container, the host's dev server. */
const base = (process.env.ENGINE_SITE_API_BASE ?? "http://host.docker.internal:3100/api/compat").replace(/\/+$/, "");

async function main() {
  const database = db();

  const [schema] = await database.execute<{ found: boolean }>(
    sql`select exists (select 1 from information_schema.tables where table_schema = 'engine' and table_name = 'console_sites') as found`,
  );

  if (!schema?.found) {
    throw new Error("The engine's tables are not here yet. Start the engine once (it creates them), then run this again.");
  }

  const brands = await database.select().from(sites).where(eq(sites.enabled, true)).orderBy(sites.slug);
  const linked: string[] = [];

  for (const brand of brands) {
    const token = randomBytes(24).toString("hex");
    const url = `${base}/${brand.slug}`;

    await database.transaction(async (tx) => {
      await tx
        .update(siteApiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(siteApiTokens.siteId, brand.id), eq(siteApiTokens.name, TOKEN_NAME), isNull(siteApiTokens.revokedAt)));

      await tx.insert(siteApiTokens).values({ siteId: brand.id, name: TOKEN_NAME, tokenHash: hashToken(token) });

      // Upsert by slug: a brand the engine has never seen is added with its
      // defaults; one it knows keeps every setting but where it calls.
      await tx.execute(sql`
        insert into engine.console_sites (slug, name, api_url, api_token)
        values (${brand.slug}, ${brand.name}, ${url}, ${token})
        on conflict (slug) do update
          set api_url = excluded.api_url, api_token = excluded.api_token, updated_at = now()
      `);
    });

    linked.push(`  ${brand.slug.padEnd(24)} ${url}`);
  }

  console.log(`Linked ${linked.length} brand(s) to the engine:\n${linked.join("\n")}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
