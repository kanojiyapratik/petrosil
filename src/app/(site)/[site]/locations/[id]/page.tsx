/**
 * One market's price history: a chart and the weekly figures for a
 * subscriber; the market, its latest move and how much history there is for
 * everyone else.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { publicLocation, type HistoryPoint } from "@/domain/public/prices";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { Gate, Movement, day, figure } from "../../ui";

export const dynamic = "force-dynamic";

const RANGES = [
  { weeks: 12, label: "3 months" },
  { weeks: 26, label: "6 months" },
  { weeks: 52, label: "1 year" },
  { weeks: 156, label: "3 years" },
];

type Props = {
  params: Promise<{ site: string; id: string }>;
  searchParams: Promise<{ weeks?: string }>;
};

async function load({ params, searchParams }: Props) {
  const { site, id } = await params;
  const brand = await liveBrandBySlug(site);
  const locationId = Number(id);

  if (!brand || !Number.isInteger(locationId) || locationId < 1) {
    return null;
  }

  const asked = Number((await searchParams).weeks);
  const weeks = RANGES.some((range) => range.weeks === asked) ? asked : 26;
  const reader = await readerFor(brand.id);
  const found = await publicLocation(brand.id, locationId, reader.entitlement.entitled, weeks);

  return found ? { site, brand, reader, weeks, ...found } : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const found = await load(props);

  return found ? { title: found.location.title } : {};
}

/** The history as a line, oldest on the left. Plain SVG: nothing to load, prints as it shows. */
function Chart({ points, currency }: { points: HistoryPoint[]; currency: string | null }) {
  const series = [...points].reverse();

  if (series.length < 2) {
    return null;
  }

  const W = 760;
  const H = 260;
  const pad = { l: 64, r: 16, t: 14, b: 30 };
  const values = series.map((p) => p.price);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) * 0.05 || 1;
  const x = (i: number) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const ticks = [lo, lo + span / 2, hi];

  return (
    <div className="bs-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Price from ${day(series[0]!.price_date)} to ${day(series.at(-1)!.price_date)}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#d9e0e3" strokeDasharray="3 4" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6b7f8b" fontFamily="IBM Plex Mono, monospace">
              {figure(Math.round(t * 100) / 100)}
            </text>
          </g>
        ))}
        <path d={line} fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinejoin="round" />
        {series.map((p, i) => (
          <circle key={p.price_date} cx={x(i)} cy={y(p.price)} r={series.length > 60 ? 0 : 2.6} fill="var(--brand)">
            <title>
              {day(p.price_date)}: {figure(p.price, currency)}
            </title>
          </circle>
        ))}
        <text x={pad.l} y={H - 8} fontSize="11" fill="#6b7f8b">
          {day(series[0]!.price_date)}
        </text>
        <text x={W - pad.r} y={H - 8} fontSize="11" fill="#6b7f8b" textAnchor="end">
          {day(series.at(-1)!.price_date)}
        </text>
      </svg>
    </div>
  );
}

export default async function LocationHistory(props: Props) {
  const found = await load(props);

  if (!found) {
    notFound();
  }

  const { site, location, locked, points, points_available, weeks, reader } = found;
  // publicLocation returns one point beyond the window, only so the oldest
  // shown can state its own change; it is not shown itself.
  const shown = points.slice(0, weeks);

  return (
    <section className="bs-card">
      <Link className="bs-crumb" href={`/${site}/price-trends`}>
        ← All markets
      </Link>
      <div className="bs-head">
        <h1>{location.title}</h1>
      </div>

      <div className="bs-stats">
        <div>
          <div className="k">Latest</div>
          <div className="v num">{locked ? <span className="lock">●●●●</span> : figure(location.price, location.currency)}</div>
        </div>
        <div>
          <div className="k">Move</div>
          <div className="v">
            <Movement row={location} />
          </div>
        </div>
        <div>
          <div className="k">Assessed</div>
          <div className="v num">{day(location.price_date) || "—"}</div>
        </div>
        <div>
          <div className="k">History</div>
          <div className="v num">{points_available.toLocaleString("en-US")} prices</div>
        </div>
      </div>

      {locked ? (
        <Gate site={site} entitlement={reader.entitlement} what="the history and its chart" />
      ) : (
        <>
          <nav className="bs-chips" aria-label="Range">
            {RANGES.map((range) => (
              <Link key={range.weeks} href={`?weeks=${range.weeks}`} aria-current={range.weeks === weeks ? "true" : undefined}>
                {range.label}
              </Link>
            ))}
          </nav>
          <Chart points={shown} currency={location.currency} />
          <div className="bs-scroll" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="r">Price</th>
                  <th className="r">Change</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((point) => (
                  <tr key={point.price_date}>
                    <td className="num">{day(point.price_date)}</td>
                    <td className="r num">{figure(point.price, location.currency)}</td>
                    <td className={`r num ${point.change_pct === null ? "flat" : point.change_pct > 0 ? "up" : point.change_pct < 0 ? "down" : "flat"}`}>
                      {point.change_pct === null ? "—" : `${point.change_pct > 0 ? "+" : ""}${point.change_pct.toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
