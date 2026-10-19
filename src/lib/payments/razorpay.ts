/**
 * Razorpay, as far as it can honestly go without the estate's live keys.
 *
 * What is real here is the part that matters for security: the signature
 * check. Razorpay's browser checkout hands the page back
 * `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature`, where
 * the signature is HMAC-SHA256 of `order_id|payment_id` keyed with the account
 * secret. Verifying it is the only thing standing between "the browser says
 * it paid" and "it paid", and it is implemented and tested here.
 *
 * What is NOT real yet is creating the order at Razorpay. That needs the live
 * key pair, which lives in the old sites' settings table and is not ours to
 * use. `createProviderOrder` mints a local reference of the same shape, so
 * the whole flow — order, checkout payload, signature, grant — works end to
 * end offline. When the keys arrive, one function body changes: POST to
 * https://api.razorpay.com/v1/orders and return the id it answers with.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Keys = { id: string; secret: string } | null;

export function razorpayKeys(): Keys {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;

  return id && secret ? { id, secret } : null;
}

/** Razorpay's documented scheme, which is also how their SDK verifies. */
export function signatureFor(orderId: string, paymentId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

export function verifySignature(
  orderId: string,
  paymentId: unknown,
  signature: unknown,
  secret: string,
): boolean {
  if (typeof paymentId !== "string" || typeof signature !== "string") {
    return false;
  }

  if (paymentId.length === 0 || signature.length === 0) {
    return false;
  }

  const expected = Buffer.from(signatureFor(orderId, paymentId, secret), "utf8");
  const given = Buffer.from(signature, "utf8");

  // Constant time, and length-checked first because timingSafeEqual throws on
  // a mismatch rather than returning false.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The provider's reference for an order.
 *
 * Local for now, and deliberately shaped like theirs (`order_` + 14 chars) so
 * nothing downstream has to change when the real call replaces this one.
 */
export async function createProviderOrder(_input: {
  amount: number;
  currency: string;
  receipt: string;
}): Promise<string> {
  return `order_${randomBytes(7).toString("hex")}`;
}
