"use client";

/**
 * An <img> that never shows the browser's broken-picture icon. When the file is
 * missing (some covers from the old sites never arrived), it hides itself — or
 * the wrapper named by `hide`, so a card looks like one without a picture — or
 * shows `fallback` instead, for a screen where staff should know.
 *
 * A server-rendered image can fail before React hydrates, so onError alone
 * misses it: the ref also checks an image that has already finished.
 */

import { useCallback, useState } from "react";

type Props = React.ImgHTMLAttributes<HTMLImageElement> & {
  /** A CSS selector for the nearest wrapper to hide with the image, e.g. ".img". */
  hide?: string;
  /** Shown in place of the image when it does not load. */
  fallback?: React.ReactNode;
};

export function SafeImg({ hide, fallback, ...props }: Props) {
  const [failed, setFailed] = useState(false);

  const fail = useCallback(
    (img: HTMLImageElement) => {
      if (fallback !== undefined) {
        setFailed(true);
        return;
      }

      const target = (hide ? img.closest<HTMLElement>(hide) : null) ?? img;
      target.style.display = "none";
    },
    [fallback, hide],
  );

  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src")) {
        fail(img);
      }
    },
    [fail],
  );

  if (failed) {
    return <>{fallback}</>;
  }

  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img {...props} ref={ref} onError={(event) => fail(event.currentTarget)} />;
}
