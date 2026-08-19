import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

/** What Hono's html tag actually returns. */
type Html = HtmlEscapedString | Promise<HtmlEscapedString> | string

import type { ConsoleSite } from './config.js'
import type { CrawlActivity, WatchedUrl } from './site-client.js'

/**
 * Server-rendered pages, using Hono's own `html` tag.
 *
 * No SPA and no build step: every screen here is a form post and a redirect,
 * which is all this console does. Interpolations in the `html` tag are escaped
 * by default -- the only unescaped values are the ones wrapped in raw(), and
 * those are the layout fragments composed below, never site data.
 */

const STYLE = `
:root { --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --bg:#f9fafb; --accent:#2563eb;
        --ok:#047857; --warn:#b45309; --bad:#b91c1c; }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       color:var(--ink); background:var(--bg); }
a { color:var(--accent); }
header { background:#fff; border-bottom:1px solid var(--line); padding:.85rem 1.25rem;
         display:flex; align-items:center; gap:1rem; }
header .brand { font-weight:700; letter-spacing:-.01em; }
header .spacer { flex:1; }
main { max-width:64rem; margin:1.5rem auto; padding:0 1.25rem 3rem; }
h1 { font-size:1.4rem; margin:0 0 .35rem; }
h2 { font-size:1.05rem; margin:1.75rem 0 .6rem; }
p.lede { color:var(--muted); margin:0 0 1.25rem; }
.card { background:#fff; border:1px solid var(--line); border-radius:.6rem; padding:1.1rem 1.25rem;
        margin-bottom:1rem; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(15rem,1fr)); gap:1rem; }
.tile { display:block; text-decoration:none; color:inherit; }
.tile:hover { border-color:var(--accent); }
.tile strong { display:block; font-size:1.05rem; margin-bottom:.2rem; }
.tile span { color:var(--muted); font-size:.9rem; word-break:break-all; }
table { width:100%; border-collapse:collapse; font-size:.9rem; }
th,td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.badge { display:inline-block; padding:.1rem .45rem; border-radius:.3rem; font-size:.75rem; font-weight:600; }
.badge-ok { background:#ecfdf5; color:var(--ok); }
.badge-mute { background:#f3f4f6; color:var(--muted); }
.badge-warn { background:#fffbeb; color:var(--warn); }
.badge-bad { background:#fef2f2; color:var(--bad); }
textarea,input { width:100%; font:inherit; padding:.55rem .65rem; border:1px solid var(--line);
                 border-radius:.4rem; background:#fff; }
textarea { min-height:8rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85rem; }
button { font:inherit; font-weight:600; padding:.5rem .9rem; border-radius:.4rem; border:1px solid transparent;
         background:var(--accent); color:#fff; cursor:pointer; }
button.secondary { background:#fff; color:var(--ink); border-color:var(--line); }
.muted { color:var(--muted); }
.small { font-size:.85rem; }
.flash { padding:.7rem .9rem; border-radius:.4rem; margin-bottom:1rem; }
.flash-ok { background:#ecfdf5; color:var(--ok); }
.flash-bad { background:#fef2f2; color:var(--bad); }
.login { max-width:22rem; margin:5rem auto; }
.row { display:flex; gap:.5rem; align-items:center; }
`

export interface LayoutOptions {
  title: string
  user?: string | undefined
  /** Breadcrumb-ish trail rendered next to the brand. */
  trail?: Array<{ label: string; href?: string }>
}

export function layout(options: LayoutOptions, body: Html) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${options.title} · Petrosil console</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<header>
  <span class="brand"><a href="/console" style="text-decoration:none;color:inherit">Petrosil console</a></span>
  ${options.trail?.map(
    (crumb) =>
      html`<span class="muted">/</span>
        ${crumb.href ? html`<a href="${crumb.href}">${crumb.label}</a>` : html`<span>${crumb.label}</span>`}`,
  )}
  <span class="spacer"></span>
  ${options.user
    ? html`<span class="muted small">${options.user}</span>
        <form method="post" action="/console/logout" style="margin:0">
          <button class="secondary" type="submit">Sign out</button>
        </form>`
    : ''}
</header>
<main>${body}</main>
</body>
</html>`
}

export const loginPage = (error?: string) =>
  layout(
    { title: 'Sign in' },
    html`<div class="login card">
      <h1>Sign in</h1>
      <p class="lede small">The console for every Petrosil site.</p>
      ${error ? html`<div class="flash flash-bad">${error}</div>` : ''}
      <form method="post" action="/console/login">
        <p><label class="small muted">Email</label><input name="email" type="email" autocomplete="username" required autofocus></p>
        <p><label class="small muted">Password</label><input name="password" type="password" autocomplete="current-password" required></p>
        <button type="submit">Sign in</button>
      </form>
    </div>`,
  )

export const sitesPage = (sites: ConsoleSite[], user: string) =>
  layout(
    { title: 'Sites', user },
    html`<h1>Sites</h1>
      <p class="lede">Pick the site you want to work on.</p>
      ${sites.length === 0
        ? html`<div class="card muted">
            No sites are configured. Add them to <code>CONSOLE_SITES</code> and restart.
          </div>`
        : html`<div class="grid">
            ${sites.map(
              (site) => html`<a class="card tile" href="/console/sites/${site.id}">
                <strong>${site.name}</strong>
                <span>${site.apiUrl}</span>
              </a>`,
            )}
          </div>`}`,
  )

export const sitePage = (site: ConsoleSite, user: string) =>
  layout(
    { title: site.name, user, trail: [{ label: site.name }] },
    html`<h1>${site.name}</h1>
      <p class="lede">${site.apiUrl}</p>
      <div class="grid">
        <a class="card tile" href="/console/sites/${site.id}/prices">
          <strong>Update prices</strong>
          <span>Upload a sheet, bulk edit, review and commit a batch.</span>
        </a>
        <a class="card tile" href="/console/sites/${site.id}/crawler">
          <strong>Crawler</strong>
          <span>Watched URLs, and what changed on them.</span>
        </a>
      </div>`,
  )

const statusBadge = (url: WatchedUrl) => {
  const kind =
    url.last_status === 'updated'
      ? 'badge-ok'
      : url.last_status === 'no_rows'
        ? 'badge-warn'
        : url.last_status === 'blocked' || url.last_status === 'disallowed' || url.last_status === 'failed'
          ? 'badge-bad'
          : 'badge-mute'

  return html`<span class="badge ${kind}">${url.last_status_text}</span>`
}

const when = (iso: string | null) => (iso === null ? '—' : iso.replace('T', ' ').slice(0, 16))

export interface CrawlerPageData {
  site: ConsoleSite
  user: string
  urls: WatchedUrl[]
  activity: CrawlActivity[]
  intervalMinutes: number
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined
}

export const crawlerPage = (data: CrawlerPageData) =>
  layout(
    {
      title: `Crawler · ${data.site.name}`,
      user: data.user,
      trail: [{ label: data.site.name, href: `/console/sites/${data.site.id}` }, { label: 'Crawler' }],
    },
    html`<h1>Crawler</h1>
      <p class="lede">
        Each URL is checked every ${data.intervalMinutes} minutes and read with AI. Nothing is
        published: findings appear below and you stage them like any other batch.
      </p>

      ${data.flash ? html`<div class="flash flash-${data.flash.kind === 'ok' ? 'ok' : 'bad'}">${data.flash.text}</div>` : ''}

      <div class="card">
        <h2 style="margin-top:0">Watched URLs</h2>
        <form method="post" action="/console/sites/${data.site.id}/crawler/urls">
          <textarea name="text" spellcheck="false" placeholder="https://example.com/base-oil-prices">${data.urls
            .filter((url) => url.enabled)
            .map((url) => url.url)
            .join('\n')}</textarea>
          <p class="small muted">
            One per line. Removing a line stops the watch — its history is kept, not deleted.
          </p>
          <button type="submit">Save URLs</button>
        </form>

        ${data.urls.length === 0
          ? ''
          : html`<h2>What each URL last reported</h2>
              <table>
                <thead>
                  <tr><th>URL</th><th>Last check</th><th>Status</th></tr>
                </thead>
                <tbody>
                  ${data.urls.map(
                    (url) => html`<tr>
                      <td style="word-break:break-all">
                        ${url.url}
                        ${url.enabled ? '' : html`<span class="badge badge-mute">stopped</span>`}
                        ${url.last_notes ? html`<div class="small muted">“${url.last_notes}”</div>` : ''}
                        ${url.last_error ? html`<div class="small" style="color:var(--bad)">${url.last_error}</div>` : ''}
                      </td>
                      <td class="small muted">${when(url.last_checked_at)}</td>
                      <td>${statusBadge(url)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>`}
      </div>

      <div class="card">
        <h2 style="margin-top:0">Recent activity</h2>
        ${data.activity.length === 0
          ? html`<p class="small muted" style="margin:0">
              No price changes yet. Only movement is recorded, so this stays empty until a
              watched page actually moves a price.
            </p>`
          : html`<form method="post" action="/console/sites/${data.site.id}/crawler/stage">
              <table>
                <thead>
                  <tr>
                    <th></th><th>Location</th><th>Price date</th>
                    <th class="num">On the page</th><th class="num">Site holds</th>
                    <th class="num">Move</th><th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.activity.map(
                    (row) => html`<tr>
                      <td>
                        <input type="checkbox" name="activity_ids" value="${row.id}"
                          ${row.differs_from_site ? raw('checked') : ''}>
                      </td>
                      <td>
                        ${row.location}
                        ${row.url ? html`<div class="small muted">${new URL(row.url).hostname}</div>` : ''}
                      </td>
                      <td>${row.price_date ?? '—'}</td>
                      <td class="num"><strong>${row.price}</strong></td>
                      <td class="num">${row.site_price === null ? html`<span class="muted">none</span>` : row.site_price}</td>
                      <td class="num">
                        ${row.change_type === 'new'
                          ? html`<span class="badge badge-mute">first seen</span>`
                          : row.change_pct === null
                            ? html`<span class="badge badge-warn">changed</span>`
                            : html`<span class="badge ${row.change_pct >= 0 ? 'badge-ok' : 'badge-bad'}">
                                ${row.change_pct >= 0 ? '+' : ''}${row.change_pct}%
                              </span>`}
                      </td>
                      <td class="small muted">${when(row.detected_at)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
              <p class="small muted">
                Rows that differ from what the site holds are ticked for you. Nothing is committed
                until you commit it on the site's preview screen.
              </p>
              <button type="submit">Stage selected as a batch</button>
            </form>`}
      </div>`,
  )

export const errorPage = (title: string, message: string, user?: string) =>
  layout(
    { title, user },
    html`<h1>${title}</h1>
      <div class="card"><p style="margin:0">${message}</p></div>
      <p><a href="/console">Back to sites</a></p>`,
  )
