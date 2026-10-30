/**
 * The parts every brand page shares: the price table, the paywall prompt,
 * an ad slot, dates and figures. Server components only — nothing here needs
 * the browser.
 */

import Link from "next/link";

import type { PublicTrendRow } from "@/domain/public/prices";
import type { Entitlement } from "@/domain/public/paywall";
import { liveAds } from "@/domain/public/ads";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "16 Oct 2026" from a Y-m-d or an ISO timestamp. */
export function day(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const [y, m, d] = value.slice(0, 10).split("-").map(Number);

  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : "";
}

export function figure(value: number | null, currency?: string | null): string {
  if (value === null) {
    return "";
  }

  const text = value.toLocaleString("en-US", { maximumFractionDigits: 2 });

  return currency ? `${text} ${currency}` : text;
}

const MOVES: Record<string, { mark: string; word: string }> = {
  up: { mark: "▲", word: "up" },
  down: { mark: "▼", word: "down" },
  flat: { mark: "—", word: "unchanged" },
};

/** Up, down or unchanged: public. The size of the move is a figure, so it is not. */
export function Movement({ row }: { row: PublicTrendRow }) {
  if (!row.movement) {
    return <span className="flat">{row.price_date ? "first price" : "no price yet"}</span>;
  }

  const move = MOVES[row.movement]!;

  return (
    <span className={row.movement}>
      {move.mark} {row.change_pct !== null ? `${Math.abs(row.change_pct).toFixed(2)}%` : move.word}
    </span>
  );
}

export function PriceTable({ site, rows }: { site: string; rows: PublicTrendRow[] }) {
  return (
    <div className="bs-scroll">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Move</th>
            <th className="r">Price</th>
            <th className="r">Previous</th>
            <th>Assessed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/${site}/locations/${row.id}`}>{row.title}</Link>
              </td>
              <td>
                <Movement row={row} />
              </td>
              <td className="r num">
                {row.locked ? <span className="lock" aria-label="For subscribers">●●●●</span> : figure(row.price, row.currency)}
              </td>
              <td className="r num">
                {row.locked ? <span className="lock" aria-label="For subscribers">●●●●</span> : figure(row.previous_price)}
              </td>
              <td className="num muted">{day(row.price_date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ASKS: Record<string, { say: string; cta: string; href: (site: string) => string }> = {
  anonymous: { say: "Prices are for subscribers.", cta: "Sign in", href: (s) => `/${s}/sign-in` },
  no_membership: { say: "Prices are for subscribers.", cta: "See the plans", href: (s) => `/${s}/subscription` },
  free: { say: "Your account is free. Subscribe to see every figure.", cta: "See the plans", href: (s) => `/${s}/subscription` },
  expired: { say: "Your subscription has ended. Renew to see the figures again.", cta: "Renew", href: (s) => `/${s}/subscription` },
};

/** What a reader who cannot see figures is told, and where they can go. Nothing for one who can. */
export function Gate({
  site,
  entitlement,
  what = "the figures",
  lead,
}: {
  site: string;
  entitlement: Entitlement;
  what?: string;
  /** The whole sentence, for a page that is not about prices. */
  lead?: string;
}) {
  if (entitlement.entitled) {
    return null;
  }

  const ask = ASKS[entitlement.reason] ?? ASKS.anonymous!;

  return (
    <div className="bs-gate">
      <span>
        {lead ?? `${ask.say} Movements and market names are free; ${what} are for paying readers.`}
      </span>
      <Link className="btn" href={ask.href(site)}>
        {ask.cta}
      </Link>
      {entitlement.reason === "anonymous" ? (
        <Link href={`/${site}/subscription`}>or see the plans</Link>
      ) : null}
    </div>
  );
}

/** One ad slot, by its title as staff name it. Nothing at all when nothing is running. */
export async function AdSlot({ brand, slot }: { brand: { id: number; slug: string }; slot: string }) {
  const [running] = await liveAds(brand, { slot });

  if (!running || running.ads.length === 0) {
    return null;
  }

  return (
    <div className="bs-ads" aria-label="Advertisement">
      {running.ads.map((ad) => {
        const art = ad.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.image_url} alt={ad.title} loading="lazy" />
        ) : ad.video_url ? (
          <video src={ad.video_url} autoPlay muted loop playsInline aria-label={ad.title} />
        ) : null;

        if (ad.code) {
          // Embed code (a Google ad) is written by staff with ad permissions and
          // runs by design; it is not reader content.
          return <div key={ad.id} dangerouslySetInnerHTML={{ __html: ad.code }} />;
        }

        return ad.click_url ? (
          <a key={ad.id} href={ad.click_url} target="_blank" rel="noopener sponsored">
            {art}
          </a>
        ) : (
          <div key={ad.id}>{art}</div>
        );
      })}
    </div>
  );
}

export function Pager({ base, page, pages, query = {} }: { base: string; page: number; pages: number; query?: Record<string, string> }) {
  if (pages <= 1) {
    return null;
  }

  const href = (to: number) => {
    const params = new URLSearchParams({ ...query, page: String(to) });

    return `${base}?${params.toString()}`;
  };

  return (
    <nav className="bs-pager" aria-label="Pages">
      {page > 1 ? <Link href={href(page - 1)}>← Newer</Link> : null}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages ? <Link href={href(page + 1)}>Older →</Link> : null}
    </nav>
  );
}

/** A positive page number from ?page=, 1 when absent or nonsense. */
export function pageParam(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);

  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

type Downloadable = { allowed: boolean; reason: "sign_in" | "subscribe" | "renew" | "no_file" | null; url: string | null };

const DOWNLOAD_ASKS = {
  sign_in: { say: "Sign in to download this.", cta: "Sign in", path: "sign-in" },
  subscribe: { say: "This is for subscribers.", cta: "See the plans", path: "subscription" },
  renew: { say: "Your subscription has ended.", cta: "Renew", path: "subscription" },
} as const;

/** The download button, or why there is none and what to do about it. */
export function Download({ site, download, back, what = "Download" }: { site: string; download: Downloadable; back: string; what?: string }) {
  if (download.allowed && download.url) {
    return (
      <a className="btn" href={download.url}>
        {what}
      </a>
    );
  }

  if (!download.reason || download.reason === "no_file") {
    return <p className="muted">The file is not available yet. <Link href={`/${site}/contact-us`}>Ask us for it</Link>.</p>;
  }

  const ask = DOWNLOAD_ASKS[download.reason];
  const href = ask.path === "sign-in" ? `/${site}/sign-in?next=${encodeURIComponent(back)}` : `/${site}/${ask.path}`;

  return (
    <div className="bs-gate">
      <span>{ask.say}</span>
      <Link className="btn" href={href}>
        {ask.cta}
      </Link>
    </div>
  );
}
