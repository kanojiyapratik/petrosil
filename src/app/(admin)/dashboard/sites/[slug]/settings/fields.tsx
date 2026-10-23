/**
 * The two field screens — directory and offers — are the same table with a
 * different `form`, so they are one component used twice.
 *
 * Each row is a field and each tick is a decision about the paywall: does a
 * reader who has not paid see the phone number on a directory entry? The old
 * arrangement spread the same answers over 44 settings rows per site with
 * names like `offer_phone_free` and no labels.
 */

import Link from "next/link";

import { brandsFor } from "@/domain/dashboard/brands";
import { listFormFields } from "@/domain/dashboard/masters";
import type { FormKind } from "@/db/schema";
import { currentViewer } from "@/lib/auth/server";
import { toggleField } from "./actions";
import { Empty, Heading, Panel, count } from "../../ui";

function Tick({
  id,
  which,
  on,
  form,
}: {
  id: number;
  which: "free" | "premium" | "enabled";
  on: boolean;
  form: FormKind;
}) {
  return (
    <form action={toggleField} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="which" value={which} />
      <input type="hidden" name="form" value={form} />
      <input type="hidden" name="to" value={on ? "0" : "1"} />
      <button className={`chip${on ? " on" : ""}`} type="submit">
        {on ? "shown" : "hidden"}
      </button>
    </form>
  );
}

export async function FieldsScreen({
  form,
  site,
  title,
  sub,
  base,
}: {
  form: FormKind;
  site: string | undefined;
  title: string;
  sub: string;
  base: string;
}) {
  const viewer = (await currentViewer())!;
  const brands = await brandsFor(viewer.siteIds);

  // One brand at a time, defaulting to the first. The paywall is decided per
  // brand, and nine brands of the same 22 fields in one table is 600 toggles
  // nobody is comparing.
  const chosen = brands.find((brand) => brand.slug === site) ?? brands[0];
  const rows = chosen
    ? await listFormFields(viewer.siteIds, form, { site: chosen.slug })
    : [];

  const paywalled = rows.filter((row) => row.enabled && !row.show_free && row.show_premium).length;

  return (
    <>
      <Heading title={title} sub={sub} />

      <div className="chips" style={{ marginBottom: 16 }}>
        {brands.map((brand) => (
          <Link
            key={brand.slug}
            className={`chip${chosen?.slug === brand.slug ? " on" : ""}`}
            href={`${base}?site=${brand.slug}`}
          >
            {brand.name}
          </Link>
        ))}
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(rows.filter((row) => row.enabled).length)}</div>
          <div className="k">fields collected</div>
        </div>
        <div className="tile">
          <div className="n">{count(paywalled)}</div>
          <div className="k">subscribers only</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.filter((row) => row.show_free).length)}</div>
          <div className="k">open to everyone</div>
        </div>
      </div>

      <Panel title="Fields" hint="Click a tick to change it. Every change is audited.">
        <table className="tight">
          <thead>
            <tr>
              <th>Field</th>
              <th>Collected</th>
              <th>A free reader sees</th>
              <th>A subscriber sees</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.label}</strong>
                  <div className="small muted">
                    <code>{row.key}</code>
                  </div>
                </td>
                <td>
                  <Tick id={row.id} which="enabled" on={row.enabled} form={form} />
                </td>
                <td>
                  <Tick id={row.id} which="free" on={row.show_free} form={form} />
                </td>
                <td>
                  <Tick id={row.id} which="premium" on={row.show_premium} form={form} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>
                    No fields defined for this form. The brand sites fall back to showing
                    everything to subscribers and nothing to the rest.
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
