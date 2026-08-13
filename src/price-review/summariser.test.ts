import { describe, expect, it } from 'vitest'

import { summarise } from './summariser.js'
import type { DiffedRow, RowStatus } from './types.js'

/**
 * Every figure the AI is given is computed here, from the diffed rows. The
 * model narrates these numbers; it never counts anything itself, because
 * models miscount rows.
 */
describe('summarise', () => {
  const row = (
    location: string,
    oldPrice: number | null,
    newPrice: number,
    status: RowStatus,
  ): DiffedRow => ({ location, oldPrice, newPrice, status })

  it('counts the rows by status', () => {
    const summary = summarise(
      [
        row('Singapore', 812, 845, 'changed'),
        row('Mumbai', 600, 600, 'unchanged'),
        row('Kandla', null, 700, 'new'),
        row('Atlantis', null, 500, 'unmatched'),
      ],
      '2026-08-20',
    )

    expect(summary.totalRows).toBe(4)
    expect(summary.priceDate).toBe('2026-08-20')
    expect(summary.byStatus).toEqual({
      changed: 1,
      new: 1,
      unchanged: 1,
      unmatched: 1,
    })
  })

  it('counts how many rose and fell', () => {
    const summary = summarise(
      [
        row('A', 100, 110, 'changed'),
        row('B', 100, 120, 'changed'),
        row('C', 100, 90, 'changed'),
        row('D', 100, 100, 'unchanged'),
        row('E', null, 500, 'new'),
      ],
      '2026-08-20',
    )

    expect(summary.changes.rose).toBe(2)
    expect(summary.changes.fell).toBe(1)
  })

  /** Median, not mean — one 340% outlier should not drag the typical move. */
  it('takes the median change percent so one outlier does not skew it', () => {
    const summary = summarise(
      [
        row('A', 100, 102, 'changed'),
        row('B', 100, 104, 'changed'),
        row('C', 100, 440, 'changed'),
      ],
      '2026-08-20',
    )

    expect(summary.changes.medianChangePct).toBe(4)
  })

  it('reports the largest rise and fall with their locations', () => {
    const summary = summarise(
      [
        row('Singapore', 100, 110, 'changed'),
        row('Mumbai', 100, 150, 'changed'),
        row('Kandla', 100, 70, 'changed'),
      ],
      '2026-08-20',
    )

    expect(summary.changes.largestRise).toMatchObject({ location: 'Mumbai', changePct: 50 })
    expect(summary.changes.largestFall).toMatchObject({ location: 'Kandla', changePct: -30 })
  })

  it('reports nulls rather than zeroes when nothing moved', () => {
    const summary = summarise([row('A', null, 500, 'new')], '2026-08-20')

    expect(summary.changes.rose).toBe(0)
    expect(summary.changes.fell).toBe(0)
    expect(summary.changes.medianChangePct).toBeNull()
    expect(summary.changes.largestRise).toBeNull()
    expect(summary.changes.largestFall).toBeNull()
  })

  /**
   * The absolute floor exists for exactly this shape: in a flat batch the
   * standard deviation is near zero, so "3 standard deviations" would be a
   * vanishingly small and meaningless bar.
   */
  it('suspects one wild jump in an otherwise flat batch', () => {
    const summary = summarise(
      [
        row('A', 100, 102, 'changed'),
        row('B', 100, 103, 'changed'),
        row('C', 100, 101, 'changed'),
        row('Mumbai', 58.2, 256.1, 'changed'),
      ],
      '2026-08-20',
    )

    expect(summary.suspectedErrors).toHaveLength(1)
    expect(summary.suspectedErrors[0]?.location).toBe('Mumbai')
    expect(summary.suspectedErrors[0]?.reason).toContain('unusually large')
  })

  it('suspects nothing in a flat batch', () => {
    const summary = summarise(
      [
        row('A', 100, 102, 'changed'),
        row('B', 100, 103, 'changed'),
        row('C', 100, 101, 'changed'),
      ],
      '2026-08-20',
    )

    expect(summary.suspectedErrors).toEqual([])
  })

  it('suspects a price of zero', () => {
    const summary = summarise([row('Haldia', 59.1, 0, 'changed')], '2026-08-20')

    expect(summary.suspectedErrors).toHaveLength(1)
    expect(summary.suspectedErrors[0]?.reason).toContain('zero')
  })

  it('suspects a row the differ rejected', () => {
    const summary = summarise([row('Kandla', 61, -12.5, 'invalid')], '2026-08-20')

    expect(summary.suspectedErrors).toHaveLength(1)
    expect(summary.suspectedErrors[0]?.status).toBe('invalid')
    expect(summary.suspectedErrors[0]?.reason).toContain('negative')
  })

  /**
   * The relative half of the rule, isolated: a 10% move is nowhere near the
   * 50% absolute floor, but it is still far outside a batch where everything
   * else moved 1%.
   */
  it('suspects a move far outside the batch even below the absolute floor', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`Flat${i}`, 100, 101, 'changed'))
    rows.push(row('Odd', 100, 110, 'changed'))

    const summary = summarise(rows, '2026-08-20')

    expect(summary.suspectedErrors).toHaveLength(1)
    expect(summary.suspectedErrors[0]?.location).toBe('Odd')
  })
})
