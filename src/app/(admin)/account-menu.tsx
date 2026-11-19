"use client";

/**
 * The right-hand end of the admin header: who is signed in, and signing out.
 *
 * It used to be a role badge, a name over an email, and a bare Sign out
 * button in a row. Now it is an avatar with the person's initials and their
 * name and role, opening a small menu with their email and Sign out, the way
 * most admin tools do it. The light/dark switch sits beside it.
 */

import { useEffect, useRef, useState } from "react";

import { signOut } from "./actions";

function initials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length >= 2) {
    return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  }

  return (words[0] ?? email).slice(0, 2).toUpperCase();
}

export function AccountMenu({ name, email, role }: { name: string; email: string; role: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);

    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const letters = initials(name, email);

  return (
    <div className="account" ref={box}>
      <button
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="avatar" aria-hidden>
          {letters}
        </span>
        <span className="account-text">
          <span className="account-name">{name}</span>
          <span className="account-role">{role}</span>
        </span>
        <svg className="account-caret" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {open ? (
        <div className="account-menu" role="menu">
          <div className="account-who">
            <span className="avatar large" aria-hidden>
              {letters}
            </span>
            <div className="account-who-text">
              <strong>{name}</strong>
              <span>{email}</span>
              <span className="badge brand">{role}</span>
            </div>
          </div>

          <div className="account-sep" />

          <form action={signOut}>
            <button type="submit" role="menuitem" className="account-item danger">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path
                  d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
