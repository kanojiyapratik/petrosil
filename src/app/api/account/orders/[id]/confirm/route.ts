/**
 * POST /api/account/orders/{id}/confirm — settle an order.
 *
 * Takes what Razorpay's checkout hands back. The signature is verified before
 * anything is granted, and confirming an order that is already paid answers
 * success without buying a second term.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { callerIp } from "@/lib/compat/auth";
import { settleOrder } from "@/domain/billing/orders";

export const dynamic = "force-dynamic";

export const POST = account(async ({ request, identity, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ message: "No such order." }, { status: 404 });
  }

  const order = await settleOrder(identity, id, await jsonBody(request), {
    ip: callerIp(request),
  });

  return NextResponse.json({ order });
});
