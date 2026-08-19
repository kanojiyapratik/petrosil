import { html, raw } from 'hono/html'

import type { StoredSite, StoredUser } from '../db/store.js'
import type { BatchEnvelope, BatchSummary } from './site-client.js'
import { flashOf, layout, when } from './views.js'
import type { Flash } from './views.js'

/**
 * The price-update screens: stage a batch, review every row, commit.
 *
 * Split from views.ts because these are the biggest screens in the console and
 * the two sets share nothing but the layout.
 *
 * The statuses and the rules around them are the site's, mirrored here so the
 * screen tells the truth about what will happen. Getting them wrong would show
 * an admin a commit button the site is going to refuse.
 */

const STATUS_TONE: Record<string, string> = {
  changed: 'ok',
  new: 'ok',
  unchanged: 'mute',
  locked: 'mute',
  ambiguous: 'warn',
  unmatched: 'warn',
  invalid: 'bad',
  conflict: 'bad',
}

/** Rows the site refuses to commit while they are still included. */
const NEEDS_ATTENTION = new Set(['ambiguous', 'unmatched', 'invalid'])

/** Rows whose value the site will let an admin change. */
const VALUE_EDITABLE = new Set(['changed', 'new', 'ambiguous', 'unmatched'])

const statusPill = (status: string) =>
  html`<span class="badge ${STATUS_TONE[status] ?? 'mute'}">${status}</span>`

export interface PricesPageData {
  site: StoredSite
  user: StoredUser
  batches: BatchSummary[]
  locations: Array<{ id: number; title: string }>
  flash?: Flash | undefined
}

export const pricesPage = (data: PricesPageData) =>
  layout(
    {
      title: `Prices · ${data.site.name}`,
      user: data.user,
      crumbs: [
        { label: data.site.name, href: `/console/sites/${data.site.id}` },
        { label: 'Update prices' },
      ],
      nav: { siteSlug: data.site.id, section: 'prices' },
    },
    html`<h1>Update prices</h1>
      <p class="lede">
        Stage a batch, review every row, then commit. Nothing reaches the site's live prices until
        you commit, and a committed batch can be rolled back.
      </p>
      ${flashOf(data.flash)}

      <div class="panel">
        <div class="head"><h2>Upload a price file</h2></div>
        <div class="body">
          <form method="post" action="/console/sites/${data.site.id}/prices/upload" enctype="multipart/form-data">
            <div class="fields">
              <div class="field">
                <label for="file">Spreadsheet</label>
                <input id="file" type="file" name="file" accept=".csv,.xls,.xlsx" required>
              </div>
              <div class="field">
                <label for="pricedate">Price date</label>
                <input id="pricedate" type="date" name="pricedate">
              </div>
            </div>
            <p class="hint">
              Two layouts work: <strong>location, price</strong>, where the date above covers every
              row, or <strong>location, date, price</strong>, where each row's own date wins. A
              header row is skipped. Up to 5000 rows.
            </p>
            <div class="actions"><button type="submit">Upload and preview</button></div>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="head"><h2>Bulk edit</h2></div>
        <div class="body">
          <form method="post" action="/console/sites/${data.site.id}/prices/bulk">
            <div class="field">
              <label for="location_ids">Locations</label>
              <select id="location_ids" name="location_ids" multiple size="8" required>
                ${data.locations.map(
                  (location) => html`<option value="${location.id}">${location.title}</option>`,
                )}
              </select>
              <p class="hint">Hold Ctrl (or Cmd) to pick several.</p>
            </div>
            <div class="field">
              <label for="operation">Operation</label>
              <select id="operation" name="operation" required>
                <option value="set">Set an absolute price</option>
                <option value="adjust">Adjust by an amount (+/-)</option>
                <option value="copy">Copy one date's prices to other dates</option>
              </select>
            </div>
            <div class="fields">
              <div class="field">
                <label for="date_from">Date from <span class="muted">(set / adjust)</span></label>
                <input id="date_from" type="date" name="date_from">
              </div>
              <div class="field"><label for="date_to">Date to</label><input id="date_to" type="date" name="date_to"></div>
              <div class="field"><label for="value">Value</label><input id="value" type="number" step="any" name="value"></div>
            </div>
            <div class="fields">
              <div class="field">
                <label for="source_date">Source date <span class="muted">(copy)</span></label>
                <input id="source_date" type="date" name="source_date">
              </div>
              <div class="field">
                <label for="target_date_from">Target from</label>
                <input id="target_date_from" type="date" name="target_date_from">
              </div>
              <div class="field">
                <label for="target_date_to">Target to</label>
                <input id="target_date_to" type="date" name="target_date_to">
              </div>
            </div>
            <div class="actions"><button type="submit">Preview changes</button></div>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="head"><h2>Recent batches</h2></div>
        ${data.batches.length === 0
          ? html`<div class="body empty">No batches yet.</div>`
          : html`<table>
              <thead><tr><th>#</th><th>Source</th><th>Rows</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                ${data.batches.map(
                  (batch) => html`<tr>
                    <td><a href="/console/sites/${data.site.id}/prices/${batch.id}">#${batch.id}</a></td>
                    <td>${batch.source}</td>
                    <td>${batch.items_count ?? '—'}</td>
                    <td>${statusPill(batch.status)}</td>
                    <td class="small muted">${when(batch.created_at ?? null)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>`,
  )

export interface BatchPageData {
  site: StoredSite
  user: StoredUser
  envelope: BatchEnvelope
  locations: Array<{ id: number; title: string }>
  flash?: Flash | undefined
}

export const batchPage = (data: BatchPageData) => {
  const { batch, summary, committable } = data.envelope
  const needsAttention = data.envelope.needs_attention
  const items = data.envelope.items ?? []
  const base = `/console/sites/${data.site.id}/prices`
  const draft = batch.status === 'draft'

  return layout(
    {
      title: `Batch #${batch.id} · ${data.site.name}`,
      user: data.user,
      crumbs: [
        { label: data.site.name, href: `/console/sites/${data.site.id}` },
        { label: 'Update prices', href: base },
        { label: `Batch #${batch.id}` },
      ],
      nav: { siteSlug: data.site.id, section: 'prices' },
    },
    html`<h1>Batch #${batch.id}</h1>
      <p class="lede">
        ${batch.source} · ${statusPill(batch.status)} · ${items.length}
        row${items.length === 1 ? '' : 's'}
      </p>
      ${flashOf(data.flash)}

      <div class="panel">
        <div class="head">
          <h2>Summary</h2><span class="spacer"></span>
          ${committable
            ? html`<span class="badge ok">ready to commit</span>`
            : html`<span class="badge warn">${needsAttention} row(s) need attention</span>`}
        </div>
        <div class="body">
          ${Object.entries(summary).filter(([, count]) => count > 0).length === 0
            ? html`<span class="empty">Nothing staged.</span>`
            : Object.entries(summary)
                .filter(([, count]) => count > 0)
                .map(
                  ([status, count]) =>
                    html`<span style="margin-right:1rem">${statusPill(status)} ${count}</span>`,
                )}
        </div>
        ${draft
          ? html`<div class="body" style="border-top:1px solid var(--line)">
              <div class="actions">
                <form method="post" action="${base}/${batch.id}/commit" style="margin:0"
                  onsubmit="return confirm('Commit this batch to live prices?')">
                  <button type="submit"
                    ${committable ? '' : raw('disabled style="opacity:.5;cursor:not-allowed"')}>
                    Commit to live prices
                  </button>
                </form>
                <form method="post" action="${base}/${batch.id}/discard" style="margin:0"
                  onsubmit="return confirm('Discard this batch? Nothing will be published.')">
                  <button class="ghost" type="submit">Discard</button>
                </form>
              </div>
              ${committable
                ? html`<p class="hint">
                    Every included row is clean. Committing writes them to the site's live prices.
                  </p>`
                : html`<p class="hint">
                    Rows marked <strong>ambiguous</strong>, <strong>unmatched</strong> or
                    <strong>invalid</strong> block a commit while they are included. Fix them, or
                    untick them to leave them out.
                  </p>`}
            </div>`
          : batch.status === 'committed'
            ? html`<div class="body" style="border-top:1px solid var(--line)">
                <form method="post" action="${base}/${batch.id}/rollback" style="margin:0"
                  onsubmit="return confirm('Roll this batch back? Live prices return to what they were.')">
                  <button class="danger" type="submit">Roll back</button>
                </form>
                <p class="hint">Restores every price this batch changed to what it was before.</p>
              </div>`
            : ''}
      </div>

      <div class="panel">
        <div class="head"><h2>Rows</h2></div>
        ${items.length === 0
          ? html`<div class="body empty">No rows.</div>`
          : html`<table>
              <thead><tr>
                <th>In</th><th>Location</th><th>Date</th>
                <th class="num">Now</th><th class="num">New</th><th class="num">Move</th>
                <th>Status</th>${draft ? html`<th></th>` : ''}
              </tr></thead>
              <tbody>
                ${items.map((item) => {
                  const action = `${base}/${batch.id}/items/${item.id}`
                  const editable = draft && VALUE_EDITABLE.has(item.status)

                  return html`<tr>
                    <td>
                      ${draft
                        ? html`<form method="post" action="${action}" style="margin:0">
                            <input type="hidden" name="is_included" value="${item.is_included ? '0' : '1'}">
                            <button class="link" type="submit"
                              title="${item.is_included ? 'Leave this row out' : 'Put this row back in'}">
                              ${item.is_included ? '☑' : '☐'}
                            </button>
                          </form>`
                        : item.is_included
                          ? '☑'
                          : '☐'}
                    </td>
                    <td>
                      ${item.location ?? html`<span class="muted">${item.raw_location ?? '—'}</span>`}
                      ${item.location === null && item.raw_location
                        ? html`<div class="quote">read as “${item.raw_location}”</div>`
                        : ''}
                      ${item.error_message ? html`<div class="err">${item.error_message}</div>` : ''}
                    </td>
                    <td class="small">${item.pricedate ?? '—'}</td>
                    <td class="num">
                      ${item.old_price === null ? html`<span class="muted">none</span>` : item.old_price}
                    </td>
                    <td class="num">
                      ${editable
                        ? html`<form method="post" action="${action}" style="margin:0;display:flex;gap:.3rem;justify-content:flex-end">
                            <input type="number" step="any" name="new_price" value="${item.new_price}"
                              style="width:7rem;padding:.25rem .4rem">
                            <button class="ghost" type="submit" style="padding:.25rem .5rem">Save</button>
                          </form>`
                        : html`<strong>${item.new_price}</strong>`}
                    </td>
                    <td class="num">
                      ${item.delta_pct === null
                        ? html`<span class="muted">—</span>`
                        : html`<span class="badge ${item.delta_pct >= 0 ? 'ok' : 'bad'}">${item.delta_pct >= 0 ? '+' : ''}${item.delta_pct}%</span>`}
                    </td>
                    <td>
                      ${statusPill(item.status)}
                      ${NEEDS_ATTENTION.has(item.status) && item.is_included
                        ? html`<div class="quote">blocks commit</div>`
                        : ''}
                    </td>
                    ${draft
                      ? html`<td>
                          ${item.status === 'unmatched' || item.status === 'ambiguous'
                            ? html`<form method="post" action="${action}" style="margin:0;display:flex;gap:.3rem">
                                <select name="location_id" style="min-width:11rem;padding:.25rem .4rem">
                                  <option value="">Pick a location…</option>
                                  ${data.locations.map(
                                    (location) =>
                                      html`<option value="${location.id}">${location.title}</option>`,
                                  )}
                                </select>
                                <button class="ghost" type="submit" style="padding:.25rem .5rem">Set</button>
                              </form>`
                            : ''}
                        </td>`
                      : ''}
                  </tr>`
                })}
              </tbody>
            </table>`}
      </div>`,
  )
}
