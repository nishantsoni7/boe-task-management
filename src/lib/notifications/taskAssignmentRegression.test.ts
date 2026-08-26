// THE HOTFIX'S OWN TEST FILE.
//
// A person created a task and assigned it to somebody else. The task appeared
// on the assignee's dashboard under "Needs Acknowledgement". No notification,
// no badge, no amount of refreshing. The row had been written; the Task feed's
// category filter — a whitelist of 16 leading-wildcard title fragments — simply
// did not select it, because `New task assigned to you` contains none of them.
//
// Every test below is written against the REAL exported filter string and the
// REAL builder, not a restatement of them, so a change to either fails here.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getNotificationCategoryFilter,
  SYSTEM_TYPE_EXCLUSION,
  SYSTEM_GENERATED_NOTIFICATION_TYPES,
  isSystemGeneratedNotificationType,
  partitionSystemNotifications,
  FINANCE_NOTIFICATION_TYPES,
  ORDER_NOTIFICATION_TYPES,
  ASSET_NOTIFICATION_TYPES,
  ATTENDANCE_PAYROLL_NOTIFICATION_TYPES,
} from '@/lib/notifications'
import {
  buildTaskAssignmentNotification,
  notifyTaskAssignment,
  TASK_ASSIGNMENT_NOTIFICATION_TYPE,
} from '@/lib/tasks/assignmentNotification'
import { groupNotificationsByTask } from '@/lib/notifications/grouping'
import type { Notification } from '@/lib/types'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const ASSIGNEE = '11111111-1111-4111-8111-111111111111'
const CREATOR  = '22222222-2222-4222-8222-222222222222'
const TASK     = '33333333-3333-4333-8333-333333333333'

// ── A faithful reader of the actual query, not a paraphrase of it ────────────
//
// Every notification endpoint builds the same three-part WHERE:
//   .eq('user_id', caller) · .or(categoryFilter) · .not('type','in',EXCLUSION)
// These two helpers interpret the exported strings so the tests exercise what
// PostgREST is actually sent.

type Row = Pick<Notification, 'user_id' | 'task_id' | 'type' | 'title' | 'is_read'> &
  Partial<Notification>

function matchesOrFragment(row: Row, fragment: string): boolean {
  if (fragment === 'task_id.not.is.null') return row.task_id != null
  const inList = /^type\.in\.\((.*)\)$/.exec(fragment)
  if (inList) return inList[1].split(',').includes(row.type)
  const ilike = /^title\.ilike\.(.*)$/.exec(fragment)
  if (ilike) {
    const re = new RegExp(`^${ilike[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
    return re.test(row.title ?? '')
  }
  throw new Error(`unsupported PostgREST fragment: ${fragment}`)
}

/** True when the row is selected by the caller-scoped category query. */
function inFeed(row: Row, caller: string, category: 'task' | 'finance' | 'order' | 'asset' | 'attendance_payroll' = 'task'): boolean {
  if (row.user_id !== caller) return false
  const excluded = SYSTEM_TYPE_EXCLUSION.slice(1, -1).split(',')
  if (excluded.includes(row.type)) return false
  return getNotificationCategoryFilter(category).split(',').some(f => matchesOrFragment(row, f))
}

const assignmentRow = () =>
  buildTaskAssignmentNotification({
    assigneeId: ASSIGNEE, actorId: CREATOR, taskId: TASK, taskTitle: 'test task',
  })

const asNotification = (over: Partial<Notification> = {}): Row => ({
  id: 'n1', user_id: ASSIGNEE, task_id: TASK, entity_id: null,
  type: TASK_ASSIGNMENT_NOTIFICATION_TYPE, title: 'New task assigned to you',
  body: 'test task', is_read: false, is_push_sent: false, is_digest: false,
  created_at: '2026-08-26T10:00:00.000Z', read_at: null,
  ...over,
} as Row)

// ── 1–3. The row itself ──────────────────────────────────────────────────────

describe('1-3. assigning a task to another user produces exactly one deliverable row', () => {
  test('1. one notification, not zero and not two', () => {
    const row = assignmentRow()
    assert.notEqual(row, null)
    const { deliverable } = partitionSystemNotifications([row!])
    assert.equal(deliverable.length, 1)
  })

  test('1b. the insert is issued exactly once — a retry cannot double it', async () => {
    const batches: unknown[][] = []
    const client = { from: () => ({ insert: (rows: unknown[]) => { batches.push(rows); return Promise.resolve({ error: null }) } }) }
    const res = await notifyTaskAssignment(client, {
      assigneeId: ASSIGNEE, actorId: CREATOR, taskId: TASK, taskTitle: 'test task',
    })
    assert.equal(res.error, null)
    assert.equal(res.skipped, false)
    assert.equal(batches.length, 1, 'one round trip')
    assert.equal(batches[0].length, 1, 'one row in it')
  })

  test('2. recipient is the assignee, and task_id is the new task', () => {
    const row = assignmentRow()!
    assert.equal(row.user_id, ASSIGNEE)
    assert.notEqual(row.user_id, CREATOR, 'the assigner is not a recipient')
    assert.equal(row.task_id, TASK)
    assert.equal(row.type, 'task_assigned')
    // The grouped card heads with `body`; the parser reads the actor sentence
    // from `title`. Both must be populated or the group loses its heading.
    assert.equal(row.body, 'test task')
    assert.ok((row.title ?? '').length > 0)
  })

  test('2b. is_push_sent is false — nothing has been pushed', () => {
    // There is no push transport in this repository. Setting the column true at
    // insert time claims a delivery that never happened and would make a
    // transport added later skip the backlog.
    assert.equal(assignmentRow()!.is_push_sent, false)
  })

  test('3. it survives the centralized system-type guard', () => {
    const row = assignmentRow()!
    assert.equal(isSystemGeneratedNotificationType(row.type), false)
    const { deliverable, suppressed } = partitionSystemNotifications([row])
    assert.equal(suppressed.length, 0)
    assert.equal(deliverable.length, 1)
  })
})

// ── 4–7. Where it shows up ───────────────────────────────────────────────────

describe('4-7. the row reaches every Task surface', () => {
  test('4. it is selected by the Task notification list query', () => {
    assert.equal(inFeed(asNotification(), ASSIGNEE), true)
  })

  test('4b. and NOT for anybody else — user scoping is unchanged', () => {
    assert.equal(inFeed(asNotification(), CREATOR), false)
  })

  test('5. it contributes to the Task unread count', () => {
    const row = asNotification({ is_read: false })
    assert.equal(inFeed(row, ASSIGNEE) && row.is_read === false, true)
    // Once read it stops counting, and only then.
    assert.equal(inFeed(asNotification({ is_read: true }), ASSIGNEE), true)
  })

  test('6. it lands in the grouped card for its own task', () => {
    const items = groupNotificationsByTask([asNotification() as Notification])
    assert.equal(items.length, 1)
    assert.equal(items[0].kind, 'task')
    if (items[0].kind !== 'task') return
    assert.equal(items[0].taskId, TASK)
    assert.equal(items[0].title, 'test task', 'the group heads with the task title')
    assert.equal(items[0].unreadCount, 1)
  })

  test('7. mark-read and delete-all reach it, by the same filter', () => {
    // Both mutations chain the identical three conditions, so a row the list
    // shows is a row they can act on. Asserted at the source so a divergence
    // cannot be introduced silently.
    const list = read('src/app/api/notifications/route.ts')
    const mark = read('src/app/api/notifications/mark-read/route.ts')
    for (const src of [list, mark]) {
      assert.ok(src.includes('getNotificationCategoryFilter'), 'uses the shared filter')
      assert.ok(src.includes('SYSTEM_TYPE_EXCLUSION'), 'chains the system exclusion')
      assert.ok(src.includes(".eq('user_id', user.id)"), 'scoped to the caller')
    }
    // Group actions are the same set narrowed by task id, never a replacement.
    assert.ok(mark.includes(".eq('task_id', taskId as string)"))
    assert.ok(list.includes(".eq('task_id', taskId)"))
    assert.equal(inFeed(asNotification(), ASSIGNEE), true)
  })
})

// ── 8. Self-assignment ───────────────────────────────────────────────────────

describe('8. a self-task notifies nobody', () => {
  test('assigning to yourself produces no row', () => {
    assert.equal(buildTaskAssignmentNotification({
      assigneeId: CREATOR, actorId: CREATOR, taskId: TASK, taskTitle: 'my own task',
    }), null)
  })

  test('and the helper reports it as a skip, not an error', async () => {
    let called = false
    const client = { from: () => ({ insert: () => { called = true; return Promise.resolve({ error: null }) } }) }
    const res = await notifyTaskAssignment(client, {
      assigneeId: CREATOR, actorId: CREATOR, taskId: TASK, taskTitle: 'my own task',
    })
    assert.equal(res.skipped, true)
    assert.equal(res.error, null)
    assert.equal(called, false, 'no database call at all')
  })

  test('this is the rule every other task path already applies', () => {
    // Named at the source so "notify the actor" cannot come back on one path.
    assert.ok(read('src/app/api/notify-status-update/route.ts').includes('notifyUserId === user.id'))
    assert.ok(read('src/app/api/cancel-task/route.ts').includes("task.assigned_to !== user.id"))
    assert.ok(read('src/app/api/restore-task/route.ts').includes('recipient !== user.id'))
    assert.ok(read('supabase/migrations/20260833000000_task_creator_approval.sql')
      .includes('v_recipient <> v_uid'))
  })
})

// ── 9–10. Comments ───────────────────────────────────────────────────────────

describe('9-10. a comment notifies the other participant only', () => {
  const detail = read('src/app/tasks/[id]/page.tsx')

  test('9. the recipient is the other party — creator or assignee', () => {
    assert.ok(detail.includes(
      'const recipient = currentUserId === task.created_by ? task.assigned_to : task.created_by'),
      'the comment recipient rule is unchanged')
    assert.ok(detail.includes("action: 'comment_added'"))
  })

  test('10. the author is never notified about their own comment', () => {
    // Guarded twice: the caller refuses to send, and the route refuses to write.
    assert.ok(detail.includes('recipient && recipient !== currentUserId'))
    const route = read('src/app/api/notify-status-update/route.ts')
    assert.ok(route.includes('if (notifyUserId === user.id)'))
    assert.ok(route.includes('{ skipped: true }'))
  })

  test('and the comment row still reaches the feed under the new rule', () => {
    assert.equal(inFeed(asNotification({
      type: 'task_acknowledged', title: 'Dhruv added a comment',
    }), ASSIGNEE), true)
  })
})

// ── 11–13. The completion workflow ───────────────────────────────────────────

describe('11-13. submit / approve / return notify the right person', () => {
  const sql = read('supabase/migrations/20260833000000_task_creator_approval.sql')

  test('11. submission notifies the creator (the approver)', () => {
    assert.match(sql, /v_recipient := v_task\.created_by;\s*\n\s*v_title\s*:= v_actor_name \|\| ' submitted task for approval'/)
  })

  test('12. approval notifies the assignee', () => {
    assert.match(sql, /v_recipient := v_task\.assigned_to;\s*\n\s*v_title\s*:= v_actor_name \|\| ' approved and completed task'/)
  })

  test('13. a return notifies the assignee', () => {
    assert.match(sql, /v_recipient := v_task\.assigned_to;\s*\n\s*v_title\s*:= v_actor_name \|\| ' returned task to Working'/)
  })

  test('all three carry the task id, which is what puts them in the feed', () => {
    assert.match(sql, /insert into public\.notifications \(user_id, task_id, type, title, body, is_push_sent\)\s*\n\s*values \(v_recipient, p_task_id,/i)
    for (const title of [
      'Asha submitted task for approval',
      'Asha approved and completed task',
      'Asha returned task to Working',
    ]) {
      assert.equal(inFeed(asNotification({ type: 'task_acknowledged', title }), ASSIGNEE), true, title)
    }
  })

  test('none of the three is a suppressed type', () => {
    assert.equal(isSystemGeneratedNotificationType('task_acknowledged'), false)
  })
})

// ── 14. Suppression is unchanged ─────────────────────────────────────────────

describe('14. the five system types stay out', () => {
  test('each is still refused by the feed, even carrying a task_id', () => {
    // This is the whole reason the structural rule is safe: these rows DO have
    // a task_id, so the exclusion — not the old title whitelist — is what
    // removes them now.
    for (const type of SYSTEM_GENERATED_NOTIFICATION_TYPES) {
      assert.equal(isSystemGeneratedNotificationType(type), true, type)
      assert.equal(
        inFeed(asNotification({ type, title: 'Task overdue' }), ASSIGNEE), false,
        `${type} must never enter the Task feed`)
    }
  })

  test('the write guard still drops them before the row exists', () => {
    const { deliverable, suppressed } = partitionSystemNotifications(
      SYSTEM_GENERATED_NOTIFICATION_TYPES.map(type => ({ type })))
    assert.equal(deliverable.length, 0)
    assert.equal(suppressed.length, SYSTEM_GENERATED_NOTIFICATION_TYPES.length)
  })

  test('an actionable scheduled type is NOT suppressed', () => {
    assert.equal(isSystemGeneratedNotificationType('asset_warranty_expiring'), false)
  })
})

// ── 15. Every other module is untouched ──────────────────────────────────────

describe('15. Finance, Orders, Assets and Attendance/Payroll are unchanged', () => {
  const EXPECTED: Record<string, readonly string[]> = {
    finance: FINANCE_NOTIFICATION_TYPES,
    order: ORDER_NOTIFICATION_TYPES,
    asset: ASSET_NOTIFICATION_TYPES,
    attendance_payroll: ATTENDANCE_PAYROLL_NOTIFICATION_TYPES,
  }

  for (const [category, types] of Object.entries(EXPECTED)) {
    test(`${category} still selects exactly its own enum types`, () => {
      const filter = getNotificationCategoryFilter(category as 'finance')
      assert.equal(filter, `type.in.(${types.join(',')})`)
    })
  }

  test('no non-task row can be claimed by the Task rule', () => {
    // Every one of them writes task_id null (or never sets it), so the
    // structural rule cannot reach them.
    for (const types of Object.values(EXPECTED)) {
      for (const type of types) {
        assert.equal(
          inFeed(asNotification({ type, task_id: null, entity_id: 'e1' }), ASSIGNEE),
          false, `${type} must not enter the Task feed`)
      }
    }
  })
})

// ── 16. One filter, every endpoint ───────────────────────────────────────────

describe('16. list, count and both mutations share one canonical Task rule', () => {
  test('all four build their scope from getNotificationCategoryFilter', () => {
    const list = read('src/app/api/notifications/route.ts')
    const mark = read('src/app/api/notifications/mark-read/route.ts')
    // GET count, GET list, DELETE — the same call, three times in one file.
    assert.equal((list.match(/getNotificationCategoryFilter\(categoryResult\.category\)/g) ?? []).length, 2)
    assert.equal((list.match(/\.or\(activityFilter\)/g) ?? []).length, 3)
    assert.equal((list.match(/SYSTEM_TYPE_EXCLUSION/g) ?? []).length, 4)
    assert.ok(mark.includes('.or(getNotificationCategoryFilter(categoryResult.category)).not(\'type\', \'in\', SYSTEM_TYPE_EXCLUSION)'))
  })

  test('the badge counts all come from that one endpoint', () => {
    const hook = read('src/hooks/queries/useUnreadNotifications.ts')
    assert.ok(hook.includes('/api/notifications?count=1&category='))
    // Desktop nav, mobile nav and the module card all read this hook, so there
    // is no second place a count could disagree.
    assert.ok(read('src/components/layout/NotificationsNavItem.tsx').includes('useUnreadNotifications'))
  })
})

// ── 17. Wording can never hide a row again ───────────────────────────────────

describe('17. no title wording can hide a task notification with a valid task_id', () => {
  const TITLES = [
    'New task assigned to you',
    'New quotation request',
    'Task reopened',
    'Priya reopened a task',
    'Task moved to Waiting',
    'Task moved to Blocked',
    'Task status updated',
    'Dhruv added a comment',
    '',
    'something nobody has written yet',
  ]

  for (const title of TITLES) {
    test(`"${title || '(empty)'}" is in the feed`, () => {
      assert.equal(inFeed(asNotification({ title }), ASSIGNEE), true)
    })
  }

  test('the filter names no title at all', () => {
    const filter = getNotificationCategoryFilter('task')
    assert.equal(filter, 'task_id.not.is.null')
    assert.equal(/title/.test(filter), false)
  })

  test('and a row WITHOUT a task_id is not in the Task feed', () => {
    // The other half of the rule. A finance row titled "…completed task" would
    // have been swept in by the old whitelist; it cannot be now.
    assert.equal(inFeed(asNotification({
      task_id: null, type: 'finance_approved_linked', title: 'Ravi completed task',
    }), ASSIGNEE), false)
  })
})

// ── 18. A failed insert is never reported as a success ───────────────────────

describe('18. insert failures are surfaced, not swallowed', () => {
  test('the helper returns the error unchanged', async () => {
    const client = { from: () => ({ insert: () => Promise.resolve({ error: { message: 'permission denied' } }) }) }
    const res = await notifyTaskAssignment(client, {
      assigneeId: ASSIGNEE, actorId: CREATOR, taskId: TASK, taskTitle: 'test task',
    })
    assert.equal(res.skipped, false)
    assert.equal(res.error?.message, 'permission denied')
  })

  test('every call site reads that error and logs it', () => {
    const SITES: [path: string, marker: string][] = [
      ['src/app/tasks/create/page.tsx',                  '[tasks create] notification insert failed'],
      ['src/app/tasks/assigned-by-me/page.tsx',          'notification insert failed'],
      ['src/app/tasks/quotation-requests/new/page.tsx',  'notification insert failed'],
      ['src/components/meetings/MeetingTaskModal.tsx',   'notification insert failed'],
      ['src/app/api/tasks/[id]/copy/route.ts',           'notification insert failed'],
    ]
    for (const [path, marker] of SITES) {
      const src = read(path)
      assert.ok(src.includes('notifErr'), `${path} captures the error`)
      assert.ok(src.includes(marker), `${path} logs it`)
    }
  })

  test('the server routes return a 500 rather than a silent success', () => {
    const route = read('src/app/api/notify-status-update/route.ts')
    assert.ok(route.includes('if (error) {'))
    assert.ok(route.includes('{ status: 500 }'))
  })
})
