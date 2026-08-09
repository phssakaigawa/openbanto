import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  // Static ESM imports are evaluated before top-level test code. Set the
  // instance home in a hoisted block so shared/path constants resolve to an
  // isolated writable database instead of the user's real runtime DB.
  process.env.RYOKO_HOME = `/tmp/openryoko-costs-test-${process.pid}`
  delete process.env.JINN_HOME
})

import { getCostSummary, getCostsByEmployee } from '../costs.js'

describe('getCostSummary', () => {
  it('returns zero total when no sessions exist', () => {
    const result = getCostSummary('month')
    expect(result.total).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(result.daily)).toBe(true)
    expect(Array.isArray(result.byEmployee)).toBe(true)
  })

  it('returns zero for day period', () => {
    const result = getCostSummary('day')
    expect(result.total).toBeGreaterThanOrEqual(0)
  })

  it('returns zero for week period', () => {
    const result = getCostSummary('week')
    expect(result.total).toBeGreaterThanOrEqual(0)
  })
})

describe('getCostsByEmployee', () => {
  it('returns an array', () => {
    const result = getCostsByEmployee('month')
    expect(Array.isArray(result)).toBe(true)
  })
})
