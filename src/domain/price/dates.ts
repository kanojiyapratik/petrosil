/**
 * Reading a date out of whatever a caller sent.
 *
 * Ported from the Laravel sites' PriceDateParser, including its refusals: a
 * purely numeric string ("2026", or a text-formatted Excel serial "45292") is
 * NOT a date here. The old code rejected it because PHP's strtotime would
 * silently read it as a bare HH:MM time on today's date; JavaScript's Date
 * would misread it just as happily, so the rule stays.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

/** Y-m-d in the server's own calendar day, which is what "today" means to the lock rule. */
export function today(now: Date = new Date()): string {
  return format(now);
}

export function format(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

/**
 * @returns the date as `YYYY-MM-DD`, or null when the value is not a date.
 */
export function parseDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : format(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  if (text === "") {
    return null;
  }

  // See the note above: a bare number is not a date.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }

  const iso = ISO.exec(text);
  if (iso) {
    return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // The sites and their editors write dates both ways round. Day-first is the
  // house style on every Petrosil site, so 03-10-2026 is 3 October.
  const dmy = DMY.exec(text);
  if (dmy) {
    return valid(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  // `new Date("5 October 2026")` is local midnight; `new Date("2026-10-05")`
  // would be UTC midnight, but that form never reaches here — the ISO branch
  // above takes it, so there is no timezone shift to undo.
  return format(parsed);
}

function valid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return format(date);
}
