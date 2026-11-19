/**
 * Light and dark mode, for the whole website: the admin, the sign-in pages,
 * the front door and all nine brand sites.
 *
 * The choice is a cookie rather than browser storage so the server can put it
 * on `<html data-theme>` before the page is sent: no white flash on a dark
 * page while a script catches up. With no cookie, nothing is set and the
 * stylesheets follow the computer's own setting through
 * `prefers-color-scheme`.
 */

export const THEME_COOKIE = "theme";

export type Theme = "light" | "dark";

/** The cookie's value, or undefined (follow the system) for anything else. */
export function parseTheme(value: string | undefined): Theme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}
