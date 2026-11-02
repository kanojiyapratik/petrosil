"use client";

/**
 * `next/link`, prefetching on intent instead of on sight.
 *
 * Next prefetches every link in the viewport, and every page here is
 * rendered per request: an admin screen opened with 60–140 server renders
 * behind it (the rail's 25 entries, the tabs, a link per table row), most of
 * them thrown away, each one a round of database queries. A brand's public
 * page did the same with 60–90. This asks for a page when the pointer reaches
 * its link or a finger touches it, which is still before the click lands.
 */

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof NextLink>;

export default function Link({ prefetch, onMouseEnter, onTouchStart, onFocus, ...props }: Props) {
  const router = useRouter();

  // An explicit prefetch keeps Next's own behaviour.
  if (prefetch !== undefined) {
    return <NextLink prefetch={prefetch} onMouseEnter={onMouseEnter} onTouchStart={onTouchStart} onFocus={onFocus} {...props} />;
  }

  const href = typeof props.href === "string" ? props.href : null;
  const warm = () => {
    if (href && href.startsWith("/")) {
      router.prefetch(href);
    }
  };

  return (
    <NextLink
      prefetch={false}
      onMouseEnter={(event) => {
        warm();
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        warm();
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        warm();
        onFocus?.(event);
      }}
      {...props}
    />
  );
}
