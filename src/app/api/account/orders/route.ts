/**
 * GET  /api/account/orders — my invoices.
 * POST /api/account/orders — place one, priced by the server.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { ordersFor, placeOrder } from "@/domain/billing/orders";

export const dynamic = "force-dynamic";

export const GET = account(async ({ identity }) =>
  NextResponse.json({ orders: await ordersFor(identity.user.id) }),
);

export const POST = account(async ({ request, identity }) =>
  NextResponse.json(await placeOrder(identity, await jsonBody(request)), { status: 201 }),
);
