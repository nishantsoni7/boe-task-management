/**
 * SENDING A PI BACK TO THE SALESPERSON WITH A COMMENT (20270619000000).
 *
 * The migration is read as text here (supabase/tests/order_handoff_send_to_sales_pglite.mjs
 * executes it), and the pure rules the page uses are exercised directly.
 *
 * Run:
 *   npx tsx --test src/lib/orders/operationsHandoffSendBack.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORDER_OPERATIONS_HANDOFF_COLUMNS,
  OPERATIONS_HANDOFF_EVENT_LABEL,
  OPERATIONS_HANDOFF_EVENT_TONE,
  SEND_BACK_AGAIN_LABEL,
  SEND_BACK_BUTTON_LABEL,
  canSendBackToSales,
  describeHandoffFailure,
  describeOperationsHandoffEvent,
  latestSentToSales,
  sentBackLine,
  validateSendBackComment,
} from './operationsHandoff'
import { orderAttentionItems } from './orderWorkspace'
import { getNotificationMeta } from '@/lib/notificationMeta'
import type { Notification } from '@/lib/types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/20270619000000_order_handoff_send_to_sales.sql'), 'utf8')
const CODE = SQL.replace(/--[^\n]*/g, '')

describe('the migration', () => {
  test('is additive: one function, no table or column change', () => {
    assert.equal((SQL.match(/create or replace function/g) ?? []).length, 1)
    assert.equal(/alter table|create table|drop |truncate|delete from|alter type/i.test(CODE), false)
  })

  test('the function is a pinned SECURITY DEFINER, executable by signed-in users only', () => {
    assert.match(SQL, /security definer\s+set search_path = public, pg_temp/)
    assert.match(SQL, /revoke execute on function public\.send_order_handoff_to_sales\(uuid, text\) from public, anon;/)
    assert.match(SQL, /grant\s+execute on function public\.send_order_handoff_to_sales\(uuid, text\) to authenticated;/)
  })

  test('authority is an approver or administrator who can open the Order; state is checked', () => {
    assert.match(SQL, /public\.actor_has_module_permission\('orders', 'approve_order'\)/)
    assert.match(SQL, /public\.can_read_order_detail\(v_h\.order_id\)/)
    for (const marker of ['SEND_BACK_COMMENT_REQUIRED', 'SEND_BACK_COMMENT_TOO_LONG', 'SEND_BACK_NO_SALESPERSON', 'CLOSED', 'SUPERSEDED', 'ALREADY_ACCEPTED', 'NOT_FOUND']) {
      assert.ok(SQL.includes(`ORDER_OPERATIONS_HANDOFF_${marker}`), marker)
    }
  })

  test('it changes nothing about the handoff, the PI, the Order or its alignment', () => {
    assert.equal(/update\s+public\./i.test(CODE), false, 'no update statement at all')
    assert.equal(/insert\s+into\s+public\.(?!order_activity_log)/i.test(CODE), false, 'the only insert is the history entry')
  })

  test('the history carries the comment and the notice goes through the one Orders helper with an existing type', () => {
    assert.match(SQL, /'operations_handoff_sent_to_sales'/)
    assert.match(SQL, /public\.order_notify_users\(\s+v_recipients, v_actor, v_h\.order_id, 'order_operations_review_decided'/)
    assert.equal(/insert\s+into\s+public\.notifications/i.test(CODE), false)
  })

  test('the page does NOT depend on the migration for what it reads: the handoff columns are unchanged', () => {
    assert.equal(ORDER_OPERATIONS_HANDOFF_COLUMNS.includes('comment'), false)
    assert.equal(ORDER_OPERATIONS_HANDOFF_COLUMNS.split(', ').length, 25)
  })
})

describe('the rules the page uses', () => {
  const awaiting = { status: 'awaiting' as const, superseded_at: null }
  const ok = { handoff: awaiting, orderStatus: 'running', maySend: true, viewingAs: false }

  test('offered on a live version that is flagged or waiting, to an approver or administrator, never under View As', () => {
    assert.equal(canSendBackToSales(ok), true)
    assert.equal(canSendBackToSales({ ...ok, handoff: { status: 'clarification_needed', superseded_at: null } }), true)
    assert.equal(canSendBackToSales({ ...ok, maySend: false }), false)
    assert.equal(canSendBackToSales({ ...ok, viewingAs: true }), false)
    assert.equal(canSendBackToSales({ ...ok, orderStatus: 'cancelled' }), false)
    assert.equal(canSendBackToSales({ ...ok, handoff: { status: 'accepted', superseded_at: null } }), false)
    assert.equal(canSendBackToSales({ ...ok, handoff: { ...awaiting, superseded_at: '2026-11-12T00:00:00Z' } }), false)
    assert.equal(canSendBackToSales({ ...ok, handoff: null }), false)
  })

  test('the comment is required and capped at 1000 characters', () => {
    assert.equal(validateSendBackComment('   ').ok, false)
    assert.deepEqual(validateSendBackComment('  Please revise the price.  '), { ok: true, comment: 'Please revise the price.' })
    assert.equal(validateSendBackComment('x'.repeat(1001)).ok, false)
    assert.equal(validateSendBackComment('x'.repeat(1000)).ok, true)
  })

  const e = (handoff: string, comment: string, at: string, who?: string) =>
    ({ event_type: 'operations_handoff_sent_to_sales', payload: { handoff_id: handoff, comment }, created_at: at, actor_name: who })

  test('the comment is read from the Order history: this handoff only, newest first', () => {
    const rows = [
      e('h1', 'older', '2026-11-12T10:00:00Z', 'Nishant'),
      e('h1', 'newer', '2026-11-12T11:00:00Z', 'Meera'),
      e('h2', "someone else's handoff", '2026-11-12T12:00:00Z'),
      { event_type: 'operations_handoff_clarification_needed', payload: { handoff_id: 'h1', comment: 'not a send-back' }, created_at: '2026-11-12T13:00:00Z' },
    ]
    assert.deepEqual(latestSentToSales(rows, 'h1'), { by: 'Meera', atIso: '2026-11-12T11:00:00Z', text: 'newer' })
    assert.equal(latestSentToSales(rows, 'h3'), null)
    assert.equal(latestSentToSales([], 'h1'), null)
  })

  test('the strip says who sent it back, when, and the comment', () => {
    const when = (iso: string | null) => (iso ? '12 Nov, 3:40 pm' : '—')
    assert.deepEqual(sentBackLine({ by: 'Nishant', atIso: '2026-11-12T10:10:00Z', text: 'Revise the price.' }, when, 'Ashok Choudhary'),
      { head: 'Sent back to Ashok Choudhary · 12 Nov, 3:40 pm · by Nishant', comment: 'Revise the price.' })
    assert.deepEqual(sentBackLine({ by: null, atIso: '2026-11-12T10:10:00Z', text: 'x' }, when, null),
      { head: 'Sent back to the salesperson · 12 Nov, 3:40 pm', comment: 'x' })
    assert.equal(sentBackLine(null, when, 'Ashok Choudhary'), null)
  })

  test('once a comment has gone the button says so and offers another', () => {
    assert.equal(SEND_BACK_AGAIN_LABEL, 'Send another comment')
    assert.notEqual(SEND_BACK_AGAIN_LABEL, SEND_BACK_BUTTON_LABEL)
  })

  test('the strip keeps Operations\' reason as it is and gives the send-back its OWN line, flagged or waiting', () => {
    const base = {
      status: 'open', productionAligned: false, hasSalesperson: true, hasDueDate: true, hasLeadSource: true, isOverdue: false,
      awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
    }
    const find = (r: Parameters<typeof orderAttentionItems>[0]['operationsReview']) =>
      orderAttentionItems({ ...base, operationsReview: r } as Parameters<typeof orderAttentionItems>[0]).find(i => i.key === 'operations_review')
    const sent = { head: 'Sent back to Ashok · 6:04 pm', comment: 'Revise it.' }
    const flagged = find({ versionNumber: 1, status: 'clarification_needed', unassigned: false, reasonLine: 'Price is low.', sentBack: sent })
    assert.equal(flagged?.detail, 'Price is low.')
    assert.deepEqual(flagged?.sent, sent)
    const waiting = find({ versionNumber: 1, status: 'awaiting', unassigned: false, sentBack: sent })
    assert.equal(waiting?.detail, 'Operations has not accepted this PI version yet.')
    assert.deepEqual(waiting?.sent, sent)
    const none = find({ versionNumber: 1, status: 'awaiting', unassigned: false })
    assert.equal(none?.detail, 'Operations has not accepted this PI version yet.')
    assert.equal(none?.sent, undefined)
  })

  test('the history says it in words', () => {
    assert.equal(OPERATIONS_HANDOFF_EVENT_LABEL.operations_handoff_sent_to_sales, 'The approver sent it to the salesperson')
    assert.equal(OPERATIONS_HANDOFF_EVENT_TONE.operations_handoff_sent_to_sales, 'amber')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_sent_to_sales', { version_number: 1, comment: 'Revise the price.' }), 'PI V1 · Revise the price.')
  })

  test('the database refusals are said in words', () => {
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_SEND_BACK_COMMENT_REQUIRED: x' }), /comment/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_SEND_BACK_NO_SALESPERSON: Order 0547' }), /no other active salesperson/)
    assert.match(describeHandoffFailure({ message: 'Only an administrator or a PI approver can send a PI back to the salesperson' }), /PI approver/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED: PI V1' }), /already accepted/)
  })
})

describe('the notice', () => {
  const notice = (title: string): Notification => ({
    id: 'n1', user_id: 'u1', task_id: null, entity_id: 'order-1', type: 'order_operations_review_decided',
    title, body: 'Revise the price.', is_read: false, created_at: '2026-11-12T10:10:00Z',
  } as unknown as Notification)

  test('is badged "Returned to Sales" and opens the Order at the Operations strip', () => {
    const m = getNotificationMeta(notice('Order 0547: Nishant sent PI V1 back to you.'))
    assert.equal(m.badge.label, 'Returned to Sales')
    assert.equal(m.href, '/orders/order-1#operations-review')
  })

  test('Operations\' own decision keeps its badge', () => {
    const m = getNotificationMeta(notice('Order 0547: Operations asked for clarification on PI V1.'))
    assert.equal(m.badge.label, 'Operations decided')
  })
})
