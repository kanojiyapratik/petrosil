/**
 * What an order comes to.
 *
 * Money is counted in whole minor units — paise, cents — and carried as
 * decimal strings at the edges. Not floats: 0.1 + 0.2 is a bad thing to find
 * on an invoice, and the old sites' float columns are why two subscriptions
 * in the dumps are recorded at 599.99.
 */

import type { coupons } from "@/db/schema";

export type Coupon = typeof coupons.$inferSelect;

export type Priced = { list_amount: string; discount: string; amount: string };

const toMinor = (value: string | number): number => Math.round(Number(value) * 100);

const toDecimal = (minor: number): string => (minor / 100).toFixed(2);

/**
 * Null when the code may not be used — expired, switched off, used up, meant
 * for another brand, or quoted in a currency this order is not in. The caller
 * answers "that code is no good" without saying which: a message naming the
 * reason turns the checkout into a way of exploring the coupon table.
 */
export function applyCoupon(
  listAmount: string,
  coupon: Coupon,
  siteId: number,
  currency: string,
  today: string,
): Priced | null {
  if (!coupon.enabled) {
    return null;
  }

  // A null site means every brand; anything else has to match the order's.
  if (coupon.siteId !== null && coupon.siteId !== siteId) {
    return null;
  }

  if (coupon.startsAt !== null && coupon.startsAt > today) {
    return null;
  }

  // The last day belongs to the code, as it does to a subscription.
  if (coupon.expiresAt !== null && coupon.expiresAt < today) {
    return null;
  }

  if (coupon.maxRedemptions !== null && coupon.redeemed >= coupon.maxRedemptions) {
    return null;
  }

  const list = toMinor(listAmount);
  let discount: number;

  if (coupon.percentOff !== null) {
    if (coupon.percentOff < 1 || coupon.percentOff > 100) {
      return null;
    }

    discount = Math.round((list * coupon.percentOff) / 100);
  } else if (coupon.amountOff !== null) {
    // A flat discount is a quantity of money, so it only means anything in a
    // stated currency. Taking "100 off" an order priced in another one is how
    // a 100 INR code becomes a 100 USD discount.
    if (coupon.currency !== null && coupon.currency !== currency) {
      return null;
    }

    discount = toMinor(coupon.amountOff);
  } else {
    return null;
  }

  // Never past zero: a discount larger than the order is a free order, never
  // a refund.
  discount = Math.min(Math.max(0, discount), list);

  return {
    list_amount: toDecimal(list),
    discount: toDecimal(discount),
    amount: toDecimal(list - discount),
  };
}

export const undiscounted = (listAmount: string): Priced => ({
  list_amount: toDecimal(toMinor(listAmount)),
  discount: "0.00",
  amount: toDecimal(toMinor(listAmount)),
});

/** Razorpay and most providers charge in the smallest unit of the currency. */
export const minorUnits = (amount: string): number => toMinor(amount);
