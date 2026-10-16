/**
 * PUT /api/compat/{site}/price-batches/items/{id} — edit one staged row.
 *
 * Note the path: `items` is a static segment that sits beside `{id}`, exactly
 * as the Laravel route table has it (`price-batches/items/{id}`), so the
 * module's SiteClient needs no change.
 */
import { NextResponse } from "next/server";

import { compat, idFrom, jsonBody } from "@/lib/compat/route";
import { updateItem } from "@/domain/price/batches";
import { itemJson } from "@/lib/compat/shapes";
import { db } from "@/db";
import { locations } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export const PUT = compat(async ({ request, caller, params }) => {
  const id = idFrom(params);

  if (id === null) {
    return NextResponse.json({ message: "No such batch item." }, { status: 404 });
  }

  const body = await jsonBody(request);
  const item = await updateItem(caller.site.id, id, body);

  let title: string | null = null;

  if (item.locationId !== null) {
    const [row] = await db()
      .select({ title: locations.title })
      .from(locations)
      .where(eq(locations.id, item.locationId))
      .limit(1);

    title = row?.title ?? null;
  }

  return NextResponse.json({ item: itemJson(item, title) });
});
