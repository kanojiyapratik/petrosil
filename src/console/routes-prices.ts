import type { Context, Hono } from 'hono'

import type { Store, StoredSite, StoredUser } from '../db/store.js'
import { createSiteClient } from './site-client.js'
import type { SiteClientOptions } from './site-client.js'
import { errorPage } from './views.js'
import type { Flash } from './views.js'
import { batchPage, pricesPage } from './views-prices.js'

/**
 * The price-update screens.
 *
 * Registered onto the console's app rather than mounted as a sub-app, because
 * every route here needs the `:id` site parameter and the session the parent
 * already established. The helpers it needs are handed in rather than
 * re-derived, so there is exactly one definition of "which site is this" and
 * "who is asking".
 */
export interface PriceRoutesContext<E extends { Variables: { user: StoredUser } }> {
  store: Store
  clientOptions: SiteClientOptions
  siteOr404: (c: Context<E>) => Promise<StoredSite | Response>
  userOf: (c: Context<E>) => StoredUser
  redirectWith: (c: Context<E>, path: string, kind: 'ok' | 'err', text: string) => Response
  flashOf: (c: Context<E>) => Flash | undefined
}

export function registerPriceRoutes<E extends { Variables: { user: StoredUser } }>(
  app: Hono<E>,
  ctx: PriceRoutesContext<E>,
): void {
  const clientFor = (site: StoredSite) => createSiteClient(site, ctx.clientOptions)

  /**
   * Locations, for the pickers.
   *
   * A site that cannot answer must not take the whole screen down with it:
   * without the list the bulk-edit form and the location fixer are unusable,
   * but the batch list and every other row still are.
   */
  const locationsOf = async (site: StoredSite) => {
    try {
      return (await clientFor(site).locations()).data
    } catch {
      return []
    }
  }

  app.get('/sites/:id/prices', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    try {
      const [batches, locations] = await Promise.all([clientFor(site).batches(), locationsOf(site)])

      return c.html(
        pricesPage({
          site,
          user: ctx.userOf(c),
          batches: batches.data,
          locations,
          flash: ctx.flashOf(c),
        }),
      )
    } catch (error) {
      return c.html(errorPage('Could not reach the site', messageOf(error), ctx.userOf(c)), 502)
    }
  })

  app.post('/sites/:id/prices/upload', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const back = `/console/sites/${site.id}/prices`
    const form = await c.req.parseBody()
    const file = form['file']

    if (!(file instanceof File) || file.size === 0) {
      return ctx.redirectWith(c, back, 'err', 'Choose a file to upload.')
    }

    try {
      // Relayed to the site untouched: reading the sheet is its job, because
      // it is what knows its own locations and date formats.
      const result = await clientFor(site).uploadBatch(file, String(form['pricedate'] ?? ''))

      await ctx.store.record({
        userEmail: ctx.userOf(c).email,
        siteSlug: site.id,
        action: 'uploaded a price file',
        detail: `${file.name} to batch #${result.batch.id}`,
      })

      return ctx.redirectWith(
        c,
        `${back}/${result.batch.id}`,
        'ok',
        `Staged batch #${result.batch.id} from ${file.name}. Nothing is committed yet.`,
      )
    } catch (error) {
      return ctx.redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.post('/sites/:id/prices/bulk', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const back = `/console/sites/${site.id}/prices`
    const form = await c.req.parseBody({ all: true })
    const rawIds = form['location_ids']
    const locationIds = (Array.isArray(rawIds) ? rawIds : rawIds === undefined ? [] : [rawIds])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)

    if (locationIds.length === 0) {
      return ctx.redirectWith(c, back, 'err', 'Pick at least one location.')
    }

    // Only fields that were actually filled in are forwarded. Each operation
    // has its own required fields on the site, and sending empty strings for
    // the ones this operation does not use would fail that validation for no
    // reason.
    const params: Record<string, string | number[]> = { location_ids: locationIds }

    for (const key of [
      'operation',
      'date_from',
      'date_to',
      'value',
      'source_date',
      'target_date_from',
      'target_date_to',
    ]) {
      const value = form[key]

      if (typeof value === 'string' && value.trim() !== '') {
        params[key] = value
      }
    }

    try {
      const result = await clientFor(site).bulkBatch(params)

      await ctx.store.record({
        userEmail: ctx.userOf(c).email,
        siteSlug: site.id,
        action: 'staged a bulk edit',
        detail: `${String(params['operation'] ?? '?')} on ${locationIds.length} location(s) to batch #${result.batch.id}`,
      })

      return ctx.redirectWith(
        c,
        `${back}/${result.batch.id}`,
        'ok',
        `Staged batch #${result.batch.id}. Nothing is committed yet.`,
      )
    } catch (error) {
      return ctx.redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.get('/sites/:id/prices/:batchId', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const batchId = Number(c.req.param('batchId'))

    try {
      const [envelope, locations] = await Promise.all([
        clientFor(site).batch(batchId),
        locationsOf(site),
      ])

      return c.html(
        batchPage({ site, user: ctx.userOf(c), envelope, locations, flash: ctx.flashOf(c) }),
      )
    } catch (error) {
      return c.html(errorPage('Could not load the batch', messageOf(error), ctx.userOf(c)), 502)
    }
  })

  app.post('/sites/:id/prices/:batchId/items/:itemId', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const batchId = Number(c.req.param('batchId'))
    const itemId = Number(c.req.param('itemId'))
    const back = `/console/sites/${site.id}/prices/${batchId}`
    const form = await c.req.parseBody()
    const patch: Record<string, unknown> = {}

    // Only what this form actually sent. The site re-diffs a row whenever a
    // value changes, so forwarding a field that did not change would
    // recompute its status for nothing.
    if (typeof form['new_price'] === 'string' && form['new_price'] !== '') {
      patch['new_price'] = Number(form['new_price'])
    }

    if (typeof form['location_id'] === 'string' && form['location_id'] !== '') {
      patch['location_id'] = Number(form['location_id'])
    }

    if (typeof form['is_included'] === 'string') {
      patch['is_included'] = form['is_included'] === '1'
    }

    if (Object.keys(patch).length === 0) {
      return ctx.redirectWith(c, back, 'err', 'Nothing to change.')
    }

    try {
      await clientFor(site).updateItem(itemId, patch)

      return c.redirect(back)
    } catch (error) {
      return ctx.redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.post('/sites/:id/prices/:batchId/commit', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const batchId = Number(c.req.param('batchId'))
    const back = `/console/sites/${site.id}/prices/${batchId}`

    try {
      const result = await clientFor(site).commitBatch(batchId)

      // The one action in this console that changes a live price, so it is
      // the one the audit trail exists for.
      await ctx.store.record({
        userEmail: ctx.userOf(c).email,
        siteSlug: site.id,
        action: 'COMMITTED a batch to live prices',
        detail: `batch #${batchId}${result['committed'] ? ` (${String(result['committed'])} rows)` : ''}`,
      })

      return ctx.redirectWith(c, back, 'ok', `Batch #${batchId} committed to live prices.`)
    } catch (error) {
      return ctx.redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.post('/sites/:id/prices/:batchId/rollback', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const batchId = Number(c.req.param('batchId'))
    const back = `/console/sites/${site.id}/prices/${batchId}`

    try {
      await clientFor(site).rollbackBatch(batchId)

      await ctx.store.record({
        userEmail: ctx.userOf(c).email,
        siteSlug: site.id,
        action: 'ROLLED BACK a committed batch',
        detail: `batch #${batchId}`,
      })

      return ctx.redirectWith(c, back, 'ok', `Batch #${batchId} rolled back.`)
    } catch (error) {
      return ctx.redirectWith(c, back, 'err', messageOf(error))
    }
  })

  app.post('/sites/:id/prices/:batchId/discard', async (c) => {
    const site = await ctx.siteOr404(c)

    if (site instanceof Response) {
      return site
    }

    const batchId = Number(c.req.param('batchId'))

    try {
      await clientFor(site).discardBatch(batchId)

      await ctx.store.record({
        userEmail: ctx.userOf(c).email,
        siteSlug: site.id,
        action: 'discarded a draft batch',
        detail: `batch #${batchId}`,
      })

      return ctx.redirectWith(
        c,
        `/console/sites/${site.id}/prices`,
        'ok',
        `Batch #${batchId} discarded.`,
      )
    } catch (error) {
      return ctx.redirectWith(
        c,
        `/console/sites/${site.id}/prices/${batchId}`,
        'err',
        messageOf(error),
      )
    }
  })
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
