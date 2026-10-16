/**
 * POST /api/compat/{site}/price-crawl/activity/clear
 *
 * POST, not DELETE: the Laravel sites' .htaccess answers 403 to a DELETE on
 * /api/*, so the module only ever learned to POST here. Keeping the verb
 * means the module needs no change.
 */
import { NextResponse } from "next/server";

import { compat } from "@/lib/compat/route";
import { clearActivity } from "@/domain/crawl/activity";

export const dynamic = "force-dynamic";

export const POST = compat(async ({ caller }) => NextResponse.json(await clearActivity(caller.site.id)));
