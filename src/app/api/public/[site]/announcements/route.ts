/**
 * GET /api/public/{site}/announcements — the strip, if anything is running.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { liveAnnouncements } from "@/domain/content/pages";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand }) =>
  NextResponse.json({ announcements: await liveAnnouncements(brand.id) }),
);
