/** GET /api/compat/{site}/price-batches/{id} — the batch with every staged row. */
import { NextResponse } from "next/server";

import { compat, idFrom } from "@/lib/compat/route";
import { batchItems, batchOnSite } from "@/domain/price/batches";
import { pricesBefore } from "@/domain/price/locations";
import { envelopeJson, itemJson } from "@/lib/compat/shapes";
import { db } from "@/db";
import { locations } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export const GET = compat(async ({ caller, params }) => {
  const id = idFrom(params);

  if (id === null) {
    return NextResponse.json({ message: "No such batch." }, { status: 404 });
  }

  const batch = await batchOnSite(caller.site.id, id);

  if (!batch) {
    return NextResponse.json({ message: "No such batch." }, { status: 404 });
  }

  const items = await batchItems(batch.id);
  const titles = await titlesFor(caller.site.id);
  const earlier = await pricesBefore(
    items
      .filter((item) => item.oldPrice === null && item.locationId !== null)
      .map((item) => ({ locationId: item.locationId!, priceDate: item.priceDate })),
  );

  return NextResponse.json({
    ...envelopeJson(batch, items),
    items: items.map((item) =>
      itemJson(
        item,
        item.locationId ? titles.get(item.locationId) ?? null : null,
        item.oldPrice === null && item.locationId !== null ? earlier.get(`${item.locationId}:${item.priceDate}`) ?? null : undefined,
      ),
    ),
  });
});

async function titlesFor(siteId: number): Promise<Map<number, string>> {
  const rows = await db()
    .select({ id: locations.id, title: locations.title })
    .from(locations)
    .where(eq(locations.siteId, siteId));

  return new Map(rows.map((row) => [row.id, row.title]));
}

