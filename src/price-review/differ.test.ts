import { afterEach, describe, expect, it, vi } from 'vitest'

import { diffPrices } from './differ.js'
import type { PriceReviewRequest } from './types.js'

/**
 * Ported from the Laravel module's PriceReviewDifferTest, one test per case.
 *
 * The differ is deliberately stateless: it never reaches for a database. The
 * calling site sends its own current prices and its own list of live
 * locations, which is what lets one deployment serve any site.
 */
describe('diffPrices', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const today = (date: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${date}T00:00:00Z`))
  }

  const diff = (overrides: Partial<PriceReviewRequest> = {}) =>
    diffPrices({
      priceDate: '2026-08-20',
      rows: [],
      currentPrices: [],
      validLocations: [],
      ...overrides,
    })

  it('marks a location with no price on that date as new', () => {
    today('2026-08-13')

    const rows = diff({
      rows: [{ location: 'Singapore', price: 845 }],
      validLocations: ['Singapore'],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      location: 'Singapore',
      status: 'new',
      oldPrice: null,
      newPrice: 845,
    })
  })

  it('marks a price equal to the one the site holds as unchanged', () => {
    today('2026-08-13')

    const rows = diff({
      rows: [{ location: 'Singapore', price: 812 }],
      currentPrices: [{ location: 'Singapore', price: 812 }],
      validLocations: ['Singapore'],
    })

    expect(rows[0]).toMatchObject({ status: 'unchanged', oldPrice: 812 })
  })

  it('marks a different price on a date not yet past as changed', () => {
    today('2026-08-13')

    const rows = diff({
      priceDate: '2026-08-20',
      rows: [{ location: 'Singapore', price: 845 }],
      currentPrices: [{ location: 'Singapore', price: 812 }],
      validLocations: ['Singapore'],
    })

    expect(rows[0]).toMatchObject({ status: 'changed', oldPrice: 812, newPrice: 845 })
  })

  it('marks a different price on a past date as locked', () => {
    today('2026-08-13')

    const rows = diff({
      priceDate: '2026-08-01',
      rows: [{ location: 'Singapore', price: 845 }],
      currentPrices: [{ location: 'Singapore', price: 812 }],
      validLocations: ['Singapore'],
    })

    expect(rows[0]?.status).toBe('locked')
  })

  /**
   * The counterpart to the rule above, and the reason it cannot simply ban
   * past dates: every real price is entered days after the date it applies
   * to, so an empty past date must stay fillable.
   */
  it('still allows an empty past date to be backfilled', () => {
    today('2026-08-13')

    const rows = diff({
      priceDate: '2026-08-01',
      rows: [{ location: 'Singapore', price: 845 }],
      currentPrices: [],
      validLocations: ['Singapore'],
    })

    expect(rows[0]?.status).toBe('new')
  })

  /**
   * The module knows nothing about any site's locations, so a name the site
   * did not list as live is reported back rather than guessed at.
   */
  it('marks a location the site did not list as live as unmatched', () => {
    today('2026-08-13')

    const rows = diff({
      rows: [{ location: 'Atlantis', price: 845 }],
      validLocations: ['Singapore', 'Mumbai'],
    })

    expect(rows[0]).toMatchObject({ status: 'unmatched', location: 'Atlantis' })
  })

  /** Rejected outright, never clamped to zero — a bad number is a data problem. */
  it('marks a negative price as invalid without clamping it', () => {
    today('2026-08-13')

    const rows = diff({
      rows: [{ location: 'Singapore', price: -12.5 }],
      currentPrices: [{ location: 'Singapore', price: 812 }],
      validLocations: ['Singapore'],
    })

    expect(rows[0]).toMatchObject({ status: 'invalid', newPrice: -12.5 })
  })

  it('marks a non-numeric price as invalid', () => {
    today('2026-08-13')

    const rows = diff({
      rows: [{ location: 'Singapore', price: 'n/a' }],
      validLocations: ['Singapore'],
    })

    expect(rows[0]?.status).toBe('invalid')
  })

  /**
   * JavaScript's Number('') is 0, and Number(null) is 0 — both would sail
   * through a naive numeric check and publish a zero price. PHP's is_numeric
   * rejected them, so the port must too.
   */
  it('marks an empty or null price as invalid rather than zero', () => {
    today('2026-08-13')

    const rows = diff({
      rows: [
        { location: 'Singapore', price: '' },
        { location: 'Mumbai', price: null },
      ],
      validLocations: ['Singapore', 'Mumbai'],
    })

    expect(rows[0]?.status).toBe('invalid')
    expect(rows[1]?.status).toBe('invalid')
  })
})
