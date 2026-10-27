"use client";

/**
 * A button that opens a small form in a popup, for adding something short:
 * a location, a country, a notice. Big editors (an article, a report) keep
 * their own page. The popup is the browser's own dialog, so Escape closes it
 * and focus stays inside while it is open.
 */

import { useRef } from "react";

export function Popup({
  label,
  title,
  children,
  ghost = false,
}: {
  /** The button's words: "New location". */
  label: string;
  /** The popup's heading. */
  title: string;
  children: React.ReactNode;
  ghost?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" className={`small${ghost ? " ghost" : ""}`} onClick={() => dialog.current?.showModal()}>
        {label}
      </button>
      <dialog
        ref={dialog}
        className="popup"
        aria-label={title}
        // A click on the dimmed backdrop lands on the dialog itself: close.
        onClick={(event) => {
          if (event.target === dialog.current) {
            dialog.current.close();
          }
        }}
      >
        <div className="popup-head">
          <h2>{title}</h2>
          <button type="button" className="ghost small" aria-label="Close" onClick={() => dialog.current?.close()}>
            ✕
          </button>
        </div>
        <div className="popup-body">{children}</div>
      </dialog>
    </>
  );
}
