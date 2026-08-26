/**
 * System-generated activity must not become a user notification.
 *
 * The rule under test: a record the SYSTEM produced about itself — the hourly
 * `run_task_health_check` job's `escalation` / `overdue` rows, `stale_flag`,
 * the digests — is not something anybody can act on, so it must not create an
 * in-app notification row and must not leave anything for a push transport to
 * pick up. Everything a PERSON did, and every scheduled reminder that asks a
 * person to do something, is untouched.
 *
 * Run:
 *   npx tsx --test src/lib/notificationSystemActivity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SYSTEM_GENERATED_NOTIFICATION_TYPES,
  ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES,
  SYSTEM_TYPE_EXCLUSION,
  isSystemGeneratedNotificationType,
  partitionSystemNotifications,
  getNotificationCategoryFilter,
  FINANCE_NOTIFICATION_TYPES,
  ORDER_NOTIFICATION_TYPES,
  ASSET_NOTIFICATION_TYPES,
  ATTENDANCE_PAYROLL_NOTIFICATION_TYPES,
} from './notifications'
import {
  insertUserNotifications,
  type NotificationInsert,
  type NotificationInsertClient,
} from './notificationWrites'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Records every insert so a test can assert that NONE happened. */
function recordingClient(error: { message: string } | null = null) {
  const calls: NotificationInsert[][] = []
  const client: NotificationInsertClient = {
    from: () => ({
      insert: async (rows: NotificationInsert[]) => { calls.push(rows); return { error } },
    }),
  }
  return { client, calls }
}

const row = (type: string, over: Partial<NotificationInsert> = {}): NotificationInsert => ({
  user_id: 'u1', task_id: 't1', type, title: 'Something happened',
  body: 'Task title', is_push_sent: true, ...over,
})

// ── 1. Human-triggered events still notify ───────────────────────────────────

describe('human-triggered task events are untouched', () => {
  // Every event /api/notify-status-update composes, plus the other three Task
  // Management writers. All of them are somebody clicking something.
  const HUMAN_TYPES = ['task_acknowledged', 'task_assigned', 'task_delegated',
                       'delegation_accepted', 'delegation_declined', 'blocker_tagged']

  for (const type of HUMAN_TYPES) {
    test(`${type} is written`, async () => {
      const { client, calls } = recordingClient()
      const result = await insertUserNotifications(client, row(type))
      assert.equal(result.inserted, 1)
      assert.equal(result.suppressed, 0)
      assert.equal(result.error, null)
      assert.equal(calls.length, 1)
      assert.equal(calls[0][0].type, type)
    })
  }

  test('a batch of human events is written whole', async () => {
    const { client, calls } = recordingClient()
    const result = await insertUserNotifications(client, [
      row('task_acknowledged'), row('task_assigned'), row('task_acknowledged'),
    ])
    assert.equal(result.inserted, 3)
    assert.equal(calls[0].length, 3)
  })

  test('an insert failure is reported, not swallowed', async () => {
    const { client } = recordingClient({ message: 'boom' })
    const result = await insertUserNotifications(client, row('task_acknowledged'))
    assert.equal(result.inserted, 0)
    assert.deepEqual(result.error, { message: 'boom' })
  })
})

// ── 2. System activity creates nothing ───────────────────────────────────────

describe('system-generated activity is suppressed', () => {
  for (const type of SYSTEM_GENERATED_NOTIFICATION_TYPES) {
    test(`${type} produces NO in-app notification row`, async () => {
      const { client, calls } = recordingClient()
      const result = await insertUserNotifications(client, row(type))
      assert.equal(result.inserted, 0, 'no row was written')
      assert.equal(result.suppressed, 1)
      assert.equal(calls.length, 0, 'the database was not touched at all')
    })

    test(`${type} dispatches NO push`, async () => {
      // There is no push transport to intercept: a push is delivered by reading
      // notification rows (is_push_sent is the flag one would read). Suppression
      // happens BEFORE the row exists, so there is nothing to deliver — which is
      // what "no push is dispatched" means here, and it is stronger than
      // filtering at delivery time.
      const { client, calls } = recordingClient()
      await insertUserNotifications(client, row(type, { is_push_sent: true }))
      assert.deepEqual(calls, [])
    })
  }

  test('escalation is suppressed even inside a mixed batch, and the rest still send', async () => {
    const { client, calls } = recordingClient()
    const result = await insertUserNotifications(client, [
      row('task_acknowledged', { user_id: 'a' }),
      row('escalation',        { user_id: 'b' }),
      row('overdue',           { user_id: 'c' }),
      row('task_assigned',     { user_id: 'd' }),
    ])
    assert.equal(result.inserted, 2)
    assert.equal(result.suppressed, 2)
    assert.deepEqual(calls[0].map(r => r.user_id), ['a', 'd'])
  })

  test('suppression is not an error — the business action already happened', async () => {
    const { client } = recordingClient()
    const result = await insertUserNotifications(client, row('escalation'))
    assert.equal(result.error, null)
  })

  test('the predicate and the list agree, and nothing else is caught by it', () => {
    for (const t of SYSTEM_GENERATED_NOTIFICATION_TYPES) {
      assert.equal(isSystemGeneratedNotificationType(t), true, t)
    }
    for (const t of ['task_acknowledged', 'task_assigned', 'finance_submitted',
                     'order_submitted', 'asset_assigned', 'attendance_issue_raised']) {
      assert.equal(isSystemGeneratedNotificationType(t), false, t)
    }
    assert.equal(isSystemGeneratedNotificationType(null), false)
    assert.equal(isSystemGeneratedNotificationType(undefined), false)
  })

  test('partitionSystemNotifications keeps order and loses nothing', () => {
    const rows = [row('overdue'), row('task_assigned'), row('stale_flag'), row('task_acknowledged')]
    const { deliverable, suppressed } = partitionSystemNotifications(rows)
    assert.deepEqual(deliverable.map(r => r.type), ['task_assigned', 'task_acknowledged'])
    assert.deepEqual(suppressed.map(r => r.type),  ['overdue', 'stale_flag'])
    assert.equal(deliverable.length + suppressed.length, rows.length)
  })
})

// ── 3. Actionable scheduled reminders are NOT collateral damage ──────────────

describe('scheduled reminders that need a person stay on', () => {
  for (const type of ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES) {
    test(`${type} survives the rule`, async () => {
      const { client, calls } = recordingClient()
      const result = await insertUserNotifications(client, row(type, { task_id: null, entity_id: 'asset-1' }))
      assert.equal(result.suppressed, 0)
      assert.equal(result.inserted, 1)
      assert.equal(calls[0][0].type, type)
    })
  }

  test('no actionable scheduled type is also listed as system-generated', () => {
    for (const t of ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES) {
      assert.equal(isSystemGeneratedNotificationType(t), false, t)
    }
  })

  test('the warranty sweep still inserts, and is not routed through the guard', () => {
    // Deliberate: it builds `asset_warranty_expiring` rows only, and the guard
    // exists to stop system TYPES, not scheduled writers. If this route were
    // ever "cleaned up" into the suppression path by mistake, admins would stop
    // being told about expiring warranties.
    const sweep = read('src/app/api/assets/warranty-sweep/route.ts')
    assert.ok(sweep.includes("supabase.from('notifications').insert(pending)"))
    assert.ok(sweep.includes("type: 'asset_warranty_expiring'"))
  })
})

// ── 4. No module feed can surface a system row ───────────────────────────────

describe('the read side excludes system types too', () => {
  const CATEGORIES = ['task', 'finance', 'order', 'asset', 'attendance_payroll'] as const

  test('no category whitelist contains a system type', () => {
    const lists = [FINANCE_NOTIFICATION_TYPES, ORDER_NOTIFICATION_TYPES,
                   ASSET_NOTIFICATION_TYPES, ATTENDANCE_PAYROLL_NOTIFICATION_TYPES]
    for (const list of lists) {
      for (const t of list) assert.equal(isSystemGeneratedNotificationType(t), false, t)
    }
  })

  test('no category filter names a system type', () => {
    for (const c of CATEGORIES) {
      const filter = getNotificationCategoryFilter(c)
      for (const t of SYSTEM_GENERATED_NOTIFICATION_TYPES) {
        assert.equal(filter.includes(t), false, `${c} filter mentions ${t}`)
      }
    }
  })

  test('SYSTEM_TYPE_EXCLUSION is a PostgREST in-list of exactly the system types', () => {
    assert.equal(SYSTEM_TYPE_EXCLUSION, `(${SYSTEM_GENERATED_NOTIFICATION_TYPES.join(',')})`)
    assert.match(SYSTEM_TYPE_EXCLUSION, /^\([a-z_,]+\)$/)
  })

  test('list, count, delete-all and mark-all-read all apply it', () => {
    const list = read('src/app/api/notifications/route.ts')
    const mark = read('src/app/api/notifications/mark-read/route.ts')
    // Three in the list route: the ?count=1 badge path, the list path, and DELETE.
    assert.equal((list.match(/\.not\('type', 'in', SYSTEM_TYPE_EXCLUSION\)/g) ?? []).length, 3,
      'count, list and delete-all must each exclude system rows')
    assert.ok(mark.includes(".not('type', 'in', SYSTEM_TYPE_EXCLUSION)"),
      'mark-all-read must not flip rows the feed never shows')
  })
})

// ── 5. The rule is centralized, not copied ──────────────────────────────────

describe('one rule, one place', () => {
  const TASK_ROUTES = [
    'src/app/api/notify-status-update/route.ts',
    'src/app/api/cancel-task/route.ts',
    'src/app/api/restore-task/route.ts',
    'src/app/api/tasks/[id]/copy/route.ts',
  ]

  for (const path of TASK_ROUTES) {
    test(`${path} writes through the shared guard`, () => {
      const src = read(path)
      assert.ok(src.includes("insertUserNotifications"), 'uses the guard')
      assert.equal(/\.from\('notifications'\)\s*\.insert/.test(src), false,
        'no direct notifications insert bypasses the guard')
    })
  }

  test('the guard names the rule once, by import', () => {
    const guard = read('src/lib/notificationWrites.ts')
    assert.ok(guard.includes("from '@/lib/notifications'"),
      'the type list is imported, not re-declared')
    assert.equal(guard.includes("'escalation'"), false,
      'no second copy of the suppressed-type list')
  })

  test('activity history is untouched by the rule', () => {
    // The escalation must still HAPPEN and must still be recorded. The guard
    // knows nothing about task_activity_log, and the two routes that write both
    // still write the log.
    const guard = read('src/lib/notificationWrites.ts')
    assert.equal(guard.includes('task_activity_log'), false)
    for (const path of ['src/app/api/cancel-task/route.ts', 'src/app/api/restore-task/route.ts']) {
      assert.ok(read(path).includes("task_activity_log"), `${path} still records the action`)
    }
  })
})
