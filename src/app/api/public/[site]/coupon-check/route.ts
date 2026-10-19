/**
 * POST /api/public/{site}/coupon-check — what would this code make it cost?
 *
 * Answers 200 with `valid: false` rather than an error status, and never says
 * why a code was refused. "Expired" and "used up" and "wrong brand" are all
 * facts about the coupon table.
 */
import { NextResponse } from "next/server";

import { jsonBody } from "@/lib/auth/account";
import { publicApi } from "@/lib/public/route";
import { quote } from "@/domain/billing/orders";
import { AccountError } from "@/domain/accounts/register";

export const dynamic = "force-dynamic";

export const POST = publicApi(async ({ request, brand }) => {
  const body = await jsonBody(request);

  try {
    const { priced } = await quote(brand.id, body.plan, body.years, body.code);

    return NextResponse.json({ valid: true, ...priced });
  } catch (error) {
    if (error instanceof AccountError) {
      // A bad plan or term is the caller's mistake and worth saying; a bad
      // code is just "no".
      if (error.field === "code") {
        return NextResponse.json({ valid: false, message: error.message });
      }

      return NextResponse.json({ valid: false, message: error.message }, { status: error.status });
    }

    throw error;
  }
});
