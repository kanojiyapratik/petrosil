import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import type { Store, StoredSite, StoredUser } from '../db/store.js'
import { SESSION_COOKIE, authenticate, hashPassword, newSession, readSession, signSession } from './auth.js'
import { normaliseSiteInput } from './config.js'
import { SiteError, createSiteClient } from './site-client.js'
import type { SiteClientOptions } from './site-client.js'
import {
  crawlerPage,
  errorPage,
  loginPage,
  sitePage,
  sitesPage,
  settingsPage,
  usersPage,
} from './views.js'

/** Typed so the signed-in user can ride on the request. */
type ConsoleEnv = { Variables: { user: StoredUser } }

export interface ConsoleOptions {
  store: Store
  /** Signs session cookies. Changing it signs everyone out. */
  secret: string
  /** Cookies are Secure by default; off for plain-http local runs. */
  secureCookies?: boolean
  clientOptions?: SiteClientOptions
}

/**
 * The console: sign in, pick a site, work on it.
 *
 * Every screen is a form post and a redirect. The console keeps no price data
 * of its own -- it reads and writes through each site's API with that site's
 * token, which is what lets one deployment serve all of them. Its own
 * database holds only who may sign in, which sites exist, and what was done.
 */
export function createConsole(options: ConsoleOptions) {
  const app = new Hono<ConsoleEnv>()
  const secure = options.secureCookies ?? true
  const store = options.store

  const sessionFor = (c: Context<ConsoleEnv>) => readSession(getCookie(c, SESSION_COOKIE), options.secret)

  /** The signed-in user, or null if the cookie names someone who no longer is. */
  const currentUser = async (c: Context<ConsoleEnv>): Promise<StoredUser | null> => {
    const session = sessionFor(c)

    if (!session) {
      return null
    }

    const users = await store.activeUsers()

    return users.find((user) => user.email === session.email) ?? null
  }

  const redirectWith = (c: Context<ConsoleEnv>, path: string, kind: 'ok' | 'err', text: string) =>
    c.redirect(`${path}?${kind}=${encodeURIComponent(text)}`)

  const flashOf = (c: Context<ConsoleEnv>) => {
    const ok = c.req.query('ok')
    const err = c.req.query('err')

    return ok ? { kind: 'ok' as const, text: ok } : err ? { kind: 'bad' as const, text: err } : undefined
  }

  app.get('/login', (c) => c.html(loginPage()))

  app.post('/login', async (c) => {
    const form = await c.req.parseBody()
    const email = String(form['email'] ?? '')
    const password = String(form['password'] ?? '')
    const user = await authenticate(await store.activeUsers(), email, password)

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

    await store.record({ userEmail: user.email, action: 'signed in' })

    return c.redirect('/console')
  })

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' })

    return c.redirect('/console/login')
  })

  // Everything past here needs a session. The login routes are declared above
  // deliberately: middleware order is what keeps them reachable.
  app.use('*', async (c, next) => {
    const user = await currentUser(c)

    if (!user) {
      return c.redirect('/console/login')
    }

    c.set('user', user)

    return next()
  })

  const userOf = (c: Context<ConsoleEnv>): StoredUser => c.get('user')

  const siteOr404 = async (c: Context<ConsoleEnv>): Promise<StoredSite | Response> => {
    const site = await store.siteBySlug(c.req.param('id') ?? '')

    if (!site || !site.enabled) {
      return c.html(
        errorPage('No such site', 'That site is not configured, or has been turned off.', userOf(c)),
        404,
      )
    }

    return site
  }

  app.get('/', async (c) =>
    c.html(sitesPage(await store.enabledSites(), userOf(c), flashOf(c))),
  )

  app.get('/sites/:id', async (c) => {
    const site = await siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    return c.html(sitePage(site, userOf(c), await store.audit(8, site.id)))
  })

  app.get('/sites/:id/crawler', async (c) => {
    const site = await siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const client = createSiteClient(site, options.clientOptions ?? {})

    try {
      // Both in one go: the screen is useless with either half missing, and
      // the sites are slow enough that serialising them would show.
      const [urls, activity] = await Promise.all([client.watchedUrls(), client.activity(50)])

      return c.html(
        crawlerPage({
          site,
          user: userOf(c),
          urls: urls.data,
          activity: activity.data,
          intervalMinutes: urls.interval_minutes,
          flash: flashOf(c),
        }),
      )
    } catch (error) {
      return c.html(errorPage('Could not reach the site', messageOf(error), userOf(c)), 502)
    }
  })

  app.post('/sites/:id/crawler/urls', async (c) => {
    const site = await siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const form = await c.req.parseBody()
    const client = createSiteClient(site, options.clientOptions ?? {})
    const back = `/console/sites/${site.id}/crawler`

    try {
      const result = await client.replaceWatchedUrls(String(form['text'] ?? ''))

      await store.record({
        userEmail: userOf(c).email,
        siteSlug: site.id,
        action: 'saved watched URLs',
        detail: `${result.watched} watched, ${result.added} added, ${result.stopped} stopped`,
      })

      return redirectWith(
        c,
        back,
        'ok',
        `Saved. ${result.watched} watched, ${result.added} added, ${result.reenabled} re-enabled, ${result.stopped} stopped.`,
      )
    } catch (error) {
      return redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.post('/sites/:id/crawler/stage', async (c) => {
    const site = await siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const form = await c.req.parseBody({ all: true })
    const raw = form['activity_ids']
    const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)

    const back = `/console/sites/${site.id}/crawler`

    if (ids.length === 0) {
      return redirectWith(c, back, 'err', 'Nothing was selected.')
    }

    try {
      const result = await createSiteClient(site, options.clientOptions ?? {}).stage(ids)

      await store.record({
        userEmail: userOf(c).email,
        siteSlug: site.id,
        action: 'staged a batch from crawled prices',
        detail: `batch #${result.batch_id}, ${result.rows} row(s)`,
      })

      return redirectWith(
        c,
        back,
        'ok',
        `Staged batch #${result.batch_id} with ${result.rows} row(s). Nothing is committed yet.`,
      )
    } catch (error) {
      return redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.get('/sites/:id/prices', async (c) => {
    const site = await siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    return c.html(
      errorPage(
        'Update prices',
        'Not built yet. Upload, bulk edit and the preview screen move here next; until then they are still on the site itself.',
        userOf(c),
      ),
      501,
    )
  })

  // ---- settings ----------------------------------------------------------

  const adminOnly = (c: Context<ConsoleEnv>) =>
    userOf(c).isAdmin
      ? null
      : c.html(
          errorPage('Not allowed', 'Only an administrator can change these settings.', userOf(c)),
          403,
        )

  app.get('/settings/sites', async (c) => {
    const denied = adminOnly(c)

    if (denied) {
      return denied
    }

    return c.html(settingsPage(await store.sites(), userOf(c), flashOf(c)))
  })

  app.post('/settings/sites', async (c) => {
    const denied = adminOnly(c)

    if (denied) {
      return denied
    }

    const form = await c.req.parseBody()
    const back = '/console/settings/sites'

    try {
      const site = normaliseSiteInput({
        slug: String(form['slug'] ?? ''),
        name: String(form['name'] ?? ''),
        apiUrl: String(form['api_url'] ?? ''),
        apiToken: String(form['api_token'] ?? ''),
        enabled: form['enabled'] === 'on' || form['enabled'] === '1',
      })

      const existing = await store.siteBySlug(site.slug)

      if (!existing && site.apiToken === '') {
        return redirectWith(c, back, 'err', 'A new site needs an API token.')
      }

      await store.upsertSite(site)
      await store.record({
        userEmail: userOf(c).email,
        siteSlug: site.slug,
        action: existing ? 'updated a site' : 'added a site',
        detail: site.apiUrl,
      })

      return redirectWith(c, back, 'ok', `${site.name} saved.`)
    } catch (error) {
      return redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.get('/settings/users', async (c) => {
    const denied = adminOnly(c)

    if (denied) {
      return denied
    }

    return c.html(usersPage(await store.users(), userOf(c), flashOf(c)))
  })

  app.post('/settings/users', async (c) => {
    const denied = adminOnly(c)

    if (denied) {
      return denied
    }

    const form = await c.req.parseBody()
    const back = '/console/settings/users'
    const email = String(form['email'] ?? '').trim().toLowerCase()
    const password = String(form['password'] ?? '')

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return redirectWith(c, back, 'err', 'That is not an email address.')
    }

    if (password.length < 10) {
      return redirectWith(c, back, 'err', 'Use a password of at least 10 characters.')
    }

    try {
      await store.createUser({
        email,
        name: String(form['name'] ?? '').trim() || email,
        passwordHash: await hashPassword(password),
        isAdmin: form['is_admin'] === 'on' || form['is_admin'] === '1',
      })

      await store.record({ userEmail: userOf(c).email, action: 'added a user', detail: email })

      return redirectWith(c, back, 'ok', `${email} can now sign in.`)
    } catch (error) {
      const message = messageOf(error)

      return redirectWith(
        c,
        back,
        'err',
        message.includes('console_users_email_key') ? 'That email already has an account.' : message,
      )
    }
  })

  app.post('/settings/users/:id/disabled', async (c) => {
    const denied = adminOnly(c)

    if (denied) {
      return denied
    }

    const form = await c.req.parseBody()
    const id = Number(c.req.param('id'))
    const disabled = String(form['disabled'] ?? '') === '1'
    const back = '/console/settings/users'
    const users = await store.users()
    const target = users.find((user) => user.id === id)

    if (!target) {
      return redirectWith(c, back, 'err', 'No such user.')
    }

    // Locking every administrator out of a console whose settings only an
    // administrator can reach would need a database edit to undo.
    const otherAdmins = users.filter(
      (user) => user.isAdmin && !user.disabledAt && user.id !== id,
    ).length

    if (disabled && target.isAdmin && otherAdmins === 0) {
      return redirectWith(c, back, 'err', 'That is the last administrator — disabling it would lock everyone out.')
    }

    await store.setUserDisabled(id, disabled)
    await store.record({
      userEmail: userOf(c).email,
      action: disabled ? 'disabled a user' : 'enabled a user',
      detail: target.email,
    })

    return redirectWith(c, back, 'ok', `${target.email} ${disabled ? 'disabled' : 'enabled'}.`)
  })

  return app
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ConsoleApp = ReturnType<typeof createConsole>
