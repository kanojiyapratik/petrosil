import { describe, expect, it } from 'vitest'

import { createApp } from './app.js'
import type { AiDriver } from '../ai/types.js'

const TOKEN = 'test-api-token'

const stubDriver = (completion: Partial<Awaited<ReturnType<AiDriver['generate']>>>): AiDriver => ({
  generate: async () => ({
    status: 'complete',
    text: 'Prices rose modestly across the board.',
    promptTokens: 300,
    completionTokens: 120,
    error: null,
    ...completion,
  }),
})

const appWith = (driver: AiDriver) =>
  createApp({ apiToken: TOKEN, driver, defaultModel: 'gemini-2.5-flash' })

const validBody = {
  price_date: '2026-08-20',
  rows: [
    { location: 'Singapore', price: 845 },
    { location: 'Mumbai', price: 600 },
    { location: 'Atlantis', price: 500 },
  ],
  current_prices: [
    { location: 'Singapore', price: 812 },
    { location: 'Mumbai', price: 600 },
  ],
  valid_locations: ['Singapore', 'Mumbai'],
}

const post = (app: ReturnType<typeof createApp>, body: unknown, token: string | null = TOKEN) =>
  app.request('/api/price-reviews', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

describe('GET /api/models', () => {
  it('lists the configured provider and its models', async () => {
    const response = await appWith(stubDriver({})).request('/api/models', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })

    expect(response.status).toBe(200)

    const json = (await response.json()) as any
    const google = json.find((p: any) => p.provider === 'google')

    expect(google).toMatchObject({ provider: 'google', available: true })
    expect(google.models.map((m: any) => m.key)).toContain('gemini-2.5-flash')
  })

  it('needs a token', async () => {
    const response = await appWith(stubDriver({})).request('/api/models')

    expect(response.status).toBe(401)
  })
})

describe('POST /api/price-reviews', () => {
  it('returns the diffed rows, the summary and the narration', async () => {
    const response = await post(appWith(stubDriver({})), validBody)

    expect(response.status).toBe(201)

    const json = (await response.json()) as any

    expect(json.rows[0]).toMatchObject({ status: 'changed', old_price: 812, new_price: 845 })
    expect(json.rows[1].status).toBe('unchanged')
    expect(json.rows[2].status).toBe('unmatched')

    expect(json.summary.total_rows).toBe(3)
    expect(json.summary.changes.rose).toBe(1)

    expect(json.analysis.status).toBe('complete')
    expect(json.analysis.output_markdown).toBe('Prices rose modestly across the board.')
  })

  /** The callers are PHP sites: every key on the wire is snake_case. */
  it('presents the largest move in snake_case like the rest of the payload', async () => {
    const response = await post(appWith(stubDriver({})), validBody)
    const json = (await response.json()) as any

    expect(json.summary.changes.largest_rise).toEqual({
      location: 'Singapore',
      old: 812,
      new: 845,
      change_pct: 4.06,
    })
  })

  it('rejects a request with no token', async () => {
    const response = await post(appWith(stubDriver({})), validBody, null)

    expect(response.status).toBe(401)
  })

  it('rejects a request with the wrong token', async () => {
    const response = await post(appWith(stubDriver({})), validBody, 'not-the-token')

    expect(response.status).toBe(401)
  })

  it('rejects a malformed request', async () => {
    const response = await post(appWith(stubDriver({})), { rows: 'not-an-array' })

    expect(response.status).toBe(422)
  })

  /** A model decline is still a successful request — it is not a 500. */
  it('returns 201 with a declined analysis when the model declines', async () => {
    const app = appWith(
      stubDriver({ status: 'declined', text: null, error: 'The model declined to respond: SAFETY' }),
    )

    const response = await post(app, validBody)

    expect(response.status).toBe(201)

    const json = (await response.json()) as any
    expect(json.analysis.status).toBe('declined')
    expect(json.rows).toHaveLength(3)
  })

  /**
   * The diff and the figures are the module's own work and stay valid even
   * when the provider is unreachable — the site should still get its preview.
   */
  it('still returns rows and summary when the provider fails', async () => {
    const app = createApp({
      apiToken: TOKEN,
      defaultModel: 'gemini-2.5-flash',
      driver: {
        generate: async () => {
          throw new Error('Gemini request failed: connect ECONNREFUSED')
        },
      },
    })

    const response = await post(app, validBody)

    expect(response.status).toBe(502)

    const json = (await response.json()) as any
    expect(json.analysis.status).toBe('failed')
    expect(json.rows).toHaveLength(3)
    expect(json.summary.total_rows).toBe(3)
  })
})
