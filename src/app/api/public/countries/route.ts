/**
 * GET /api/public/countries — the list the sign-up and profile forms offer,
 * with each country's two-letter code and dialling code (the old sites'
 * country and phone-code selects). Brandless, like /sites.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { COUNTRIES } from "@/domain/geo/countries";

export const dynamic = "force-static";

export const GET = publicApi(async () => NextResponse.json({ countries: COUNTRIES }), { brandless: true });
