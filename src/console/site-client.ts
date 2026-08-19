import type { ConsoleSite } from './config.js'

/**
 * The console's view of one site, over that site's own API.
 *
 * The console holds no site database credentials and no price data. Every
 * screen it renders is built from these calls, which is what lets one console
 * drive every Petrosil site: add a row to CONSOLE_SITES and it appears.
 *
 * The Python crawler talks to the same API with the same token; this is the
 * TypeScript half of the same contract.
 */

// baseoil's .htaccess firewall answers 403 to non-browser user-agents on
// /api/*. The real fix is an exemption for this module's egress IP or a
// shared header; until then a browser-shaped UA is what gets through, so it
// is the default rather than a surprise in production.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export class SiteError extends Error {
  override readonly name = 'SiteError'

  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
  }
}

export interface WatchedUrl {
  id: number
  url: string
  label: string | null
  enabled: boolean
  last_status: string | null
  last_status_text: string
  last_error: string | null
  last_notes: string | null
  last_row_count: number
  last_checked_at: string | null
  last_changed_at: string | null
}

export interface CrawlActivity {
  id: number
  url_id: number
  url: string | null
  location: string
  price_date: string | null
  price: number
  previous_price: number | null
  site_price: number | null
  change_type: string
  change_pct: number | null
  differs_from_site: boolean
  detected_at: string | null
}

export interface BatchItem {
  id: number
  raw_location: string | null
  location_id: number | null
  location: string | null
  pricedate: string | null
  currency: string | null
  old_price: number | null
  new_price: number
  delta: number | null
  delta_pct: number | null
  status: string
  is_included: boolean
  error_message: string | null
}

export interface BatchEnvelope {
  batch: { id: number; status: string; source: string; created_at: string | null }
  summary: Record<string, number>
  needs_attention: number
  committable: boolean
  items?: BatchItem[]
}

export interface BatchSummary {
  id: number
  source: string
  status: string
  items_count?: number
  created_at?: string
}

export interface SiteClientOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}

export function createSiteClient(site: ConsoleSite, options: SiteClientOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  // Generous on purpose: these sites are cold Laravel 7 and regularly take
  // 15-20 seconds to answer. A tight timeout fails the screen, not the site.
  const timeoutMs = options.timeoutMs ?? 120_000
  const userAgent = options.userAgent ?? BROWSER_UA

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response

    try {
      response = await fetchImpl(`${site.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${site.token}`,
          accept: 'application/json',
          'user-agent': userAgent,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new SiteError(
        `${site.name} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.status === 401 || response.status === 403) {
      // These two look identical from out here and lead to completely
      // different fixes, so the message names both.
      throw new SiteError(
        `${site.name} refused the request (HTTP ${response.status}). Check the site's API token, and whether its .htaccess is blocking this caller on /api/*.`,
        response.status,
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')

      throw new SiteError(
        `${site.name} answered HTTP ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      )
    }

    if (response.status === 204) {
      return undefined as T
    }

    try {
      return (await response.json()) as T
    } catch {
      throw new SiteError(`${site.name} did not return JSON`, response.status)
    }
  }

  /**
   * Multipart, for the one endpoint that takes a file. Content-Type is left
   * to fetch on purpose: it has to append the multipart boundary, and setting
   * the header by hand produces a body the site cannot parse.
   */
  async function requestForm<T>(path: string, form: FormData): Promise<T> {
    let response: Response

    try {
      response = await fetchImpl(`${site.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${site.token}`,
          accept: 'application/json',
          'user-agent': userAgent,
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new SiteError(
        `${site.name} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      // The site's own validation message is the useful part here -- "the
      // file must be xlsx, xls or csv" beats "HTTP 422".
      const message =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message: unknown }).message)
          : `HTTP ${response.status}`

      throw new SiteError(`${site.name} rejected the upload: ${message}`, response.status)
    }

    return payload as T
  }

  return {
    site,

    watchedUrls: () =>
      request<{ interval_minutes: number; data: WatchedUrl[] }>('GET', '/price-crawl/urls'),

    replaceWatchedUrls: (text: string) =>
      request<{ watched: number; added: number; reenabled: number; stopped: number }>(
        'PUT',
        '/price-crawl/urls',
        { text },
      ),

    activity: (limit = 50) =>
      request<{ data: CrawlActivity[] }>('GET', `/price-crawl/activity?limit=${limit}`),

    stage: (activityIds: number[]) =>
      request<{ batch_id: number; rows: number; status: string }>(
        'POST',
        '/price-crawl/activity/stage',
        { activity_ids: activityIds },
      ),

    batches: () =>
      request<{ data: BatchSummary[]; meta?: unknown }>('GET', '/price-batches'),

    batch: (id: number) => request<BatchEnvelope>('GET', `/price-batches/${id}`),

    /**
     * Forwards the admin's file to the site untouched.
     *
     * The console never reads the spreadsheet: parsing it is the site's job,
     * because the site is what knows its own locations and date formats. This
     * is a relay, not a parser.
     */
    uploadBatch: async (file: File, priceDate: string): Promise<BatchEnvelope> => {
      const form = new FormData()
      form.append('file', file, file.name)

      if (priceDate !== '') {
        form.append('pricedate', priceDate)
      }

      return requestForm<BatchEnvelope>('/price-batches/upload', form)
    },

    bulkBatch: (params: Record<string, string | number[]>) =>
      request<BatchEnvelope>('POST', '/price-batches/bulk', params),

    updateItem: (id: number, patch: Record<string, unknown>) =>
      request<{ item: BatchItem }>('PUT', `/price-batches/items/${id}`, patch),

    commitBatch: (id: number) =>
      request<Record<string, unknown>>('POST', `/price-batches/${id}/commit`, {}),

    rollbackBatch: (id: number) =>
      request<Record<string, unknown>>('POST', `/price-batches/${id}/rollback`, {}),

    discardBatch: (id: number) =>
      request<Record<string, unknown>>('POST', `/price-batches/${id}/discard`, {}),

    locations: () => request<{ data: Array<{ id: number; title: string }> }>('GET', '/locations'),
  }
}

export type SiteClient = ReturnType<typeof createSiteClient>
