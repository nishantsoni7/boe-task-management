/**
 * Attendance-correction guards — who may correct, when, and with what reason,
 * plus the before/after pair the audit history stores.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/correctionRules.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canCorrectAttendance,
  validateCorrectionInput,
  toEngineCorrection,
  buildCorrectionAudit,
  type DaySnapshot,
} from './correctionRules'

// ─── 8 + 9: locking and permission ───────────────────────────────────────────

describe('canCorrectAttendance', () => {
  test('an admin may correct a draft or generated period', () => {
    assert.equal(canCorrectAttendance('admin', 'draft').allowed, true)
    assert.equal(canCorrectAttendance('admin', 'generated').allowed, true)
  })

  test('a locked period is refused, with a message that says why', () => {
    const decision = canCorrectAttendance('admin', 'locked')
    assert.equal(decision.allowed, false)
    if (decision.allowed) return
    assert.equal(decision.reason, 'payroll_locked')
    assert.match(decision.message, /locked/i)
  })

  test('no role other than admin may correct attendance', () => {
    for (const role of ['manager', 'member', 'hr', '', null, undefined]) {
      const decision = canCorrectAttendance(role, 'draft')
      assert.equal(decision.allowed, false, `role ${role} must be refused`)
      if (!decision.allowed) assert.equal(decision.reason, 'not_authorised')
    }
  })

  test('an unauthorised caller is refused even on an unlocked period', () => {
    // Order matters: a non-admin must be told they lack permission, not that
    // the period happens to be open.
    const decision = canCorrectAttendance('manager', 'locked')
    assert.equal(decision.allowed, false)
    if (!decision.allowed) assert.equal(decision.reason, 'not_authorised')
  })
})

// ─── 5: the remark is mandatory ──────────────────────────────────────────────

describe('validateCorrectionInput', () => {
  const base = {
    attendance_date: '2026-07-21',
    check_in_at: '2026-07-21T04:30:00.000Z',
    check_out_at: '2026-07-21T13:00:00.000Z',
    day_treatment: 'auto',
    remark: 'Forgot to punch in; actual arrival confirmed by manager.',
  }

  test('a complete correction is accepted', () => {
    const result = validateCorrectionInput(base)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.remark, base.remark)
    assert.equal(result.value.day_treatment, 'auto')
  })

  test('a missing remark is rejected', () => {
    const result = validateCorrectionInput({ ...base, remark: undefined })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /remark is required/i)
  })

  test('a whitespace-only remark is rejected', () => {
    for (const remark of ['', '   ', '\t\n  ']) {
      const result = validateCorrectionInput({ ...base, remark })
      assert.equal(result.ok, false, `"${remark}" must be rejected`)
    }
  })

  test('the remark is stored trimmed', () => {
    const result = validateCorrectionInput({ ...base, remark: '  Machine failed to capture punch-out.  ' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.remark, 'Machine failed to capture punch-out.')
  })

  test('an invalid date is rejected', () => {
    for (const attendance_date of ['21-07-2026', '2026-7-21', '', undefined]) {
      assert.equal(validateCorrectionInput({ ...base, attendance_date }).ok, false)
    }
  })

  test('an unknown day treatment is rejected', () => {
    assert.equal(validateCorrectionInput({ ...base, day_treatment: 'paid_leave' }).ok, false)
  })

  test('day treatment defaults to auto when omitted', () => {
    const result = validateCorrectionInput({ ...base, day_treatment: undefined })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.day_treatment, 'auto')
  })

  test('empty punches are accepted as "no punch"', () => {
    const result = validateCorrectionInput({ ...base, check_in_at: null, check_out_at: '' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.corrected_check_in_at, null)
    assert.equal(result.value.corrected_check_out_at, null)
  })

  test('a punch-out at or before the punch-in is rejected', () => {
    const sameTime = validateCorrectionInput({ ...base, check_out_at: base.check_in_at })
    assert.equal(sameTime.ok, false)

    const reversed = validateCorrectionInput({
      ...base,
      check_in_at:  '2026-07-21T13:00:00.000Z',
      check_out_at: '2026-07-21T04:30:00.000Z',
    })
    assert.equal(reversed.ok, false)
    if (!reversed.ok) assert.match(reversed.error, /later than punch-in/i)
  })

  test('an unparseable timestamp is rejected rather than silently dropped', () => {
    assert.equal(validateCorrectionInput({ ...base, check_in_at: 'yesterday morning' }).ok, false)
    assert.equal(validateCorrectionInput({ ...base, check_in_at: 12345 }).ok, false)
  })

  test('waiver flags default to false and only true turns them on', () => {
    const off = validateCorrectionInput(base)
    assert.equal(off.ok, true)
    if (!off.ok) return
    assert.equal(off.value.waive_late_arrival, false)

    const on = validateCorrectionInput({ ...base, waive_late_arrival: true, waive_missing_punch: 'yes' })
    assert.equal(on.ok, true)
    if (!on.ok) return
    assert.equal(on.value.waive_late_arrival, true)
    // A truthy non-boolean is not a waiver — the flag has to be sent properly.
    assert.equal(on.value.waive_missing_punch, false)
  })

  test('the validated value converts straight to an engine correction', () => {
    const result = validateCorrectionInput(base)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(toEngineCorrection(result.value), {
      attendance_date: '2026-07-21',
      corrected_check_in_at:  '2026-07-21T04:30:00.000Z',
      corrected_check_out_at: '2026-07-21T13:00:00.000Z',
      day_treatment: 'auto',
      waive_late_arrival: false,
      waive_early_checkout: false,
      waive_missing_punch: false,
    })
  })
})

// ─── 10: audit history keeps old and new ─────────────────────────────────────

describe('buildCorrectionAudit', () => {
  const before: DaySnapshot = {
    check_in_at: '2026-07-21T13:30:00.000Z',
    check_out_at: null,
    classification: 'missing_punch',
    deduction_amount: 2737.5647,
    net_salary: 27262.4353,
  }
  const after: DaySnapshot = {
    check_in_at: '2026-07-21T04:30:00.000Z',
    check_out_at: '2026-07-21T13:00:00.000Z',
    classification: 'full_present',
    deduction_amount: 0,
    net_salary: 30000,
  }

  test('both sides of every changed value are retained', () => {
    const audit = buildCorrectionAudit(before, after)
    assert.equal(audit.original_check_in_at,    '2026-07-21T13:30:00.000Z')
    assert.equal(audit.original_check_out_at,   null)
    assert.equal(audit.original_classification, 'missing_punch')
    assert.equal(audit.revised_classification,  'full_present')
    assert.equal(audit.original_deduction_amount, 2737.56)
    assert.equal(audit.revised_deduction_amount,  0)
    assert.equal(audit.original_net_salary,       27262.44)
    assert.equal(audit.revised_net_salary,        30000)
  })

  test('money is rounded to the two decimals the payroll columns store', () => {
    // Engine amounts are unrounded (salary/26/8.5 rarely lands on a paisa), so
    // the audit rounds once, at the boundary, to match numeric(10,2)/(12,2).
    const audit = buildCorrectionAudit(
      { ...before, deduction_amount: 1.006, net_salary: 2.994 },
      { ...after,  deduction_amount: 0.125, net_salary: 3.0049 },
    )
    assert.equal(audit.original_deduction_amount, 1.01)
    assert.equal(audit.original_net_salary,       2.99)
    assert.equal(audit.revised_deduction_amount,  0.13)
    assert.equal(audit.revised_net_salary,        3)
  })

  test('a day with nothing recorded before still produces a complete audit row', () => {
    const audit = buildCorrectionAudit(
      { check_in_at: null, check_out_at: null, classification: 'full_absent', deduction_amount: 1153.85, net_salary: 28846.15 },
      after,
    )
    assert.equal(audit.original_classification, 'full_absent')
    assert.equal(audit.revised_classification,  'full_present')
    assert.ok(audit.original_deduction_amount > audit.revised_deduction_amount)
  })
})
