import { describe, expect, it, vi } from 'vitest'

import { authenticate, hashPassword, newSession, readSession, signSession, verifyPassword } from './auth.js'
import { ConsoleConfigError, parseSites, parseUsers } from './config.js'
import type { ConsoleSite } from './config.js'
import { createConsole } from './routes.js'
import { SiteError, createSiteClient } from './site-client.js'

const SECRET = 'a'.repeat(40)

const SITE: ConsoleSite = {
  id: 'baseoil',
  name: 'Base Oil Report',
  apiUrl: 'https://baseoilreport.com/api',
  token: 'site-token',
}

describe('parseSites', () => {
  it('reads a site list', () => {
    const sites = parseSites(JSON.stringify([SITE]))

    expect(sites[0]).toMatchObject({ id: 'baseoil', name: 'Base Oil Report' })
  })

  it('is empty when nothing is configured', () => {
    expect(parseSites(undefined)).toEqual([])
    expect(parseSites('  ')).toEqual([])
  })

  it('trims a trailing slash so paths do not double up', () => {
    expect(parseSites(JSON.stringify([{ ...SITE, apiUrl: 'https://x.com/api/' }]))[0]?.apiUrl).toBe(
      'https://x.com/api',
    )
  })

  it('falls back to the id when no name is given', () => {
    const [site] = parseSites(JSON.stringify([{ id: 'baseoil', apiUrl: 'https://x.com/api', token: 't' }]))

    expect(site?.name).toBe('baseoil')
  })

  it('refuses an id that is not URL-safe', () => {
    expect(() => parseSites(JSON.stringify([{ ...SITE, id: 'Base Oil!' }]))).toThrow(ConsoleConfigError)
  })

  it('refuses a non-web apiUrl, which would send a site token somewhere odd', () => {
    expect(() => parseSites(JSON.stringify([{ ...SITE, apiUrl: 'file:///etc/passwd' }]))).toThrow(
      ConsoleConfigError,
    )
  })

  it('refuses a missing token rather than making unauthenticated calls', () => {
    expect(() => parseSites(JSON.stringify([{ id: 'x', apiUrl: 'https://x.com/api' }]))).toThrow(
      /token is required/,
    )
  })

  it('refuses malformed JSON loudly', () => {
    expect(() => parseSites('{oops')).toThrow(ConsoleConfigError)
    expect(() => parseSites('{"id":"x"}')).toThrow(/must be a JSON array/)
  })
})

describe('parseUsers', () => {
  const user = { email: 'Rakesh@Tikitech.in', name: 'Rakesh', passwordHash: 'scrypt:aa:bb' }

  it('lowercases the email so sign-in is not case-sensitive', () => {
    expect(parseUsers(JSON.stringify([user]))[0]?.email).toBe('rakesh@tikitech.in')
  })

  it('refuses a plain password in place of a hash', () => {
    expect(() =>
      parseUsers(JSON.stringify([{ ...user, passwordHash: 'hunter2' }])),
    ).toThrow(/scrypt hash/)
  })
})

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery')

    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('rejects a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt:zz')).toBe(false)
  })
})

describe('authenticate', () => {
  const users = async () => [
    { email: 'rakesh@tikitech.in', name: 'Rakesh', passwordHash: await hashPassword('good-password') },
  ]

  it('accepts the right password, whatever the email casing', async () => {
    expect(await authenticate(await users(), 'RAKESH@tikitech.in', 'good-password')).not.toBeNull()
  })

  it('rejects a wrong password', async () => {
    expect(await authenticate(await users(), 'rakesh@tikitech.in', 'nope')).toBeNull()
  })

  it('rejects an unknown email', async () => {
    expect(await authenticate(await users(), 'nobody@example.com', 'good-password')).toBeNull()
  })
})

describe('sessions', () => {
  it('round-trips a signed session', () => {
    const token = signSession(newSession('rakesh@tikitech.in'), SECRET)

    expect(readSession(token, SECRET)?.email).toBe('rakesh@tikitech.in')
  })

  it('refuses a session signed with a different secret', () => {
    const token = signSession(newSession('rakesh@tikitech.in'), SECRET)

    expect(readSession(token, 'b'.repeat(40))).toBeNull()
  })

  it('refuses a tampered payload', () => {
    const token = signSession(newSession('rakesh@tikitech.in'), SECRET)
    const forged = Buffer.from(JSON.stringify({ email: 'someone@else.com', expiresAt: 9e9 }))
      .toString('base64url')

    expect(readSession(`${forged}.${token.split('.')[1]}`, SECRET)).toBeNull()
  })

  it('refuses an expired session', () => {
    const token = signSession(newSession('rakesh@tikitech.in', 60, 0), SECRET)

    expect(readSession(token, SECRET, 120_000)).toBeNull()
  })

  it('refuses nonsense', () => {
    expect(readSession(undefined, SECRET)).toBeNull()
    expect(readSession('not-a-token', SECRET)).toBeNull()
  })
})

describe('createSiteClient', () => {
  const responding = (payload: unknown, status = 200) => {
    const calls: Array<{ url: string; init: RequestInit }> = []

    const stub = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })

      return new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    return { stub, calls }
  }

  it('sends the site token and a browser user-agent', async () => {
    const { stub, calls } = responding({ interval_minutes: 15, data: [] })

    await createSiteClient(SITE, { fetch: stub }).watchedUrls()

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(calls[0]!.url).toBe('https://baseoilreport.com/api/price-crawl/urls')
    expect(headers.authorization).toBe('Bearer site-token')
    expect(headers['user-agent']).toContain('Mozilla/5.0')
  })

  it('names both causes when the site answers 403', async () => {
    // A blocked user-agent and a bad token look identical from here and lead
    // to entirely different fixes.
    const { stub } = responding({}, 403)

    await expect(createSiteClient(SITE, { fetch: stub }).watchedUrls()).rejects.toThrow(/\.htaccess/)
  })

  it('reports an unreachable site rather than returning nothing', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    await expect(createSiteClient(SITE, { fetch: failing }).watchedUrls()).rejects.toThrow(SiteError)
  })

  it('posts the URL text as the site expects it', async () => {
    const { stub, calls } = responding({ watched: 1, added: 1, reenabled: 0, stopped: 0 })

    await createSiteClient(SITE, { fetch: stub }).replaceWatchedUrls('https://example.com/a')

    expect(calls[0]!.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'https://example.com/a' })
  })
})

describe('the console', () => {
  const fakeStore = (users, sites) => {
    const state = { users: [...users], sites: [...sites], audit: [] }

    return {
      users: async () => state.users,
      activeUsers: async () => state.users.filter((u) => !u.disabledAt),
      createUser: async (u) => {
        const row = { ...u, id: state.users.length + 1, disabledAt: null }
        state.users.push(row)
        return row
      },
      setUserPassword: async () => undefined,
      setUserDisabled: async (id, disabled) => {
        const row = state.users.find((u) => u.id === id)
        if (row) row.disabledAt = disabled ? '2026-01-01T00:00:00Z' : null
      },
      sites: async () => state.sites,
      enabledSites: async () => state.sites.filter((s) => s.enabled),
      siteBySlug: async (slug) => state.sites.find((s) => s.id === slug) ?? null,
      upsertSite: async (s) => {
        const row = { dbId: 1, id: s.slug, name: s.name, apiUrl: s.apiUrl, token: s.apiToken, enabled: s.enabled }
        const at = state.sites.findIndex((e) => e.id === s.slug)
        if (at === -1) state.sites.push(row); else state.sites[at] = row
        return row
      },
      record: async (e) => { state.audit.push(e) },
      audit: async () => state.audit,
      _state: state,
    }
  }

  const consoleWith = async (overrides = {}) => {
    const users = overrides.users ?? [
      {
        id: 1,
        email: 'rakesh@tikitech.in',
        name: 'Rakesh',
        passwordHash: await hashPassword('good-password'),
        isAdmin: true,
        disabledAt: null,
      },
    ]
    const sites = overrides.sites ?? [{ ...SITE, dbId: 1, enabled: true }]
    delete overrides.users
    delete overrides.sites

    return createConsole({
      store: fakeStore(users, sites),
      secret: SECRET,
      secureCookies: false,
      ...overrides,
    })
  }

  const signIn = async (app: Awaited<ReturnType<typeof consoleWith>>) => {
    const response = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=rakesh@tikitech.in&password=good-password',
    })

    return response.headers.get('set-cookie')?.split(';')[0] ?? ''
  }

  it('shows a login page to a stranger', async () => {
    const response = await (await consoleWith()).request('/login')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Sign in')
  })

  it('sends a signed-out visitor to the login page, wherever they aimed', async () => {
    const app = await consoleWith()

    for (const path of ['/', '/sites/baseoil', '/sites/baseoil/crawler']) {
      const response = await app.request(path)

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/console/login')
    }
  })

  it('signs in and lands on the site list', async () => {
    const app = await consoleWith()
    const cookie = await signIn(app)

    expect(cookie).toContain('petrosil_console=')

    const response = await app.request('/', { headers: { cookie } })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Base Oil Report')
  })

  it('says the same thing for a wrong password and an unknown email', async () => {
    const app = await consoleWith()

    const wrongPassword = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=rakesh@tikitech.in&password=nope',
    })
    const unknownEmail = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=nobody@example.com&password=good-password',
    })

    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(await wrongPassword.text()).toContain('Those details are not right.')
    expect(await unknownEmail.text()).toContain('Those details are not right.')
  })

  it('offers both options once a site is picked', async () => {
    const app = await consoleWith()
    const cookie = await signIn(app)

    const body = await (await app.request('/sites/baseoil', { headers: { cookie } })).text()

    expect(body).toContain('Update prices')
    expect(body).toContain('Crawler')
  })

  it('404s a site that is not configured', async () => {
    const app = await consoleWith()
    const cookie = await signIn(app)

    expect((await app.request('/sites/nope', { headers: { cookie } })).status).toBe(404)
  })

  it('renders the crawler screen from what the site reports', async () => {
    const fetchStub = (async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes('/activity')
            ? {
                data: [
                  {
                    id: 7,
                    url_id: 1,
                    url: 'https://example.com/prices',
                    location: 'Europe SN 500 FOB Group I',
                    price_date: '2026-08-14',
                    price: 902.5,
                    previous_price: 869,
                    site_price: 845,
                    change_type: 'changed',
                    change_pct: 3.86,
                    differs_from_site: true,
                    detected_at: '2026-08-18T12:00:00+00:00',
                  },
                ],
              }
            : {
                interval_minutes: 15,
                data: [
                  {
                    id: 1,
                    url: 'https://example.com/prices',
                    label: null,
                    enabled: true,
                    last_status: 'updated',
                    last_status_text: 'Price change found',
                    last_error: null,
                    last_notes: 'read the weekly table',
                    last_row_count: 4,
                    last_checked_at: '2026-08-18T12:00:00+00:00',
                    last_changed_at: null,
                  },
                ],
              },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

    const app = await consoleWith({ clientOptions: { fetch: fetchStub } })
    const cookie = await signIn(app)
    const body = await (await app.request('/sites/baseoil/crawler', { headers: { cookie } })).text()

    expect(body).toContain('https://example.com/prices')
    expect(body).toContain('Price change found')
    expect(body).toContain('read the weekly table')
    expect(body).toContain('Europe SN 500 FOB Group I')
    expect(body).toContain('902.5')
    expect(body).toContain('3.86%')
  })

  it('says so plainly when the site cannot be reached', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const app = await consoleWith({ clientOptions: { fetch: failing } })
    const cookie = await signIn(app)
    const response = await app.request('/sites/baseoil/crawler', { headers: { cookie } })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('could not be reached')
  })

  it('saves the URL list through the site and reports what changed', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })

      return new Response(JSON.stringify({ watched: 2, added: 1, reenabled: 0, stopped: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const app = await consoleWith({ clientOptions: { fetch: stub } })
    const cookie = await signIn(app)

    const response = await app.request('/sites/baseoil/crawler/urls', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'text=https%3A%2F%2Fexample.com%2Fa',
    })

    expect(calls[0]?.body).toEqual({ text: 'https://example.com/a' })
    expect(response.status).toBe(302)
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('2 watched, 1 added')
  })

  it('stages the ticked findings and names the batch it made', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ batch_id: 42, rows: 2, status: 'draft' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const app = await consoleWith({ clientOptions: { fetch: stub } })
    const cookie = await signIn(app)

    const response = await app.request('/sites/baseoil/crawler/stage', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'activity_ids=7&activity_ids=8',
    })

    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('batch #42')
  })

  it('refuses to stage nothing rather than making an empty batch', async () => {
    const stub = vi.fn()
    const app = await consoleWith({ clientOptions: { fetch: stub as unknown as typeof fetch } })
    const cookie = await signIn(app)

    const response = await app.request('/sites/baseoil/crawler/stage', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })

    expect(stub).not.toHaveBeenCalled()
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('Nothing was selected')
  })

  it('signs out', async () => {
    const app = await consoleWith()
    const cookie = await signIn(app)

    const response = await app.request('/logout', { method: 'POST', headers: { cookie } })

    expect(response.headers.get('location')).toBe('/console/login')
    expect(response.headers.get('set-cookie')).toContain('petrosil_console=;')
  })
})
