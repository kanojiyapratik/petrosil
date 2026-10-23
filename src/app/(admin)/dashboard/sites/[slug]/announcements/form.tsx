"use client";

/**
 * Writing a notice.
 *
 * Both dates are optional and say so in words rather than with a blank box:
 * no start means it is running now, no end means until somebody takes it
 * down. That is how `liveAnnouncements` reads them, and it is the one thing
 * about this form that is not obvious from looking at it.
 */

import { useActionState } from "react";

import { saveNotice, type NoticeResult } from "./actions";
import type { Brand } from "@/domain/dashboard/brands";

export type Notice = {
  id: number;
  site: string;
  body: string;
  link: string | null;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
};

export function NoticeForm({
  brands,
  notice,
  onlySite,
}: {
  brands: Brand[];
  notice?: Notice;
  onlySite?: string;
}) {
  const [state, action, pending] = useActionState(saveNotice, null as NoticeResult);
  const editing = notice !== undefined;

  return (
    <form action={action}>
      {editing ? <input type="hidden" name="id" value={notice.id} /> : null}
      {editing || onlySite ? (
        <input type="hidden" name="site" value={notice?.site ?? onlySite ?? ""} />
      ) : null}

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <p className="flash" role="status">
          {state.saved}
        </p>
      ) : null}

      <div className="bar">
        {!editing && !onlySite ? (
          <div className="field">
            <label htmlFor="site">Brand</label>
            <select id="site" name="site" defaultValue={brands[0]?.slug ?? ""} required>
              {brands.map((brand) => (
                <option key={brand.slug} value={brand.slug}>
                  {brand.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="field grow">
          <label htmlFor={`body-${notice?.id ?? "new"}`}>The notice</label>
          <input
            id={`body-${notice?.id ?? "new"}`}
            name="body"
            type="text"
            maxLength={2000}
            defaultValue={notice?.body ?? ""}
            placeholder="The 24 October report is out."
            required
          />
        </div>

        <div className="field grow">
          <label htmlFor={`link-${notice?.id ?? "new"}`}>Links to (optional)</label>
          <input
            id={`link-${notice?.id ?? "new"}`}
            name="link"
            type="text"
            maxLength={512}
            defaultValue={notice?.link ?? ""}
          />
        </div>

        <div className="field">
          <label htmlFor={`from-${notice?.id ?? "new"}`}>From</label>
          <input
            id={`from-${notice?.id ?? "new"}`}
            name="starts_at"
            type="date"
            defaultValue={notice?.starts_at ?? ""}
          />
        </div>

        <div className="field">
          <label htmlFor={`until-${notice?.id ?? "new"}`}>Until</label>
          <input
            id={`until-${notice?.id ?? "new"}`}
            name="ends_at"
            type="date"
            defaultValue={notice?.ends_at ?? ""}
          />
        </div>

        <div className="field">
          <label>
            <input type="checkbox" name="enabled" defaultChecked={notice?.enabled ?? true} />{" "}
            On
          </label>
        </div>

        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save" : "Add"}
        </button>
      </div>

      {!editing ? (
        <p className="small muted" style={{ margin: ".4rem 0 0" }}>
          Leave <strong>From</strong> empty for a notice that runs now, and{" "}
          <strong>Until</strong> empty for one that runs until somebody takes it down. The last
          day counts.
        </p>
      ) : null}
    </form>
  );
}
