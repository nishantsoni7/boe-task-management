// THE PI REVIEW CHAIN (owner, 2026-11-14, Order 547): every hop between Operations and Sales passes through the
// approver, who decides whether to pass it on or send it back, and every round is tracked.
//
// The migration (20270718000000) is read as text here and EXECUTED by supabase/tests/order_handoff_review_chain_pglite.mjs
// (24 checks, not part of npm test); the pure rules the screens use are exercised directly.
//
// Run with: npm run test:file -- src/lib/orders/operationsHandoffChain.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlaggedPiStripView } from '@/components/orders/dashboard/FlaggedPiStrip'
import { flaggedCard } from '@/lib/modules/forYouWork'
import {
  FORWARD_NOTE_REQUIRED,
  OPERATIONS_HANDOFF_EVENT_LABEL,
  canForwardToOperations,
  chainHolderOf,
  chainRoundOf,
  describeHandoffFailure,
  describeOperationsHandoffEvent,
  latestReturnedToOperations,
  validateForwardNote,
} from './operationsHandoff'
import { flaggedRow } from './adminDashboard'
import { SALES_REPLIED_ROW_LABEL, readFlaggedPis, type FlaggedPi } from './flaggedPis'
import { orderAttentionItems } from './orderWorkspace'
import { buildReviewThread } from './piReviewThread'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20270718000000_order_handoff_review_chain.sql')
const code = SQL.replace(/--[^\n]*/g, '')
const fn = (name: string) => {
  const from = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(from >= 0, `${name} is in the migration`)
  const next = code.indexOf('create or replace function', from + 10)
  return code.slice(from, next < 0 ? undefined : next)
}

describe('the migration', () => {
  test('adds three columns and one trigger, moves nothing destructively', () => {
    assert.match(code, /add column if not exists chain_holder text default 'operations'/)
    assert.match(code, /add column if not exists chain_since\s+timestamptz not null default now\(\)/)
    assert.match(code, /add column if not exists chain_round\s+integer not null default 0/)
    assert.match(code, /create trigger order_operations_handoffs_chain_sync\s+before update on public\.order_operations_handoffs/)
    assert.equal(/drop table|drop column|truncate|delete from/i.test(code), false)
  })

  test('every function is a pinned SECURITY DEFINER; the doors are for signed-in users only, the helper for nobody', () => {
    assert.equal((code.match(/security definer\s+set search_path = public, pg_temp/g) ?? []).length, 7)
    for (const sig of ['forward_order_handoff_to_operations(uuid, text)', 'respond_order_handoff_clarification(uuid, text)', 'send_order_handoff_to_sales(uuid, text)']) {
      const esc = sig.replace(/[()]/g, '\\$&')
      assert.match(code, new RegExp(`revoke execute on function public\\.${esc} from public, anon;`), sig)
      assert.match(code, new RegExp(`grant\\s+execute on function public\\.${esc} to authenticated;`), sig)
    }
    assert.match(code, /revoke all on function public\.order_chain_coordinators\(\) from public, anon, authenticated;/)
  })

  test('the salesperson\'s reply goes to the APPROVER: it needs Sales to hold it, the handoff stays flagged, Operations is not told', () => {
    const body = fn('respond_order_handoff_clarification')
    assert.match(body, /ORDER_OPERATIONS_HANDOFF_NOT_WITH_SALES/)
    assert.match(body, /v_h\.chain_holder is distinct from 'sales'/)
    assert.match(body, /chain_holder = 'coordinator'/)
    assert.equal(/status\s*=\s*'awaiting'/.test(body), false, 'the reply never puts the handoff back to awaiting')
    assert.equal(/order_operations_review_requested|array\[v_h\.assigned_to\]/.test(body), false, 'Operations is not notified by the reply')
    assert.match(body, /perform public\.order_notify_users\(\s+public\.order_chain_coordinators\(\)/)
    assert.match(body, /public\.can_propose_order_pi_edit\(v_h\.order_id\)/)
  })

  test('Operations\' flag tells the approvers, never the salesperson; an acceptance still tells the salesperson', () => {
    const body = fn('order_operations_handoff_notify')
    assert.match(body, /if new\.status = 'accepted' then\s+perform public\.order_notify_users\(\s+array\[v_order\.assigned_to\]/)
    assert.match(body, /else\s+perform public\.order_notify_users\(\s+array_remove\(public\.order_chain_coordinators\(\), new\.approved_by\)/)
    assert.equal((body.match(/array\[v_order\.assigned_to\]/g) ?? []).length, 1, 'the salesperson appears once: the acceptance')
  })

  test('forwarding needs an approver, takes the locks in the order decide uses, and tells the reviewer through the helper', () => {
    const body = fn('forward_order_handoff_to_operations')
    assert.match(body, /actor_has_module_permission\('orders', 'approve_order'\)/)
    assert.match(body, /from public\.order_operations_reviewers where duty = 'pi_handoff' for share;[\s\S]*from public\.orders where id = v_order_id for update;[\s\S]*from public\.order_operations_handoffs where id = p_handoff_id for update;/)
    for (const marker of ['NOT_FOUND', 'CLOSED', 'SUPERSEDED', 'ALREADY_ACCEPTED', 'STALE', 'ALREADY_WITH_OPERATIONS', 'FORWARD_NOTE_REQUIRED', 'FORWARD_NOTE_TOO_LONG']) {
      assert.ok(body.includes(`ORDER_OPERATIONS_HANDOFF_${marker}`), marker)
    }
    assert.match(body, /perform public\.order_notify_users\(\s+array\[v_h\.assigned_to\], v_actor, v_h\.order_id, 'order_operations_review_requested'/)
    assert.match(body, /'operations_handoff_returned_to_operations'/)
  })

  test('sending to Sales also marks Sales as the holder', () => {
    assert.match(fn('send_order_handoff_to_sales'), /update public\.order_operations_handoffs set chain_holder = 'sales' where id = v_h\.id;/)
  })

  test('the list shows the salesperson ONLY what the approver sent them, and an approver everything', () => {
    const body = fn('my_flagged_pis')
    assert.match(body, /and \(v_coord\s+or \(h\.chain_holder = 'sales' and public\.can_propose_order_pi_edit\(h\.order_id\)\)\)/)
    assert.match(body, /'holder',\s+h\.chain_holder/)
    assert.match(body, /'round',\s+h\.chain_round/)
  })

  test('no function writes a raw notification: everything goes through the one Orders helper', () => {
    assert.equal(/insert\s+into\s+public\.notifications/i.test(code), false)
  })

  test('the page does NOT read the chain columns from order_page_bundle: its handoff read is unchanged', () => {
    const cols = read('src/lib/orders/operationsHandoff.ts')
    assert.equal(/ORDER_OPERATIONS_HANDOFF_COLUMNS = \[[\s\S]*chain_holder[\s\S]*\]\.join/.test(cols), false)
  })
})

// ── Who holds it ───────────────────────────────────────────────────────────────

const H = 'h1'
const live = (over: Record<string, unknown> = {}) => ({
  id: H, status: 'awaiting' as 'awaiting' | 'clarification_needed' | 'accepted', superseded_at: null as string | null,
  clarification_at: null as string | null, created_at: '2026-11-10T10:00:00Z', ...over,
})
const ev = (event_type: string, created_at: string, payload: Record<string, unknown> = {}) => ({ event_type, payload: { handoff_id: H, ...payload }, created_at })

describe('who holds the version (the page derives it by the rule the database stores)', () => {
  const FLAG = '2026-11-11T10:00:00Z', SENT = '2026-11-12T10:00:00Z', REPLY = '2026-11-13T10:00:00Z', PASS = '2026-11-13T12:00:00Z'
  const flagged = (at = FLAG) => live({ status: 'clarification_needed', clarification_at: at })

  test('Operations reviewing: Operations. Flagged: the approver. Sent to Sales: Sales. Replied: the approver again', () => {
    assert.equal(chainHolderOf({ live: live(), history: [] }), 'operations')
    assert.equal(chainHolderOf({ live: flagged(), history: [] }), 'coordinator')
    assert.equal(chainHolderOf({ live: flagged(), history: [ev('operations_handoff_sent_to_sales', SENT)] }), 'sales')
    assert.equal(chainHolderOf({ live: flagged(), history: [ev('operations_handoff_sent_to_sales', SENT), ev('operations_handoff_clarification_answered', REPLY)] }), 'coordinator')
  })

  test('the approver passes it on: Operations. Operations flags again: the approver', () => {
    const history = [ev('operations_handoff_sent_to_sales', SENT), ev('operations_handoff_clarification_answered', REPLY), ev('operations_handoff_returned_to_operations', PASS)]
    assert.equal(chainHolderOf({ live: live({ clarification_at: FLAG }), history }), 'operations')
    assert.equal(chainHolderOf({ live: flagged('2026-11-14T09:00:00Z'), history }), 'coordinator', 'a newer flag wins')
  })

  test('sent to Sales before Operations decided: Sales; flagged while with Sales: the approver', () => {
    assert.equal(chainHolderOf({ live: live(), history: [ev('operations_handoff_sent_to_sales', SENT)] }), 'sales')
    assert.equal(chainHolderOf({ live: flagged('2026-11-13T00:00:00Z'), history: [ev('operations_handoff_sent_to_sales', SENT)] }), 'coordinator')
  })

  test('Order 547\'s state (answered under the old door, back to awaiting): Operations', () => {
    const history = [ev('operations_handoff_sent_to_sales', SENT), ev('operations_handoff_clarification_answered', '2026-11-14T07:14:00Z')]
    assert.equal(chainHolderOf({ live: live({ clarification_at: FLAG }), history }), 'operations')
  })

  test('nobody holds an accepted or replaced version; another handoff\'s events do not count', () => {
    assert.equal(chainHolderOf({ live: live({ status: 'accepted' }), history: [] }), null)
    assert.equal(chainHolderOf({ live: live({ superseded_at: '2026-11-14T00:00:00Z' }), history: [] }), null)
    assert.equal(chainHolderOf({ live: null, history: [] }), null)
    assert.equal(chainHolderOf({ live: flagged(), history: [{ ...ev('operations_handoff_sent_to_sales', SENT), payload: { handoff_id: 'other' } }] }), 'coordinator')
  })

  test('the round is how many times Operations flagged THIS version (a withdrawn acceptance counts)', () => {
    const history = [
      ev('operations_handoff_clarification_needed', FLAG), ev('operations_handoff_acceptance_withdrawn', REPLY),
      ev('operations_handoff_sent_to_sales', SENT), { ...ev('operations_handoff_clarification_needed', FLAG), payload: { handoff_id: 'other' } },
    ]
    assert.equal(chainRoundOf(history, H), 2)
    assert.equal(chainRoundOf(history, null), 0)
    assert.equal(chainRoundOf([], H), 0)
  })
})

// ── Passing it on to Operations ────────────────────────────────────────────────

describe('passing it on to Operations', () => {
  const ok = { handoff: { status: 'clarification_needed' as const, superseded_at: null }, holder: 'coordinator' as const, orderStatus: 'running', mayForward: true, viewingAs: false }

  test('offered to an approver while the approver or Sales holds the live version; never otherwise', () => {
    assert.equal(canForwardToOperations(ok), true)
    assert.equal(canForwardToOperations({ ...ok, holder: 'sales' }), true, 'taking it back from Sales')
    assert.equal(canForwardToOperations({ ...ok, handoff: { status: 'awaiting', superseded_at: null } }), true)
    assert.equal(canForwardToOperations({ ...ok, holder: 'operations' }), false, 'already with Operations')
    assert.equal(canForwardToOperations({ ...ok, holder: null }), false)
    assert.equal(canForwardToOperations({ ...ok, mayForward: false }), false)
    assert.equal(canForwardToOperations({ ...ok, viewingAs: true }), false)
    assert.equal(canForwardToOperations({ ...ok, orderStatus: 'cancelled' }), false)
    assert.equal(canForwardToOperations({ ...ok, handoff: { status: 'accepted', superseded_at: null } }), false)
    assert.equal(canForwardToOperations({ ...ok, handoff: { status: 'clarification_needed', superseded_at: '2026-11-14T00:00:00Z' } }), false)
    assert.equal(canForwardToOperations({ ...ok, handoff: null }), false)
  })

  test('the note is required unless the salesperson\'s reply is what is being passed on', () => {
    assert.deepEqual(validateForwardNote('   ', false), { ok: false, message: FORWARD_NOTE_REQUIRED })
    assert.deepEqual(validateForwardNote('  The rates are right.  ', false), { ok: true, note: 'The rates are right.' })
    assert.deepEqual(validateForwardNote('', true), { ok: true, note: null })
    assert.equal(validateForwardNote('x'.repeat(1001), true).ok, false)
    assert.equal(validateForwardNote('x'.repeat(1000), false).ok, true)
  })

  test('the newest pass-on for THIS handoff is read from the history', () => {
    const rows = [
      { ...ev('operations_handoff_returned_to_operations', '2026-11-14T10:00:00Z', { note: 'older' }), actor_name: 'Nishant Soni' },
      { ...ev('operations_handoff_returned_to_operations', '2026-11-14T11:00:00Z', { note: ' newer ', reply_forwarded: true }), actor_name: 'Nishant Soni' },
      { ...ev('operations_handoff_returned_to_operations', '2026-11-14T12:00:00Z', { note: 'other' }), payload: { handoff_id: 'other', note: 'other' } },
    ]
    assert.deepEqual(latestReturnedToOperations(rows, H), { by: 'Nishant Soni', atIso: '2026-11-14T11:00:00Z', note: 'newer', replyForwarded: true })
    assert.equal(latestReturnedToOperations(rows, 'nope'), null)
  })

  test('the database refusals are said in words', () => {
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_NOT_WITH_SALES: PI V1' }), /not with Sales/)
    assert.match(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_ALREADY_WITH_OPERATIONS: PI V1' }), /already with Operations/)
    assert.equal(describeHandoffFailure({ message: 'ORDER_OPERATIONS_HANDOFF_FORWARD_NOTE_REQUIRED: say why' }), FORWARD_NOTE_REQUIRED)
    assert.match(describeHandoffFailure({ message: 'Only an administrator or a PI approver can pass a PI on to Operations' }), /can pass a PI on to Operations/)
    assert.match(describeHandoffFailure({ message: 'Only the person who owns this PI, or an administrator, can reply on it' }), /can reply on it/)
  })

  test('the history says each hop in words', () => {
    assert.equal(OPERATIONS_HANDOFF_EVENT_LABEL.operations_handoff_returned_to_operations, 'The approver passed it to Operations')
    assert.equal(OPERATIONS_HANDOFF_EVENT_LABEL.operations_handoff_clarification_answered, 'The salesperson replied to the approver')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_returned_to_operations', { version_number: 1, reply_forwarded: true, note: 'Please accept.' }),
      'PI V1 · with the salesperson’s reply · Please accept.')
    assert.equal(describeOperationsHandoffEvent('operations_handoff_clarification_answered', { version_number: 1, response: 'Fixed.' }), 'PI V1 · Fixed.')
  })
})

// ── The thread ─────────────────────────────────────────────────────────────────

describe('the review thread', () => {
  const rows = [
    { ...ev('operations_handoff_recorded', '2026-11-10T10:00:00Z', { version_number: 1 }), actor_name: 'Nishant Soni' },
    { ...ev('operations_handoff_clarification_needed', '2026-11-11T10:00:00Z', { version_number: 1, reason: 'Rates look low' }), actor_name: 'Nitish Bansal' },
    { ...ev('operations_handoff_sent_to_sales', '2026-11-12T10:00:00Z', { version_number: 1, comment: 'Check and resubmit' }), actor_name: 'Nishant Soni' },
    { ...ev('operations_handoff_clarification_answered', '2026-11-13T10:00:00Z', { version_number: 1, response: 'Revised the rates' }), actor_name: 'Ashok Choudhary' },
    { ...ev('operations_handoff_returned_to_operations', '2026-11-13T12:00:00Z', { version_number: 1, reply_forwarded: true }), actor_name: 'Nishant Soni' },
    { ...ev('operations_handoff_clarification_needed', '2026-11-14T10:00:00Z', { version_number: 1, reason: 'Still not aligned' }), actor_name: 'Nitish Bansal' },
    { event_type: 'order_status_changed', payload: {}, created_at: '2026-11-14T11:00:00Z' },
  ]

  test('every hop in order, numbered by round; events that are not part of the loop are left out', () => {
    const t = buildReviewThread([...rows].reverse())
    assert.equal(t.rounds, 2)
    assert.deepEqual(t.entries.map(e => [e.kind, e.round]), [
      ['sent_for_review', 0], ['flagged', 1], ['sent_to_sales', 1], ['reply', 1], ['passed_to_operations', 1], ['flagged', 2],
    ])
    assert.equal(t.entries[1].title, 'Nitish Bansal cannot accept PI V1')
    assert.equal(t.entries[1].text, 'Rates look low')
    assert.equal(t.entries[3].title, 'Ashok Choudhary replied to the approver: PI unchanged')
    assert.equal(t.entries[4].title, 'Nishant Soni passed PI V1 to Operations with the reply')
    assert.equal(t.entries[4].text, null)
  })

  test('a round is counted per version; no flag means no loop', () => {
    assert.equal(buildReviewThread(rows.slice(0, 1)).rounds, 0)
    assert.equal(buildReviewThread([]).rounds, 0)
  })
})

// ── The screens ────────────────────────────────────────────────────────────────

const raw = (over: Record<string, unknown> = {}) => ({
  handoff_id: 'h-547', order_id: 'o-547', order_number: '0547', client_name: 'Suresh Ji', version_number: 1, reason: 'Rates look low',
  by_name: 'Nitish Bansal', since: '2026-11-11T10:00:00Z', waiting_seconds: 3600, ...over,
})
const rowOf = (over: Record<string, unknown> = {}): FlaggedPi => readFlaggedPis([raw(over)])[0]

describe('the flagged list and the dashboards', () => {
  test('the chain fields are read; a database without them reads as before (no holder, it waits on the reader)', () => {
    const r = rowOf({ holder: 'coordinator', mine: false, round: 2, holder_since: '2026-11-12T10:00:00Z', reply: ' Fixed ', reply_by_name: 'Ashok Choudhary', reply_at: '2026-11-13T10:00:00Z' })
    assert.deepEqual({ h: r.holder, m: r.mine, n: r.round, s: r.holderSince, r: r.reply, b: r.replyByName }, { h: 'coordinator', m: false, n: 2, s: '2026-11-12T10:00:00Z', r: 'Fixed', b: 'Ashok Choudhary' })
    const old = rowOf()
    assert.deepEqual({ h: old.holder, m: old.mine, n: old.round, r: old.reply }, { h: null, m: true, n: 0, r: null })
  })

  test('the approver\'s row says who holds it: flagged, replied (with the reply), with Sales; and the round from the second on', () => {
    const flagged = flaggedRow(rowOf({ holder: 'coordinator', mine: true }))
    assert.equal(flagged.chip?.tone, 'danger')
    assert.equal(flagged.ref, 'Order 547 · PI V1')
    const replied = flaggedRow(rowOf({ holder: 'coordinator', mine: true, round: 2, reply: 'Revised the rates', reply_by_name: 'Ashok Choudhary' }))
    assert.equal(replied.chip?.label, SALES_REPLIED_ROW_LABEL)
    assert.equal(replied.chip?.tone, 'warn')
    assert.match(replied.chip?.sub ?? '', /Ashok Choudhary: “Revised the rates”/)
    assert.equal(replied.ref, 'Order 547 · PI V1 · Round 2')
    const withSales = flaggedRow(rowOf({ holder: 'sales', mine: false }), { by: 'Nishant Soni', atIso: '2026-11-12T10:00:00Z', text: 'Check and resubmit' })
    assert.equal(withSales.chip?.tone, 'info')
    assert.match(withSales.chip?.sub ?? '', /Nishant Soni: “Check and resubmit”/)
  })

  test('the salesperson\'s strip draws only what waits on them, titled as sent back to them; nothing when none does', () => {
    const state = (rows: FlaggedPi[]) => ({ kind: 'ready' as const, rows })
    const mine = rowOf({ holder: 'sales', mine: true })
    const watch = rowOf({ handoff_id: 'h-2', order_id: 'o-2', order_number: '0548', client_name: 'Other Client', holder: 'coordinator', mine: false })
    const out = renderToStaticMarkup(createElement(FlaggedPiStripView, { state: state([mine, watch]) }))
    assert.match(out, /1 PI sent back to you/)
    assert.match(out, /Suresh Ji/)
    assert.doesNotMatch(out, /Other Client/)
    assert.equal(renderToStaticMarkup(createElement(FlaggedPiStripView, { state: state([watch]) })), '')
  })

  test('the For you card is the reader\'s own work: reply for Sales, decide or forward for the approver', () => {
    assert.equal(flaggedCard(rowOf({ holder: 'sales', mine: true })).action, 'Reply')
    assert.equal(flaggedCard(rowOf({ holder: 'coordinator', mine: true })).action, 'Decide')
    const replied = flaggedCard(rowOf({ holder: 'coordinator', mine: true, reply: 'Revised the rates', reply_by_name: 'Ashok Choudhary' }))
    assert.equal(replied.action, 'Forward')
    assert.match(replied.label, /^Sales replied on a flagged PI · /)
    assert.match(replied.detail, /Ashok Choudhary: “Revised the rates”/)
    assert.equal(flaggedCard(rowOf()).action, 'Respond', 'a database without the chain keeps the earlier word')
    const hook = read('src/hooks/queries/useForYouWork.ts')
    assert.match(hook, /\(flagged\.data\?\.rows \?\? \[\]\)\.filter\(r => r\.mine\)\.map\(flaggedCard\)/)
  })

  test('the Order banner says Sales replied, and the round once there is a loop', () => {
    const item = (over: Record<string, unknown>) => orderAttentionItems({
      status: 'running', productionAligned: false, hasSalesperson: true, hasDueDate: true, hasLeadSource: true, isOverdue: false,
      awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
      operationsReview: { versionNumber: 1, status: 'clarification_needed', unassigned: false, ...over },
    } as Parameters<typeof orderAttentionItems>[0]).find(i => i.key === 'operations_review')
    assert.equal(item({})?.title, 'PI V1 flagged by operations')
    assert.equal(item({ replied: true })?.title, 'PI V1 flagged by operations: Sales replied, waiting for the approver')
    assert.equal(item({ replied: true, round: 2 })?.title, 'PI V1 flagged by operations: Sales replied, waiting for the approver · Round 2')
    assert.equal(item({ returned: 'with_sales', round: 3 })?.title, 'PI V1 returned to Sales · Round 3')
  })
})

describe('where the Order page uses it', () => {
  const page = read('src/app/orders/[id]/page.tsx')

  test('the reply button needs the holder; the approver gets Forward / Return to Operations and the thread is drawn', () => {
    assert.match(page, /const respondOffered = operationsReviewOpen && canRespondToHandoff\(\{\s+handoff: splitOperationsHandoffs\(handoffs\)\.live,\s+holder: chainHolder,/)
    assert.match(page, /const forwardOffered = operationsReviewOpen && canForwardToOperations\(\{[\s\S]*?mayForward: actingAsAdmin \|\| mayDecidePiAsAdmin,/)
    assert.match(page, /supabase\.rpc\('forward_order_handoff_to_operations', \{\s+p_handoff_id: live\.id,\s+p_note: note,/)
    assert.match(page, /<ForwardToOperationsModal[\s\S]*?onConfirm=\{note => forwardToOperations\(note\)\}/)
    assert.match(page, /<PiReviewThread\s+entries=\{reviewThread\.entries\}/)
    assert.match(page, /const salesReturn = salesReturnStage\(\{\s+live: operationsSplit\.live,\s+holder: chainHolder,/)
  })

  test('the queues read the stored holder, not the history', () => {
    assert.match(read('src/lib/orders/operationsHandoff.ts'), /export const QUEUE_HANDOFF_COLUMNS = 'id, order_id, status, assigned_to, chain_holder'/)
    assert.match(read('src/app/orders/all/page.tsx'), /setWithSalesOrders\(ordersWithSales\(rows\)\)/)
  })
})
