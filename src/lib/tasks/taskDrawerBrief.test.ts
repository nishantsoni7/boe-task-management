/**
 * taskDrawerBrief — what the task preview drawer says about a task
 *
 * The drawer states the status in a sentence with its reason, then the last few
 * REAL updates. These tests pin the rules: the same status-reason derivation as
 * the full task page, system lines skipped, and the drawer adding no query and
 * no write of its own.
 *
 * Run:
 *   npm run test:file -- src/lib/tasks/taskDrawerBrief.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dueInText, holderText, headlineOf, statusReasonOf, latestUpdatesOf, LATEST_UPDATES_MAX,
} from './taskDrawerBrief'

const TODAY = '2026-11-11'
const USERS = { u1: 'Nishant Soni', u2: 'Dhruv Patel' }

const row = (over: Record<string, unknown>) => ({
  id: String(over.id ?? 'r'),
  action: 'note_added',
  note: null as string | null,
  from_status: null as never,
  to_status: null as never,
  created_at: '2026-11-10T10:00:00Z',
  actor_id: 'u2',
  old_val: null as string | null,
  new_val: null as string | null,
  ...over,
}) as Parameters<typeof latestUpdatesOf>[0][number]

describe('dueInText', () => {
  test('counts days the way the overdue flag does', () => {
    assert.equal(dueInText('2026-11-11', 'working', TODAY), 'due today')
    assert.equal(dueInText('2026-11-12', 'working', TODAY), 'due tomorrow')
    assert.equal(dueInText('2026-11-15', 'working', TODAY), 'due in 4 days')
    assert.equal(dueInText('2026-11-10', 'working', TODAY), 'overdue by 1 day')
    assert.equal(dueInText('2026-11-01', 'working', TODAY), 'overdue by 10 days')
  })

  test('a far date is a date, not a long countdown', () => {
    assert.match(dueInText('2026-12-20', 'working', TODAY), /^due \d{1,2} \w{3}/)
  })

  test('no due date says so', () => {
    assert.equal(dueInText(null, 'working', TODAY), 'no due date')
  })

  test('a finished or in-review task is never called overdue', () => {
    for (const s of ['completed', 'cancelled', 'pending_approval']) {
      assert.match(dueInText('2026-11-01', s, TODAY), /^due \d{1,2} \w{3}/, s)
    }
  })
})

describe('holderText / headlineOf', () => {
  const task = { status: 'working' as const, due_date: '2026-11-12', assigned_to: 'u2', created_by: 'u1' }

  test('"Working · due tomorrow · with Dhruv Patel"', () => {
    assert.deepEqual(headlineOf(task, { userMap: USERS, today: TODAY }),
      { status: 'Working', due: 'due tomorrow', who: 'with Dhruv Patel' })
  })

  test('always a name, never "you": View As hands the drawer the viewed person as the viewer', () => {
    assert.equal(headlineOf(task, { userMap: USERS, currentUserId: 'u2', today: TODAY }).who, 'with Dhruv Patel')
    assert.equal(headlineOf(task, { userMap: USERS, currentUserId: 'u1', today: TODAY }).who, 'with Dhruv Patel')
  })

  test('work awaiting approval is with its creator, and is labelled for the viewer', () => {
    const t = { ...task, status: 'pending_approval' as const }
    assert.equal(holderText(t, USERS), 'Nishant Soni')
    assert.equal(headlineOf(t, { userMap: USERS, currentUserId: 'u1', today: TODAY }).status, 'For Approval')
    assert.equal(headlineOf(t, { userMap: USERS, currentUserId: 'u2', today: TODAY }).status, 'Approval Pending')
  })

  test('a finished task is with nobody; an unknown name is left out, not guessed', () => {
    assert.equal(holderText({ ...task, status: 'completed' }, USERS), null)
    assert.equal(holderText({ ...task, status: 'cancelled' }, USERS), null)
    assert.equal(headlineOf(task, { userMap: {}, today: TODAY }).who, null)
  })

  test('falls back to the assignee name a manager view already carries', () => {
    assert.equal(holderText({ ...task, assignee_name: 'Dhruv P' }, undefined), 'Dhruv P')
  })
})

describe('statusReasonOf — same derivation as the full task page', () => {
  const working = { status: 'working' as const, blocker_reason: null }

  test('the NEWEST status_changed row gives the reason, who set it and when', () => {
    const log = [
      row({ id: 'c', action: 'note_added', note: 'a comment' }),
      row({ id: 'b', action: 'status_changed', note: 'Customer approved the drawing', actor_id: 'u2', created_at: '2026-11-09T09:00:00Z' }),
      row({ id: 'a', action: 'status_changed', note: 'older reason' }),
    ]
    assert.deepEqual(statusReasonOf(working, log),
      { id: 'b', reason: 'Customer approved the drawing', actorId: 'u2', at: '2026-11-09T09:00:00Z' })
  })

  test('a status change with no words falls back to the page defaults', () => {
    const log = [row({ action: 'status_changed', note: '  ' })]
    assert.equal(statusReasonOf(working, log).reason, 'Task is in progress')
    assert.equal(statusReasonOf({ status: 'waiting', blocker_reason: null }, log).reason, 'Task is waiting for input')
    assert.equal(statusReasonOf({ status: 'blocked', blocker_reason: null }, log).reason, 'Task is blocked')
    assert.equal(statusReasonOf({ status: 'pending', blocker_reason: null }, log).reason, null)
  })

  test('no status change among the loaded rows means no reason and no "set by"', () => {
    assert.deepEqual(statusReasonOf(working, [row({ action: 'created' })]),
      { id: null, reason: null, actorId: null, at: null })
    assert.deepEqual(statusReasonOf(working, []), { id: null, reason: null, actorId: null, at: null })
  })

  test('a blocked task does not repeat the Blocker box in the reason', () => {
    const log = [row({ action: 'status_changed', note: 'Waiting for the die', actor_id: 'u2' })]
    const blocked = { status: 'blocked' as const, blocker_reason: 'Waiting for the die' }
    assert.equal(statusReasonOf(blocked, log).reason, null)
    assert.equal(statusReasonOf(blocked, log).actorId, 'u2', 'who set it is still shown')
  })

  test('a cancelled task shows the reason the cancel wrote into the log', () => {
    const log = [row({ action: 'status_changed', from_status: 'working', to_status: 'cancelled', note: 'Customer withdrew' })]
    assert.equal(statusReasonOf({ status: 'cancelled', blocker_reason: null }, log).reason, 'Customer withdrew')
  })
})

describe('latestUpdatesOf — the last three REAL updates', () => {
  test('system lines are skipped when a real update exists', () => {
    const log = [
      row({ id: '1', action: 'escalated', note: 'Auto-escalated: no update for 72 hours' }),
      row({ id: '2', action: 'stale_flagged', note: 'Auto-flagged: same status for 5+ days' }),
      row({ id: '3', action: 'acknowledged' }),
      row({ id: '4', action: 'note_added', note: 'Sent the sample' }),
    ]
    assert.deepEqual(latestUpdatesOf(log).map(u => u.id), ['4'])
  })

  test('at most three, newest first', () => {
    const log = ['1', '2', '3', '4', '5'].map(id => row({ id, action: 'note_added', note: id }))
    assert.equal(LATEST_UPDATES_MAX, 3)
    assert.deepEqual(latestUpdatesOf(log).map(u => u.id), ['1', '2', '3'])
  })

  test('when only system lines exist the section is not left empty', () => {
    const log = [row({ id: '1', action: 'acknowledged' }), row({ id: '2', action: 'escalated' })]
    assert.deepEqual(latestUpdatesOf(log).map(u => u.id), ['1', '2'])
    assert.deepEqual(latestUpdatesOf([]), [])
  })

  test('a status change carries its reason; a progress update says so', () => {
    const [changed, progress] = latestUpdatesOf([
      row({ id: '1', action: 'status_changed', from_status: 'working', to_status: 'waiting', note: 'Need the logo file' }),
      row({ id: '2', action: 'status_changed', from_status: 'working', to_status: 'working', note: 'Half done' }),
    ])
    assert.equal(changed.what, 'changed the status from Working to Waiting')
    assert.equal(changed.detail, 'Need the logo file')
    assert.equal(progress.what, 'posted a progress update')
    assert.equal(progress.detail, 'Half done')
  })

  test('comments, and files with no words, are told apart', () => {
    const [text, file] = latestUpdatesOf([
      row({ id: '1', action: 'note_added', note: 'Please check' }),
      row({ id: '2', action: 'note_added', note: null }),
    ])
    assert.equal(text.what, 'commented')
    assert.equal(text.detail, 'Please check')
    assert.equal(file.what, 'attached a file')
    assert.equal(file.detail, null)
  })

  test('a due-date change shows old → new, and "No date" / "Cleared" at the ends', () => {
    const [moved, set, cleared] = latestUpdatesOf([
      row({ id: '1', action: 'due_date_changed', old_val: '2026-11-12', new_val: '2026-11-20' }),
      row({ id: '2', action: 'due_date_changed', old_val: null, new_val: '2026-11-20' }),
      row({ id: '3', action: 'deadline_changed', old_val: '2026-11-12', new_val: null }),
    ])
    assert.equal(moved.what, 'changed the due date')
    assert.match(moved.detail ?? '', /^\d{1,2} \w{3} → \d{1,2} \w{3}$/)
    assert.match(set.detail ?? '', /^No date → /)
    assert.match(cleared.detail ?? '', / → Cleared$/)
  })

  test('a priority change shows old → new when both are known', () => {
    const [p] = latestUpdatesOf([row({ action: 'priority_changed', old_val: 'low', new_val: 'high' })])
    assert.equal(p.what, 'changed the priority')
    assert.equal(p.detail, 'low → high')
  })

  test('every line keeps who did it and when', () => {
    const [u] = latestUpdatesOf([row({ id: 'x', actor_id: 'u1', created_at: '2026-11-10T08:30:00Z', note: 'hi' })])
    assert.equal(u.actorId, 'u1')
    assert.equal(u.at, '2026-11-10T08:30:00Z')
  })
})

describe('TaskDetailPanel source — what the redesign must keep', () => {
  const ROOT = process.cwd()
  const SRC = readFileSync(join(ROOT, 'src/components/ui/TaskDetailPanel.tsx'), 'utf8')

  test('still ONE read of the log (20 rows) and no write of any kind', () => {
    assert.equal((SRC.match(/\.from\(/g) ?? []).length, 1)
    assert.match(SRC, /\.from\('task_activity_log'\)/)
    assert.match(SRC, /\.limit\(20\)/)
    for (const write of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /fetch\(/]) {
      assert.doesNotMatch(SRC, write)
    }
  })

  test('reads the columns the due-date and priority lines need', () => {
    assert.match(SRC, /\.select\('id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id'\)/)
  })

  test('keeps dialog role, Escape, scroll lock and the 44 px close target', () => {
    assert.match(SRC, /role="dialog"/)
    assert.match(SRC, /aria-modal="true"/)
    assert.match(SRC, /e\.key === 'Escape'/)
    assert.match(SRC, /document\.body\.style\.overflow = 'hidden'/)
    assert.match(SRC, /minWidth: '44px', minHeight: '44px'/)
  })

  test('is built from the brief, with the description clamped to three lines', () => {
    assert.match(SRC, /headlineOf\(task,/)
    assert.match(SRC, /statusReasonOf\(task, activityLog\)/)
    assert.match(SRC, /latestUpdatesOf\(activityLog\)/)
    assert.match(SRC, /u\.id === statusReason\.id \? \{ \.\.\.u, detail: null \}/, 'the headline reason is not printed twice')
    assert.match(SRC, /clampLines=\{3\}/)
    assert.match(SRC, /moreLabel="Show more"/)
  })
})
