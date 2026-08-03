/**
 * Payroll Result Detail — which dates land in which tab.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/resultTabs.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDeductionDay,
  isConsideredDay,
  isCorrectableDay,
  payableDayValue,
  toDeductionDays,
  toConsideredDays,
} from './resultTabs'
import type { EngineDay, DayClassification, PendingDeductionLine } from './types'

function day(overrides: Partial<EngineDay> = {}): EngineDay {
  return {
    date: '2026-07-21',
    classification: 'full_present',
    effective_hours_worked: 8.5,
    deduction_lines: [],
    total_deduction_amount: 0,
    check_in_at: '2026-07-21T04:30:00.000Z',
    check_out_at: '2026-07-21T13:00:00.000Z',
    raw_check_in_at: '2026-07-21T04:30:00.000Z',
    raw_check_out_at: '2026-07-21T13:00:00.000Z',
    is_corrected: false,
    ...overrides,
  }
}

function line(type: string, amount: number): PendingDeductionLine {
  return {
    line_date: '2026-07-21',
    deduction_type: type as PendingDeductionLine['deduction_type'],
    hours_deducted: 2,
    amount_deducted: amount,
  }
}

// ─── 11: Deductions tab ──────────────────────────────────────────────────────

describe('the Deductions tab', () => {
  test('holds dates that actually cost money', () => {
    assert.equal(isDeductionDay(day({ total_deduction_amount: 271.49, deduction_lines: [line('late_arrival', 271.49)] })), true)
  })

  test('excludes a clean day', () => {
    assert.equal(isDeductionDay(day()), false)
  })

  test('excludes a deduction fully absorbed by paid leave', () => {
    // The line exists in the ledger at ₹0 — showing it under a red heading
    // would tell the employee they lost money they did not lose.
    const absorbed = day({ deduction_lines: [line('late_arrival', 0)], total_deduction_amount: 0 })
    assert.equal(isDeductionDay(absorbed), false)
    assert.equal(toDeductionDays([absorbed]).length, 0)
  })

  test('drops zero-amount lines from a date that also has a charged one', () => {
    const mixed = day({
      deduction_lines: [line('late_arrival', 0), line('missing_punch_out', 271.49)],
      total_deduction_amount: 271.49,
    })
    const [row] = toDeductionDays([mixed])
    assert.deepEqual(row.lines.map(l => l.deduction_type), ['missing_punch_out'])
    assert.equal(row.total_amount, 271.49)
  })

  test('carries the correction flag and the effective punches through', () => {
    const corrected = day({
      total_deduction_amount: 100,
      deduction_lines: [line('late_arrival', 100)],
      is_corrected: true,
      check_in_at: '2026-07-21T05:15:00.000Z',
    })
    const [row] = toDeductionDays([corrected])
    assert.equal(row.is_corrected, true)
    assert.equal(row.check_in_at, '2026-07-21T05:15:00.000Z')
  })

  test('one date with two reasons stays one row', () => {
    const twoReasons = day({
      deduction_lines: [line('missing_punch_out', 271.49), line('late_arrival', 1222.19)],
      total_deduction_amount: 1493.68,
    })
    const rows = toDeductionDays([twoReasons])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].lines.length, 2)
  })
})

// ─── 12: Days Considered tab ─────────────────────────────────────────────────

describe('the Days Considered tab', () => {
  const paid: DayClassification[] = [
    'full_present', 'present_with_shortfall', 'short_present', 'missing_punch', 'half_day', 'weekly_off', 'holiday',
  ]
  const notPaid: DayClassification[] = ['full_absent', 'pre_joining']

  test('holds every paid or present status', () => {
    for (const classification of paid) {
      assert.equal(isConsideredDay(day({ classification })), true, `${classification} must be counted`)
    }
  })

  test('excludes absence and dates before joining', () => {
    for (const classification of notPaid) {
      assert.equal(isConsideredDay(day({ classification })), false, `${classification} must not be counted`)
    }
  })

  test('a date that was both worked and deducted appears in both tabs', () => {
    // A late arrival is a full present day that still carries an hourly cut.
    // Hiding it from Days Considered would understate the days worked.
    const late = day({ deduction_lines: [line('late_arrival', 271.49)], total_deduction_amount: 271.49 })
    assert.equal(isDeductionDay(late), true)
    assert.equal(isConsideredDay(late), true)
  })

  test('payable day value reflects what the date is worth', () => {
    assert.equal(payableDayValue('full_present'), 1)
    assert.equal(payableDayValue('missing_punch'), 1)
    assert.equal(payableDayValue('half_day'), 0.5)
    assert.equal(payableDayValue('weekly_off'), 0)
    assert.equal(payableDayValue('holiday'), 0)
    assert.equal(payableDayValue('full_absent'), 0)
  })

  test('the rows carry the status, hours and correction flag', () => {
    const [row] = toConsideredDays([day({ is_corrected: true })])
    assert.equal(row.classification, 'full_present')
    assert.equal(row.effective_hours_worked, 8.5)
    assert.equal(row.payable_day_value, 1)
    assert.equal(row.is_corrected, true)
  })
})

// ─── Editability ─────────────────────────────────────────────────────────────

describe('isCorrectableDay', () => {
  test('worked, absent and missing-punch dates can be corrected', () => {
    for (const classification of ['full_present', 'full_absent', 'missing_punch', 'half_day'] as DayClassification[]) {
      assert.equal(isCorrectableDay(day({ classification })), true)
    }
  })

  test('dates payroll never counts cannot be corrected', () => {
    // There is nothing on a weekly off, a holiday or a pre-joining date for a
    // correction to change.
    for (const classification of ['weekly_off', 'holiday', 'pre_joining'] as DayClassification[]) {
      assert.equal(isCorrectableDay(day({ classification })), false)
    }
  })
})
