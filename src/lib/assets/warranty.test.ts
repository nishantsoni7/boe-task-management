/**
 * Warranty status — derived, never stored.
 *
 * Run:
 *   npx tsx --test src/lib/assets/warranty.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPIRING_SOON_DAYS,
  daysUntilWarrantyExpiry,
  isWarrantyExpiringSoon,
  validateWarrantyDates,
  warrantyDetailLine,
  warrantyStatus,
} from './warranty'

// A fixed "today" so nothing here depends on when the suite runs.
const TODAY = '2026-08-01'

describe('warrantyStatus', () => {
  test('no expiry recorded is "not available", NOT "expired"', () => {
    // The distinction the whole module rests on: an asset nobody wrote a
    // warranty down for has not lost one.
    assert.equal(warrantyStatus(null, TODAY), 'not_available')
    assert.equal(warrantyStatus(undefined, TODAY), 'not_available')
    assert.equal(warrantyStatus('', TODAY), 'not_available')
    assert.equal(warrantyStatus('   ', TODAY), 'not_available')
  })

  test('an unreadable date reads as not available rather than crashing', () => {
    assert.equal(warrantyStatus('not-a-date', TODAY), 'not_available')
  })

  test('a future expiry beyond the notice window is active', () => {
    assert.equal(warrantyStatus('2027-01-01', TODAY), 'active')
  })

  test('a past expiry is expired', () => {
    assert.equal(warrantyStatus('2026-07-31', TODAY), 'expired')
  })

  test('expiring today is expiring_soon, not expired', () => {
    // The boundary that decides whether someone still has time to renew.
    assert.equal(warrantyStatus(TODAY, TODAY), 'expiring_soon')
  })

  test('exactly at the threshold is still expiring_soon', () => {
    assert.equal(warrantyStatus('2026-08-31', TODAY), 'expiring_soon') // 30 days
  })

  test('one day past the threshold is active', () => {
    assert.equal(warrantyStatus('2026-09-01', TODAY), 'active') // 31 days
  })

  test('the threshold is a parameter, so the rule is assertable at its edges', () => {
    assert.equal(warrantyStatus('2026-08-10', TODAY, 7), 'active')
    assert.equal(warrantyStatus('2026-08-10', TODAY, 9), 'expiring_soon')
  })

  test('the default threshold really is 30 days', () => {
    assert.equal(EXPIRING_SOON_DAYS, 30)
  })

  test('a timestamp is treated as its calendar date', () => {
    // Warranty is a calendar fact. It must not expire at 05:30 because the
    // reader's browser is in IST.
    assert.equal(warrantyStatus('2026-07-31T23:59:59Z', TODAY), 'expired')
    assert.equal(warrantyStatus('2026-08-01T00:00:01Z', TODAY), 'expiring_soon')
  })
})

describe('daysUntilWarrantyExpiry', () => {
  test('counts whole days, 0 on the expiry date itself', () => {
    assert.equal(daysUntilWarrantyExpiry(TODAY, TODAY), 0)
    assert.equal(daysUntilWarrantyExpiry('2026-08-11', TODAY), 10)
    assert.equal(daysUntilWarrantyExpiry('2026-07-22', TODAY), -10)
  })

  test('null when there is no usable date', () => {
    assert.equal(daysUntilWarrantyExpiry(null, TODAY), null)
    assert.equal(daysUntilWarrantyExpiry('rubbish', TODAY), null)
  })

  test('crosses a month boundary correctly', () => {
    assert.equal(daysUntilWarrantyExpiry('2026-09-01', '2026-08-30'), 2)
  })
})

describe('warrantyDetailLine', () => {
  test('says nothing at all when there is no date', () => {
    // Never "expires never".
    assert.equal(warrantyDetailLine(null, TODAY), null)
  })

  test('singular and plural both read as English', () => {
    assert.equal(warrantyDetailLine('2026-08-02', TODAY), 'Expires in 1 day')
    assert.equal(warrantyDetailLine('2026-08-03', TODAY), 'Expires in 2 days')
    assert.equal(warrantyDetailLine('2026-07-31', TODAY), 'Expired 1 day ago')
    assert.equal(warrantyDetailLine('2026-07-30', TODAY), 'Expired 2 days ago')
  })

  test('expiry day has its own sentence', () => {
    assert.equal(warrantyDetailLine(TODAY, TODAY), 'Expires today')
  })
})

describe('isWarrantyExpiringSoon', () => {
  test('true only inside the window, and never once expired', () => {
    assert.equal(isWarrantyExpiringSoon('2026-08-15', TODAY), true)
    assert.equal(isWarrantyExpiringSoon('2027-01-01', TODAY), false)
    assert.equal(isWarrantyExpiringSoon('2026-07-01', TODAY), false)
    assert.equal(isWarrantyExpiringSoon(null, TODAY), false)
  })
})

describe('validateWarrantyDates', () => {
  test('either side may be absent', () => {
    assert.equal(validateWarrantyDates(null, null), null)
    assert.equal(validateWarrantyDates(null, '2027-01-01'), null)
    assert.equal(validateWarrantyDates('2026-01-01', null), null)
  })

  test('expiry before start is refused, mirroring the DB constraint', () => {
    const msg = validateWarrantyDates('2026-06-01', '2026-05-01')
    assert.ok(msg && msg.includes('earlier'))
  })

  test('equal dates are allowed — a one-day warranty is still a warranty', () => {
    assert.equal(validateWarrantyDates('2026-06-01', '2026-06-01'), null)
  })

  test('an unreadable date is named as such', () => {
    assert.ok(validateWarrantyDates('yesterday', null))
    assert.ok(validateWarrantyDates(null, 'soon'))
  })
})
