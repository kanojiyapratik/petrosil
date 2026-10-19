/**
 * What counts as an email address, and what counts as a password.
 *
 * Stated once, because registration, the reset link and the change-password
 * screen must agree. The old estate did not: one site's reset form accepted
 * six characters while its register form asked for eight.
 */

/** Laravel's default, which is what 112,000 migrated subscribers are used to. */
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

/**
 * Deliberately permissive. Address syntax is not worth litigating in a
 * regex — the confirmation mail is what proves an address exists, and a
 * stricter pattern mostly rejects real people with unusual domains.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const readEmail = (value: unknown): string | null => {
  const email = String(value ?? "").trim().toLowerCase();

  return email.length > 0 && email.length <= 191 && EMAIL.test(email) ? email : null;
};

export type PasswordCheck = { ok: true } | { ok: false; message: string };

export function checkPassword(password: unknown, email?: string | null): PasswordCheck {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return { ok: false, message: `Choose a password of at least ${MIN_PASSWORD} characters.` };
  }

  if (password.length > MAX_PASSWORD) {
    return { ok: false, message: `Choose a password of at most ${MAX_PASSWORD} characters.` };
  }

  if (password.trim().length === 0) {
    return { ok: false, message: "Choose a password with something in it." };
  }

  // The single most common weak choice among people filling in a form that
  // already has their address in the field above it.
  if (email && password.toLowerCase() === email.toLowerCase()) {
    return { ok: false, message: "Choose a password that is not your email address." };
  }

  return { ok: true };
}

export const readName = (value: unknown): string | null => {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");

  return name.length > 0 ? name.slice(0, 191) : null;
};

/** Optional free-text field: trimmed, length-capped, blank becomes null. */
export const readText = (value: unknown, max: number): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();

  return text.length > 0 ? text.slice(0, max) : null;
};
