/**
 * Group actions: what they change, what they must not touch, and what happens
 * when they fail.
 *
 * The mutations are driven through their real TanStack option objects against a
 * real QueryClient and an injected fetch, so the optimistic write, the unread
 * delta and the rollback are exercised rather than described.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/groupMutations.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, MutationObserver } from '@tanstack/react-query'
import type { Notification } from '@/lib/types'
import { notificationKeys } from '@/lib/notificationCache'
import {
  markManyReadOptions,
  markTaskGroupReadOptions,
  deleteSelectedOptions,
  deleteTaskGroupOptions,
  type NotificationMutationDeps,
} from '@/lib/notificationMutations'
import { groupNotificationsByTask } from './grouping'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const TASK_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const TASK_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

let seq = 0
function n(over: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `n${seq}`, user_id: 'me', task_id: TASK_A, entity_id: null,
    type: 'task_acknowledged', title: 'Dhruv added a comment', body: 'A task',
    is_read: false, is_push_sent: true, is_digest: false,
    created_at: '2026-08-26T10:00:00.000Z', read_at: null, ...over,
  } as Notification
}

type Call = { url: string; method?: string; body: unknown }

function harness(rows: Notification[], unread: number, respond: (c: Call) => Response) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(notificationKeys.list('task'), rows)
  qc.setQueryData(notificationKeys.count('task'), { unreadCount: unread })
  const calls: Call[] = []
  const errors: string[] = []
  const deps: NotificationMutationDeps = {
    qc, category: 'task',
    reportError: m => errors.push(m),
    fetchFn: async (url, init) => {
      const call = { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null }
      calls.push(call)
      return respond(call)
    },
  }
  const list  = () => qc.getQueryData<Notification[]>(notificationKeys.list('task')) ?? []
  const count = () => qc.getQueryData<{ unreadCount: number }>(notificationKeys.count('task'))?.unreadCount
  return { qc, deps, calls, errors, list, count }
}

const ok = (body: unknown = { success: true }): Response =>
  ({ ok: true, status: 200, json: async () => body } as Response)
const fail = (): Response =>
  ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response)

/** Drives a mutation option object end to end against its QueryClient. */
async function mutate<T>(qc: QueryClient, options: object, variables: T) {
  const observer = new MutationObserver(qc, options as never)
  try { await observer.mutate(variables as never) } catch { /* handled by onError */ }
}

// ── 14, 17. Mark a group read ───────────────────────────────────────────────

describe('14/17. marking a task group read', () => {
  const rows = () => [
    n({ id: 'u1', task_id: TASK_A, is_read: false }),
    n({ id: 'r1', task_id: TASK_A, is_read: true }),
    n({ id: 'u2', task_id: TASK_A, is_read: false }),
    n({ id: 'x1', task_id: TASK_B, is_read: false }),
  ]

  test('14. every unread event of THAT task flips, and nothing else', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, updatedCount: 2, unreadAffected: 2 }))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)

    const byId = Object.fromEntries(h.list().map(r => [r.id, r]))
    assert.equal(byId.u1.is_read, true)
    assert.equal(byId.u2.is_read, true)
    assert.equal(byId.r1.is_read, true, 'already read, untouched')
    assert.equal(byId.x1.is_read, false, 'another task is not touched')
  })

  test('17. ONE request, naming the TASK rather than the loaded ids', async () => {
    // The page is bounded, so an ids list would silently skip anything outside
    // the window — the defect this replaced.
    const h = harness(rows(), 3, () => ok({ success: true, unreadAffected: 2 }))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, '/api/notifications/mark-read')
    const body = h.calls[0].body as { taskId?: string; ids?: string[] }
    assert.equal(body.taskId, TASK_A)
    assert.equal(body.ids, undefined)
  })

  test('17. the canonical unread count drops by the SERVER’s exact number', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, unreadAffected: 2 }))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)
    assert.equal(h.count(), 1)
  })

  test('a group whose loaded events are already read still defers to the server', async () => {
    // Nothing visible to subtract, but older unread rows may exist — so the
    // correction comes from the response, not from the empty local delta.
    const h = harness([n({ id: 'r1', is_read: true })], 5,
      () => ok({ success: true, unreadAffected: 4 }))
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)
    assert.equal(h.count(), 1, '5 - 4 that the server actually flipped')
  })

  test('22. a failure restores both the rows and the count', async () => {
    const h = harness(rows(), 3, () => fail())
    await mutate(h.qc, markTaskGroupReadOptions(h.deps), TASK_A)
    const byId = Object.fromEntries(h.list().map(r => [r.id, r]))
    assert.equal(byId.u1.is_read, false, 'rolled back')
    assert.equal(byId.u2.is_read, false)
    assert.equal(h.count(), 3, 'and so is the badge')
    assert.equal(h.errors.length, 1, 'and the reader is told')
  })

  test('the id-based mark-read still exists, for an explicit selection', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, updatedCount: 1 }))
    await mutate(h.qc, markManyReadOptions(h.deps), ['u1'])
    assert.deepEqual((h.calls[0].body as { ids: string[] }).ids, ['u1'])
    assert.equal(h.count(), 2)
  })
})

// ── 18-19, 22. Delete a group ───────────────────────────────────────────────

describe('18/19. deleting a task group', () => {
  const rows = () => [
    n({ id: 'a1', task_id: TASK_A, is_read: false }),
    n({ id: 'a2', task_id: TASK_A, is_read: false }),
    n({ id: 'a3', task_id: TASK_A, is_read: true }),
    n({ id: 'b1', task_id: TASK_B, is_read: false }),
  ]

  test('18. only that task’s notifications go', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, deletedCount: 3, unreadAffected: 2 }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.deepEqual(h.list().map(r => r.id), ['b1'])
  })

  test('18. the request names the task, the category, and the caller’s own session', async () => {
    const h = harness(rows(), 3, () => ok({ success: true, deletedCount: 3, unreadAffected: 2 }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.equal(h.calls[0].method, 'DELETE')
    assert.match(h.calls[0].url, /^\/api\/notifications\?category=task&taskId=/)
    assert.ok(h.calls[0].url.includes(TASK_A))
    // The route resolves the user server-side; no id is sent.
    const route = read('src/app/api/notifications/route.ts')
    assert.ok(route.includes(".eq('user_id', user.id)"))
    assert.ok(route.includes("if (taskId !== null) deleteQuery = deleteQuery.eq('task_id', taskId)"))
  })

  test('19. it cannot reach the task, its history, comments or attachments', () => {
    const route = read('src/app/api/notifications/route.ts')
    const del = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(del.includes("from('notifications')"))
    for (const table of ['tasks', 'task_activity_log', 'task_comments', 'task_attachments']) {
      assert.equal(new RegExp(`from\\('${table}'\\)`).test(del), false,
        `the endpoint must never touch ${table}`)
    }
    const view = read('src/components/notifications/NotificationsView.tsx')
    assert.ok(view.includes('Delete all notifications for this task?'))
    assert.ok(view.includes(
      'This removes the notification entries only. The task and its activity history will remain.'))
    assert.ok(view.includes('window.confirm('), 'the scope exceeds the screen, so it confirms')
  })

  test('the unread count drops by the server’s exact number, not the loaded one', async () => {
    // 2 unread loaded, but the server removed 7 unread rows in total.
    const h = harness(rows(), 9, () => ok({ success: true, deletedCount: 12, unreadAffected: 7 }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.equal(h.count(), 2, '9 - 7')
  })

  test('deleting a fully read group leaves the count alone', async () => {
    const h = harness([n({ id: 'r1', is_read: true }), n({ id: 'r2', is_read: true })], 4,
      () => ok({ success: true, deletedCount: 2, unreadAffected: 0 }))
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.equal(h.count(), 4)
  })

  test('22. a failed group delete restores the rows, the count and the grouping', async () => {
    const h = harness(rows(), 3, () => fail())
    await mutate(h.qc, deleteTaskGroupOptions(h.deps), TASK_A)
    assert.deepEqual(h.list().map(r => r.id).sort(), ['a1', 'a2', 'a3', 'b1'])
    assert.equal(h.count(), 3)
    assert.equal(h.errors.length, 1)
    assert.equal(groupNotificationsByTask(h.list()).length, 2)
  })
})

// ── 20-21, 23. The existing workflows still hold ────────────────────────────

describe('20/21/23. individual and selected actions across groups', () => {
  test('21. selected delete spans two groups in one request', async () => {
    const h = harness([
      n({ id: 'a1', task_id: TASK_A }), n({ id: 'b1', task_id: TASK_B }),
      n({ id: 'a2', task_id: TASK_A }),
    ], 3, () => ok({ success: true, deletedIds: ['a1', 'b1'] }))
    await mutate(h.qc, deleteSelectedOptions(h.deps), ['a1', 'b1'])
    assert.deepEqual(h.list().map(r => r.id), ['a2'])
    assert.equal(h.calls.length, 1)
  })

  test('23. an in-flight widening read cannot resurrect a deleted event', () => {
    // "Load older" stands down while any mutation is pending, and a row with a
    // delete in flight is filtered out of the rendered list regardless.
    const hook = read('src/hooks/queries/useNotifications.ts')
    assert.ok(hook.includes('if (loadingOlder || blocked) return'))
    const view = read('src/components/notifications/NotificationsView.tsx')
    assert.ok(view.includes('pendingDeletes.size > 0 || markingAll || deletingBulk || deletingAll'))
    assert.ok(view.includes('useNotifications(category, mutationInFlight)'))
    // The group card also refuses to draw a row whose delete is in flight.
    const card = read('src/components/notifications/NotificationTaskGroup.tsx')
    // The guarantee, not one spelling of it: the event map returns nothing for
    // a row whose delete is in flight, before any element is built.
    assert.match(card, /pendingDeletes\.has\([^)]+\)\)\s*return null/)
  })

  test('13. expanding is a disclosure and marks nothing read', () => {
    const card = read('src/components/notifications/NotificationTaskGroup.tsx')
    const toggle = card.slice(card.indexOf('onClick={() => setOpen'), card.indexOf('aria-controls'))
    assert.equal(/markRead|markManyRead|onMarkGroupRead/.test(toggle), false,
      'the accordion trigger must not mark anything read')
  })
})

// ── 34-35. Nothing was restored or migrated ─────────────────────────────────

describe('34/35. no regression into suppressed territory', () => {
  test('34. no escalation or overdue notification path is reintroduced', () => {
    for (const f of [
      'src/lib/notifications/grouping.ts',
      'src/components/notifications/NotificationTaskGroup.tsx',
      'src/components/notifications/NotificationRow.tsx',
    ]) {
      const src = read(f)
      assert.equal(/'escalation'|'overdue'|'stale_flag'/.test(src), false, f)
    }
  })

  test('35. GROUPING added no migration — the newer files are not its doing', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    const newer = files.filter(f => f.slice(0, 14) > '20261015000000')
    assert.deepEqual(newer, [
      '20261016000000_notifications_link_activity_log.sql',
      // Customer Review Outreach, the Top 3 Focus unpin and the Image Editor
      // registration — three separate modules added later still. Named rather
      // than tolerated by a loosened rule, so a further unexplained file
      // appearing here still fails.
      '20261017000000_customer_review_outreach.sql',
      '20261018000000_unpin_tasks_submitted_for_approval.sql',
      '20261020000000_register_image_editor_module.sql',
      '20261021000000_seed_customer_review_test_cards.sql',
      '20261022000000_image_editor_result_history.sql',
      '20261023000000_review_workflow_ai_drafts.sql',
      // The batch-approval pair, in the order they must apply. The deletion
      // migration runs FIRST so the schema one lands on an empty card table
      // and can enforce its approval invariants without a legacy exemption.
      '20261025000000_review_workflow_remove_legacy_test_data.sql',
      '20261026000000_review_workflow_batch_approval.sql',
      // Provider-call idempotency: a request key is CLAIMED before the model
      // is called, so two simultaneous requests cannot both be billed for.
      '20261027000000_review_workflow_generation_claims.sql',
      // Assets & Access, from a separate branch: the delegated Access Register
      // permission and the asset handover acknowledgement. Neither touches
      // this work's tables, policies or functions.
      '20261028000000_assets_access_manage_access_records.sql',
      '20261029000000_asset_handover_acknowledgement.sql',
      // Verifier deletion, and the Add-versus-Replace choice at approval.
      '20261030000000_review_workflow_deletion_and_replacement.sql',
      // Twelve drafts a batch, editing a pending draft before approval, and up
      // to four review images. It touches only this module's own tables.
      '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
      // BOE Credits Phase 1A: the append-only credit ledger, its derived balance
      // view, the settings table and the service-role posting functions. Two new
      // tables of its own; it touches nothing any other module creates.
      '20261101000000_boe_credits_foundation.sql',
      // BOE Credits Phase 1B: re-creates transition_customer_review_test_card() so a
      // verified review posts its review_reward in the same transaction. One
      // function, no table, no data.
      '20261102000000_boe_credits_review_reward.sql',
      // BOE Credits Phase 1C: the attendance redemption record table and the
      // service-role function that covers one attendance day with credits. One
      // new table of its own; it touches nothing any other module creates.
      '20261103000000_boe_credits_attendance_redemption.sql',
      // BOE Credits Phase 1D: configurable settings, monthly review qualification
      // and the payroll salary addition. Three new credits tables of its own; it
      // touches nothing any other module creates.
      '20261104000000_boe_credits_phase_1d.sql',
      // Half-day company holidays: adds holiday_type/half_session to
      // payroll_holidays. Touches nothing this module creates.
      '20261105000000_holiday_half_day.sql',
      // Employee designation level: one nullable, informational column on
      // public.users, granted to authenticated. Reaches nothing here.
      '20261106000000_employee_designation_level.sql',
      // Review types, batch assignment and the project image library: two new
      // tables of its own, columns on customer_review_test_cards and one on
      // boe_credit_settings. It reaches nothing here.
      '20261107000000_review_types_assignment_and_image_groups.sql',
      // Variable Review Workflow batch size: three CHECKs on its own batch and
      // claim tables widened from 12 to a 6-20 range, two nullable columns added
      // to customer_review_draft_batches, and three of its own functions
      // redefined. It creates no table and reaches nothing here.
      '20261108000000_review_workflow_variable_batch_size.sql',
      // Performance: Personal Performance and Team Performance become separately
      // configurable capabilities. It registers two actions on the existing
      // `performance` permission module and seeds the admin/manager role grants
      // that reproduce today's role checks exactly. It creates no table, alters
      // no table and defines no function, so it reaches nothing asserted here.
      '20261109000000_performance_personal_and_team_capabilities.sql',
      // The forward-only correction to it: Performance management visibility is
      // granted per employee, never inherited from the `manager` role name. It
      // deletes two role_permissions rows and inserts two
      // employee_permission_overrides rows. It creates no table, alters no table
      // and defines no function, so it reaches nothing asserted here.
      '20261110000000_performance_team_visibility_is_granted_not_inherited.sql',
      // The two permission_modules rows whose display_name and description had
      // drifted from src/lib/permissions/modules.ts, moved onto the registry text.
      // Two UPDATE statements against display text. It creates no table, alters no
      // table and defines no function, so it reaches nothing asserted here.
      '20261111000000_permission_module_labels_follow_the_registry.sql',
      // Performance participation: one UPDATE holding a partner out of the
      // measured population, via users.performance_tracking_enabled (20260719000000).
      // A DATA migration — it creates no table, alters no table, defines no
      // function and deletes nothing, so it reaches nothing asserted here.
      '20261112000000_exclude_partner_from_performance_population.sql',
      // Minop Stage 1: raw authenticated webhook audit/quarantine only.
      // It creates one isolated Minop delivery table and does not touch the
      // schema, functions or data asserted by this older migration test.
      '20261113000000_create_minop_webhook_deliveries.sql',
      // Widens the Review Workflow test_body column CHECK from 900 to 1800
      // characters, so a 200-word generation ceiling is not silently capped by
      // storage. One constraint dropped and re-added, wider. It creates no
      // table, alters no other table and defines no function, so it reaches
      // nothing asserted here.
      '20261114000000_review_generation_word_range_and_body_length.sql',
      // Restores the transaction-local marker approve_finance_payment_request
      // sets around its own decision UPDATE, which 20261013000000 dropped when it
      // restated the function. One function body re-emitted; it creates no table,
      // alters no table, touches no policy and adds no grant, so it reaches
      // nothing asserted here.
      '20261115000000_restore_finance_payment_verification_context.sql',
      // PI review gate, PI versions and production alignment (20261116000000):
      // order_submissions gains the PI-decision columns, orders the production
      // alignment columns, order_pi_versions is created, and the Order-side
      // activity policy is added. It re-emits approve_order_submission,
      // submit_pi_for_review_internal, pi_submission_payment_summary and
      // orders_guard_amendable_columns. It touches nothing asserted here.
      '20261116000000_order_submission_pi_review_gate_versions_and_production.sql',
      // The two post-approval PI edits — Change PI and the client-details
      // correction — now open the EXISTING order-amendment context around their
      // own Order UPDATE, which orders_guard_amendable_columns() requires. Two
      // function bodies re-emitted; no table, policy, trigger or grant changes,
      // so it reaches nothing asserted here.
      '20261117000000_order_submission_post_approval_edits_use_the_amendment_context.sql',
    ], 'the activity-link column and the three modules added by later work')
    // Grouping is a presentation change and its own files reach for no schema.
    for (const f of ['src/lib/notifications/grouping.ts', 'src/lib/notificationMutations.ts']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      assert.equal(/alter table|create index|migration/i.test(src), false, f)
    }
  })
})
