import { Hono } from 'hono'
import { z } from 'zod'

import { renderPrompt } from '../ai/prompt.js'
import type { AiDriver } from '../ai/types.js'
import { diffPrices } from '../price-review/differ.js'
import { summarise } from '../price-review/summariser.js'
import type { DiffedRow, PriceSummary } from '../price-review/types.js'

export interface AppOptions {
  apiToken: string
  driver: AiDriver
  defaultModel: string
}

/** Snake_case on the wire — the callers are PHP sites. */
const requestSchema = z.object({
  price_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'price_date must be YYYY-MM-DD'),
  rows: z
    .array(z.object({ location: z.string(), price: z.unknown() }))
    .min(1)
    .max(5000),
  current_prices: z.array(z.object({ location: z.string(), price: z.number() })).default([]),
  valid_locations: z.array(z.string()).default([]),
  title: z.string().optional(),
  model: z.string().optional(),
})

export function createApp(options: AppOptions) {
  const app = new Hono()

  /**
   * Every route sits behind one shared bearer token. Fails closed: an empty
   * configured token rejects every request rather than letting them through
   * as if auth were disabled.
   */
  app.use('/api/*', async (c, next) => {
    const provided = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''

    if (options.apiToken === '' || provided === '' || !timingSafeEqual(provided, options.apiToken)) {
      return c.json({ message: 'Unauthenticated.' }, 401)
    }

    return next()
  })

  /**
   * The model picker on the calling site's preview page. Only google is
   * configured; the shape keeps the `available` flag so a site can grey out a
   * provider rather than offer one that would fail.
   */
  app.get('/api/models', (c) =>
    c.json([
      {
        provider: 'google',
        label: 'Google Gemini',
        available: true,
        models: [
          { key: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
          { key: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
          { key: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        ],
      },
    ]),
  )

  app.post('/api/price-reviews', async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))

    if (!parsed.success) {
      return c.json({ message: 'The request is invalid.', errors: parsed.error.flatten() }, 422)
    }

    const body = parsed.data

    const rows = diffPrices({
      priceDate: body.price_date,
      // A row whose `price` key is absent arrives as undefined; normalise it to
      // null so the differ's numeric check rejects it as `invalid` rather than
      // letting TypeScript's optional shape hide a missing value.
      rows: body.rows.map((row) => ({ location: row.location, price: row.price ?? null })),
      currentPrices: body.current_prices,
      validLocations: body.valid_locations,
    })

    const summary = summarise(rows, body.price_date)
    const title = body.title ?? `Bulk price update — ${body.price_date}`
    const model = body.model ?? options.defaultModel

    // The diff and the figures are this module's own work: they stay valid
    // even when the provider is unreachable, so a failed narration still
    // returns a usable preview rather than nothing.
    let analysis
    let status: 201 | 502 = 201

    try {
      const completion = await options.driver.generate(
        model,
        renderPrompt('price_batch', title, summary),
      )

      analysis = {
        status: completion.status,
        output_markdown: completion.text,
        model,
        prompt_tokens: completion.promptTokens,
        completion_tokens: completion.completionTokens,
        error: completion.error,
      }
    } catch (error) {
      status = 502
      analysis = {
        status: 'failed' as const,
        output_markdown: null,
        model,
        prompt_tokens: null,
        completion_tokens: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    return c.json({ rows: rows.map(presentRow), summary: presentSummary(summary), analysis }, status)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  return app
}

const presentRow = (row: DiffedRow) => ({
  location: row.location,
  old_price: row.oldPrice,
  new_price: row.newPrice,
  status: row.status,
})

const presentSummary = (summary: PriceSummary) => ({
  total_rows: summary.totalRows,
  price_date: summary.priceDate,
  by_status: summary.byStatus,
  changes: {
    rose: summary.changes.rose,
    fell: summary.changes.fell,
    median_change_pct: summary.changes.medianChangePct,
    largest_rise: presentMove(summary.changes.largestRise),
    largest_fall: presentMove(summary.changes.largestFall),
  },
  suspected_errors: summary.suspectedErrors.map((e) => ({
    location: e.location,
    old_price: e.oldPrice,
    new_price: e.newPrice,
    status: e.status,
    reason: e.reason,
  })),
})

const presentMove = (move: PriceSummary['changes']['largestRise']) =>
  move === null
    ? null
    : { location: move.location, old: move.old, new: move.new, change_pct: move.changePct }

/** Constant-time compare so the token can't be probed by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let diff = 0

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return diff === 0
}
