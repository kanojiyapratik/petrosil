/**
 * The AI's draft: a price for every market it could find evidence for, the
 * ones a rule worked out, and the checks that ask whether the sheet
 * contradicts the brand's own rules — then saving the kept rows as a draft
 * price update. A saved draft stays readable, beside what was saved.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { brandsFor } from "@/domain/dashboard/brands";
import { aiDraft } from "@/domain/ai/update";
import { Heading, Panel, when } from "@/app/(admin)/ui";
import { DraftReview } from "../../forms";

export const metadata = { title: "AI draft · Petrosil" };

const figure = (value: number | null) => (value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));
export const dynamic = "force-dynamic";

export default async function DraftPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const draftId = Number(id);

  if (!Number.isInteger(draftId) || draftId < 1) {
    notFound();
  }

  let loaded;

  try {
    loaded = await aiDraft(viewer, slug, draftId);
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      notFound();
    }

    if (error instanceof AccessError || error instanceof EngineError) {
      return (
        <>
          <Heading title={`AI draft #${draftId}`} />
          <p className="flash bad" role="alert">
            {error.message}
          </p>
        </>
      );
    }

    throw error;
  }

  const { draft, findings, blockers } = loaded;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);
  const rows = draft.rows.filter((row) => !row.is_benchmark);
  const benchmarks = draft.rows.filter((row) => row.is_benchmark && row.suggested_price != null);

  return (
    <>
      <Heading
        title={`AI draft #${draft.id}`}
        sub={`Prices for ${draft.price_date ?? "—"} · drafted ${when(draft.created_at)} by ${draft.created_by} · ${draft.model ?? "model not recorded"}${
          draft.instructions ? ` · ${draft.instructions.length} characters of instructions sent` : " · no instructions sent"
        }`}
      >
        <a className="button ghost small" href={`/api/dashboard/sites/${slug}/ai/drafts/${draft.id}/workings`}>
          Download the workings
        </a>
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/ai-update`}>
          Back
        </Link>
      </Heading>

      {findings.length ? (
        <Panel
          title={blockers ? `Before you save — ${blockers} to fix` : `Before you save — ${findings.length} to look at`}
          hint="Checked against this brand's own price rules and rounding, not anyone's view of the market."
        >
          <table className="tight">
            <thead>
              <tr>
                <th>Market</th>
                <th>Check</th>
                <th>What is wrong</th>
                <th className="num">Expected</th>
                <th className="num">On this draft</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding, index) => (
                <tr key={index}>
                  <td>{finding.location || "—"}</td>
                  <td>
                    <span className={`badge ${finding.severity === "blocker" ? "bad" : "warn"}`}>{finding.check.replace(/_/g, " ")}</span>
                  </td>
                  <td className="small">{finding.detail}</td>
                  <td className="num">{figure(finding.expected)}</td>
                  <td className="num">{figure(finding.actual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <Panel title="The AI's prices" flush={false}>
        <DraftReview
          slug={slug}
          draftId={draft.id}
          pricedate={draft.price_date ?? ""}
          rows={rows}
          savedTo={draft.batch_id}
          brand={brand?.name ?? slug}
        />
      </Panel>

      {benchmarks.length ? (
        <Panel title="Report figures your rules used" hint="Read from the reports to work other prices out. They are never saved as prices themselves.">
          <table className="tight">
            <tbody>
              {benchmarks.map((row) => (
                <tr key={row.location}>
                  <td>{row.location.replace(/^Report:\s*/, "")}</td>
                  <td className="num">
                    {row.detail?.money ?? ""}
                    {row.suggested_price}
                  </td>
                  <td className="small muted">{row.source ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </>
  );
}
