/**
 * RESPONDING TO OPERATIONS' OBJECTION WITH REMARKS ONLY (20270422000000).
 *
 * The migration is read as text (it cannot be executed without a database
 * stack), and the pure rules the page uses are exercised directly.
 *
 * Run:
 *   npx tsx --test src/lib/orders/operationsHandoffResponse.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORDER_OPERATIONS_HANDOFF_COLUMNS,
  answeredAfterObjection,
  latestHandoffAnswer,
  OPERATIONS_HANDOFF_EVENT_LABEL,
  canRespondToHandoff,
  describeHandoffFailure,
  validateHandoffResponse,
} from './operationsHandoff'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/20270422000000_order_handoff_clarification_response.sql'), 'utf8')

describe('the migration', () => {
  test('is additive: three nullable columns, one constraint, one function', () => {
    assert.match(SQL, /add column if not exists clarification_response\s+text/)
    assert.match(SQL, /add column if not exists clarification_responded_by uuid references public\.users\(id\) on delete set null/)
    assert.match(SQL, /add column if not exists clarification_responded_at timestamptz/)
    assert.match(SQL, /order_operations_handoffs_response_complete/)
    assert.equal((SQL.match(/create or replace function/g) ?? []).length, 1)
    assert.equal(/drop (table|column)|truncate|delete from/i.test(SQL.replace(/--[^\n]*/g, '')), false)
  })

  test('the function is a pinned SECURITY DEFINER, executable by signed-in users only', () => {
    assert.match(SQL, /security definer\s+set search_path = public, pg_temp/)
    assert.match(SQL, /revoke execute on function public\.respond_order_handoff_clarification\(uuid, text\) from public, anon;/)
    assert.match(SQL, /grant\s+execute on function public\.respond_order_handoff_clarification\(uuid, text\) to authenticated;/)
  })

  test('authority is the PI owner or an administrator — the Edit PI rule — and state is re-checked under locks', () => {
    assert.match(SQL, /public\.can_propose_order_pi_edit\(v_h\.order_id\)/)
    assert.match(SQL, /from public\.order_operations_reviewers where duty = 'pi_handoff' for share;[\s\S]*from public\.orders where id = v_order_id for update;[\s\S]*from public\.order_operations_handoffs where id = p_handoff_id for update;/)
    for (const marker of ['RESPONSE_REQUIRED', 'RESPONSE_TOO_LONG', 'CLOSED', 'SUPERSEDED', 'NOT_FLAGGED', 'STALE']) {
      assert.ok(SQL.includes(`ORDER_OPERATIONS_HANDOFF_${marker}`), marker)
    }
  })

  test('the flagged handoff returns to awaiting; the objection is kept; nothing else moves', () => {
    assert.match(SQL, /set status = 'awaiting',\s+clarification_response = v_remark,/)
    assert.equal(/clarification_reason\s*=/.test(SQL.replace(/--[^\n]*/g, '').replace(/'objection', v_h\.clarification_reason/g, '')), false,
      'the objection columns are never written here')
    assert.equal(/update public\.orders|order_operations_handoff_set_alignment/.test(SQL.replace(/--[^\n]*/g, '')), false,
      'the Order and its alignment are untouched')
    assert.equal(/order_pi_versions\s*\n?\s*set|insert into public\.order_pi_versions/.test(SQL), false, 'no new PI version')
  })

  test('the history records the answer and the reviewer is notified with the existing type', () => {
    assert.match(SQL, /'operations_handoff_clarification_answered'/)
    assert.ok(OPERATIONS_HANDOFF_EVENT_LABEL.operations_handoff_clarification_answered)
  })

  test('the page does NOT depend on the migration: its handoff read (pinned to order_page_bundle) is unchanged', () => {
    for (const c of ['clarification_response', 'clarification_responded_by', 'clarification_responded_at']) {
      assert.equal(ORDER_OPERATIONS_HANDOFF_COLUMNS.includes(c), false, c)
    }
  })

  test('the reviewer is told through the one Orders helper, not a raw insert', () => {
    assert.match(SQL, /perform public\.order_notify_users\(\s+array\[v_h\.assigned_to\], v_actor, v_h\.order_id, 'order_operations_review_requested'/)
    assert.equal(/insert\s+into\s+public\.notifications/i.test(SQL), false)
  })
})

describe('the rules the page uses', () => {
  const flagged = { status: 'clarification_needed' as const, superseded_at: null }

  test('the response is offered only on a live flagged version, to someone who may, never under View As', () => {
    const ok = { handoff: flagged, orderStatus: 'running', mayRespond: true, viewingAs: false }
    assert.equal(canRespondToHandoff(ok), true)
    assert.equal(canRespondToHandoff({ ...ok, mayRespond: false }), false)
    assert.equal(canRespondToHandoff({ ...ok, viewingAs: true }), false)
    assert.equal(canRespondToHandoff({ ...ok, orderStatus: 'cancelled' }), false)
    assert.equal(canRespondToHandoff({ ...ok, handoff: { status: 'awaiting', superseded_at: null } }), false)
    assert.equal(canRespondToHandoff({ ...ok, handoff: { status: 'accepted', superseded_at: null } }), false)
    assert.equal(canRespondToHandoff({ ...ok, handoff: { ...flagged, superseded_at: '2026-10-27T00:00:00Z' } }), false)
    assert.equal(canRespondToHandoff({ ...ok, handoff: null }), false)
  })

  test('remarks are required and capped at 1000 characters', () => {
    assert.equal(validateHandoffResponse('   ').ok, false)
    assert.deepEqual(validateHandoffResponse('  Thumbnail added.  '), { ok: true, remark: 'Thumbnail added.' })
    assert.equal(validateHandoffResponse('x'.repeat(1001)).ok, false)
    assert.equal(validateHandoffResponse('x'.repeat(1000)).ok, true)
  })

  test('an answer older than the latest objection is not shown as its answer', () => {
    assert.equal(answeredAfterObjection('2026-10-26T10:00:00Z', '2026-10-26T11:00:00Z'), true)
    assert.equal(answeredAfterObjection('2026-10-26T12:00:00Z', '2026-10-26T11:00:00Z'), false)
    assert.equal(answeredAfterObjection(null, '2026-10-26T11:00:00Z'), true)
  })

  test('the answer is read from the Order history: this handoff only, newest first', () => {
    const e = (handoff: string, response: string, at: string, who?: string) =>
      ({ event_type: 'operations_handoff_clarification_answered', payload: { handoff_id: handoff, response }, created_at: at, actor_name: who })
    const rows = [
      e('h1', 'older', '2026-10-26T10:00:00Z', 'Rohan'),
      e('h1', 'newer', '2026-10-26T11:00:00Z', 'Meera'),
      e('h2', "someone else's handoff", '2026-10-26T12:00:00Z'),
      { event_type: 'operations_handoff_clarification_needed', payload: { handoff_id: 'h1', response: 'not an answer' }, created_at: '2026-10-26T13:00:00Z' },
    ]
    assert.deepEqual(latestHandoffAnswer(rows, 'h1'), { by: 'Meera', atIso: '2026-10-26T11:00:00Z', text: 'newer' })
    assert.equal(latestHandoffAnswer(rows, 'h3'), null)
    assert.equal(latestHandoffAnswer([], 'h1'), null)
  })

  test('the database refusals are said in words', () => {
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_NOT_FLAGGED: PI V2' }), /not waiting for a response/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_RESPONSE_REQUIRED: x' }), /remarks/)
    assert.match(describeHandoffFailure({ message: 'Only the person who owns this PI, or an administrator, can respond to Operations' }), /owns this PI/)
  })
})
