/**
 * GET  /api/dashboard/articles — everything this viewer may see, drafts included.
 * POST /api/dashboard/articles — write a new piece. It starts as a draft.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { callerIp } from "@/lib/compat/auth";
import { createArticle, staffArticles } from "@/domain/content/articles";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);

  return NextResponse.json({
    articles: await staffArticles(guard.siteIds, {
      site: url.searchParams.get("site") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      search: (url.searchParams.get("q") ?? "").trim() || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    }),
  });
});

export const POST = dashboard(async ({ request, guard }) => {
  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const article = await createArticle(guard, body, { ip: callerIp(request) });

  return NextResponse.json({ article }, { status: 201 });
});
