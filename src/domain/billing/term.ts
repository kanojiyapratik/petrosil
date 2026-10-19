/**
 * How much time a payment buys.
 *
 * One rule, and it is the one subscribers notice: **a renewal extends, it
 * does not replace.** Someone renewing three months early keeps those three
 * months. The old sites set `expiry_date = now()->addYears($n)` on payment,
 * so renewing early quietly threw away whatever was left, and the complaints
 * were handled by an admin editing the date back by hand.
 */

const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysIn = (year: number, month: number): number =>
  month === 2 && isLeap(year) ? 29 : LAST_DAY[month - 1]!;

/**
 * Adds whole years in the calendar rather than in milliseconds.
 *
 * Date arithmetic by milliseconds drifts across a leap day, and JavaScript's
 * own `setFullYear` turns 29 February into 1 March — which would hand
 * somebody a subscription that ends a day into the wrong month. 29 February
 * plus a year is 28 February.
 */
export function addYears(day: string, years: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const year = y + years;
  const date = Math.min(d, daysIn(year, m));

  return `${year}-${String(m).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

/**
 * The new end date for a term bought today.
 *
 * `current` null, or already past, means the term starts now. A term still
 * running is extended from its own end, not from today.
 */
export function extendedUntil(current: string | null, years: number, today: string): string {
  const from = current !== null && current >= today ? current : today;

  return addYears(from, Math.max(1, Math.trunc(years)));
}
