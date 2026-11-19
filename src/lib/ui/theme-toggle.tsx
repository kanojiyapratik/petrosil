"use client";

/**
 * The light/dark switch. One component, used in the admin header, on the
 * brand sites and on the sign-in pages, so it behaves the same everywhere.
 *
 * Both icons are always rendered and CSS shows the right one (see
 * `.theme-toggle` in globals.css). The server cannot know the system setting
 * when no choice has been made, so picking the icon in React would draw the
 * wrong one first and then jump.
 *
 * A click flips whatever is showing now, chosen or inherited from the system,
 * applies it at once and keeps it in the cookie for every later page.
 */

import { THEME_COOKIE, type Theme } from "./theme";

function showing(): Theme {
  const set = document.documentElement.dataset.theme;

  if (set === "light" || set === "dark") {
    return set;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  function flip() {
    const next: Theme = showing() === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      onClick={flip}
      aria-label="Switch between light and dark mode"
      title="Light or dark mode"
    >
      {/* Shown in light mode: switch to dark. */}
      <svg className="theme-toggle-moon" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path
          d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {/* Shown in dark mode: switch to light. */}
      <svg className="theme-toggle-sun" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
