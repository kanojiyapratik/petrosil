"use client";

/**
 * An ad: what it shows (a picture, a video or embed code), where, between
 * which dates, and where it links to.
 */

import { useActionState, useState } from "react";
import Link from "next/link";

import { Attachment } from "@/app/(admin)/attachment";
import type { AdForEdit } from "@/domain/ads/editor";
import { saveAdAction, withdrawAdAction, type AdResult } from "./actions";

function Flash({ state }: { state: AdResult }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  return state?.saved ? (
    <p className="flash" role="status">
      {state.saved}
    </p>
  ) : null;
}

export function AdForm({
  slug,
  slots,
  ad,
}: {
  slug: string;
  slots: { id: number; title: string; enabled: boolean }[];
  ad?: AdForEdit;
}) {
  const [state, action, pending] = useActionState(saveAdAction, null as AdResult);
  const [type, setType] = useState(ad?.ad_type ?? "image");
  const bad = (field: string) => state?.field === field || undefined;

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {ad ? <input type="hidden" name="id" value={ad.id} /> : null}

      <Flash state={state} />

      <div className="cols wide">
        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>The ad</h2>
            </div>
            <div className="body">
              <div className="field">
                <label htmlFor="title">Name</label>
                <input id="title" name="title" type="text" required maxLength={191} autoFocus={!ad} defaultValue={ad?.title ?? ""} aria-invalid={bad("title")} />
                <div className="small muted">For finding it in this list. Readers do not see it.</div>
              </div>

              <div className="field">
                <label htmlFor="ad_type">It shows</label>
                <select id="ad_type" name="ad_type" value={type} onChange={(event) => setType(event.target.value)} aria-invalid={bad("ad_type")}>
                  <option value="image">A picture</option>
                  <option value="video">A video</option>
                  <option value="code">Embed code (Google and other ad networks)</option>
                </select>
              </div>

              {type === "image" ? (
                <Attachment
                  site={slug}
                  name="image"
                  folder="ads/images"
                  label="Picture"
                  accept="image/*"
                  initial={ad?.image ?? null}
                  initialId={ad?.image_id ?? null}
                  invalid={state?.field === "image"}
                />
              ) : null}

              {type === "video" ? (
                <Attachment
                  site={slug}
                  name="video"
                  folder="ads/video"
                  label="Video"
                  accept="video/mp4,video/webm"
                  initial={ad?.video ?? null}
                  initialId={ad?.video_id ?? null}
                  invalid={state?.field === "video"}
                />
              ) : null}

              {type === "code" ? (
                <div className="field">
                  <label htmlFor="code">Embed code</label>
                  <textarea id="code" name="code" className="code" rows={8} defaultValue={ad?.code ?? ""} aria-invalid={bad("code")} />
                  <div className="small muted">Runs on the brand site exactly as pasted. Only paste code from the ad network.</div>
                </div>
              ) : null}

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="url">Links to</label>
                <input id="url" name="url" type="text" inputMode="url" maxLength={2000} placeholder="https://" defaultValue={ad?.url ?? ""} aria-invalid={bad("url")} />
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>Where and when</h2>
            </div>
            <div className="body">
              <div className="field">
                <label htmlFor="placement_id">Slot</label>
                <select id="placement_id" name="placement_id" defaultValue={ad?.placement_id ?? slots[0]?.id ?? ""} aria-invalid={bad("placement_id")}>
                  <option value="">No slot (not shown)</option>
                  {slots.map((slot) => (
                    <option key={slot.id} value={slot.id}>
                      {slot.title}
                      {slot.enabled ? "" : " (switched off)"}
                    </option>
                  ))}
                </select>
              </div>

              <div className="split" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                <div>
                  <label htmlFor="starts_at">From</label>
                  <input id="starts_at" name="starts_at" type="date" defaultValue={ad?.starts_at ?? ""} aria-invalid={bad("starts_at")} />
                </div>
                <div>
                  <label htmlFor="ends_at">Until (last day)</label>
                  <input id="ends_at" name="ends_at" type="date" defaultValue={ad?.ends_at ?? ""} aria-invalid={bad("ends_at")} />
                </div>
              </div>

              <div className="field">
                <label htmlFor="sort_order">Position in the slot</label>
                <input id="sort_order" name="sort_order" type="number" step={1} defaultValue={ad?.sort_order ?? 0} style={{ maxWidth: 120 }} />
              </div>

              <div className="checks" style={{ gridTemplateColumns: "1fr" }}>
                <label className="check">
                  <input type="checkbox" name="enabled" defaultChecked={ad?.enabled ?? true} />
                  Switched on
                </label>
                <label className="check">
                  <input type="checkbox" name="on_dashboard" defaultChecked={ad?.on_dashboard ?? false} />
                  On the website
                </label>
                <label className="check">
                  <input type="checkbox" name="on_newsletter" defaultChecked={ad?.on_newsletter ?? false} />
                  Also in newsletters
                </label>
              </div>

              {ad ? (
                <p className="small muted" style={{ margin: "14px 0 0" }}>
                  {ad.clicks.toLocaleString("en-IN")} clicks recorded.
                </p>
              ) : null}
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : ad ? "Save" : "Create ad"}
            </button>
            <Link className="button ghost" href={`/dashboard/sites/${slug}/ads`}>
              {ad ? "Back to ads" : "Cancel"}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}

/** Outside the editing form, so a stray Enter cannot take an ad down. */
export function WithdrawAd({ slug, id }: { slug: string; id: number }) {
  const [state, action, pending] = useActionState(withdrawAdAction, null as AdResult);

  return (
    <form action={action} style={{ marginTop: 16 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <div className="note">
        <Flash state={state} />
        <strong>Withdraw this ad.</strong> It comes off the site and this list. Its click count is kept. To pause it,
        untick Switched on instead.
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="ghost small" type="submit" disabled={pending}>
            Withdraw
          </button>
        </div>
      </div>
    </form>
  );
}
