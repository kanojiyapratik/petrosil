/**
 * PATCH  /api/dashboard/articles/{id} — edit, or publish.
 * DELETE /api/dashboard/articles/{id} — withdraw it. The row stays.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { callerIp } from "@/lib/compat/auth";
import { updateArticle, withdrawArticle } from "@/domain/content/articles";

export const dynamic = "force-dynamic";

const missing = () => NextResponse.json({ message: "No such article." }, { status: 404 });

export const PATCH = dashboard(async ({ request, guard, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return missing();
  }

  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const article = await updateArticle(guard, id, body, { ip: callerIp(request) });

  return article ? NextResponse.json({ article }) : missing();
});

export const DELETE = dashboard(async ({ request, guard, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return missing();
  }

  const done = await withdrawArticle(guard, id, { ip: callerIp(request) });

  return done
    ? NextResponse.json({ message: "Withdrawn. The piece is no longer published." })
    : missing();
});
