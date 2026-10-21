/**
 * The pieces every admin list screen is made of.
 *
 * Deliberately plain: a filter bar is a GET form, the pager is two links,
 * the chips are links. Nothing here is a client component, so every view has
 * a URL you can paste to a colleague — which the PHP admin managed and most
 * of its replacements do not.
 */

import Link from "next/link";

import type { Brand } from "@/domain/dashboard/brands";

export const count = (n: number) => n.toLocaleString("en-IN");

export function money(value: number | null, currency?: string | null): string {
  if (value === null) {
    return "—";
  }

  const shown = value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return currency ? `${currency} ${shown}` : shown;
}

/** An ISO timestamp as something a person reads, in the estate's own zone. */
export function when(iso: string | null): string {
  if (!iso) {
    return "—";
  }

  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export function Heading({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <div className="heading">
        <h1>{title}</h1>
        <span className="spacer" />
        {children}
      </div>
      {sub ? <p className="sub">{sub}</p> : null}
    </>
  );
}

export function Panel({
  title,
  hint,
  flush = true,
  children,
  aside,
}: {
  title?: string;
  hint?: string;
  flush?: boolean;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="panel">
      {title || hint || aside ? (
        <div className="head">
          {title ? <h2>{title}</h2> : null}
          <span className="spacer" />
          {hint ? <span className="hint">{hint}</span> : null}
          {aside}
        </div>
      ) : null}
      <div className={flush ? "body flush" : "body"}>{children}</div>
    </div>
  );
}

/** The brand `<select>` every screen shares. Hidden when there is only one. */
export function BrandField({ brands, value }: { brands: Brand[]; value?: string }) {
  if (brands.length < 2) {
    return null;
  }

  return (
    <div className="field">
      <label htmlFor="site">Brand</label>
      <select id="site" name="site" defaultValue={value ?? ""}>
        <option value="">All brands</option>
        {brands.map((brand) => (
          <option key={brand.slug} value={brand.slug}>
            {brand.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Filters({ action, children }: { action: string; children: React.ReactNode }) {
  return (
    <form className="bar" action={action} method="get">
      {children}
      <button type="submit">Filter</button>
      <Link className="button ghost" href={action}>
        Clear
      </Link>
    </form>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * Chips that filter, each carrying its own count.
 *
 * `here` keeps the other filters in the URL, so narrowing by segment does
 * not silently throw away the brand you had chosen.
 */
export function Chips({
  base,
  param,
  here,
  options,
  value,
}: {
  base: string;
  param: string;
  here: Record<string, string | undefined>;
  options: { value: string; label: string; n?: number }[];
  value?: string;
}) {
  const href = (next: string) => {
    const query = new URLSearchParams();

    for (const [key, raw] of Object.entries(here)) {
      if (raw && key !== param && key !== "page") {
        query.set(key, raw);
      }
    }

    if (next) {
      query.set(param, next);
    }

    const tail = query.toString();

    return tail ? `${base}?${tail}` : base;
  };

  return (
    <div className="chips">
      {options.map((option) => (
        <Link
          key={option.value || "all"}
          className={`chip${(value ?? "") === option.value ? " on" : ""}`}
          href={href(option.value)}
        >
          {option.label}
          {option.n === undefined ? null : <b>{count(option.n)}</b>}
        </Link>
      ))}
    </div>
  );
}

export function Pager({
  base,
  here,
  page,
  perPage,
  total,
}: {
  base: string;
  here: Record<string, string | undefined>;
  page: number;
  perPage: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));

  if (total === 0) {
    return null;
  }

  const href = (next: number) => {
    const query = new URLSearchParams();

    for (const [key, raw] of Object.entries(here)) {
      if (raw && key !== "page") {
        query.set(key, raw);
      }
    }

    if (next > 1) {
      query.set("page", String(next));
    }

    const tail = query.toString();

    return tail ? `${base}?${tail}` : base;
  };

  const first = (page - 1) * perPage + 1;
  const last = Math.min(total, page * perPage);

  return (
    <div className="pager">
      <span>
        {count(first)}–{count(last)} of {count(total)}
      </span>
      <span className="spacer" />
      {page > 1 ? <Link href={href(page - 1)}>Previous</Link> : <span className="off">Previous</span>}
      <span>
        {page} / {pages}
      </span>
      {page < pages ? <Link href={href(page + 1)}>Next</Link> : <span className="off">Next</span>}
    </div>
  );
}

/** A change, signed and coloured. `null` when there is nothing to compare to. */
export function Change({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="muted">—</span>;
  }

  if (pct === 0) {
    return <span className="muted">unchanged</span>;
  }

  return (
    <span className={pct > 0 ? "up" : "down"}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(2)}%
    </span>
  );
}

/**
 * A bar chart of a price history, drawn with divs.
 *
 * Bars are scaled between the lowest and highest figure rather than from
 * zero: these series move a few percent, and from zero they would all look
 * identical.
 */
export function Chart({ points }: { points: { price_date: string; price: number }[] }) {
  if (points.length < 2) {
    return null;
  }

  const values = points.map((point) => point.price);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;

  return (
    <div className="chart" role="img" aria-label={`${points.length} prices, ${low} to ${high}`}>
      {points.map((point) => (
        <div
          key={point.price_date}
          className="bar-col"
          style={{ height: `${12 + ((point.price - low) / span) * 88}%` }}
          title={`${point.price_date}: ${point.price}`}
        />
      ))}
    </div>
  );
}

/** Read a page number off a query string without trusting it. */
export function pageParam(raw: string | undefined): number {
  const n = Number(raw);

  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** The query a screen was asked for, as plain strings. */
export type Search = Record<string, string | string[] | undefined>;

export function one(search: Search, key: string): string | undefined {
  const raw = search[key];
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.trim() !== "" ? value.trim() : undefined;
}
