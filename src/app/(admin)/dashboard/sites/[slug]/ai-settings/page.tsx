/**
 * AI settings for one brand: which model reads its reports and drafts its
 * prices, and the standing instructions the AI is given each time. The
 * providers and their keys are set up once for every brand; a brand only
 * picks among them, and no key ever reaches this screen.
 */

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { aiSettings } from "@/domain/ai/update";
import { Heading, Panel } from "@/app/(admin)/ui";
import { InstructionsForm, ModelForm } from "./forms";

export const metadata = { title: "AI settings · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AiSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  let settings;

  try {
    settings = await aiSettings(viewer, slug);
  } catch (error) {
    if (error instanceof AccessError || error instanceof EngineError) {
      return (
        <>
          <Heading title="AI settings" />
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
      <Heading title="AI settings" sub="Which AI reads this brand's reports and drafts its prices, and what it is told each time." />

      <Panel
        title="Model"
        hint="A stronger model reads drawn tables and long reports more reliably, and costs more per draft."
        flush={false}
      >
        <ModelForm slug={slug} settings={settings} />
      </Panel>

      <Panel title="Instructions to the AI" hint="Kept as they are sent with each run, so any draft can say what it was told." flush={false}>
        <InstructionsForm slug={slug} instructions={settings.instructions ?? ""} />
      </Panel>
    </>
  );
}
