"use server";

/**
 * Changing what the crawler watches.
 *
 * `replaceWatchedUrls` does the work and already holds the two rules worth
 * knowing: a URL dropped from the list is **disabled, not deleted**, because
 * its findings are the history and a typo must not cascade that away; and if
 * any line is not an http(s) URL, nothing at all is saved — so a bad paste
 * cannot half-apply.
 *
 * The brand is resolved from its slug and checked against the grant here,
 * because the slug arrives from a form and `replaceWatchedUrls` takes a site
 * id it trusts.
 */

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, sites } from "@/db/schema";
import { currentViewer } from "@/lib/auth/server";
import { InvalidUrls, replaceWatchedUrls } from "@/domain/crawl/urls";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type WatchResult = { error?: string; saved?: string } | null;

export async function saveWatchedUrls(_state: unknown, form: FormData): Promise<WatchResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = String(form.get("site") ?? "").trim();
  const [brand] = await db().select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand || (viewer.siteIds.length > 0 && !viewer.siteIds.includes(brand.id))) {
    return { error: "That brand is not yours to change." };
  }

  try {
    const result = await replaceWatchedUrls(brand.id, {
      text: String(form.get("urls") ?? ""),
      instructions: String(form.get("instructions") ?? ""),
    });

    await db()
      .insert(auditLog)
      .values({
        siteId: brand.id,
        userId: viewer.identity.user.id,
        action: "crawl.urls.replace",
        entity: "price_crawl_urls",
        detail: { ...result },
        ip: await callerIp(),
      });

    revalidatePath("/dashboard/sites/[slug]", "layout");

    const said = [
      `${result.watched} watched`,
      result.added ? `${result.added} added` : null,
      result.reenabled ? `${result.reenabled} started again` : null,
      result.stopped ? `${result.stopped} stopped` : null,
    ].filter(Boolean);

    return { saved: `${said.join(", ")}.` };
  } catch (error) {
    if (error instanceof InvalidUrls) {
      return {
        error:
          `Not an http or https address: ${error.invalid.slice(0, 3).join(", ")}` +
          (error.invalid.length > 3 ? ` and ${error.invalid.length - 3} more` : "") +
          ". Nothing was saved.",
      };
    }

    console.error("could not replace the watch list", { slug, error });

    return { error: "Something went wrong. Nothing was saved." };
  }
}
