"use client";

/**
 * The offer form, for a new offer and an existing one.
 *
 * The contact details are on the offer, not taken from an account: most
 * offers are typed in by staff for somebody who phoned. "Posted for" ties it
 * to a member when there is one.
 */

import { useActionState } from "react";
import Link from "next/link";

import { Attachment } from "@/app/(admin)/attachment";
import type { OfferForEdit } from "@/domain/offers/editor";
import { createOfferAction, saveOfferAction, withdrawOfferAction, type OfferFormResult } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  published: "Published: on the site",
  draft: "Draft: not on the site",
  suspended: "Suspended: taken off the site for now",
};

function Flash({ state }: { state: OfferFormResult }) {
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

function Text(props: {
  name: string;
  label: string;
  value: string | null | undefined;
  max: number;
  invalid?: boolean;
  type?: string;
  grow?: boolean;
}) {
  return (
    <div className={`field${props.grow ? " grow" : ""}`}>
      <label htmlFor={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        maxLength={props.max}
        defaultValue={props.value ?? ""}
        aria-invalid={props.invalid || undefined}
      />
    </div>
  );
}

export function OfferForm({ slug, offer }: { slug: string; offer?: OfferForEdit }) {
  const editing = offer !== undefined;
  const [state, action, pending] = useActionState(editing ? saveOfferAction : createOfferAction, null as OfferFormResult);
  const bad = (field: string) => state?.field === field;

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {editing ? <input type="hidden" name="id" value={offer.id} /> : null}

      <Flash state={state} />

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The offer</h2>
          </div>
          <div className="body">
            <div className="bar">
              <div className="field">
                <label htmlFor="offer_type">They are</label>
                <select id="offer_type" name="offer_type" defaultValue={offer?.offer_type ?? "sell"} aria-invalid={bad("offer_type") || undefined}>
                  <option value="sell">Selling</option>
                  <option value="buy">Buying</option>
                </select>
              </div>
              <div className="field grow">
                <label htmlFor="subject">Subject</label>
                <input
                  id="subject"
                  name="subject"
                  type="text"
                  required
                  maxLength={255}
                  autoFocus={!editing}
                  defaultValue={offer?.subject ?? ""}
                  aria-invalid={bad("subject") || undefined}
                />
              </div>
            </div>

            <div className="bar">
              <Text name="offer_value" label="Price or quantity" value={offer?.offer_value} max={64} />
              <Text name="keywords" label="Keywords" value={offer?.keywords} max={255} grow />
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea id="description" name="description" rows={8} defaultValue={offer?.description ?? ""} />
            </div>

            <Attachment
              site={slug}
              name="image"
              folder="offers/images"
              label="Picture"
              accept="image/*"
              initial={offer?.image ?? null}
              initialId={offer?.image_id ?? null}
              invalid={bad("image")}
            />

            <Attachment
              site={slug}
              name="file"
              folder="offers/files"
              label="Attachment"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,image/*"
              initial={offer?.file ?? null}
              initialId={offer?.file_id ?? null}
              invalid={bad("file")}
            />
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="head">
              <h2>Who it is from</h2>
            </div>
            <div className="body">
              <Text name="company_name" label="Company" value={offer?.company_name} max={191} />
              <Text name="contact_person" label="Contact person" value={offer?.contact_person} max={191} />
              <Text name="contact_email" label="Contact email" value={offer?.contact_email} max={191} type="email" invalid={bad("contact_email")} />
              <Text name="contact_phone" label="Contact phone" value={offer?.contact_phone} max={64} />
              <div className="bar">
                <Text name="city" label="City" value={offer?.city} max={96} />
                <Text name="state" label="State" value={offer?.state} max={96} />
              </div>
              <Text name="country" label="Country" value={offer?.country} max={96} />

              <div className="field">
                <label htmlFor="poster_email">Posted for (member&apos;s email)</label>
                <input
                  id="poster_email"
                  name="poster_email"
                  type="email"
                  maxLength={191}
                  defaultValue={offer?.poster_email ?? ""}
                  placeholder="nobody"
                  aria-invalid={bad("poster_email") || undefined}
                />
                <div className="small muted">
                  Ties the offer to their account. Leave blank for someone without one.
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>On the site</h2>
            </div>
            <div className="body">
              <div className="field">
                <label htmlFor="status">Status</label>
                <select id="status" name="status" defaultValue={offer?.status ?? "draft"} aria-invalid={bad("status") || undefined}>
                  {Object.entries(STATUS_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {editing ? (
                <dl className="kv">
                  <dt>Opened</dt>
                  <dd>{offer.clicks.toLocaleString("en-IN")}</dd>
                </dl>
              ) : null}
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save" : "Create offer"}
            </button>
            <Link className="button ghost" href={`/dashboard/sites/${slug}/offers`}>
              {editing ? "Back to offers" : "Cancel"}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}

/** Outside the editing form, so a stray Enter cannot take an offer down. */
export function WithdrawOffer({ slug, id }: { slug: string; id: number }) {
  const [state, action, pending] = useActionState(withdrawOfferAction, null as OfferFormResult);

  return (
    <form action={action} style={{ marginTop: 16 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <div className="note">
        <Flash state={state} />
        <strong>Withdraw this offer.</strong> It comes off the site and the lists for good. To take it down for a
        while, set it to Suspended instead. Enquiries about it keep their link either way.
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="ghost small" type="submit" disabled={pending}>
            Withdraw
          </button>
        </div>
      </div>
    </form>
  );
}
