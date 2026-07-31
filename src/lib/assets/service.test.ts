/**
 * Repair & service — cost arithmetic and record validation.
 *
 * Run:
 *   npx tsx --test src/lib/assets/service.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  lastServiceDate,
  parseCost,
  summarizeService,
  totalServiceCost,
  upcomingServiceDate,
  validateServiceRecord,
} from './service'
import type { AssetServiceRecord } from './types'

const record = (over: Partial<AssetServiceRecord> = {}): AssetServiceRecord => ({
  id: 'r1',
  asset_id: 'a1',
  service_type: 'repair',
  issue: null,
  description: null,
  vendor: null,
  sent_date: null,
  returned_date: null,
  next_service_date: null,
  cost: '0',
  remarks: null,
  condition_after: null,
  status: 'completed',
  recorded_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

describe('parseCost', () => {
  test('numeric(14,2) arrives as a STRING and must become a number', () => {
    // The whole reason this module exists: "1200" + "800" is "1200800".
    assert.equal(parseCost('1200.50'), 1200.5)
    assert.equal(parseCost(1200.5), 1200.5)
  })

  test('absent and unreadable values are null, not zero and not NaN', () => {
    assert.equal(parseCost(null), null)
    assert.equal(parseCost(undefined), null)
    assert.equal(parseCost(''), null)
    assert.equal(parseCost('   '), null)
    assert.equal(parseCost('abc'), null)
    assert.equal(parseCost(Number.NaN), null)
    assert.equal(parseCost(Number.POSITIVE_INFINITY), null)
  })
})

describe('totalServiceCost', () => {
  test('sums string costs numerically', () => {
    const total = totalServiceCost([
      record({ cost: '1200' }),
      record({ cost: '800' }),
    ])
    assert.equal(total, 2000)
  })

  test('a single unreadable row contributes 0 rather than blanking the total', () => {
    const total = totalServiceCost([
      record({ cost: '1200' }),
      record({ cost: 'oops' }),
      record({ cost: null }),
      record({ cost: '300.25' }),
    ])
    assert.equal(total, 1500.25)
  })

  test('repeated float addition never surfaces as a fractional tail', () => {
    const total = totalServiceCost([
      record({ cost: '0.1' }), record({ cost: '0.2' }), record({ cost: '0.3' }),
    ])
    assert.equal(total, 0.6)
  })

  test('no records is zero, not NaN', () => {
    assert.equal(totalServiceCost([]), 0)
  })
})

describe('lastServiceDate', () => {
  test('prefers a returned date, then a sent date, then when it was recorded', () => {
    assert.equal(
      lastServiceDate([record({ returned_date: '2026-05-01', sent_date: '2026-04-01' })]),
      '2026-05-01',
    )
    assert.equal(lastServiceDate([record({ sent_date: '2026-04-01' })]), '2026-04-01')
    assert.equal(lastServiceDate([record({ created_at: '2026-03-01' })]), '2026-03-01')
  })

  test('takes the most recent across records', () => {
    const latest = lastServiceDate([
      record({ returned_date: '2026-02-01' }),
      record({ returned_date: '2026-06-01' }),
      record({ returned_date: '2026-04-01' }),
    ])
    assert.equal(latest, '2026-06-01')
  })

  test('null when nothing is dated', () => {
    assert.equal(lastServiceDate([]), null)
  })
})

describe('upcomingServiceDate', () => {
  const now = '2026-08-01T00:00:00Z'

  test('a next-service date already in the past is NOT upcoming', () => {
    // Labelling an overdue date "Upcoming" would be a lie.
    assert.equal(upcomingServiceDate([record({ next_service_date: '2026-01-01' })], now), null)
  })

  test('returns the soonest future date', () => {
    const next = upcomingServiceDate([
      record({ next_service_date: '2027-01-01' }),
      record({ next_service_date: '2026-09-15' }),
      record({ next_service_date: '2026-12-01' }),
    ], now)
    assert.equal(next, '2026-09-15')
  })

  test('today counts as upcoming', () => {
    assert.equal(upcomingServiceDate([record({ next_service_date: '2026-08-01' })], now), '2026-08-01')
  })

  test('null when nothing is scheduled', () => {
    assert.equal(upcomingServiceDate([record()], now), null)
  })
})

describe('summarizeService', () => {
  test('every figure the header shows, in one pass', () => {
    const summary = summarizeService([
      record({ cost: '1200', returned_date: '2026-05-01', next_service_date: '2026-11-01' }),
      record({ cost: '800', status: 'in_progress', sent_date: '2026-07-20' }),
    ], '2026-08-01T00:00:00Z')

    assert.equal(summary.totalCost, 2000)
    assert.equal(summary.recordCount, 2)
    assert.equal(summary.lastServiceDate, '2026-07-20')
    assert.equal(summary.upcomingServiceDate, '2026-11-01')
    assert.equal(summary.openRecordCount, 1)
  })

  test('an asset with no service history summarises to zeroes, not to nulls everywhere', () => {
    const summary = summarizeService([])
    assert.equal(summary.totalCost, 0)
    assert.equal(summary.recordCount, 0)
    assert.equal(summary.openRecordCount, 0)
    assert.equal(summary.lastServiceDate, null)
    assert.equal(summary.upcomingServiceDate, null)
  })
})

describe('validateServiceRecord', () => {
  test('accepts a well-formed record', () => {
    assert.equal(validateServiceRecord({
      serviceType: 'maintenance', cost: '500', sentDate: '2026-01-01', returnedDate: '2026-01-05',
    }), null)
  })

  test('rejects an unknown service type', () => {
    assert.ok(validateServiceRecord({ serviceType: 'exorcism' }))
  })

  test('accepts all four initial service types', () => {
    for (const t of ['repair', 'maintenance', 'inspection', 'upgrade']) {
      assert.equal(validateServiceRecord({ serviceType: t }), null, t)
    }
  })

  test('an empty cost is allowed — not every record has one yet', () => {
    assert.equal(validateServiceRecord({ serviceType: 'repair', cost: '' }), null)
    assert.equal(validateServiceRecord({ serviceType: 'repair', cost: null }), null)
  })

  test('rejects a negative cost, mirroring the CHECK constraint', () => {
    const msg = validateServiceRecord({ serviceType: 'repair', cost: '-1' })
    assert.ok(msg && msg.includes('negative'))
  })

  test('rejects a non-numeric cost', () => {
    assert.ok(validateServiceRecord({ serviceType: 'repair', cost: 'lots' }))
  })

  test('rejects a return before the send, mirroring asset_service_dates_ordered', () => {
    const msg = validateServiceRecord({
      serviceType: 'repair', sentDate: '2026-05-10', returnedDate: '2026-05-01',
    })
    assert.ok(msg && msg.includes('earlier'))
  })

  test('same-day send and return is fine', () => {
    assert.equal(validateServiceRecord({
      serviceType: 'repair', sentDate: '2026-05-10', returnedDate: '2026-05-10',
    }), null)
  })
})
