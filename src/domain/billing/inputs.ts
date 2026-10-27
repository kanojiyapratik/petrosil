/**
 * Reading money, dates and currency codes off a staff form.
 *
 * Each refuses with an `AccountError` naming the field, so the form can say
 * which box is wrong. Amounts come back as fixed two-place strings for the
 * numeric columns: no float is ever between the form and the database.
 */

import { AccountError } from "@/domain/accounts/register";

/** "15000", "15000.5", "15,000.50" → "15000.50". Commas are how the team types lakhs. */
export function moneyInput(value: unknown, field: string, message = "Enter an amount, like 15000 or 540.50."): string {
  const text = String(value ?? "").trim().replace(/,/g, "");

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) {
    throw new AccountError(message, 422, field);
  }

  return Number(text).toFixed(2);
}

/** A calendar date that exists, or null for a blank. "2026-02-30" is refused, not rolled over. */
export function dateInput(value: unknown, field: string): string | null {
  const text = String(value ?? "").trim();

  if (text === "") {
    return null;
  }

  const parsed = new Date(`${text}T00:00:00Z`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new AccountError("That is not a date.", 422, field);
  }

  return text;
}

/** Three letters, upper-cased: INR, USD. */
export function currencyInput(value: unknown, field = "currency"): string {
  const text = String(value ?? "").trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(text)) {
    throw new AccountError("Use a three-letter currency code, like INR or USD.", 422, field);
  }

  return text;
}

/** A whole number in a range, or null for a blank. */
export function countInput(value: unknown, field: string, min: number, max: number, message: string): number | null {
  const text = String(value ?? "").trim();

  if (text === "") {
    return null;
  }

  const n = Number(text);

  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AccountError(message, 422, field);
  }

  return n;
}
