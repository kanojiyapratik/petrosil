"use server";

/**
 * Trade feeds and the months they fetch. Each goes through
 * `domain/trade/feeds.ts`, which checks the brand and the permission.
 */

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { AccountError } from "@/domain/accounts/register";
import {
  checkFeedsNow,
  discardUpdate,
  publishUpdate,
  removeFeed,
  requestInsight,
  saveFeed,
  switchFeed,
  writeInsight,
} from "@/domain/trade/feeds";

export type FeedSaid = { error?: string; saved?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

type Viewer = NonNullable<Awaited<ReturnType<typeof currentViewer>>>;

async function run(form: FormData, what: string, change: (viewer: Viewer, slug: string) => Promise<string>): Promise<FeedSaid> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = text(form, "site");

  try {
    const saved = await change(viewer, slug);

    revalidatePath(`/dashboard/sites/${slug}/trade-feeds`, "layout");

    return { saved };
  } catch (error) {
    if (error instanceof EngineError || error instanceof AccessError || error instanceof AccountError) {
      return { error: error.message };
    }

    console.error(`could not ${what}`, { error });

    return { error: "Something went wrong. Nothing was changed." };
  }
}

export async function saveFeedAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  return run(form, "save a trade feed", async (viewer, slug) => {
    await saveFeed(viewer, {
      site: slug,
      id: text(form, "id") || undefined,
      location: text(form, "location"),
      kind: text(form, "kind"),
      source: text(form, "source"),
      hs_codes: text(form, "hs_codes"),
      product: text(form, "product"),
      auto_publish: form.get("auto_publish") !== null,
    });

    return "Feed saved. Check now to fetch its missing months.";
  });
}

export async function switchFeedAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  return run(form, "switch a trade feed", async (viewer, slug) => {
    const enabled = form.get("enabled") === "1";
    await switchFeed(viewer, { site: slug, id: text(form, "id"), enabled });

    return enabled ? "Feed switched on." : "Feed switched off.";
  });
}

export async function removeFeedAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  return run(form, "remove a trade feed", async (viewer, slug) => {
    await removeFeed(viewer, { site: slug, id: text(form, "id") });

    return "Feed removed. Figures it published stay on the sheets.";
  });
}

export async function checkNowAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  return run(form, "check the trade feeds", async (viewer, slug) => {
    const { results } = await checkFeedsNow(viewer, slug);
    const read = results.filter((r) => r.status === "staged" || r.status === "published").length;
    const failed = results.filter((r) => r.status === "failed").length;

    if (results.length === 0) {
      return "Every sheet is up to date: nothing to fetch.";
    }

    return `${read} month(s) fetched${failed ? `, ${failed} feed(s) could not be read (see below)` : ""}.`;
  });
}

export async function publishAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  const slug = text(form, "site");
  const id = Number(text(form, "id"));
  const matches: Record<string, string> = {};

  for (const [key, value] of form.entries()) {
    if (key.startsWith("match_") && String(value) !== "") {
      matches[key.slice(6)] = String(value);
    }
  }

  const said = await run(form, "publish a trade update", async (viewer) => {
    const { written, removed, siteId } = await publishUpdate(viewer, { site: slug, id, matches });

    // The insight is the model's, and slow: asked for once the page is back.
    after(() => writeInsight(siteId, id, viewer.identity.user.email).catch((error) => console.error("trade insight failed", { id, error })));

    return `Published: ${written} partner figure(s) written${removed ? `, ${removed} the source no longer lists removed` : ""}.`;
  });

  return said;
}

export async function discardAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  const said = await run(form, "discard a trade update", async (viewer, slug) => {
    await discardUpdate(viewer, { site: slug, id: text(form, "id") });

    return "Discarded.";
  });

  if (said?.saved) {
    redirect(`/dashboard/sites/${text(form, "site")}/trade-feeds?done=discarded`);
  }

  return said;
}

export async function insightAction(_state: FeedSaid, form: FormData): Promise<FeedSaid> {
  return run(form, "write a trade insight", async (viewer, slug) => {
    const { status, error } = await requestInsight(viewer, { site: slug, id: text(form, "id") });

    return status === "complete" ? "Insight written." : `The model did not write it: ${error ?? status}`;
  });
}
