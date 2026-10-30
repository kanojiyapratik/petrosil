/**
 * AI settings for the whole estate — what the price console's AI screen
 * was: the providers every brand's AI work runs on (add, test, change the
 * model, replace or show the key, make default, remove), which brand uses
 * which, and the last fortnight's usage. A brand uses the default unless it
 * chooses another, here or on its own AI settings tab.
 *
 * Keys stay in the AI engine. A key is shown in full only when a superadmin
 * presses Show, and every look is in the audit trail.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { EngineError } from "@/lib/engine/client";
import { aiUsage, brandAssignments, providerList } from "@/domain/ai/providers";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";
import { AddProvider, BrandModelRow, ProviderCard } from "./forms";
import { AiTabs } from "./tabs";

export const metadata = { title: "AI settings · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AiProvidersPage() {
  const viewer = (await currentViewer())!;

  if (!viewer.isSuperadmin) {
    return (
      <>
        <Heading title="AI settings" />
        <AiTabs on="providers" />
        <Panel flush={false}>
          <Empty>The AI providers and their keys are managed by a superadmin. Each brand&rsquo;s model is chosen on its AI settings screen.</Empty>
        </Panel>
      </>
    );
  }

  let loaded;

  try {
    loaded = await Promise.all([providerList(viewer), brandAssignments(viewer), aiUsage(viewer, 14)]);
  } catch (error) {
    if (error instanceof EngineError) {
      return (
        <>
          <Heading title="AI settings" />
          <AiTabs on="providers" />
          <p className="flash bad" role="alert">
            {error.message}
          </p>
        </>
      );
    }

    throw error;
  }

  const [list, brands, usage] = loaded;
  const fallback = list.providers.find((provider) => provider.is_default);

  return (
    <>
      <Heading
        title="AI settings"
        sub="The AI accounts every brand's report reading, drafting and crawling run on, which brand uses which, and what they have been used for."
      >
        <Popup label="Add a provider" title="Add an AI provider">
          <AddProvider catalogue={list.catalogue} />
        </Popup>
      </Heading>

      <AiTabs on="providers" />

      <Panel
        title="Providers"
        hint="Test one before relying on it: a wrong key, a wrong model and an empty quota all fail the same way mid-update."
        flush={false}
      >
        {list.providers.length ? (
          list.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)
        ) : (
          <Empty>No AI provider yet. Add one, or nothing can read a report.</Empty>
        )}
      </Panel>

      <Panel
        title="Which brand uses which"
        hint={fallback ? `A brand left on the default runs on ${fallback.name} (${fallback.model}).` : "No default provider yet."}
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Brand</th>
              <th>Provider and model</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(brands)
              .sort(([, a], [, b]) => a.name.localeCompare(b.name))
              .map(([slug, brand]) => (
                <BrandModelRow
                  key={slug}
                  slug={slug}
                  name={brand.name}
                  providers={list.providers}
                  providerId={brand.provider_id}
                  model={brand.model}
                />
              ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Usage — last 14 days"
        aside={
          <Link className="small" href="/dashboard/global/ai-providers/usage">
            By brand and kind of work →
          </Link>
        }
      >
        {usage.by_day.length ? (
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
              {usage.by_day.map((row, index) => (
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
          <Empty>No AI work in the last 14 days.</Empty>
        )}
      </Panel>
    </>
  );
}
