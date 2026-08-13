import type { DiffedRow, PriceSummary, SuspectedError } from './types.js'

/**
 * Below this, a single price move isn't automatically suspicious on its own —
 * it can still be caught by the relative check against the rest of the batch,
 * just not by the absolute one.
 */
export const OUTLIER_ABS_PCT_THRESHOLD = 50

/**
 * A change more than this many standard deviations from the batch's own
 * average is an outlier relative to its neighbours, even when its absolute
 * size is unremarkable.
 */
export const OUTLIER_STDDEV_MULTIPLE = 3

/**
 * Turns diffed rows into the figures the AI is asked to narrate.
 *
 * Ported from baseoil's PriceBatchSummariser, which read these numbers back
 * out of the site's database with SQL aggregates. Here they are computed from
 * the rows the differ produced, so the module stays site-agnostic.
 *
 * Nothing in this file asks a model for a number. That is the point.
 */
export function summarise(rows: DiffedRow[], priceDate: string): PriceSummary {
  return {
    totalRows: rows.length,
    priceDate,
    byStatus: byStatus(rows),
    changes: changes(rows),
    suspectedErrors: suspectedErrors(rows),
  }
}

function byStatus(rows: DiffedRow[]): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

interface Move {
  location: string
  old: number
  new: number
  changePct: number
}

/**
 * Movement figures, computed only over rows that actually have both an old and
 * a new price — a `new` row has nothing to have moved from.
 */
function movesOf(rows: DiffedRow[]): Move[] {
  const moves: Move[] = []

  for (const row of rows) {
    if (row.oldPrice === null || row.oldPrice === 0 || !Number.isFinite(row.newPrice)) {
      continue
    }

    const changePct = ((row.newPrice - row.oldPrice) / row.oldPrice) * 100

    if (Math.abs(changePct) < 0.00001) {
      continue
    }

    moves.push({
      location: row.location,
      old: row.oldPrice,
      new: row.newPrice,
      changePct: round2(changePct),
    })
  }

  return moves
}

function changes(rows: DiffedRow[]): PriceSummary['changes'] {
  const moves = movesOf(rows)
  const pcts = moves.map((m) => m.changePct).sort((a, b) => a - b)

  return {
    rose: pcts.filter((p) => p > 0).length,
    fell: pcts.filter((p) => p < 0).length,
    medianChangePct: median(pcts),
    largestRise: extreme(moves, true),
    largestFall: extreme(moves, false),
  }
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) {
    return null
  }

  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) {
    return round2(sorted[middle]!)
  }

  return round2((sorted[middle - 1]! + sorted[middle]!) / 2)
}

function extreme(moves: Move[], rising: boolean): Move | null {
  const candidates = moves.filter((m) => (rising ? m.changePct > 0 : m.changePct < 0))

  if (candidates.length === 0) {
    return null
  }

  return candidates.sort((a, b) =>
    rising ? b.changePct - a.changePct : a.changePct - b.changePct,
  )[0]!
}

/**
 * Rows worth a second look before committing: moves that are outliers for this
 * batch, and prices that cannot be right at all.
 *
 * This is the figure that earns the AI review its keep — it is what turns
 * "84 rows changed" into "84 rows changed, and this one is a typo".
 */
function suspectedErrors(rows: DiffedRow[]): SuspectedError[] {
  const reasons = new Map<number, string[]>()

  const push = (index: number, reason: string) => {
    const existing = reasons.get(index)
    existing ? existing.push(reason) : reasons.set(index, [reason])
  }

  for (const [index, pct] of outlierRows(rows)) {
    const row = rows[index]!
    push(
      index,
      `Changed by ${pct > 0 ? `+${round1(pct)}` : round1(pct)}% ` +
        `(${row.oldPrice} -> ${row.newPrice}), an unusually large move for this batch.`,
    )
  }

  // A price that cannot be right at all, regardless of how it compares to the
  // rest of the batch. A row can collect both this and the outlier reason
  // above — 59.10 -> 0 is both a -100% move and a zero.
  rows.forEach((row, index) => {
    if (row.newPrice === 0) {
      push(index, 'The proposed price is zero.')
    } else if (row.newPrice < 0) {
      push(index, `The proposed price is negative (${row.newPrice}).`)
    }

    if (row.status === 'invalid') {
      push(index, 'The row was rejected as invalid.')
    }
  })

  return [...reasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, rowReasons]) => {
      const row = rows[index]!

      return {
        location: row.location,
        oldPrice: row.oldPrice,
        newPrice: row.newPrice,
        status: row.status,
        reason: rowReasons.join(' '),
      }
    })
}

/**
 * Indexes of `changed` rows whose percentage move is an outlier: more than
 * OUTLIER_STDDEV_MULTIPLE standard deviations from the batch's own mean, OR
 * larger in absolute terms than OUTLIER_ABS_PCT_THRESHOLD regardless of the
 * batch's spread. The absolute floor is what catches a single wild jump in an
 * otherwise flat batch, where the standard deviation is near zero and a
 * multiple of it would be a meaningless bar.
 */
function outlierRows(rows: DiffedRow[]): Map<number, number> {
  const pcts = new Map<number, number>()

  rows.forEach((row, index) => {
    if (row.status !== 'changed' || row.oldPrice === null || row.oldPrice === 0) {
      return
    }

    pcts.set(index, ((row.newPrice - row.oldPrice) / row.oldPrice) * 100)
  })

  if (pcts.size === 0) {
    return new Map()
  }

  const values = [...pcts.values()]
  const mean = values.reduce((sum, p) => sum + p, 0) / values.length
  const variance = values.reduce((sum, p) => sum + (p - mean) ** 2, 0) / values.length
  const stddev = Math.sqrt(variance)

  const outliers = new Map<number, number>()

  for (const [index, pct] of pcts) {
    const farFromTheRest =
      stddev > 0.0001 && Math.abs(pct - mean) > OUTLIER_STDDEV_MULTIPLE * stddev

    if (farFromTheRest || Math.abs(pct) >= OUTLIER_ABS_PCT_THRESHOLD) {
      outliers.set(index, pct)
    }
  }

  return outliers
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100
