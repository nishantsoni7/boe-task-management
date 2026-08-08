/**
 * The issue workflow after the first submission: raising again, the trail that
 * survives it, and telling the employee what was decided.
 *
 * THE THREE DEFECTS THESE COVER
 * -----------------------------
 * 1. RE-RAISE. The database has always allowed a second issue once the first
 *    was decided — the unique indexes in 20260823000000 key on
 *    `status = 'pending'`. Every screen ignored that and tested only "is there
 *    an objection for this row", so a rejected issue from weeks ago replaced
 *    Raise Issue with a permanent badge. An employee who disagreed had nowhere
 *    to go.
 *
 * 2. HISTORY. A re-raise writes a NEW row and the table has no UPDATE policy
 *    at all, so nothing is ever overwritten — but nothing SHOWED that. The row
 *    badge said "Rejected" and the earlier reason, the admin's note and the
 *    fact that this was the second attempt were nowhere on screen.
 *
 * 3. THE SILENT DECISION. An admin resolved an issue and the employee was told
 *    nothing. The one person waiting for an answer was the only one the
 *    notification path did not write to.
 *
 * Run:
 *   npx tsx --test src/lib/objectionWorkflow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canRaiseIssue,
  raiseActionLabel,
  groupIssueChains,
  issueChainKey,
  issueSubjectKind,
  issueSubjectLabel,
  buildIssueHistory,
  ISSUE_PARAM,
  type ObjectionRow,
} from './objections'
import { getNotificationMeta } from './notificationMeta'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

let seq = 0

/** One objection row, with only the fields a rule actually reads spelled out. */
function row(o: Partial<ObjectionRow> & { created_at: string }): ObjectionRow {
  return {
    id:                `o${++seq}`,
    employee_id:       'emp-1',
    attendance_date:   null,
    payroll_result_id: null,
    reason:            'this looks wrong',
    subject_snapshot:  'snapshot',
    status:            'pending',
    reviewed_by:       null,
    reviewed_at:       null,
    review_note:       null,
    ...o,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const notif = (type: string, entityId: string | null = 'obj-1'): any => ({
  id: 'n1', type, title: 'x', body: null, is_read: false,
  created_at: new Date().toISOString(), entity_id: entityId, task_id: null,
})

// ─── 1. Raising again ─────────────────────────────────────────────────────────

describe('an employee may raise the matter again once it has been decided', () => {
  test('nothing reported yet — the action is available and reads as a first report', () => {
    assert.equal(canRaiseIssue(undefined), true)
    assert.equal(canRaiseIssue(null), true)
    assert.equal(raiseActionLabel(undefined), 'Raise Issue')
  })

  test('a PENDING issue closes the door — no accidental duplicate', () => {
    // This half must not regress: the partial unique index would reject the
    // insert anyway, but an employee should not be offered an action that is
    // going to come back as a 409.
    assert.equal(canRaiseIssue({ status: 'pending' }), false)
  })

  test('a resolved or rejected issue opens it again, labelled as a repeat', () => {
    for (const status of ['approved', 'rejected'] as const) {
      assert.equal(canRaiseIssue({ status }), true, status)
      assert.equal(raiseActionLabel({ status }), 'Raise Again', status)
    }
  })

  test('the rule matches the database, which is where it is enforced', () => {
    // The two partial unique indexes are `WHERE status = 'pending'`. If that
    // ever changes, this predicate is wrong and the UI starts offering an
    // action the insert will refuse.
    const migration = read('supabase/migrations/20260823000000_employee_record_objections.sql')
    assert.equal((migration.match(/WHERE status = 'pending'/g) ?? []).length, 2,
      'one partial unique index per target, both keyed on pending')
  })

  test('every screen that badges an issue also offers the way back', () => {
    for (const p of [
      'src/app/my-attendance/page.tsx',
      'src/app/my-payroll/page.tsx',
      'src/app/my-issues/page.tsx',
    ]) {
      const src = read(p)
      assert.ok(src.includes('canRaiseIssue'), `${p} must decide with the shared rule`)
      assert.ok(src.includes('raiseActionLabel'), `${p} must label a repeat as a repeat`)
    }
  })
})

// ─── 2. The chain ─────────────────────────────────────────────────────────────

describe('every attempt against one record is kept, and stays linked', () => {
  const first  = row({ created_at: '2026-08-01T10:00:00Z', attendance_date: '2026-07-21',
                       status: 'rejected', reviewed_at: '2026-08-02T09:00:00Z',
                       review_note: 'the machine record is correct', reason: 'I was present' })
  const second = row({ created_at: '2026-08-03T10:00:00Z', attendance_date: '2026-07-21',
                       reason: 'my colleague saw me here' })
  const other  = row({ created_at: '2026-08-04T10:00:00Z', attendance_date: '2026-07-22' })

  test('the target is the relationship — no parent id is needed or used', () => {
    assert.equal(issueChainKey(first), issueChainKey(second))
    assert.notEqual(issueChainKey(first), issueChainKey(other))
    // A payroll issue keys on its result; a row naming neither has no chain.
    assert.equal(issueChainKey(row({ created_at: '', payroll_result_id: 'res-1' })), 'emp-1|result|res-1')
    assert.equal(issueChainKey(row({ created_at: '' })), null)
  })

  test('one employee id is part of the key, so two people never share a chain', () => {
    const mine   = row({ created_at: '', attendance_date: '2026-07-21', employee_id: 'emp-1' })
    const theirs = row({ created_at: '', attendance_date: '2026-07-21', employee_id: 'emp-2' })
    assert.notEqual(issueChainKey(mine), issueChainKey(theirs))
  })

  test('chains come back oldest first, whatever order they arrived in', () => {
    // The API returns newest first; the trail reads oldest first.
    const chains = groupIssueChains([other, second, first])
    const chain  = chains.get(issueChainKey(first)!)!
    assert.deepEqual(chain.map(o => o.id), [first.id, second.id])
    assert.equal(chains.size, 2)
  })

  test('the newest attempt is the last element — what a row badge reflects', () => {
    const chain = groupIssueChains([first, second]).get(issueChainKey(first)!)!
    assert.equal(chain[chain.length - 1].id, second.id)
  })
})

// ─── 3. The history trail ─────────────────────────────────────────────────────

describe('the history shows what happened, in order, with who and when', () => {
  const first  = row({ created_at: '2026-08-01T10:00:00Z', attendance_date: '2026-07-21',
                       status: 'rejected', reviewed_at: '2026-08-02T09:00:00Z',
                       review_note: 'the machine record is correct', reason: 'I was present',
                       subject_snapshot: '2026-07-21 · no punch-in → no punch-out · absent' })
  const second = row({ created_at: '2026-08-03T10:00:00Z', attendance_date: '2026-07-21',
                       reason: 'my colleague saw me here' })

  test('a single pending issue is one event and no decision', () => {
    const events = buildIssueHistory([second])
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'raised')
    assert.equal(events[0].body, 'my colleague saw me here')
    assert.equal(events[0].snapshot, second.subject_snapshot)
  })

  test('a decided issue carries its outcome, its note and its timestamp', () => {
    const [raised, decided] = buildIssueHistory([first])
    assert.equal(raised.kind, 'raised')
    assert.equal(decided.kind, 'rejected')
    assert.equal(decided.title, 'Rejected by admin')
    assert.equal(decided.body, 'the machine record is correct')
    assert.equal(decided.at, '2026-08-02T09:00:00Z')
    assert.equal(decided.actor, 'Administrator')
  })

  test('a re-raise is labelled as one, and the earlier decision is still there', () => {
    const events = buildIssueHistory([first, second], { employeeLabel: 'You' })
    assert.deepEqual(events.map(e => e.kind), ['raised', 'rejected', 're_raised'])
    assert.match(events[2].title, /again/i)
    assert.equal(events[2].attempt, 2)
    // THE AUDIT RULE: the first submission and its rejection survive the second
    // submission verbatim. Nothing was merged, replaced or dropped.
    assert.equal(events[0].body, 'I was present')
    assert.equal(events[1].body, 'the machine record is correct')
    assert.equal(events[0].actor, 'You')
  })

  test('a resolution reads as resolved, not as approved', () => {
    const approved = row({ created_at: '2026-08-01T10:00:00Z', attendance_date: '2026-07-21',
                           status: 'approved', reviewed_at: '2026-08-02T09:00:00Z' })
    const [, decided] = buildIssueHistory([approved])
    assert.equal(decided.kind, 'approved')
    assert.equal(decided.title, 'Resolved by admin')
  })

  test('a decision with no note still appears — the event is the fact', () => {
    const approved = row({ created_at: '2026-08-01T10:00:00Z', attendance_date: '2026-07-21',
                           status: 'approved', reviewed_at: '2026-08-02T09:00:00Z', review_note: null })
    assert.equal(buildIssueHistory([approved]).length, 2)
  })

  test('every event key is unique, so nothing collapses in a list', () => {
    const keys = buildIssueHistory([first, second]).map(e => e.key)
    assert.equal(new Set(keys).size, keys.length)
  })

  test('the trail is a modal, not a page, and not a comment box', () => {
    const modal = read('src/components/objections/IssueHistoryModal.tsx')
    assert.ok(modal.includes('PayrollModal'), 'the existing BOE modal pattern')
    assert.ok(modal.includes('buildIssueHistory'), 'derived from the rows, not stored')
    for (const forbidden of ['<textarea', '<input', 'method:'] ) {
      assert.equal(modal.includes(forbidden), false,
        `history is a trail, not a conversation: found ${forbidden}`)
    }
  })

  test('nothing in the app updates or deletes an objection row', () => {
    // The audit rule, checked where it could be broken. The only writer after
    // INSERT is the review function, which touches four columns of a row that
    // is still pending and refuses everything else.
    const migration = read('supabase/migrations/20260823000000_employee_record_objections.sql')
    assert.ok(migration.includes('Deliberately NO update and NO delete policy'))
    assert.ok(migration.includes('OBJECTION_ALREADY_REVIEWED'), 'a decided row is final')

    for (const p of [
      'src/app/api/objections/route.ts',
      'src/app/api/objections/review/route.ts',
      'src/components/objections/ObjectionQueue.tsx',
      'src/components/objections/ObjectionReviewPanel.tsx',
      'src/app/my-issues/page.tsx',
    ]) {
      const src = read(p)
      for (const forbidden of [".delete()", ".update("]) {
        assert.equal(src.includes(forbidden), false, `${p} must not ${forbidden} an objection`)
      }
    }
  })

  test('both the employee and the admin can open it', () => {
    for (const p of [
      'src/app/my-attendance/page.tsx',
      'src/app/my-payroll/page.tsx',
      'src/app/my-issues/page.tsx',
      'src/components/objections/ObjectionQueue.tsx',
      'src/components/objections/ObjectionReviewPanel.tsx',
    ]) {
      assert.ok(read(p).includes('IssueHistoryModal'), `${p} must offer the history`)
    }
  })
})

// ─── 4. Naming the record ─────────────────────────────────────────────────────

describe('an issue says which record it is about', () => {
  test('an attendance issue names its date, formatted from the parts', () => {
    const o = row({ created_at: '', attendance_date: '2026-07-21' })
    assert.equal(issueSubjectKind(o), 'attendance')
    assert.equal(issueSubjectLabel(o), '21 Jul 2026')
  })

  test('a payroll issue names the period out of the snapshot', () => {
    // Read from the snapshot on purpose: a payroll result is DELETED when its
    // period is regenerated, so the snapshot is the only surviving record of
    // what the employee was looking at.
    const o = row({ created_at: '', payroll_result_id: 'res-1',
                    subject_snapshot: '07/2026 · gross ₹30,000.00 · deductions ₹0.00 · net ₹30,000.00' })
    assert.equal(issueSubjectKind(o), 'payroll')
    assert.equal(issueSubjectLabel(o), '07/2026')
  })

  test('an unknown period degrades to a phrase, not to a blank', () => {
    const o = row({ created_at: '', payroll_result_id: 'res-1', subject_snapshot: 'period unknown · gross —' })
    assert.equal(issueSubjectLabel(o), 'Payroll period')
  })
})

// ─── 5. Telling the employee ──────────────────────────────────────────────────

describe('a decision reaches the employee who raised it', () => {
  const route = read('src/app/api/objections/review/route.ts')

  test('the notification is written only after a successful status change', () => {
    // Everything that can fail returns above this point, so a notification
    // cannot exist for a review that did not happen.
    const errorBranch = route.indexOf('if (error) {')
    const notify      = route.indexOf('await notifyEmployeeOfDecision')
    assert.ok(errorBranch !== -1 && notify !== -1)
    assert.ok(errorBranch < notify, 'the error branch must return before the notify')
    assert.ok(route.indexOf('return NextResponse.json({ error: error.message }') < notify)
  })

  test('exactly once — a second review never reaches the notify at all', () => {
    // review_employee_record_objection() refuses anything that is not still
    // pending, so a repeated POST stops at the 409 above the notify.
    assert.ok(route.includes('OBJECTION_ALREADY_REVIEWED'))
    assert.ok(route.includes('{ status: 409 }'))
    const already = route.indexOf('OBJECTION_ALREADY_REVIEWED')
    assert.ok(already < route.indexOf('await notifyEmployeeOfDecision'))
    // And one insert, not one per admin — this half has a single recipient.
    const fn = route.slice(route.indexOf('async function notifyEmployeeOfDecision'))
    assert.equal((fn.match(/\.insert\(/g) ?? []).length, 1)
    assert.equal(/\.map\(/.test(fn), false, 'a single recipient is not a list')
  })

  test('the recipient comes from the reviewed row, never from the request', () => {
    const fn = route.slice(route.indexOf('async function notifyEmployeeOfDecision'))
    assert.ok(fn.includes('user_id:   row.employee_id'),
      'addressed to the employee whose objection was actually changed')
    assert.equal(/body\.employee_id|searchParams/.test(fn), false,
      'nothing about the recipient may come from the caller')
  })

  test('the outcome is in the title, and the admin note is the body', () => {
    const fn = route.slice(route.indexOf('async function notifyEmployeeOfDecision'))
    assert.ok(fn.includes("row.status === 'approved' ? 'resolved' : 'rejected'"))
    assert.ok(fn.includes('was ${outcome}'.replace(/\$/g, '$')) || /was \$\{outcome\}/.test(fn))
    assert.ok(fn.includes('row.review_note'))
  })

  test('a notification failure cannot fail the review', () => {
    const fn = route.slice(route.indexOf('async function notifyEmployeeOfDecision'))
    assert.ok(fn.includes('try {') && fn.includes('catch'), 'swallowed, not thrown')
    assert.ok(fn.includes('console.error'), 'and logged')
    assert.equal(/throw /.test(fn), false)
  })

  test('authorisation is unchanged — still admin-only, still the controlled RPC', () => {
    assert.ok(route.includes('requireAdmin'), 'the route refuses a non-admin')
    assert.ok(route.includes('review_employee_record_objection'), 'the write goes through the RPC')
    for (const table of ['payroll_results', 'attendance_records', 'attendance_day_corrections',
                         'payroll_deduction_lines', 'payroll_pending_adjustments']) {
      assert.equal(route.includes(table), false, `the review route must not touch ${table}`)
    }
  })

  test('the link lands the employee on their own issue, by filter not by route', () => {
    for (const [type, heading] of [
      ['attendance_issue_reviewed', 'Attendance'],
      ['payroll_issue_reviewed',    'Payroll'],
    ] as const) {
      const meta = getNotificationMeta(notif(type, 'obj-9'))
      assert.equal(meta.href, `/my-issues?${ISSUE_PARAM}=obj-9`, type)
      assert.equal(meta.heading, heading)
      assert.notEqual(meta.badge.label, 'Activity', `${type} must not use the neutral fallback`)
    }
  })

  test('a missing entity id degrades to the list rather than to a broken link', () => {
    assert.equal(getNotificationMeta(notif('payroll_issue_reviewed', null)).href, '/my-issues')
  })

  test('the admin-facing links are untouched', () => {
    // Two adjacent exact-match branches in getNotificationMeta. Neither may
    // swallow the other's types, whichever order they end up in.
    assert.equal(getNotificationMeta(notif('attendance_issue_raised')).href, '/attendance/correction-log')
    assert.equal(getNotificationMeta(notif('payroll_issue_raised', 'obj-9')).href,
      `/payroll?${ISSUE_PARAM}=obj-9`)
  })

  test('the issue page resolves that id against rows it already owns', () => {
    const page = read('src/app/my-issues/page.tsx')
    assert.ok(page.includes('searchParams.get(ISSUE_PARAM)'), 'only the objection id is read')
    assert.ok(page.includes('rows.find(o => o.id === focusedIssueId)'),
      'and it is looked up in the caller own list, not fetched by id')
    assert.equal(/employee_id=|searchParams\.get\('employee/.test(page), false,
      'no employee id may be taken from the query string')
    assert.ok(page.includes('o.employee_id === session.user.id'),
      'the list is scoped to the viewer even when the API answers an admin')
  })
})
