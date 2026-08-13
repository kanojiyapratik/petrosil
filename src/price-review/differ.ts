import type { DiffedRow, PriceReviewRequest } from './types.js'

/**
 * Compares proposed prices against the ones the calling site already holds.
 *
 * Stateless by design — see PriceReviewRequest. Ported from baseoil's
 * PriceDiffer, which read the site's database directly.
 */
export function diffPrices(request: PriceReviewRequest): DiffedRow[] {
  const current = currentByLocation(request)
  const todayIso = new Date().toISOString().slice(0, 10)

  return request.rows.map((row) => {
    const oldPrice = current.get(row.location) ?? null
    const newPrice = toPrice(row.price)

    return {
      location: row.location,
      oldPrice,
      newPrice: newPrice ?? Number.NaN,
      status: classify({
        location: row.location,
        validLocations: request.validLocations,
        oldPrice,
        newPrice,
        priceDate: request.priceDate,
        todayIso,
      }),
    }
  })
}

function classify(input: {
  location: string
  validLocations: string[]
  oldPrice: number | null
  newPrice: number | null
  priceDate: string
  todayIso: string
}): DiffedRow['status'] {
  if (!input.validLocations.includes(input.location)) {
    return 'unmatched'
  }

  // Rejected, never clamped: a negative or unreadable price is a problem with
  // the sheet, and silently turning it into 0 would publish a wrong price
  // rather than surface the mistake.
  if (input.newPrice === null || input.newPrice < 0) {
    return 'invalid'
  }

  if (input.oldPrice === null) {
    return 'new'
  }

  if (samePrice(input.oldPrice, input.newPrice)) {
    return 'unchanged'
  }

  // Published history is immutable: a price already recorded on a past date is
  // never rewritten. Backfilling an *empty* past date stays allowed — that is
  // the null branch above, and it matters because prices arrive days after the
  // date they apply to.
  if (input.priceDate < input.todayIso) {
    return 'locked'
  }

  return 'changed'
}

/**
 * PHP's is_numeric rejected '' and null; JavaScript's Number() turns both into
 * 0, which would publish a zero price. Reject anything that is not a finite
 * number or a non-blank numeric string.
 */
function toPrice(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)

    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function currentByLocation(request: PriceReviewRequest): Map<string, number> {
  return new Map(request.currentPrices.map((c) => [c.location, Number(c.price)]))
}

/** Prices are floats; compare with a tolerance rather than ===. */
function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.00001
}
