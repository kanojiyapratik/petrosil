"use client";

/**
 * The forms on the global screens.
 *
 * Each starts from one of the versions the brands already have (the biggest
 * group by default), and applies to the brands ticked. `{brand}` in the text
 * is written as each brand's own name.
 */

import { useActionState, useState } from "react";

import { applyEmailAction, applyFieldAction, applyPageAction, newPageAction, type GlobalResult } from "./actions";

type Brand = { slug: string; name: string };

function Flash({ state }: { state: GlobalResult }) {
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

/** Tick boxes for the brands, with "All brands" to tick or untick them all. */
function BrandTicks({ brands, chosen, onChange }: { brands: Brand[]; chosen: string[]; onChange: (next: string[]) => void }) {
  const all = brands.length > 0 && brands.every((brand) => chosen.includes(brand.slug));

  return (
    <div className="checks">
      {brands.length > 1 ? (
        <label className="check all">
          <input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked ? brands.map((b) => b.slug) : [])} />
          All brands
        </label>
      ) : null}
      {brands.map((brand) => (
        <label className="check" key={brand.slug}>
          <input
            type="checkbox"
            name="site"
            value={brand.slug}
            checked={chosen.includes(brand.slug)}
            onChange={(event) =>
              onChange(event.target.checked ? [...new Set([...chosen, brand.slug])] : chosen.filter((slug) => slug !== brand.slug))
            }
          />
          {brand.name}
        </label>
      ))}
    </div>
  );
}

/** Which existing version to start from. */
function VersionPicker<T extends { brands: Brand[] }>({
  versions,
  at,
  onPick,
}: {
  versions: T[];
  at: number;
  onPick: (index: number) => void;
}) {
  if (versions.length < 2) {
    return null;
  }

  return (
    <div className="field">
      <label htmlFor="version">Start from</label>
      <select id="version" value={at} onChange={(event) => onPick(Number(event.target.value))}>
        {versions.map((version, index) => (
          <option key={index} value={index}>
            Version {index + 1}: {version.brands.map((brand) => brand.name).join(", ")}
          </option>
        ))}
      </select>
    </div>
  );
}

const MARKER_NOTE = "Write {brand} where the brand's name goes: it becomes Base Oil Report, Bitumart … on each.";

/* ------------------------------------------------------------------ pages */

type PageVersion = { title: string; body: string; visible: boolean; brands: Brand[] };

export function GlobalPageForm({ slug, versions, brands }: { slug: string; versions: PageVersion[]; brands: Brand[] }) {
  const [state, action, pending] = useActionState(applyPageAction, null as GlobalResult);
  const [at, setAt] = useState(0);
  // The brands that have this page, to start with: ticking every brand would hand a one-brand page to all nine.
  const [chosen, setChosen] = useState(versions.flatMap((v) => v.brands.map((brand) => brand.slug)));
  const version = versions[at]!;

  return (
    <form action={action} key={at}>
      <input type="hidden" name="slug" value={slug} />
      <Flash state={state} />

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The page</h2>
          </div>
          <div className="body">
            <VersionPicker versions={versions} at={at} onPick={setAt} />
            <div className="bar" style={{ marginBottom: 14 }}>
              <div className="field grow">
                <label htmlFor="title">Title</label>
                <input id="title" name="title" type="text" required maxLength={255} defaultValue={version.title} />
              </div>
              <div className="field grow">
                <label htmlFor="new_slug">Address</label>
                <input id="new_slug" name="new_slug" type="text" maxLength={191} defaultValue={slug} />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="body">Body (HTML)</label>
              <textarea id="body" name="body" className="code" rows={22} defaultValue={version.body} />
              <div className="small muted">
                {MARKER_NOTE} Changing the address moves the page on the brands ticked, and every link to the old one
                stops working.
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>Apply to</h2>
            </div>
            <div className="body">
              <BrandTicks brands={brands} chosen={chosen} onChange={setChosen} />
              <label className="check" style={{ marginTop: 14 }}>
                <input type="checkbox" name="visible" defaultChecked={version.visible} />
                Shown on the brand sites
              </label>
            </div>
          </div>
          <div className="actions">
            <button type="submit" name="intent" value="apply" disabled={pending || chosen.length === 0}>
              {pending ? "Applying…" : `Apply to ${chosen.length} brand${chosen.length === 1 ? "" : "s"}`}
            </button>
            <button type="submit" name="intent" value="remove" className="ghost" disabled={pending || chosen.length === 0}>
              Delete from them
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Apply replaces each ticked brand&apos;s own page, and gives one to a ticked brand without it. Delete removes
            it from the ticked brands; the audit trail keeps the words. Brands not ticked are left as they are.
          </p>
        </div>
      </div>
    </form>
  );
}

/** Start a new page on the ticked brands: it opens next for its words, hidden until you show it. */
export function NewGlobalPage({ brands }: { brands: Brand[] }) {
  const [state, action, pending] = useActionState(newPageAction, null as GlobalResult);
  const [chosen, setChosen] = useState(brands.map((brand) => brand.slug));

  return (
    <form action={action}>
      <Flash state={state} />
      <div className="bar" style={{ marginBottom: 12 }}>
        <div className="field grow">
          <label htmlFor="new-title">Title</label>
          <input id="new-title" name="title" type="text" required maxLength={255} placeholder="Advertise with {brand}" />
        </div>
        <div className="field grow">
          <label htmlFor="new-slug">Address</label>
          <input id="new-slug" name="slug" type="text" maxLength={191} placeholder="made from the title" />
        </div>
        <button type="submit" disabled={pending || chosen.length === 0}>
          {pending ? "Creating…" : `Create on ${chosen.length} brand${chosen.length === 1 ? "" : "s"}`}
        </button>
      </div>
      <BrandTicks brands={brands} chosen={chosen} onChange={setChosen} />
    </form>
  );
}

/* ---------------------------------------------------------- system emails */

type EmailVersion = { subject: string; body: string; enabled: boolean; brands: Brand[] };

export function GlobalEmailForm({
  emailKey,
  variant,
  versions,
  brands,
}: {
  emailKey: string;
  variant: string;
  versions: EmailVersion[];
  brands: Brand[];
}) {
  const [state, action, pending] = useActionState(applyEmailAction, null as GlobalResult);
  const [at, setAt] = useState(0);
  // The brands that have this email, to start with.
  const [chosen, setChosen] = useState(versions.flatMap((v) => v.brands.map((brand) => brand.slug)));
  const version = versions[at]!;

  return (
    <form action={action} key={at}>
      <input type="hidden" name="key" value={emailKey} />
      <input type="hidden" name="variant" value={variant} />
      <Flash state={state} />

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The email</h2>
          </div>
          <div className="body">
            <VersionPicker versions={versions} at={at} onPick={setAt} />
            <div className="field">
              <label htmlFor="subject">Subject</label>
              <input id="subject" name="subject" type="text" required maxLength={255} defaultValue={version.subject} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="body">Body (HTML)</label>
              <textarea id="body" name="body" className="code" rows={20} defaultValue={version.body} />
              <div className="small muted">
                {MARKER_NOTE} The email&apos;s own placeholders, like {"{name}"}, are filled when it is sent.
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>Apply to</h2>
            </div>
            <div className="body">
              <BrandTicks brands={brands} chosen={chosen} onChange={setChosen} />
              <label className="check" style={{ marginTop: 14 }}>
                <input type="checkbox" name="enabled" defaultChecked={version.enabled} />
                Sent (untick to stop this email on the brands ticked)
              </label>
            </div>
          </div>
          <div className="actions">
            <button type="submit" disabled={pending || chosen.length === 0}>
              {pending ? "Applying…" : `Apply to ${chosen.length} brand${chosen.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------- field visibility */

/** The brands a field rule applies to, chosen once for the whole screen. */
export function VisibilityTable({
  brands,
  forms,
}: {
  brands: Brand[];
  forms: {
    form: "directory" | "offer";
    title: string;
    rows: { key: string; label: string; brands: number; of: number; free: number; premium: number; enabled: number; agreed: boolean }[];
  }[];
}) {
  const [chosen, setChosen] = useState(brands.map((brand) => brand.slug));

  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="head">
          <h2>Apply to</h2>
          <span className="spacer" />
          <span className="hint">Every Apply below sets the field on these brands.</span>
        </div>
        <div className="body">
          <BrandTicks brands={brands} chosen={chosen} onChange={setChosen} />
        </div>
      </div>

      {forms.map((section) => (
        <div className="panel" key={section.form} style={{ marginBottom: 16 }}>
          <div className="head">
            <h2>{section.title}</h2>
          </div>
          <table className="tight">
            <thead>
              <tr>
                <th>Field</th>
                <th>Now</th>
                <th>Free readers see it</th>
                <th>Paying readers see it</th>
                <th>Shown at all</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <FieldRow key={row.key} form={section.form} row={row} chosen={chosen} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

function FieldRow({
  form,
  row,
  chosen,
}: {
  form: "directory" | "offer";
  row: { key: string; label: string; brands: number; of: number; free: number; premium: number; enabled: number; agreed: boolean };
  chosen: string[];
}) {
  const [state, action, pending] = useActionState(applyFieldAction, null as GlobalResult);
  const id = `field-${form}-${row.key}`;
  // A box starts ticked when most brands have it ticked.
  const most = (n: number) => n * 2 > row.brands;

  return (
    <tr>
      <td>
        <form id={id} action={action}>
          <input type="hidden" name="form" value={form} />
          <input type="hidden" name="key" value={row.key} />
          {chosen.map((slug) => (
            <input key={slug} type="hidden" name="site" value={slug} />
          ))}
        </form>
        <strong>{row.label}</strong>
        {state?.error ? <div className="small bad">{state.error}</div> : state?.saved ? <div className="small muted">{state.saved}</div> : null}
      </td>
      <td>
        {row.agreed ? (
          <span className="badge ok">same on {row.brands}</span>
        ) : (
          <span className="badge warn">differs</span>
        )}
        <div className="small muted">
          free {row.free}/{row.brands} · paying {row.premium}/{row.brands}
        </div>
      </td>
      <td>
        <input form={id} type="checkbox" name="show_free" defaultChecked={most(row.free)} aria-label={`${row.label}: free readers`} />
      </td>
      <td>
        <input form={id} type="checkbox" name="show_premium" defaultChecked={most(row.premium)} aria-label={`${row.label}: paying readers`} />
      </td>
      <td>
        <input form={id} type="checkbox" name="enabled" defaultChecked={most(row.enabled)} aria-label={`${row.label}: shown`} />
      </td>
      <td>
        <button form={id} type="submit" className="small" disabled={pending || chosen.length === 0}>
          {pending ? "Applying…" : "Apply"}
        </button>
      </td>
    </tr>
  );
}
