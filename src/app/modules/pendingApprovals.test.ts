/**
 * Pending approvals on the Modules launcher: attendance requests an admin can
 * decide from the first screen.
 *
 * The helpers are executed; the gate and the wiring are read from the source,
 * as the launcher's other suites do (there is no DOM harness for this page).
 *
 * Run:
 *   npx tsx --test src/app/modules/pendingApprovals.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttendanceRequestRow } from '@/lib/attendance/requests'
import {
  actionableRequests, initialsOf, launcherRequests, LAUNCHER_REQUEST_TYPES, PENDING_APPROVALS_SHOWN,
} from '@/lib/attendance/pendingApprovals'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const PAGE = read('src/app/modules/page.tsx')
const CARD = read('src/app/modules/PendingApprovals.tsx')
const PANEL = read('src/app/modules/AttentionPanel.tsx')
const CSS = read('src/app/modules/attentionPanel.module.css')

const row = (id: string, employee_id: string, status: AttendanceRequestRow['status'] = 'pending') =>
  ({ id, employee_id, status })

describe('which requests the card lists', () => {
  test('pending requests from other people, in the order the queue returned them', () => {
    const rows = [row('a', 'u1'), row('b', 'me'), row('c', 'u2', 'approved'), row('d', 'u3')]
    assert.deepEqual(actionableRequests(rows, 'me').map(r => r.id), ['a', 'd'])
  })

  test("the admin's own request is never offered — another admin decides it", () => {
    assert.deepEqual(actionableRequests([row('x', 'me')], 'me'), [])
  })

  test('the list is short and the rest is one link away', () => {
    assert.equal(PENDING_APPROVALS_SHOWN, 5)
    assert.match(CARD, /rows\.slice\(0, PENDING_APPROVALS_SHOWN\)/)
    assert.match(CARD, /href="\/attendance\/requests"/)
  })

  test('only leave and late arrival — the other types stay in Attendance', () => {
    assert.deepEqual([...LAUNCHER_REQUEST_TYPES], ['late_arrival', 'half_day', 'full_day_leave'])
    const typed = (id: string, request_type: AttendanceRequestRow['request_type']) => ({ id, request_type })
    const rows = [
      typed('a', 'late_arrival'), typed('b', 'early_departure'), typed('c', 'half_day'),
      typed('d', 'time_out'), typed('e', 'full_day_leave'),
    ]
    assert.deepEqual(launcherRequests(rows).map(r => r.id), ['a', 'c', 'e'])
    assert.match(CARD, /launcherRequests\(actionableRequests\(/)
  })
})

describe('initials for the avatar chip', () => {
  test('first and last name', () => {
    assert.equal(initialsOf('Dhruv Kumar Sharma'), 'DS')
    assert.equal(initialsOf('asha'), 'A')
    assert.equal(initialsOf('  '), '?')
    assert.equal(initialsOf(null), '?')
  })
})

describe('who sees it, and what it may do', () => {
  test('ADMINS ONLY, by the signed-in profile, never while previewing', () => {
    assert.match(PAGE, /const showPendingApprovals = !viewMode && !!userId && profile\?\.role === 'admin'/)
    assert.match(PAGE, /showAttendance: showPendingApprovals,/)
    // The queue is not even asked for unless that gate passed.
    assert.match(CARD, /enabled: enabled && !!userId,/)
    assert.match(PANEL, /const leaveOn = showAttendance && on\('leave_late'\)/)
    assert.match(PANEL, /usePendingApprovalQueue\(userId, leaveOn\)/)
  })

  test('it uses the existing queue and decision routes, which keep every rule', () => {
    assert.match(CARD, /\/api\/attendance-requests\?scope=queue&status=pending/)
    assert.match(CARD, /\/api\/attendance-requests\/\$\{target\.id\}\/decision/)
    assert.match(CARD, /<RequestReviewDrawer/)
    // No direct table access from the browser: the routes run the checks.
    assert.equal(/\.from\('attendance_requests'\)/.test(CARD), false)
  })

  test("it is the For you panel's leave and late-arrival cards, beside the modules", () => {
    assert.ok(PAGE.indexOf('<AttentionPanel') > PAGE.indexOf('modules-essentials-heading'))
    assert.equal(PAGE.includes('<PendingApprovals'), false)
    assert.match(PANEL, /<PendingApprovals userId=\{userId\} shown=\{key => s\.shown\(key\)\} \/>/)
  })

  test('with nothing waiting, no card is drawn', () => {
    assert.match(CARD, /if \(rows\.length === 0\) \{/)
  })

  test('each request says how long it has waited and has a Review button', () => {
    assert.match(CARD, /\$\{timeAgo\(r\.submitted_at\)\}/)
    assert.match(CARD, />\s*Review\s*</)
  })
})

describe('the rows are styled as actions', () => {
  test('a real tap target for Review', () => {
    const h = CSS.match(/\.button,\s*\.buttonPrimary\s*\{[^}]*height: (\d+)px;/)
    assert.ok(h && Number(h[1]) >= 36, 'Review is at least 36px tall')
  })
})
