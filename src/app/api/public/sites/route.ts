/**
 * GET /api/public/sites — the nine brands, for the umbrella home page.
 *
 * `brandless`: this is the one public endpoint with no brand in its path, so
 * the wrapper skips the slug lookup. Nothing price-shaped goes out here.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { brandCards } from "@/domain/public/estate";

export const dynamic = "force-dynamic";

export const GET = publicApi(
  async () => NextResponse.json({ sites: await brandCards() }),
  { brandless: true },
);
