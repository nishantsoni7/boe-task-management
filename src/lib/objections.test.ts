/**
 * Objection rules — the parts that need no database.
 *
 * The validator mirrors the table's own CHECK constraints, so these tests are
 * also the statement of what the constraints mean: exactly one target, a reason
 * that survives trimming, and a snapshot the browser never gets to write.
 *
 * Run:
 *   npx tsx --test src/lib/objections.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateObjectionInput,
  attendanceSnapshot,
  payrollSnapshot,
  employeeStatusLabel,
  isObjectionStatus,
  isReviewableStatus,
  ownAttendanceObjections,
  objectionsByAttendanceDate,
  REASON_MAX_LENGTH,
  type ObjectionRow,
} from './objections'

describe('validateObjectionInput — exactly one target', () => {
  test('an attendance date alone is valid', () => {
    const r = validateObjectionInput({ attendance_date: '2026-07-20', reason: 'I was present' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.ok && r.target, { kind: 'attendance', attendanceDate: '2026-07-20' })
  })

  test('a payroll result alone is valid', () => {
    const r = validateObjectionInput({ payroll_result_id: 'res-1', reason: 'net looks low' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.ok && r.target, { kind: 'payroll', payrollResultId: 'res-1' })
  })

  test('both targets is rejected — the table constraint would reject it too', () => {
    const r = validateObjectionInput({
      attendance_date: '2026-07-20', payroll_result_id: 'res-1', reason: 'x',
    })
    assert.equal(r.ok, false)
  })

  test('neither target is rejected', () => {
    assert.equal(validateObjectionInput({ reason: 'x' }).ok, false)
  })

  test('a malformed date is rejected before it reaches the database', () => {
    assert.equal(validateObjectionInput({ attendance_date: '20-07-2026', reason: 'x' }).ok, false)
    assert.equal(validateObjectionInput({ attendance_date: 'yesterday', reason: 'x' }).ok, false)
  })

  test('non-string targets cannot smuggle a value through', () => {
    assert.equal(validateObjectionInput({ attendance_date: { toString: () => '2026-07-20' }, reason: 'x' }).ok, false)
    assert.equal(validateObjectionInput({ payroll_result_id: 123, reason: 'x' }).ok, false)
  })
})

describe('validateObjectionInput — the reason', () => {
  test('an empty or whitespace reason is rejected', () => {
    for (const reason of ['', '   ', '\t\n', undefined, null, 42]) {
      assert.equal(
        validateObjectionInput({ attendance_date: '2026-07-20', reason }).ok, false,
        `reason ${JSON.stringify(reason)} must not pass`,
      )
    }
  })

  test('the reason is trimmed, so padding cannot fake content', () => {
    const r = validateObjectionInput({ attendance_date: '2026-07-20', reason: '  punch missing  ' })
    assert.equal(r.ok && r.reason, 'punch missing')
  })

  test('an over-long reason is rejected', () => {
    const r = validateObjectionInput({
      attendance_date: '2026-07-20', reason: 'a'.repeat(REASON_MAX_LENGTH + 1),
    })
    assert.equal(r.ok, false)
  })

  test('a reason exactly at the limit is accepted', () => {
    const r = validateObjectionInput({
      attendance_date: '2026-07-20', reason: 'a'.repeat(REASON_MAX_LENGTH),
    })
    assert.equal(r.ok, true)
  })
})

describe('status vocabulary', () => {
  test('only the three statuses are statuses', () => {
    for (const s of ['pending', 'approved', 'rejected']) assert.equal(isObjectionStatus(s), true)
    for (const s of ['resolved', 'PENDING', '', null, 1]) assert.equal(isObjectionStatus(s), false)
  })

  test('only approved and rejected are reviewable — an admin cannot set pending', () => {
    assert.equal(isReviewableStatus('approved'), true)
    assert.equal(isReviewableStatus('rejected'), true)
    assert.equal(isReviewableStatus('pending'), false)
  })

  test('approved reads as Resolved to the employee', () => {
    assert.equal(employeeStatusLabel('pending'),  'Issue Pending')
    assert.equal(employeeStatusLabel('approved'), 'Resolved')
    assert.equal(employeeStatusLabel('rejected'), 'Rejected')
  })
})

describe('snapshots describe, they do not compute', () => {
  const clock = (s: string) => s.slice(11, 16)

  test('an attendance snapshot names the punches as they stand', () => {
    const s = attendanceSnapshot({
      attendance_date: '2026-07-20',
      check_in_at:  '2026-07-20T20:50:00Z',
      check_out_at: null,
      effective_status: 'missing_punch',
      clock,
    })
    assert.match(s, /2026-07-20/)
    assert.match(s, /20:50/)
    assert.match(s, /no punch-out/)
    assert.match(s, /missing_punch/)
  })

  test('a day with no punches at all still describes itself', () => {
    const s = attendanceSnapshot({
      attendance_date: '2026-07-21',
      check_in_at: null, check_out_at: null,
      effective_status: 'absent', clock,
    })
    assert.match(s, /no punch-in/)
    assert.match(s, /no punch-out/)
  })

  test('a payroll snapshot carries the three figures the employee saw', () => {
    const s = payrollSnapshot({
      payroll_month: 7, payroll_year: 2026,
      gross_salary: 18000, total_deductions: 2036.2, net_salary: 15963.8,
    })
    assert.match(s, /07\/2026/)
    assert.match(s, /18,000\.00/)
    assert.match(s, /2,036\.20/)
    assert.match(s, /15,963\.80/)
  })

  test('missing figures render as a dash rather than a zero', () => {
    const s = payrollSnapshot({
      payroll_month: null, payroll_year: null,
      gross_salary: null, total_deductions: null, net_salary: null,
    })
    assert.match(s, /period unknown/)
    assert.match(s, /—/)
    assert.equal(/₹0\.00/.test(s), false, 'a missing amount must never read as zero')
  })
})

// ─── Whose 11 July is it? ─────────────────────────────────────────────────────
//
// An attendance objection is keyed by DATE, and a date is not a person. The
// self-service page matched badges on date alone, which was invisible for an
// ordinary employee (the API pins them to their own rows) and wrong for an
// ADMIN, who gets the company-wide review queue from that same endpoint: one
// employee's pending issue on 11 July showed as "Issue Pending" on the admin's
// own 11 July row — a false statement about the admin's attendance.

const A = 'employee-a'
const B = 'employee-b'

const objection = (
  employee_id: string,
  attendance_date: string | null,
  extra: Partial<ObjectionRow> = {},
): ObjectionRow => ({
  id: `${employee_id}-${attendance_date}-${extra.status ?? 'pending'}`,
  employee_id,
  attendance_date,
  payroll_result_id: null,
  reason: 'looks wrong',
  subject_snapshot: 'snapshot',
  status: 'pending',
  reviewed_by: null,
  reviewed_at: null,
  review_note: null,
  created_at: '2026-08-08T00:00:00Z',
  ...extra,
})

describe('an attendance badge belongs to one employee AND one date', () => {
  // The company-wide answer an admin gets back from /api/objections.
  const adminQueue: ObjectionRow[] = [
    objection(B, '2026-07-11'),
    objection(A, '2026-07-11'),
    objection(A, '2026-07-20', { status: 'approved' }),
    objection(B, '2026-07-22'),
    { ...objection(A, null), payroll_result_id: 'res-1' },
  ]

  test('1. A own objection on 11 July appears on A row', () => {
    const mine = objectionsByAttendanceDate(ownAttendanceObjections(adminQueue, A))
    assert.equal(mine.get('2026-07-11')?.employee_id, A)
  })

  test('2. B objection on the SAME date does not appear on A row', () => {
    const mine = ownAttendanceObjections(adminQueue, A)
    assert.equal(mine.some(o => o.employee_id === B), false, 'a colleague row must never survive the filter')

    // And with B first in the list — the ordering that produced the bug, since
    // a date-keyed map takes whichever row it meets first.
    const byDate = objectionsByAttendanceDate(ownAttendanceObjections(adminQueue, A))
    assert.notEqual(byDate.get('2026-07-11')?.employee_id, B)
  })

  test('3. an admin viewing their own page inherits nobody else badge', () => {
    // The observed case: the only objection for 22 July belongs to B, so the
    // admin's own 22 July row must have no badge at all.
    const mine = objectionsByAttendanceDate(ownAttendanceObjections(adminQueue, A))
    assert.equal(mine.has('2026-07-22'), false, 'a date only a colleague objected to must stay blank')
    assert.deepEqual([...mine.keys()].sort(), ['2026-07-11', '2026-07-20'])
  })

  test('4. an ordinary employee sees exactly what they saw before', () => {
    // Their API answer is already pinned to them, so the filter is a no-op —
    // the fix must not take anything away from the case that already worked.
    const ownOnly = adminQueue.filter(o => o.employee_id === A)
    assert.deepEqual(ownAttendanceObjections(ownOnly, A), ownOnly.filter(o => o.attendance_date))
    const byDate = objectionsByAttendanceDate(ownAttendanceObjections(ownOnly, A))
    assert.equal(byDate.get('2026-07-20')?.status, 'approved', 'a resolved issue still shows as resolved')
  })

  test('5. the filter is page-level — the queue it reads is left whole', () => {
    const before = JSON.stringify(adminQueue)
    ownAttendanceObjections(adminQueue, A)
    assert.equal(JSON.stringify(adminQueue), before, 'filtering must not mutate the company-wide list')
    assert.equal(adminQueue.filter(o => o.employee_id === B).length, 2,
      'the admin queue still carries every employee — that is what it is for')
  })

  test('6. payroll objections are not days, and an unknown viewer gets nothing', () => {
    // A payroll objection has no attendance_date and must never reach a day row.
    assert.equal(ownAttendanceObjections(adminQueue, A).some(o => o.payroll_result_id), false)
    // Fails closed: no viewer id means no badges, never everybody's.
    assert.deepEqual(ownAttendanceObjections(adminQueue, ''), [])
  })

  test('the newest objection per date wins, and only among the viewer own', () => {
    const rows = [
      objection(B, '2026-07-11', { status: 'rejected' }),
      objection(A, '2026-07-11', { status: 'approved' }),   // newest of A
      objection(A, '2026-07-11', { status: 'pending', id: 'older' }),
    ]
    const byDate = objectionsByAttendanceDate(ownAttendanceObjections(rows, A))
    assert.equal(byDate.get('2026-07-11')?.status, 'approved')
  })

  test('the self-service page scopes at the boundary, not at the badge', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/my-attendance/page.tsx'), 'utf8')
    assert.ok(page.includes('ownAttendanceObjections<ObjectionRow>(objections ?? [], session.user.id)'),
      'the list must be narrowed to the session employee as it arrives')
    assert.equal(page.includes('.filter((o: ObjectionRow) => o.attendance_date)'), false,
      'the old date-only filter must be gone, not merely supplemented')
  })
})
