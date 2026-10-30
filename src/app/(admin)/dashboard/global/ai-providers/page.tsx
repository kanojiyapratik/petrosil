/**
 * AI providers — the accounts every brand's AI work runs on. Set up once
 * here; each brand then picks one on its own AI settings screen, or uses the
 * default. Keys stay in the AI engine and are never shown in full.
 */

import { currentViewer } from "@/lib/auth/server";
import { EngineError } from "@/lib/engine/client";
import { providerList } from "@/domain/ai/providers";
import { Empty, Heading, Panel } from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";
import { AddProvider, ProviderCard } from "./forms";
import { AiTabs } from "./tabs";

export const metadata = { title: "AI providers · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AiProvidersPage() {
  const viewer = (await currentViewer())!;

  if (!viewer.isSuperadmin) {
    return (
      <>
        <Heading title="AI providers" />
        <AiTabs on="providers" />
        <Panel flush={false}>
          <Empty>The AI providers and their keys are managed by a superadmin. Each brand&rsquo;s model is chosen on its AI settings screen.</Empty>
        </Panel>
      </>
    );
  }

  let list;

  try {
    list = await providerList(viewer);
  } catch (error) {
    if (error instanceof EngineError) {
      return (
        <>
          <Heading title="AI providers" />
          <AiTabs on="providers" />
          <p className="flash bad" role="alert">
            {error.message}
          </p>
        </>
      );
    }

    throw error;
  }

  return (
    <>
      <Heading
        title="AI providers"
        sub="The AI accounts every brand's report reading, drafting and crawling run on. A brand uses the default unless its AI settings choose another."
      >
        <Popup label="Add a provider" title="Add an AI provider">
          <AddProvider catalogue={list.catalogue} />
        </Popup>
      </Heading>

      <AiTabs on="providers" />

      <Panel title={`${list.providers.length} provider${list.providers.length === 1 ? "" : "s"}`} hint="Keys are shown by their ends only, and are never sent to this screen." flush={false}>
        {list.providers.length ? (
          list.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)
        ) : (
          <Empty>No AI provider yet. Add one, or nothing can read a report.</Empty>
        )}
      </Panel>
    </>
  );
}
