/* Creates the trade feeds whose sources were checked against the sheets.

   Each one below reproduced the figures the team had typed in, partner by
   partner, for the latest month its sheet held (checked 2026-11-13; ±1
   where the source has since revised). A feed that already exists for a
   sheet is left alone, so this is safe to run again.

   Left out on purpose:
   - India: DGCI&S's figures do not match any brand's India sheets (base oil,
     bitumen and titanium dioxide all differ by 5-60%), so those sheets come
     from another source — the vendor's customs data — and stay manual.
   - South Korea: needs KOREA_CUSTOMS_API_KEY; added switched off.

     npm run trade:feeds            (local)
     DATABASE_URL=... npm run trade:feeds
*/
import { and, eq, isNull } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { sites, tradeFeeds, tradeLocations, type TradeSource } from "@/db/schema";

type Seed = { site: string; reporter: string; kind: "import" | "export"; source: TradeSource; codes: string[]; product: string; enabled?: boolean };

const both = (site: string, reporter: string, source: TradeSource, codes: string[], product: string): Seed[] => [
  { site, reporter, kind: "import", source, codes, product },
  { site, reporter, kind: "export", source, codes, product },
];

const FEEDS: Seed[] = [
  ...both("baseoil", "Thailand", "thailand", ["27101941000"], "Lubricating base oil"),
  ...both("baseoil", "Singapore", "singapore", ["27101941"], "Lubricating base oil"),
  { site: "baseoil", reporter: "South Korea", kind: "export", source: "korea", codes: ["2710195020"], product: "Lubricating base oil", enabled: false },
  ...both("bitumart", "Japan", "japan", ["271320"], "Bitumen"),
  ...both("bitumart", "Thailand", "thailand", ["27132000000"], "Bitumen"),
  ...both("bitumart", "Singapore", "singapore", ["27132000"], "Bitumen"),
  ...both("titaniumdioxidereport", "Japan", "japan", ["320611"], "Titanium dioxide pigments"),
  ...both("titaniumdioxidereport", "Singapore", "singapore", ["3206111"], "Titanium dioxide pigments"),
  { site: "titaniumdioxidereport", reporter: "Thailand", kind: "import", source: "thailand", codes: ["32061110000"], product: "Titanium dioxide pigments" },
  ...both("waxreport", "Japan", "japan", ["271220"], "Paraffin wax"),
  ...both("waxreport", "Thailand", "thailand", ["27122000000"], "Paraffin wax"),
];

async function main(): Promise<void> {
  let made = 0;

  for (const seed of FEEDS) {
    const [brand] = await db().select().from(sites).where(eq(sites.slug, seed.site)).limit(1);

    if (!brand) {
      console.log(`- ${seed.site}: no such brand here, skipped`);
      continue;
    }

    const [place] = await db()
      .select()
      .from(tradeLocations)
      .where(and(eq(tradeLocations.siteId, brand.id), eq(tradeLocations.title, seed.reporter), isNull(tradeLocations.deletedAt)))
      .limit(1);

    if (!place) {
      console.log(`- ${seed.site}: no country called ${seed.reporter}, skipped`);
      continue;
    }

    const inserted = await db()
      .insert(tradeFeeds)
      .values({
        siteId: brand.id,
        locationId: place.id,
        kind: seed.kind,
        source: seed.source,
        hsCodes: seed.codes,
        product: seed.product,
        enabled: seed.enabled ?? true,
      })
      .onConflictDoNothing()
      .returning({ id: tradeFeeds.id });

    made += inserted.length;
    console.log(`${inserted.length ? "+" : "="} ${seed.site}: ${seed.reporter} ${seed.kind}s from ${seed.source} (${seed.codes.join(", ")})`);
  }

  console.log(`${made} feed(s) created.`);
  await closeDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
