"use client";

/**
 * The brand picker in the admin header: the one place a brand is chosen.
 *
 * It replaced two things. The rail used to list all nine brands, each with a
 * price-freshness dot and a legend, and the header had a plain dropdown that
 * filtered the shared screens. The owner asked for the rail list to go, and
 * then for choosing a brand to open it directly, so this one control does
 * both jobs: choosing a brand opens that brand's own page (its overview and
 * all its tabs), and the choice is kept, so the shared screens visited after
 * it show that brand too. The freshness each rail entry
 * carried is shown here, spelled out beside each brand, so the colour is
 * never the only signal.
 *
 * Where you are decides what a choice does:
 *
 * - Choosing a brand opens its page. From another brand's page it opens the
 *   same tab, so switching brands while on Prices stays on Prices.
 * - "All brands" goes back to the estate Dashboard from a brand's page, and
 *   simply un-narrows any other screen.
 * - Opening a brand's page another way (a link on the Dashboard) makes that
 *   the chosen brand, so the picker and the shared screens agree with it.
 */

import Link from "@/lib/ui/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { chooseBrand } from "./actions";
import { brandTabPath, type Freshness } from "./nav";

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

  // Arrived on a brand's page some other way than the picker: make it the
  // chosen brand, so Customers or Payments next show the same brand.
  const pageSlug = brandPage(path)?.slug ?? null;
  useEffect(() => {
    if (pageSlug && pageSlug !== chosen && brands.some((brand) => brand.slug === pageSlug)) {
      void chooseBrand(pageSlug);
    }
  }, [pageSlug, chosen, brands]);

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

    // Already standing in this brand's page: nothing to do.
    if (page && slug === page.slug) {
      return;
    }

    start(async () => {
      await chooseBrand(slug);

      if (slug) {
        router.push(brandTabPath(slug, page?.rest.split("/")[1] ?? ""));
      } else if (page) {
        router.push("/dashboard");
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="bswitch" ref={box}>
      {single ? (
        <Link className="bswitch-button on" href={`/dashboard/sites/${brands[0]!.slug}`}>
          <span className="bswitch-kicker">Brand</span>
          <span className="bswitch-value">
            <i className={`freshdot ${TONE[brands[0]!.freshness]}`} aria-hidden />
            <span className="bswitch-name">{brands[0]!.name}</span>
          </span>
        </Link>
      ) : (
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

      {shared && current ? <span className="bswitch-note">This screen covers every brand</span> : null}
    </div>
  );
}
