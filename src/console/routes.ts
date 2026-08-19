import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import { SESSION_COOKIE, authenticate, newSession, readSession, signSession } from './auth.js'
import type { ConsoleSite, ConsoleUser } from './config.js'
import { SiteError, createSiteClient } from './site-client.js'
import type { SiteClientOptions } from './site-client.js'
import { crawlerPage, errorPage, loginPage, sitePage, sitesPage } from './views.js'

export interface ConsoleOptions {
  sites: ConsoleSite[]
  users: ConsoleUser[]
  /** Signs session cookies. Changing it signs everyone out. */
  secret: string
  /** Cookies are Secure by default; off for plain-http local runs. */
  secureCookies?: boolean
  clientOptions?: SiteClientOptions
}

/**
 * The console: sign in, pick a site, work on it.
 *
 * Every screen is a form post and a redirect. The console keeps no data of
 * its own -- it reads and writes through each site's API with that site's
 * token, which is what lets one deployment serve all of them.
 */
export function createConsole(options: ConsoleOptions) {
  const app = new Hono()
  const secure = options.secureCookies ?? true

  const sessionFor = (c: Context) =>
    readSession(getCookie(c, SESSION_COOKIE), options.secret)

  const userFor = (email: string) => options.users.find((user) => user.email === email) ?? null

  app.get('/login', (c) => c.html(loginPage()))

  app.post('/login', async (c) => {
    const form = await c.req.parseBody()
    const email = String(form['email'] ?? '')
    const password = String(form['password'] ?? '')
    const user = await authenticate(options.users, email, password)

    if (!user) {
      // One message for both wrong-email and wrong-password: saying which
      // would tell a stranger which addresses have accounts.
      return c.html(loginPage('Those details are not right.'), 401)
    }

    setCookie(c, SESSION_COOKIE, signSession(newSession(user.email), options.secret), {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      path: '/',
    })

    return c.redirect('/console')
  })

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' })

    return c.redirect('/console/login')
  })

  // Everything past here needs a session. The login routes are declared
  // above deliberately: middleware order is what keeps them reachable.
  app.use('*', async (c, next) => {
    const session = sessionFor(c)

    if (!session || !userFor(session.email)) {
      return c.redirect('/console/login')
    }

    return next()
  })

  app.get('/', (c) => {
    const session = sessionFor(c)

    return c.html(sitesPage(options.sites, session?.email ?? ''))
  })

  app.get('/sites/:id', (c) => {
    const site = options.sites.find((candidate) => candidate.id === c.req.param('id'))
    const session = sessionFor(c)

    if (!site) {
      return c.html(errorPage('No such site', 'That site is not configured.', session?.email), 404)
    }

    return c.html(sitePage(site, session?.email ?? ''))
  })

  app.get('/sites/:id/crawler', async (c) => {
    const site = options.sites.find((candidate) => candidate.id === c.req.param('id'))
    const session = sessionFor(c)

    if (!site) {
      return c.html(errorPage('No such site', 'That site is not configured.', session?.email), 404)
    }

    const client = createSiteClient(site, options.clientOptions ?? {})
    const flashKind = c.req.query('ok') ? 'ok' : c.req.query('err') ? 'bad' : null
    const flashText = c.req.query('ok') ?? c.req.query('err')

    try {
      // Both in one go: the screen is useless with either half missing, and
      // the sites are slow enough that serialising them would show.
      const [urls, activity] = await Promise.all([client.watchedUrls(), client.activity(50)])

      return c.html(
        crawlerPage({
          site,
          user: session?.email ?? '',
          urls: urls.data,
          activity: activity.data,
          intervalMinutes: urls.interval_minutes,
          ...(flashKind && flashText ? { flash: { kind: flashKind, text: flashText } } : {}),
        }),
      )
    } catch (error) {
      return c.html(
        errorPage('Could not reach the site', messageOf(error), session?.email),
        error instanceof SiteError && error.status === 403 ? 502 : 502,
      )
    }
  })

  app.post('/sites/:id/crawler/urls', async (c) => {
    const site = options.sites.find((candidate) => candidate.id === c.req.param('id'))

    if (!site) {
      return c.redirect('/console')
    }

    const form = await c.req.parseBody()
    const client = createSiteClient(site, options.clientOptions ?? {})

    try {
      const result = await client.replaceWatchedUrls(String(form['text'] ?? ''))

      return c.redirect(
        `/console/sites/${site.id}/crawler?ok=${encodeURIComponent(
          `Saved. ${result.watched} watched, ${result.added} added, ${result.reenabled} re-enabled, ${result.stopped} stopped.`,
        )}`,
      )
    } catch (error) {
      return c.redirect(
        `/console/sites/${site.id}/crawler?err=${encodeURIComponent(messageOf(error))}`,
      )
    }
  })

  app.post('/sites/:id/crawler/stage', async (c) => {
    const site = options.sites.find((candidate) => candidate.id === c.req.param('id'))

    if (!site) {
      return c.redirect('/console')
    }

    const form = await c.req.parseBody({ all: true })
    const raw = form['activity_ids']
    const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)

    if (ids.length === 0) {
      return c.redirect(
        `/console/sites/${site.id}/crawler?err=${encodeURIComponent('Nothing was selected.')}`,
      )
    }

    const client = createSiteClient(site, options.clientOptions ?? {})

    try {
      const result = await client.stage(ids)

      return c.redirect(
        `/console/sites/${site.id}/crawler?ok=${encodeURIComponent(
          `Staged batch #${result.batch_id} with ${result.rows} row(s). Nothing is committed yet.`,
        )}`,
      )
    } catch (error) {
      return c.redirect(
        `/console/sites/${site.id}/crawler?err=${encodeURIComponent(messageOf(error))}`,
      )
    }
  })

  app.get('/sites/:id/prices', (c) => {
    const site = options.sites.find((candidate) => candidate.id === c.req.param('id'))
    const session = sessionFor(c)

    if (!site) {
      return c.html(errorPage('No such site', 'That site is not configured.', session?.email), 404)
    }

    return c.html(
      errorPage(
        'Update prices',
        'Not built yet. The upload, bulk-edit and preview screens move here next; for now they are still on the site itself.',
        session?.email,
      ),
      501,
    )
  })

  return app
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
