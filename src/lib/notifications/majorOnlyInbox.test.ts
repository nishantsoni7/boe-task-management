/**
 * MAJOR ACTIVITY ONLY (owner, 2026-11-23): the Orders and Finance inboxes show
 * a notice only when a named person must act, is stuck until they hear back, or
 * something went wrong. Routine types are hidden — still written, never
 * selected, never pushed.
 *
 * What this pins:
 *   1. the exact shown / routine split the owner approved (changing it is a
 *      deliberate edit of this file);
 *   2. every Orders / Finance type any migration adds to the enum is decided
 *      one way or the other, so a NEW type cannot silently appear in (or
 *      vanish from) an inbox;
 *   3. the feed filter, and so the unread count, Mark all read and Delete all,
 *      select the shown list and name no routine type;
 *   4. a routine type gets no phone alert, a shown one does;
 *   5. the "New update" mark on Confirmed Orders still reads its rows;
 *   6. the one-line note exists for exactly the two inboxes that hide types.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/majorOnlyInbox.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import {
  FINANCE_NOTIFICATION_TYPES,
  FINANCE_ROUTINE_NOTIFICATION_TYPES,
  ORDER_NOTIFICATION_TYPES,
  ORDER_ROUTINE_NOTIFICATION_TYPES,
  MAJOR_ONLY_NOTE,
  getNotificationCategoryFilter,
} from '@/lib/notifications'
import { pushCategoryFor } from '@/lib/push/pushPolicy'
import { ORDER_UNREAD_TYPES } from '@/lib/orders/orderUnreadUpdates'

const sorted = (xs: readonly string[]) => [...xs].sort()
const typesIn = (filter: string) => filter.replace(/^type\.in\.\(|\)$/g, '').split(',')

describe('the approved split', () => {
  test('Finance shows five types', () => {
    assert.deepEqual(sorted(FINANCE_NOTIFICATION_TYPES), sorted([
      'finance_clarification', 'finance_rejected',
      'finance_handover_requested', 'finance_handover_disputed', 'finance_handover_reminder',
    ]))
  })

  test('Finance hides eight types', () => {
    assert.deepEqual(sorted(FINANCE_ROUTINE_NOTIFICATION_TYPES), sorted([
      'finance_submitted', 'finance_resubmitted',
      'finance_approved_suspense', 'finance_approved_linked', 'finance_linked', 'finance_status_corrected',
      'finance_handover_accepted', 'finance_handover_cancelled',
    ]))
  })

  test('Orders shows eighteen types', () => {
    assert.deepEqual(sorted(ORDER_NOTIFICATION_TYPES), sorted([
      'order_converted', 'order_update_status',
      'order_operations_review_requested', 'order_operations_review_decided',
      'pi_exception_requested', 'pi_exception_approved', 'pi_exception_rejected',
      'pi_revision_proposed', 'pi_revision_approved', 'pi_revision_rejected',
      'order_document_review_requested', 'order_document_review_decided',
      'pi_correction_requested', 'pi_correction_resolved', 'pi_correction_rejected',
      'pi_review_decided',
      'order_change_requested', 'order_change_decided',
    ]))
  })

  test('Orders hides ten types', () => {
    assert.deepEqual(sorted(ORDER_ROUTINE_NOTIFICATION_TYPES), sorted([
      'order_update_amended', 'order_update_production', 'order_update_payment', 'order_update_approval',
      'pi_review_requested',
      'order_submitted', 'order_assigned', 'order_clarification', 'order_resubmitted', 'order_rejected',
    ]))
  })

  test('no type is both shown and routine, and none is listed twice', () => {
    for (const [shown, routine] of [
      [FINANCE_NOTIFICATION_TYPES, FINANCE_ROUTINE_NOTIFICATION_TYPES],
      [ORDER_NOTIFICATION_TYPES, ORDER_ROUTINE_NOTIFICATION_TYPES],
    ] as const) {
      const all = [...shown, ...routine]
      assert.equal(new Set(all).size, all.length, 'a type appears twice')
    }
  })
})

describe('every Orders / Finance type is decided', () => {
  const dir = 'supabase/migrations'
  const enumValues = new Set<string>()
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql'))) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8')
    for (const m of sql.matchAll(/add value if not exists '([a-z_]+)'/gi)) enumValues.add(m[1])
  }

  test('the migrations were actually read', () => {
    assert.ok(enumValues.has('finance_submitted') && enumValues.has('pi_review_requested'))
  })

  test('a finance_* type is shown or routine', () => {
    const decided = new Set<string>([...FINANCE_NOTIFICATION_TYPES, ...FINANCE_ROUTINE_NOTIFICATION_TYPES])
    for (const t of enumValues) if (t.startsWith('finance_')) assert.ok(decided.has(t), `${t} is undecided`)
  })

  test('an order_* / pi_* type is shown or routine', () => {
    const decided = new Set<string>([...ORDER_NOTIFICATION_TYPES, ...ORDER_ROUTINE_NOTIFICATION_TYPES])
    for (const t of enumValues) if (/^(order_|pi_)/.test(t)) assert.ok(decided.has(t), `${t} is undecided`)
  })
})

describe('the inbox reads the shown list only', () => {
  test('the Finance and Orders filters select exactly the shown types', () => {
    assert.deepEqual(sorted(typesIn(getNotificationCategoryFilter('finance'))), sorted(FINANCE_NOTIFICATION_TYPES))
    assert.deepEqual(sorted(typesIn(getNotificationCategoryFilter('order'))), sorted(ORDER_NOTIFICATION_TYPES))
  })

  test('neither filter names a routine type', () => {
    const finance = typesIn(getNotificationCategoryFilter('finance'))
    const order = typesIn(getNotificationCategoryFilter('order'))
    for (const t of FINANCE_ROUTINE_NOTIFICATION_TYPES) assert.equal(finance.includes(t), false, t)
    for (const t of ORDER_ROUTINE_NOTIFICATION_TYPES) assert.equal(order.includes(t), false, t)
  })
})

describe('phone alerts follow the same split', () => {
  test('a routine type gets no push, a shown type does', () => {
    for (const t of FINANCE_ROUTINE_NOTIFICATION_TYPES) assert.equal(pushCategoryFor({ task_id: null, type: t }), null, t)
    for (const t of ORDER_ROUTINE_NOTIFICATION_TYPES) assert.equal(pushCategoryFor({ task_id: null, type: t }), null, t)
    for (const t of FINANCE_NOTIFICATION_TYPES) assert.equal(pushCategoryFor({ task_id: null, type: t }), 'finance', t)
    for (const t of ORDER_NOTIFICATION_TYPES) assert.equal(pushCategoryFor({ task_id: null, type: t }), 'order', t)
  })
})

describe('the "New update" mark on Confirmed Orders is untouched', () => {
  test('it still reads status, amended, production and payment rows by type', () => {
    for (const t of ['order_update_status', 'order_update_amended', 'order_update_production', 'order_update_payment']) {
      assert.ok(ORDER_UNREAD_TYPES.includes(t), `${t} must stay in ORDER_UNREAD_TYPES`)
    }
  })

  test('amended, production and payment are routine, so they are hidden from the inbox but still counted by the mark', () => {
    for (const t of ['order_update_amended', 'order_update_production', 'order_update_payment']) {
      assert.ok((ORDER_ROUTINE_NOTIFICATION_TYPES as readonly string[]).includes(t), t)
    }
  })
})

describe('the one-line note', () => {
  test('exists for Orders and Finance only, and points at a same-origin page', () => {
    assert.deepEqual(Object.keys(MAJOR_ONLY_NOTE).sort(), ['finance', 'order'])
    for (const note of Object.values(MAJOR_ONLY_NOTE)) {
      assert.ok(note.text.startsWith('Major activity only.'))
      assert.ok(note.href.startsWith('/') && !note.href.startsWith('//'))
      assert.ok(note.linkLabel.length > 0)
    }
  })

  test('the inbox view renders it above the list, through AppLink', () => {
    const view = readFileSync('src/components/notifications/NotificationsView.tsx', 'utf8')
    assert.ok(view.includes('MAJOR_ONLY_NOTE[category]'))
    assert.ok(view.includes('data-testid="major-only-note"'))
    assert.ok(view.indexOf('major-only-note') < view.indexOf('<NotificationListSkeleton />'),
      'the note must come before the list so it shows while loading and when empty')
    assert.match(view, /<AppLink\s/)
  })
})
