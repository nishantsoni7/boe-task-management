/**
 * The creator-approval workflow's two contracts with code that cannot import
 * the other side.
 *
 * 1. NOTIFICATIONS. Task Management notifications are whitelisted into the feed
 *    by TITLE (src/lib/notifications.ts) — deliberately, because widening the
 *    filter to "any row with a task_id" would resurface ~16k historical
 *    overdue/escalation rows nothing has ever shown. That makes the three new
 *    titles load-bearing strings: a title the filter does not match is a
 *    notification that exists in the table and appears on no screen, in no
 *    unread count, and is cleared by no mark-all-read. The titles themselves
 *    are composed in SQL, so these assertions check BOTH ends — the filter and
 *    the migration text — against one set of literals.
 *
 * 2. RESTORE. Reopening an approved task must not drop it back into the
 *    approval queue.
 *
 * 3. PRESENTATION. `pending_approval` is the first task status that is not one
 *    lowercase word, so every screen that used to capitalise the raw value
 *    would have rendered "Pending_approval". The shared label is what stops it.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/reviewTransitions.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restoreTargetStatus, TASK_REVIEW_NOTIFICATION_SUFFIXES } from './reviewTransitions'
import { getNotificationCategoryFilter } from '@/lib/notifications'
import { statusBadgeClass, taskStatusLabel } from '@/lib/ui'

const MIGRATION_STATUS      = 'supabase/migrations/20260832000000_task_pending_approval_status.sql'
const MIGRATION             = 'supabase/migrations/20260833000000_task_creator_approval.sql'
const MIGRATION_ENFORCEMENT = 'supabase/migrations/20260834000000_task_creator_approval_enforcement.sql'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const statusSql      = read(MIGRATION_STATUS)
const migrationSql   = read(MIGRATION)
const enforcementSql = read(MIGRATION_ENFORCEMENT)

/** The three titles as the RPC actually composes them: "<actor name> <suffix>". */
const ACTOR = 'Priya Sharma'
const TITLES = {
  submit:  `${ACTOR} ${TASK_REVIEW_NOTIFICATION_SUFFIXES.submit}`,
  approve: `${ACTOR} ${TASK_REVIEW_NOTIFICATION_SUFFIXES.approve}`,
  return:  `${ACTOR} ${TASK_REVIEW_NOTIFICATION_SUFFIXES.return}`,
}

/**
 * Does a PostgREST `.or()` filter of `title.ilike.%…%` fragments select a row
 * with this title? Mirrors ILIKE: case-insensitive, `%` is "anything".
 */
function titleMatchesFilter(filter: string, title: string): boolean {
  return filter.split(',').some(fragment => {
    const m = /^title\.ilike\.(.*)$/.exec(fragment)
    if (!m) return false
    const pattern = m[1]
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape regex metacharacters
      .replace(/%/g, '.*')                      // ILIKE wildcard
    return new RegExp(`^${pattern}$`, 'i').test(title)
  })
}

describe('the task notification filter selects all three review titles', () => {
  const filter = getNotificationCategoryFilter('task')

  for (const [action, title] of Object.entries(TITLES)) {
    test(`${action}: "${title}" is in the Task feed`, () => {
      assert.equal(titleMatchesFilter(filter, title), true)
    })
  }

  test('every fragment in the filter is a title match, not a type or column match', () => {
    // The Task category is title-based by necessity; a `type.in.(…)` fragment
    // creeping in here would mean somebody started mixing the two schemes.
    for (const fragment of filter.split(',')) {
      assert.match(fragment, /^title\.ilike\./, `unexpected fragment: ${fragment}`)
    }
  })

  test('the filter is not widened to every row carrying a task_id', () => {
    assert.ok(!filter.includes('task_id'), 'task_id must never appear in the Task filter')
  })

  test('an unrelated task notification title is still excluded', () => {
    // The health-check cron's rows are the reason the filter is a whitelist.
    assert.equal(titleMatchesFilter(filter, 'Task overdue'), false)
    assert.equal(titleMatchesFilter(filter, 'Escalation: no update in 7 days'), false)
  })
})

describe('the migration composes exactly those titles', () => {
  for (const [action, suffix] of Object.entries(TASK_REVIEW_NOTIFICATION_SUFFIXES)) {
    test(`${action}: the SQL contains "${suffix}"`, () => {
      assert.ok(
        migrationSql.includes(`' ${suffix}'`),
        `${MIGRATION} no longer composes "… ${suffix}" — the feed filter and the RPC have drifted`,
      )
    })
  }

  test('the RPC reuses the existing task notification enum value', () => {
    // A new `notification_type` value would have to be committed before any
    // code could reference it; `task_acknowledged` is what every other Task
    // Management notification already carries.
    assert.ok(migrationSql.includes("'task_acknowledged'"))
  })

  test('the notification recipient and body come from the locked row, not the caller', () => {
    assert.ok(migrationSql.includes('v_recipient, p_task_id'))
    assert.ok(migrationSql.includes('v_task.title'))
    // The only inputs the function accepts.
    assert.match(migrationSql, /p_task_id uuid,\s*\n\s*p_action\s+text,\s*\n\s*p_note\s+text default null/)
  })
})

// ─── The three-file rollout ──────────────────────────────────────────────────
//
// The workflow ships as three migrations because two of the three orderings
// break production:
//
//   enforcement before the new frontend -> the deployed frontend still calls
//     `.update({ status: 'completed' })` for delegated tasks, and the trigger
//     starts refusing every one of them;
//   the new frontend before the RPC     -> Submit for Approval 404s.
//
// Only 832 -> 833 -> deploy -> 834 has no broken window. These assertions pin
// that separation, because it is invisible in the application code and a later
// "tidy up the migrations" would silently reintroduce the outage.
describe('the rollout is split across three migrations', () => {
  test('832 adds the status value and nothing else', () => {
    assert.match(statusSql, /alter type %I add value if not exists ''pending_approval''/)
    assert.equal(/create (or replace )?function/i.test(statusSql), false,
      '20260832 must define no functions — it is the inert status-only file')
    assert.equal(/create trigger/i.test(statusSql), false,
      '20260832 must create no trigger')
  })

  test('833 defines the RPC and installs NO enforcement', () => {
    assert.match(migrationSql, /create or replace function public\.transition_task_review/)
    assert.match(migrationSql, /grant execute on function public\.transition_task_review\(uuid, text, text\) to authenticated/)
    // The three things that would make 833 restrictive, and must not be here.
    assert.equal(/create trigger/i.test(migrationSql), false,
      '20260833 must create no trigger — it is applied while the OLD frontend is still live')
    assert.equal(/create or replace function public\.tasks_enforce_review_path/.test(migrationSql), false,
      'the enforcement function belongs to 20260834')
    assert.equal(/create or replace function public\.in_task_review/.test(migrationSql), false,
      'in_task_review is read only by the trigger, so it belongs to 20260834')
  })

  test('834 installs the enforcement and redefines no RPC', () => {
    assert.match(enforcementSql, /create or replace function public\.in_task_review/)
    assert.match(enforcementSql, /create or replace function public\.tasks_enforce_review_path/)
    assert.match(enforcementSql, /create trigger tasks_enforce_review_path\s*\n\s*before update on public\.tasks/)
    assert.equal(/create or replace function public\.transition_task_review/.test(enforcementSql), false,
      '20260834 must not redefine the RPC — it only adds the rule')
  })

  test('834 is re-runnable and reversible', () => {
    // Applying it twice must be a no-op, and backing it out must not need a
    // data migration: dropping the trigger returns the DB to the 833 state.
    assert.match(enforcementSql, /drop trigger if exists tasks_enforce_review_path on public\.tasks/)
    assert.equal(/\bdrop function\b(?! if exists)/i.test(enforcementSql), false)
    assert.equal(/\b(update|delete from|insert into)\s+public\.tasks\b/i.test(enforcementSql), false,
      '20260834 must not touch a single row')
  })

  test('the RPC sets the context flag that the trigger will later read', () => {
    // This is what lets 833's function body stay byte-identical when 834 lands.
    assert.match(migrationSql, /set_config\('boe\.task_review_context', 'task_review', true\)/)
    assert.match(enforcementSql, /current_setting\('boe\.task_review_context', true\)/)
  })

  test('834 keeps the exemptions that make the rule narrow', () => {
    // Identity-less sessions (service role: cancel-task, restore-task, cron).
    assert.match(enforcementSql, /v_uid\s+uuid\s*:=\s*auth\.uid\(\)/)
    assert.match(enforcementSql, /if v_uid is null then\s*\n\s*return new;/)
    // Quotation requests and self tasks never reach a check.
    assert.match(enforcementSql, /coalesce\(old\.task_type, 'general'\) <> 'quotation_request'/)
    assert.match(enforcementSql, /old\.created_by <> old\.assigned_to/)
    // Cancelling a task that is awaiting approval stays possible.
    assert.match(enforcementSql, /new\.status::text <> 'cancelled'/)
  })

  test('each file states its prerequisite in its own header', () => {
    assert.match(migrationSql,   /REQUIRES 20260832000000/)
    assert.match(enforcementSql, /APPLY THIS ONLY AFTER THE NEW FRONTEND IS DEPLOYED/)
  })
})

describe('taskStatusLabel', () => {
  test('the same status is named from the reader\'s side of it', () => {
    assert.equal(taskStatusLabel('pending_approval', 'creator'),  'For Approval')
    assert.equal(taskStatusLabel('pending_approval', 'assignee'), 'Approval Pending')
    assert.equal(taskStatusLabel('pending_approval', 'other'),    'Pending Approval')
    assert.equal(taskStatusLabel('pending_approval'),             'Pending Approval')
  })

  test('no label ever shows the raw underscored value', () => {
    for (const viewer of ['creator', 'assignee', 'other'] as const) {
      assert.ok(!taskStatusLabel('pending_approval', viewer).includes('_'))
    }
  })

  test('every other status keeps the capitalisation it always had', () => {
    const before: Record<string, string> = {
      pending: 'Pending', started: 'Started', working: 'Working',
      waiting: 'Waiting', blocked: 'Blocked', completed: 'Completed',
      cancelled: 'Cancelled',
    }
    for (const [status, label] of Object.entries(before)) {
      for (const viewer of ['creator', 'assignee', 'other'] as const) {
        assert.equal(taskStatusLabel(status, viewer), label, `${status}/${viewer}`)
      }
    }
  })

  test('the new status has its own badge class, distinct from waiting', () => {
    assert.equal(statusBadgeClass('pending_approval'), 'boe-badge boe-badge-pending-approval')
    assert.notEqual(statusBadgeClass('pending_approval'), statusBadgeClass('waiting'))
    // And the class it names actually exists, or the badge renders unstyled.
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    assert.ok(css.includes('.boe-badge-pending-approval'))
  })
})

describe('restoreTargetStatus', () => {
  test('an approved completion reopens to Working, not back into the queue', () => {
    assert.equal(restoreTargetStatus('pending_approval'), 'working')
  })

  test('every other status restores exactly as it did before', () => {
    for (const status of ['pending', 'started', 'working', 'waiting', 'blocked']) {
      assert.equal(restoreTargetStatus(status), status)
    }
  })

  test('a missing previous status still falls back to Working', () => {
    assert.equal(restoreTargetStatus(null), 'working')
    assert.equal(restoreTargetStatus(undefined), 'working')
    assert.equal(restoreTargetStatus(''), 'working')
  })
})
