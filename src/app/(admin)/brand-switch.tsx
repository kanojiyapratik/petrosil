"use client";

/**
 * The brand picker in the admin header: the one place a brand is chosen.
 *
 * It replaced two things. The rail used to list all nine brands, each with a
 * price-freshness dot and a legend, and the header had a plain dropdown that
 * filtered the shared screens. The owner asked for the rail list to go, so
 * this one control now does both jobs: it filters, and once a brand is
 * chosen it offers that brand's own page. The freshness each rail entry
 * carried is shown here, spelled out beside each brand, so the colour is
 * never the only signal.
 *
 * Where you are decides what a choice does:
 *
 * - On a brand's own page (`/dashboard/sites/<slug>/...`) the picker shows
 *   that brand, and choosing another opens the same tab of the other brand.
 *   "All brands" there goes to the Dashboard, since a brand page has no
 *   all-brands version.
 * - On the screens every brand shares (Global settings, Currencies, Roles)
 *   it still works, but says that this screen covers every brand.
 * - Everywhere else it narrows what the screen shows.
 *
 * Either way the choice is kept, so it is still chosen on the next screen.
 */

import Link from "@/lib/ui/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { chooseBrand } from "./actions";
import type { Freshness } from "./nav";

type Option = { slug: string; name: string; freshness: Freshness };

/** Screens that are the same for every brand, so the filter cannot narrow them. */
const SHARED = ["/dashboard/global", "/dashboard/currencies", "/dashboard/roles"];

/** Under a shared prefix, but a report of what each brand did, so it can be narrowed. */
const NARROWABLE = ["/dashboard/global/ai-providers/usage"];

const TONE: Record<Freshness, string> = { fresh: "ok", due: "warn", stale: "bad", none: "" };
const SAYS: Record<Freshness, string> = {
  fresh: "Prices up to date",
  due: "Update due",
  stale: "Overdue",
  none: "No prices yet",
};

function brandPage(path: string): { slug: string; rest: string } | null {
  const match = /^\/dashboard\/sites\/([^/]+)(\/.*)?$/.exec(path);

  return match ? { slug: match[1]!, rest: match[2] ?? "" } : null;
}

export function BrandSwitch({ brands, chosen }: { brands: Option[]; chosen: string | null }) {
  const path = usePathname();
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on a click elsewhere, on Escape, and whenever the screen changes.
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

  useEffect(() => {
    setOpen(false);
  }, [path]);

  if (brands.length === 0) {
    return null;
  }

  const page = brandPage(path);
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  const shared = SHARED.some(under) && !NARROWABLE.some(under);
  const value = page?.slug ?? chosen ?? "";
  const current = brands.find((brand) => brand.slug === value) ?? null;
  // Staff with one brand have nothing to switch between, but still need the
  // way to their brand's page that the rail used to give them.
  const single = brands.length === 1;

  function pick(slug: string) {
    setOpen(false);

    if (slug === value) {
      return;
    }

    start(async () => {
      await chooseBrand(slug);

      if (page) {
        // The same tab of the other brand. A record's id under a tab belongs
        // to the brand it came from, so only the tab itself is kept.
        const tab = page.rest.split("/")[1];
        router.push(slug ? `/dashboard/sites/${slug}${tab ? `/${tab}` : ""}` : "/dashboard");
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="bswitch" ref={box}>
      {single ? null : (
        <button
          type="button"
          className={current ? "bswitch-button on" : "bswitch-button"}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="bswitch-kicker">{page ? "Brand" : "Showing"}</span>
          <span className="bswitch-value">
            {current ? <i className={`freshdot ${TONE[current.freshness]}`} aria-hidden /> : null}
            <span className="bswitch-name">{current ? current.name : "All brands"}</span>
          </span>
          <svg className="bswitch-caret" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      )}

      {open ? (
        <div className="bswitch-menu" role="listbox" aria-label="Brand">
          <button
            type="button"
            role="option"
            aria-selected={!current}
            className={current ? "bswitch-item" : "bswitch-item on"}
            onClick={() => pick("")}
          >
            <span className="bswitch-item-name">All brands</span>
            <span className="bswitch-item-note">{brands.length} brands</span>
          </button>

          <div className="bswitch-sep" />

          {brands.map((brand) => (
            <button
              key={brand.slug}
              type="button"
              role="option"
              aria-selected={brand.slug === value}
              className={brand.slug === value ? "bswitch-item on" : "bswitch-item"}
              onClick={() => pick(brand.slug)}
            >
              <i className={`freshdot ${TONE[brand.freshness]}`} aria-hidden />
              <span className="bswitch-item-name">{brand.name}</span>
              <span className="bswitch-item-note">{SAYS[brand.freshness]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* The brand's own page, which the rail used to link to. */}
      {(current || single) && !page ? (
        <Link className="bswitch-open" href={`/dashboard/sites/${(current ?? brands[0]!).slug}`}>
          Open {single ? brands[0]!.name : "brand page"}
          <span aria-hidden> →</span>
        </Link>
      ) : null}

      {shared && current ? <span className="bswitch-note">This screen covers every brand</span> : null}
    </div>
  );
}
