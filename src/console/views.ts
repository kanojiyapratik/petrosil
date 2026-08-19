import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

import type { AuditEntry, StoredSite, StoredUser } from '../db/store.js'
import type { CrawlActivity, WatchedUrl } from './site-client.js'

/**
 * Server-rendered pages, using Hono's own `html` tag.
 *
 * No SPA and no build step: every screen is a form post and a redirect, which
 * is all this console does. Interpolations in the `html` tag are escaped by
 * default; the only unescaped values are wrapped in raw(), and those are the
 * stylesheet and layout fragments composed here -- never site data.
 */

type Html = HtmlEscapedString | Promise<HtmlEscapedString> | string

export interface Flash {
  kind: 'ok' | 'bad'
  text: string
}

const STYLE = `
*,*::before,*::after { box-sizing:border-box; }
:root {
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0; --bg:#f1f5f9;
  --panel:#ffffff; --accent:#1d4ed8; --accent-soft:#eff6ff;
  --ok:#047857; --ok-soft:#ecfdf5; --warn:#b45309; --warn-soft:#fffbeb;
  --bad:#b91c1c; --bad-soft:#fef2f2;
  --radius:10px; --shadow:0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.04);
}
body { margin:0; background:var(--bg); color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }

.shell { display:grid; grid-template-columns:15rem 1fr; min-height:100vh; }
.side { background:#0f172a; color:#cbd5e1; padding:1.1rem .85rem; }
.side .logo { color:#fff; font-weight:700; letter-spacing:-.015em; font-size:1.02rem;
  padding:.3rem .6rem 1.1rem; display:block; }
.side .logo small { display:block; font-weight:500; font-size:.75rem; color:#64748b; letter-spacing:0; }
.side .group { font-size:.68rem; text-transform:uppercase; letter-spacing:.08em; color:#64748b;
  padding:1.1rem .6rem .35rem; }
.side a.nav { display:block; padding:.45rem .6rem; border-radius:7px; color:#cbd5e1; font-size:.9rem; }
.side a.nav:hover { background:#1e293b; color:#fff; text-decoration:none; }
.side a.nav.on { background:var(--accent); color:#fff; }

.main { display:flex; flex-direction:column; min-width:0; }
.top { background:var(--panel); border-bottom:1px solid var(--line); padding:.7rem 1.5rem;
  display:flex; align-items:center; gap:.6rem; }
.crumb { color:var(--muted); font-size:.88rem; }
.crumb b { color:var(--ink); font-weight:600; }
.spacer { flex:1; }
.who { color:var(--muted); font-size:.85rem; }
.content { padding:1.6rem 1.5rem 3.5rem; max-width:72rem; width:100%; }

h1 { font-size:1.45rem; letter-spacing:-.015em; margin:0 0 .3rem; }
h2 { font-size:1rem; margin:0 0 .9rem; letter-spacing:-.005em; }
.lede { color:var(--muted); margin:0 0 1.4rem; max-width:46rem; }

.panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:var(--shadow); margin-bottom:1.15rem; }
.panel > .body { padding:1.15rem 1.25rem; }
.panel > .head { padding:.9rem 1.25rem; border-bottom:1px solid var(--line);
  display:flex; align-items:center; gap:.6rem; }
.panel > .head h2 { margin:0; }

.tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(16rem,1fr)); gap:1rem; }
.tile { display:block; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  padding:1.1rem 1.2rem; box-shadow:var(--shadow); color:inherit; }
.tile:hover { border-color:var(--accent); text-decoration:none; transform:translateY(-1px); }
.tile strong { display:block; font-size:1.02rem; margin-bottom:.25rem; }
.tile span { color:var(--muted); font-size:.87rem; }

table { width:100%; border-collapse:collapse; font-size:.89rem; }
thead th { text-align:left; font-size:.7rem; text-transform:uppercase; letter-spacing:.07em;
  color:var(--faint); font-weight:600; padding:.55rem .75rem; border-bottom:1px solid var(--line); }
tbody td { padding:.6rem .75rem; border-bottom:1px solid var(--line); vertical-align:top; }
tbody tr:last-child td { border-bottom:0; }
tbody tr:hover { background:#f8fafc; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.wrap { word-break:break-all; }

.badge { display:inline-block; padding:.12rem .5rem; border-radius:999px; font-size:.72rem;
  font-weight:600; white-space:nowrap; }
.badge.ok { background:var(--ok-soft); color:var(--ok); }
.badge.mute { background:#f1f5f9; color:var(--muted); }
.badge.warn { background:var(--warn-soft); color:var(--warn); }
.badge.bad { background:var(--bad-soft); color:var(--bad); }

label { display:block; font-size:.8rem; font-weight:600; color:var(--muted); margin-bottom:.25rem; }
input,textarea,select { width:100%; font:inherit; padding:.5rem .65rem; color:var(--ink);
  border:1px solid var(--line); border-radius:7px; background:#fff; }
input:focus,textarea:focus,select:focus { outline:2px solid var(--accent-soft); border-color:var(--accent); }
textarea { min-height:8.5rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85rem; }
.field { margin-bottom:.9rem; }
.fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:0 1rem; }
.check { display:flex; align-items:center; gap:.45rem; font-size:.88rem; color:var(--ink); font-weight:500; }
.check input { width:auto; }

button,.btn { font:inherit; font-weight:600; font-size:.88rem; padding:.5rem .95rem; border-radius:7px;
  border:1px solid transparent; background:var(--accent); color:#fff; cursor:pointer; display:inline-block; }
button:hover { filter:brightness(1.06); }
button.ghost { background:#fff; color:var(--ink); border-color:var(--line); }
button.danger { background:#fff; color:var(--bad); border-color:var(--line); }
button.link { background:none; border:0; color:var(--accent); padding:0; font-weight:600; }

.flash { padding:.7rem .95rem; border-radius:8px; margin-bottom:1.15rem; font-size:.9rem; border:1px solid transparent; }
.flash.ok { background:var(--ok-soft); color:var(--ok); border-color:#a7f3d0; }
.flash.bad { background:var(--bad-soft); color:var(--bad); border-color:#fecaca; }

.hint { color:var(--muted); font-size:.82rem; margin:.4rem 0 0; }
.muted { color:var(--muted); }
.small { font-size:.83rem; }
.empty { color:var(--muted); font-size:.9rem; padding:.4rem 0; }
.quote { color:var(--muted); font-size:.82rem; margin-top:.2rem; }
.err { color:var(--bad); font-size:.82rem; margin-top:.2rem; }
.actions { display:flex; gap:.5rem; align-items:center; margin-top:.4rem; }

.login-wrap { display:flex; min-height:100vh; align-items:center; justify-content:center; padding:1.5rem; }
.login { width:100%; max-width:23rem; }
.login .brand { text-align:center; margin-bottom:1.1rem; }
.login .brand strong { display:block; font-size:1.15rem; letter-spacing:-.02em; }
.login .brand span { color:var(--muted); font-size:.85rem; }

@media (max-width:820px) {
  .shell { grid-template-columns:1fr; }
  .side { display:flex; flex-wrap:wrap; gap:.3rem; padding:.7rem; }
  .side .logo { width:100%; padding-bottom:.5rem; }
  .side .group { display:none; }
}
`

export interface Chrome {
  title: string
  user: StoredUser
  crumbs?: Array<{ label: string; href?: string }>
  /** Which sidebar entry is current. */
  nav?: { siteSlug?: string; section?: 'crawler' | 'prices' | 'sites' | 'users' }
  sites?: StoredSite[]
}

export function layout(chrome: Chrome, body: Html) {
  const nav = chrome.nav ?? {}

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${chrome.title} · Petrosil console</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<div class="shell">
  <nav class="side">
    <a class="logo" href="/console">Petrosil <small>price console</small></a>
    <a class="nav ${nav.siteSlug ? '' : 'on'}" href="/console">All sites</a>
    ${nav.siteSlug
      ? html`<div class="group">This site</div>
          <a class="nav ${nav.section === 'prices' ? 'on' : ''}" href="/console/sites/${nav.siteSlug}/prices">Update prices</a>
          <a class="nav ${nav.section === 'crawler' ? 'on' : ''}" href="/console/sites/${nav.siteSlug}/crawler">Crawler</a>`
      : ''}
    ${chrome.user.isAdmin
      ? html`<div class="group">Settings</div>
          <a class="nav ${nav.section === 'sites' ? 'on' : ''}" href="/console/settings/sites">Sites</a>
          <a class="nav ${nav.section === 'users' ? 'on' : ''}" href="/console/settings/users">Users</a>`
      : ''}
  </nav>
  <div class="main">
    <header class="top">
      <span class="crumb">
        ${chrome.crumbs && chrome.crumbs.length > 0
          ? chrome.crumbs.map(
              (crumb, at) =>
                html`${at > 0 ? raw(' &rsaquo; ') : ''}${crumb.href
                  ? html`<a href="${crumb.href}">${crumb.label}</a>`
                  : html`<b>${crumb.label}</b>`}`,
            )
          : html`<b>${chrome.title}</b>`}
      </span>
      <span class="spacer"></span>
      <span class="who">${chrome.user.name}${chrome.user.isAdmin ? ' · admin' : ''}</span>
      <form method="post" action="/console/logout" style="margin:0">
        <button class="ghost" type="submit">Sign out</button>
      </form>
    </header>
    <div class="content">${body}</div>
  </div>
</div>
</body>
</html>`
}

const flashOf = (flash?: Flash) =>
  flash ? html`<div class="flash ${flash.kind === 'ok' ? 'ok' : 'bad'}">${flash.text}</div>` : ''

export const loginPage = (error?: string) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Petrosil console</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<div class="login-wrap">
  <div class="login">
    <div class="brand"><strong>Petrosil price console</strong><span>Prices and crawlers, for every site</span></div>
    <div class="panel"><div class="body">
      ${error ? html`<div class="flash bad">${error}</div>` : ''}
      <form method="post" action="/console/login">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required autofocus>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button type="submit" style="width:100%">Sign in</button>
      </form>
    </div></div>
  </div>
</div>
</body>
</html>`

export const sitesPage = (sites: StoredSite[], user: StoredUser, flash?: Flash) =>
  layout(
    { title: 'Sites', user, sites },
    html`<h1>Sites</h1>
      <p class="lede">Pick the site you want to work on. Prices and crawlers for all of them live here.</p>
      ${flashOf(flash)}
      ${sites.length === 0
        ? html`<div class="panel"><div class="body empty">
            No sites yet.
            ${user.isAdmin
              ? html`<a href="/console/settings/sites">Add the first one</a>.`
              : 'Ask an administrator to add one.'}
          </div></div>`
        : html`<div class="tiles">
            ${sites.map(
              (site) => html`<a class="tile" href="/console/sites/${site.id}">
                <strong>${site.name}</strong>
                <span class="wrap">${site.apiUrl}</span>
              </a>`,
            )}
          </div>`}`,
  )

export const sitePage = (site: StoredSite, user: StoredUser, recent: AuditEntry[]) =>
  layout(
    { title: site.name, user, crumbs: [{ label: site.name }], nav: { siteSlug: site.id } },
    html`<h1>${site.name}</h1>
      <p class="lede wrap">${site.apiUrl}</p>
      <div class="tiles">
        <a class="tile" href="/console/sites/${site.id}/prices">
          <strong>Update prices</strong>
          <span>Upload a sheet, bulk edit, review and commit a batch.</span>
        </a>
        <a class="tile" href="/console/sites/${site.id}/crawler">
          <strong>Crawler</strong>
          <span>Watched URLs, and what changed on them.</span>
        </a>
      </div>
      <div class="panel" style="margin-top:1.2rem">
        <div class="head"><h2>Recent activity on this site</h2></div>
        <div class="body">
          ${recent.length === 0
            ? html`<div class="empty">Nothing yet.</div>`
            : html`<table><tbody>
                ${recent.map(
                  (entry) => html`<tr>
                    <td>${entry.action}${entry.detail ? html` <span class="muted">— ${entry.detail}</span>` : ''}</td>
                    <td class="small muted">${entry.userEmail}</td>
                    <td class="small muted">${when(entry.createdAt)}</td>
                  </tr>`,
                )}
              </tbody></table>`}
        </div>
      </div>`,
  )

const statusBadge = (url: WatchedUrl) => {
  const kind =
    url.last_status === 'updated'
      ? 'ok'
      : url.last_status === 'no_rows'
        ? 'warn'
        : url.last_status === 'blocked' || url.last_status === 'disallowed' || url.last_status === 'failed'
          ? 'bad'
          : 'mute'

  return html`<span class="badge ${kind}">${url.last_status_text}</span>`
}

const when = (iso: string | null | undefined) =>
  iso ? iso.replace('T', ' ').slice(0, 16) : '—'

export interface CrawlerPageData {
  site: StoredSite
  user: StoredUser
  urls: WatchedUrl[]
  activity: CrawlActivity[]
  intervalMinutes: number
  flash?: Flash | undefined
}

export const crawlerPage = (data: CrawlerPageData) =>
  layout(
    {
      title: `Crawler · ${data.site.name}`,
      user: data.user,
      crumbs: [
        { label: data.site.name, href: `/console/sites/${data.site.id}` },
        { label: 'Crawler' },
      ],
      nav: { siteSlug: data.site.id, section: 'crawler' },
    },
    html`<h1>Crawler</h1>
      <p class="lede">
        Each URL is checked every ${data.intervalMinutes} minutes and read with AI. Nothing is
        published: findings appear below and you stage them like any other batch.
      </p>
      ${flashOf(data.flash)}

      <div class="panel">
        <div class="head"><h2>Watched URLs</h2><span class="spacer"></span>
          <span class="badge mute">${data.urls.filter((url) => url.enabled).length} watched</span></div>
        <div class="body">
          <form method="post" action="/console/sites/${data.site.id}/crawler/urls">
            <textarea name="text" spellcheck="false" placeholder="https://example.com/base-oil-prices">${data.urls
              .filter((url) => url.enabled)
              .map((url) => url.url)
              .join('\n')}</textarea>
            <p class="hint">One per line. Removing a line stops the watch — its history is kept, not deleted.</p>
            <div class="actions"><button type="submit">Save URLs</button></div>
          </form>
        </div>
        ${data.urls.length === 0
          ? ''
          : html`<table>
              <thead><tr><th>URL</th><th>Last check</th><th>Status</th></tr></thead>
              <tbody>
                ${data.urls.map(
                  (url) => html`<tr>
                    <td class="wrap">
                      ${url.url}
                      ${url.enabled ? '' : html` <span class="badge mute">stopped</span>`}
                      ${url.last_notes ? html`<div class="quote">“${url.last_notes}”</div>` : ''}
                      ${url.last_error ? html`<div class="err">${url.last_error}</div>` : ''}
                    </td>
                    <td class="small muted">${when(url.last_checked_at)}</td>
                    <td>${statusBadge(url)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>

      <div class="panel">
        <div class="head"><h2>Price changes found</h2><span class="spacer"></span>
          ${data.activity.length > 0 ? html`<span class="badge ok">${data.activity.length}</span>` : ''}</div>
        ${data.activity.length === 0
          ? html`<div class="body empty">
              No price changes yet. Only movement is recorded, so this stays empty until a watched
              page actually moves a price.
            </div>`
          : html`<form method="post" action="/console/sites/${data.site.id}/crawler/stage">
              <table>
                <thead><tr>
                  <th></th><th>Location</th><th>Price date</th>
                  <th class="num">On the page</th><th class="num">Site holds</th>
                  <th class="num">Move</th><th>Seen</th>
                </tr></thead>
                <tbody>
                  ${data.activity.map(
                    (row) => html`<tr>
                      <td><input type="checkbox" name="activity_ids" value="${row.id}"
                        ${row.differs_from_site ? raw('checked') : ''}></td>
                      <td>${row.location}
                        ${row.url ? html`<div class="quote">${hostOf(row.url)}</div>` : ''}</td>
                      <td>${row.price_date ?? '—'}</td>
                      <td class="num"><strong>${row.price}</strong></td>
                      <td class="num">${row.site_price === null ? html`<span class="muted">none</span>` : row.site_price}</td>
                      <td class="num">
                        ${row.change_type === 'new'
                          ? html`<span class="badge mute">first seen</span>`
                          : row.change_pct === null
                            ? html`<span class="badge warn">changed</span>`
                            : html`<span class="badge ${row.change_pct >= 0 ? 'ok' : 'bad'}">${row.change_pct >= 0 ? '+' : ''}${row.change_pct}%</span>`}
                      </td>
                      <td class="small muted">${when(row.detected_at)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
              <div class="body">
                <p class="hint" style="margin-top:0">
                  Rows that differ from what the site holds are ticked for you. Nothing is committed
                  until you commit it on the preview screen.
                </p>
                <div class="actions"><button type="submit">Stage selected as a batch</button></div>
              </div>
            </form>`}
      </div>`,
  )

export const settingsPage = (sites: StoredSite[], user: StoredUser, flash?: Flash) =>
  layout(
    { title: 'Sites', user, crumbs: [{ label: 'Settings' }, { label: 'Sites' }], nav: { section: 'sites' } },
    html`<h1>Sites</h1>
      <p class="lede">
        Each site is reached over its own API with its own token. Adding one here is all it takes —
        no redeploy.
      </p>
      ${flashOf(flash)}

      <div class="panel">
        <div class="head"><h2>Add or update a site</h2></div>
        <div class="body">
          <form method="post" action="/console/settings/sites">
            <div class="fields">
              <div class="field">
                <label for="name">Website name</label>
                <input id="name" name="name" placeholder="Base Oil Report" required>
              </div>
              <div class="field">
                <label for="slug">Short name</label>
                <input id="slug" name="slug" placeholder="baseoil" pattern="[a-z0-9][a-z0-9-]*" required>
              </div>
            </div>
            <div class="field">
              <label for="api_url">API address</label>
              <input id="api_url" name="api_url" placeholder="https://baseoilreport.com/api" required>
            </div>
            <div class="field">
              <label for="api_token">API token</label>
              <input id="api_token" name="api_token" placeholder="the site's users.api_token">
              <p class="hint">Leave blank when updating an existing site to keep its current token.</p>
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="enabled" checked> Enabled</label></div>
            <div class="actions"><button type="submit">Save site</button></div>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="head"><h2>Configured sites</h2></div>
        ${sites.length === 0
          ? html`<div class="body empty">None yet.</div>`
          : html`<table>
              <thead><tr><th>Name</th><th>Short name</th><th>API address</th><th>Status</th></tr></thead>
              <tbody>
                ${sites.map(
                  (site) => html`<tr>
                    <td><strong>${site.name}</strong></td>
                    <td class="small muted">${site.id}</td>
                    <td class="wrap small">${site.apiUrl}</td>
                    <td>${site.enabled
                      ? html`<span class="badge ok">enabled</span>`
                      : html`<span class="badge mute">off</span>`}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
      </div>`,
  )

export const usersPage = (users: StoredUser[], user: StoredUser, flash?: Flash) =>
  layout(
    { title: 'Users', user, crumbs: [{ label: 'Settings' }, { label: 'Users' }], nav: { section: 'users' } },
    html`<h1>Users</h1>
      <p class="lede">Who can sign in to this console. Disabling keeps their history readable; there is no delete.</p>
      ${flashOf(flash)}

      <div class="panel">
        <div class="head"><h2>Add someone</h2></div>
        <div class="body">
          <form method="post" action="/console/settings/users">
            <div class="fields">
              <div class="field"><label for="u-name">Name</label><input id="u-name" name="name" placeholder="Rakesh"></div>
              <div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" required></div>
            </div>
            <div class="field">
              <label for="u-password">Password</label>
              <input id="u-password" name="password" type="password" minlength="10" required>
              <p class="hint">At least 10 characters. They can be given it directly; it is stored hashed.</p>
            </div>
            <div class="field"><label class="check"><input type="checkbox" name="is_admin"> Administrator (can manage sites and users)</label></div>
            <div class="actions"><button type="submit">Add user</button></div>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="head"><h2>Accounts</h2></div>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${users.map(
              (row) => html`<tr>
                <td>${row.name}</td>
                <td class="small">${row.email}</td>
                <td>${row.isAdmin ? html`<span class="badge ok">admin</span>` : html`<span class="badge mute">member</span>`}</td>
                <td>${row.disabledAt ? html`<span class="badge bad">disabled</span>` : html`<span class="badge ok">active</span>`}</td>
                <td>
                  <form method="post" action="/console/settings/users/${row.id}/disabled" style="margin:0">
                    <input type="hidden" name="disabled" value="${row.disabledAt ? '0' : '1'}">
                    <button class="${row.disabledAt ? 'ghost' : 'danger'}" type="submit">
                      ${row.disabledAt ? 'Enable' : 'Disable'}
                    </button>
                  </form>
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
  )

export const errorPage = (title: string, message: string, user: StoredUser) =>
  layout(
    { title, user },
    html`<h1>${title}</h1>
      <div class="panel"><div class="body"><p style="margin:0">${message}</p></div></div>
      <p><a href="/console">Back to sites</a></p>`,
  )

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
