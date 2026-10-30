/**
 * AI usage — every model call the brands' AI work made, by brand and by
 * kind of work, and by day and model. The tokens are what a provider bills
 * by; a run of failed calls is a key or a quota to look at.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { EngineError } from "@/lib/engine/client";
import { aiUsage } from "@/domain/ai/providers";
import { Empty, Heading, Panel, count, one, type Search } from "@/app/(admin)/ui";
import { AiTabs } from "../tabs";

export const metadata = { title: "AI usage · Petrosil" };
export const dynamic = "force-dynamic";

const SPANS = [7, 30, 90];

/** The engine's names for its work, in the words of the screens that do it. */
const KIND: Record<string, string> = {
  extract_file: "reading reports",
  extract_file_images: "reading pictures in reports",
  extract_file_pictures: "reading pages as pictures",
  editorial: "drafting prices",
  editorial_benchmarks: "drafting: report figures for the rules",
  editorial_second_look: "drafting: a second look at missed markets",
  editorial_images: "reading pictures (older runs)",
  crawler_match: "suggesting markets for crawled prices",
  crawl: "reading watched pages",
  summary: "the note above the prices",
  provider_test: "testing a provider",
  price_review: "checking an uploaded price sheet",
};

export default async function AiUsagePage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const days = SPANS.includes(Number(one(await searchParams, "days"))) ? Number(one(await searchParams, "days")) : 30;

  let report;

  try {
    report = await aiUsage(viewer, days);
  } catch (error) {
    if (error instanceof EngineError) {
      return (
        <>
          <Heading title="AI usage" />
          <p className="flash bad" role="alert">
            {error.message}
          </p>
        </>
      );
    }

    throw error;
  }

  const totals = report.by_site.reduce(
    (sum, row) => ({
      calls: sum.calls + row.calls,
      failed: sum.failed + row.failed,
      tokens: sum.tokens + row.prompt_tokens + row.completion_tokens,
    }),
    { calls: 0, failed: 0, tokens: 0 },
  );

  return (
    <>
      <Heading
        title="AI usage"
        sub={report.estate ? "Every model call across the brands." : "Model calls for the brands you work on."}
      >
        <div className="chips">
          {SPANS.map((span) => (
            <Link key={span} className={`chip${span === days ? " on" : ""}`} href={`/dashboard/global/ai-providers/usage?days=${span}`}>
              {span} days
            </Link>
          ))}
        </div>
      </Heading>

      <AiTabs on="usage" />

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(totals.calls)}</div>
          <div className="k">model calls in {days} days</div>
        </div>
        <div className="tile">
          <div className="n">{count(totals.failed)}</div>
          <div className="k">failed</div>
        </div>
        <div className="tile">
          <div className="n">{count(totals.tokens)}</div>
          <div className="k">tokens, in and out</div>
        </div>
      </div>

      <Panel title="By brand and kind of work">
        {report.by_site.length ? (
          <table className="tight">
            <thead>
              <tr>
                <th>Brand</th>
                <th>Work</th>
                <th className="num">Calls</th>
                <th className="num">Failed</th>
                <th className="num">Tokens in</th>
                <th className="num">Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {report.by_site.map((row, index) => (
                <tr key={index}>
                  <td>{row.site ? report.names[row.site] ?? row.site : <span className="muted">no brand</span>}</td>
                  <td>{KIND[row.kind] ?? row.kind.replace(/_/g, " ")}</td>
                  <td className="num">{count(row.calls)}</td>
                  <td className="num">{row.failed ? <span className="badge bad">{count(row.failed)}</span> : "0"}</td>
                  <td className="num">{count(row.prompt_tokens)}</td>
                  <td className="num">{count(row.completion_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No AI work in the last {days} days.</Empty>
        )}
      </Panel>

      {report.estate ? (
        <Panel title="By day and model">
          {report.by_day.length ? (
            <table className="tight">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th className="num">Calls</th>
                  <th className="num">Tokens in</th>
                  <th className="num">Tokens out</th>
                </tr>
              </thead>
              <tbody>
                {report.by_day.map((row, index) => (
                  <tr key={index}>
                    <td>{row.day}</td>
                    <td>{row.provider}</td>
                    <td className="small">{row.model}</td>
                    <td className="num">{count(row.calls)}</td>
                    <td className="num">{count(row.prompt_tokens)}</td>
                    <td className="num">{count(row.completion_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No AI work in the last {days} days.</Empty>
          )}
        </Panel>
      ) : null}
    </>
  );
}
