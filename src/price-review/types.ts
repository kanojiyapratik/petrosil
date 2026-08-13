/**
 * One site's request for a price review.
 *
 * The module holds no price data of its own, so everything needed to judge the
 * upload arrives in the request: the proposed rows, the prices the site
 * currently holds for that date, and the locations the site still considers
 * live. That is what makes a single deployment usable by any site.
 */
export interface PriceReviewRequest {
  /** Y-m-d, the date the batch applies to. */
  priceDate: string
  /** Parsed out of the uploaded sheet by the calling site. */
  rows: ProposedRow[]
  /** What the site currently holds for that date. */
  currentPrices: CurrentPrice[]
  /** The locations the site still considers live. */
  validLocations: string[]
}

export interface ProposedRow {
  location: string
  /** Unknown rather than number: a sheet cell can hold anything. */
  price: unknown
}

export interface CurrentPrice {
  location: string
  price: number
}

export type RowStatus =
  | 'new'
  | 'changed'
  | 'unchanged'
  | 'locked'
  | 'unmatched'
  | 'invalid'

export interface DiffedRow {
  location: string
  oldPrice: number | null
  newPrice: number
  status: RowStatus
}

export interface Move {
  location: string
  old: number
  new: number
  changePct: number
}

export interface SuspectedError {
  location: string
  oldPrice: number | null
  newPrice: number
  status: RowStatus
  reason: string
}

/** The figures handed to the model. Every one is computed, never asked for. */
export interface PriceSummary {
  totalRows: number
  priceDate: string
  byStatus: Record<string, number>
  changes: {
    rose: number
    fell: number
    medianChangePct: number | null
    largestRise: Move | null
    largestFall: Move | null
  }
  suspectedErrors: SuspectedError[]
}
