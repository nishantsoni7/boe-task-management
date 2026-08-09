/**
 * Attendance & Payroll participation.
 *
 * BOE keeps accounts that must stay live but must not be paid or measured —
 * dummy logins, family members, non-salaried users. The requirement is that
 * excluding one of them changes what is CALCULATED without touching the account,
 * and these tests pin both halves of that: the excluded member cannot reach
 * payroll generation by any route, and nothing about their account is read to
 * decide it.
 *
 * The generation half is proved end-to-end through the real engine rather than
 * by asserting on a boolean, because the whole point of the defect class is a
 * caller that forgets the filter.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/participation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PARTICIPATION_COLUMN,
  participatesInPayroll,
  partitionByParticipation,
  onlyParticipating,
  excludeConfirmTitle,
  EXCLUDE_CONFIRM_BODY,
} from './participation'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord } from './types'

// ─── The predicate ────────────────────────────────────────────────────────────

describe('participatesInPayroll', () => {
  test('a member with the flag on takes part', () => {
    assert.equal(participatesInPayroll({ payroll_active: true }), true)
  })

  test('a member with the flag off does not', () => {
    assert.equal(participatesInPayroll({ payroll_active: false }), false)
  })

  test('a missing flag means "not selected", not "excluded"', () => {
    // payroll_active is NOT NULL DEFAULT true, so a query that did not ask for
    // the column must not be read as everybody being excluded.
    assert.equal(participatesInPayroll({}), true)
    assert.equal(participatesInPayroll({ payroll_active: null }), true)
  })

  test('a soft-deleted row never takes part, whatever the flag says', () => {
    assert.equal(participatesInPayroll({ payroll_active: true, is_deleted: true }), false)
  })

  test('a null or undefined row does not take part', () => {
    assert.equal(participatesInPayroll(null), false)
    assert.equal(participatesInPayroll(undefined), false)
  })

  test('the account being active is NOT what this reads', () => {
    // The entire requirement: exclusion must not be expressed as deactivation,
    // so is_active is not an input here and an excluded member is a live account.
    assert.equal(participatesInPayroll({ payroll_active: false, is_deleted: false }), false)
  })
})

// ─── Partition ────────────────────────────────────────────────────────────────

describe('partitionByParticipation', () => {
  const roster = [
    { id: 'a', payroll_active: true },
    { id: 'b', payroll_active: false },
    { id: 'c', payroll_active: true },
    { id: 'd', payroll_active: true, is_deleted: true },
  ]

  test('splits the roster without losing anybody', () => {
    const { included, excluded } = partitionByParticipation(roster)
    assert.deepEqual(included.map(r => r.id), ['a', 'c'])
    assert.deepEqual(excluded.map(r => r.id), ['b', 'd'])
    assert.equal(included.length + excluded.length, roster.length)
  })

  test('an empty roster produces two empty lists', () => {
    const { included, excluded } = partitionByParticipation([])
    assert.deepEqual(included, [])
    assert.deepEqual(excluded, [])
  })
})

// ─── The database filter ──────────────────────────────────────────────────────

describe('onlyParticipating', () => {
  test('restricts the query on the participation column, in the database', () => {
    // Filtering after the read is not equivalent: an excluded member would still
    // cross the wire, and any caller that forgot to filter would leak them.
    const calls: Array<[string, unknown]> = []
    const fakeQuery = {
      eq(column: string, value: unknown) { calls.push([column, value]); return this },
    }

    const returned = onlyParticipating(fakeQuery)

    assert.deepEqual(calls, [[PARTICIPATION_COLUMN, true]])
    assert.equal(PARTICIPATION_COLUMN, 'payroll_active', 'the column must stay the existing one — no second source of truth')
    assert.equal(returned, fakeQuery, 'must stay chainable so callers can add .order()/.or()')
  })
})

// ─── Generation ───────────────────────────────────────────────────────────────

const PERIOD: EnginePeriod = { id: 'p1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

function employee(overrides: Partial<EngineEmployee> = {}): EngineEmployee {
  return {
    id: 'emp-1',
    monthly_salary: 26000,
    payroll_active: true,
    joining_date: null,
    employment_type: 'permanent',
    ...overrides,
  }
}

// A full present day, so an included employee demonstrably produces a result.
const ATTENDANCE: EngineAttendanceRecord[] = [
  {
    id: 'r1',
    attendance_date: '2026-07-01',
    check_in_at:  '2026-07-01T04:30:00Z',   // 10:00 IST
    check_out_at: '2026-07-01T13:00:00Z',   // 18:30 IST
  },
]

describe('payroll generation honours participation', () => {
  test('an included member enters generation and produces a result', () => {
    const outcome = generatePayrollForEmployee(employee(), PERIOD, ATTENDANCE, [], [])
    assert.equal(isSkip(outcome), false)
  })

  test('an excluded member does not — the engine refuses before calculating', () => {
    const outcome = generatePayrollForEmployee(
      employee({ payroll_active: false }), PERIOD, ATTENDANCE, [], [],
    )
    assert.equal(isSkip(outcome), true)
    assert.equal(isSkip(outcome) && outcome.reason, 'employee_inactive')
  })

  test('a re-included member participates again, with no other change', () => {
    // Re-enabling is the same one field going back. Nothing else about the
    // employee is touched, so the same inputs produce a normal result again.
    const outcome = generatePayrollForEmployee(
      employee({ payroll_active: true }), PERIOD, ATTENDANCE, [], [],
    )
    assert.equal(isSkip(outcome), false)
    assert.equal(!isSkip(outcome) && outcome.gross_salary, 26000)
  })

  test('the named-employee path filters before the engine, not after', () => {
    // What /api/payroll/generate does with an explicit employee_ids list. The
    // engine guard is a backstop; the boundary is here, so a future caller that
    // does not go through the engine still cannot process an excluded member.
    const named = [
      employee({ id: 'included-1' }),
      employee({ id: 'excluded-1', payroll_active: false }),
      employee({ id: 'included-2' }),
    ]

    const { included, excluded } = partitionByParticipation(named)

    assert.deepEqual(included.map(e => e.id), ['included-1', 'included-2'])
    assert.deepEqual(excluded.map(e => e.id), ['excluded-1'])

    for (const e of included) {
      assert.equal(isSkip(generatePayrollForEmployee(e, PERIOD, ATTENDANCE, [], [])), false)
    }
  })
})

// ─── Confirmation copy ────────────────────────────────────────────────────────

describe('confirmation copy', () => {
  test('names the member and promises history is untouched', () => {
    assert.equal(excludeConfirmTitle('Asha Rao'), 'Exclude Asha Rao from Attendance & Payroll?')
    assert.match(EXCLUDE_CONFIRM_BODY, /Future attendance and payroll calculations will ignore this member/)
    assert.match(EXCLUDE_CONFIRM_BODY, /historical records will remain unchanged/)
  })
})
