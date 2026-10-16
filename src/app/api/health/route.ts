/** Liveness for Railway's healthcheck: the process is up and the database answers. */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await db().execute(sql`select 1`);

    return NextResponse.json({ status: "ok", database: "up" });
  } catch (error) {
    console.error("health check failed", error);

    return NextResponse.json({ status: "degraded", database: "down" }, { status: 503 });
  }
}
