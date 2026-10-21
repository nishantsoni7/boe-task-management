// THE OPERATIONS DASHBOARD (20270401000000).
//
// The database decides which lines of a revised PI changed and stores the answers
// (supabase/migrations/20270401000000_operations_dashboard.sql). These pin the other
// half: the page validates that answer, builds exactly the answers the database asks for,
// and an order already in production is never un-aligned by a change request.
//
// Run with: npx tsx --test "src/lib/orders/operationsDashboard.test.ts"

/* eslint-disable @typescript-eslint/no-explicit-any -- the malformed-payload cases reach into an untyped fixture on purpose */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyToAll,
  buildAnswers,
  describeAnswerFailure,
  dispatchGapNotes,
  emptyDraft,
  parseOperationsRead,
  responseSummary,
  responseTone,
  tally,
  ANSWER_FALLBACK,
  type ChangeLine,
} from './operationsDashboard'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')
const MIGRATION = 'supabase/migrations/20270401000000_operations_dashboard.sql'

const period = (o = 3, d = 2) => ({
  from: '2026-09-01', to: '2026-09-30',
  orders: { count: o, value: 1200000 }, dispatches: { count: d, value: 800000 },
})

const payload = (over: Record<string, unknown> = {}) => ({
  today: '2026-10-22',
  viewer: { is_reviewer: true, is_approver: false },
  pending_changes: [{
    handoff_id: 'h1', order_id: 'o1', display_number: '524', client_name: 'Acme',
    version_number: 2, approved_at: '2026-10-21T10:00:00Z', approved_by_name: 'Owner', revision_reason: 'Client wants 12',
    changes: {
      available: true,
      lines: [
        { key: 'item:B001', title: 'Chair (item B001)', kind: 'changed', changes: [{ label: 'Quantity', old: '10', new: '12' }] },
        { key: 'group:schedule', title: 'Dates', kind: 'changed', changes: [{ label: 'Due Date', old: '2026-11-01', new: null }] },
      ],
    },
  }],
  responses: [{
    handoff_id: 'h0', order_id: 'o0', display_number: '510', client_name: 'Beta', version_number: 2, still_current: true,
    answered_at: '2026-10-20T08:00:00Z', answered_by_name: 'Nitish', can_do: 1, cannot_do: 1, discuss: 0,
    lines: [{ key: 'item:B002', title: 'Table', decision: 'cannot_do', note: 'Cut already made' }],
  }],
  periods: { last_month: period(), last_six_months: period(9, 7), gaps: { dispatched_without_date: 2, orders_without_value: 1, no_confirm_date: 0 } },
  ...over,
})

const lines: ChangeLine[] = [
  { key: 'a', title: 'Chair', kind: 'changed', changes: [], answer: null },
  { key: 'b', title: 'Table', kind: 'changed', changes: [], answer: null },
]

describe('parseOperationsRead', () => {
  test('reads a well-formed answer', () => {
    const r = parseOperationsRead(payload())
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.read.pending[0].lines.length, 2)
    assert.equal(r.read.pending[0].lines[1].changes[0].new, null)
    assert.equal(r.read.responses[0].lines[0].decision, 'cannot_do')
    assert.equal(r.read.lastSixMonths.dispatches.count, 7)
  })

  test('a malformed answer is an error, never an empty dashboard', () => {
    assert.equal(parseOperationsRead(null).ok, false)
    assert.equal(parseOperationsRead(payload({ pending_changes: 'none' })).ok, false)
    assert.equal(parseOperationsRead(payload({ viewer: { is_reviewer: 'yes', is_approver: false } })).ok, false)
    const bad: any = payload()
    bad.pending_changes[0].changes.lines[0].kind = 'edited'
    assert.equal(parseOperationsRead(bad).ok, false)
    const badDecision: any = payload()
    badDecision.responses[0].lines[0].decision = 'maybe'
    assert.equal(parseOperationsRead(badDecision).ok, false)
  })

  test('an empty list of changes is a real, readable state', () => {
    const r = parseOperationsRead(payload({ pending_changes: [], responses: [] }))
    assert.ok(r.ok)
    if (r.ok) assert.deepEqual([r.read.pending.length, r.read.responses.length], [0, 0])
  })
})

describe('answering', () => {
  test('Accept all and Reject all fill every line; typed notes stay', () => {
    const d = emptyDraft(lines)
    d.a.note = 'keep me'
    const rejected = applyToAll(d, 'cannot_do')
    assert.deepEqual(Object.values(rejected).map(v => v.decision), ['cannot_do', 'cannot_do'])
    assert.equal(rejected.a.note, 'keep me')
    assert.deepEqual(tally(applyToAll(d, 'can_do')), { canDo: 2, cannotDo: 0, discuss: 0, open: 0 })
  })

  test('every line must be answered before anything is sent', () => {
    const d = emptyDraft(lines)
    d.a.decision = 'can_do'
    const r = buildAnswers(lines, d, '')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.message, /Table/)
  })

  test('a note is required unless the answer is can do; one shared reason covers the rest', () => {
    const d = applyToAll(emptyDraft(lines), 'cannot_do')
    assert.equal(buildAnswers(lines, d, '').ok, false)
    const shared = buildAnswers(lines, d, 'Production already cut')
    assert.ok(shared.ok)
    if (shared.ok) assert.deepEqual(shared.answers.map(a => a.note), ['Production already cut', 'Production already cut'])
    d.a.note = 'Only this one'
    const mixed = buildAnswers(lines, d, 'Production already cut')
    assert.ok(mixed.ok)
    if (mixed.ok) assert.deepEqual(mixed.answers.map(a => a.note), ['Only this one', 'Production already cut'])
  })

  test('can do sends no note unless one was typed', () => {
    const r = buildAnswers(lines, applyToAll(emptyDraft(lines), 'can_do'), 'ignored shared reason')
    assert.ok(r.ok)
    if (r.ok) assert.deepEqual(r.answers.map(a => a.note), [null, null])
  })

  test('failures are said in words, and an unknown one still gets a sentence', () => {
    assert.match(describeAnswerFailure({ message: 'ORDER_CHANGES_INCOMPLETE: answer every changed line' }), /Every changed line/)
    assert.equal(describeAnswerFailure({ message: 'boom' }), ANSWER_FALLBACK)
  })

  test('a response is summarised and toned by what the approver has to do', () => {
    assert.equal(responseSummary({ canDo: 2, cannotDo: 1, discuss: 0 }), '2 can do · 1 cannot do')
    assert.equal(responseTone({ cannotDo: 1, discuss: 1 }), 'danger')
    assert.equal(responseTone({ cannotDo: 0, discuss: 1 }), 'attention')
    assert.equal(responseTone({ cannotDo: 0, discuss: 0 }), 'good')
  })

  test('what is missing from the dispatch figures is said, not hidden', () => {
    const r = parseOperationsRead(payload())
    assert.ok(r.ok)
    if (!r.ok) return
    const notes = dispatchGapNotes(r.read.gaps)
    assert.equal(notes.length, 2)
    assert.match(notes[0], /2 dispatched orders have no recorded dispatch date/)
    assert.deepEqual(dispatchGapNotes({ dispatchedWithoutDate: 0, ordersWithoutValue: 0, noConfirmDate: 3 }), [])
  })
})

describe('the migration (20270401000000)', () => {
  const sql = read(MIGRATION)

  test('an aligned order is no longer un-aligned when a revision is approved', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.order_pi_versions_record_operations_handoff()'),
                         sql.indexOf('-- ═══ 2.'))
    assert.ok(fn.length > 500)
    assert.equal(/order_operations_handoff_set_alignment\s*\(/.test(fn), false, 'the trigger must not call set_alignment')
    assert.match(fn, /'alignment_kept', v_alignment = 'aligned'/)
    assert.match(fn, /production_alignment_at_approval/)
  })

  test('answering never writes the order', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.answer_order_pi_changes'),
                         sql.indexOf('-- ═══ 6.'))
    assert.ok(fn.length > 1000)
    assert.equal(/update\s+public\.orders\b/i.test(fn), false)
    assert.equal(/set_alignment/.test(fn), false)
    assert.match(fn, /h\.assigned_to <> v_actor/, 'only the assigned reviewer may answer')
    assert.match(fn, /ORDER_CHANGES_NOTE_REQUIRED/)
    assert.match(fn, /ORDER_CHANGES_INCOMPLETE/)
  })

  test('only the two dashboard RPCs are callable by clients; the answers table is closed', () => {
    assert.match(sql, /grant\s+execute on function public\.answer_order_pi_changes\(uuid, jsonb\) to authenticated/)
    assert.match(sql, /grant\s+execute on function public\.operations_orders_dashboard\(\) to authenticated/)
    assert.match(sql, /revoke execute on function public\.order_handoff_change_lines\(uuid\) from public, anon, authenticated/)
    assert.match(sql, /revoke all on table public\.order_pi_change_answers from public, anon, authenticated/)
    assert.equal(/grant\s+(select|all)[^;]*order_pi_change_answers/i.test(sql), false)
  })

  test('every definer function pins its search_path', () => {
    const definers = sql.match(/security definer/g)?.length ?? 0
    const pinned = sql.match(/set search_path = public, pg_temp/g)?.length ?? 0
    assert.ok(definers >= 5)
    assert.ok(pinned >= definers)
  })

  test('the page asks for the Operations read and falls back when it is not on the database', () => {
    const page = read('src/app/orders/page.tsx')
    assert.match(page, /supabase\.rpc\('operations_orders_dashboard'\)/)
    assert.match(page, /isDashboardFunctionMissing\(operationsRes\.error\)/)
    assert.match(page, /profile\?\.team === 'operations' && operations\.kind !== 'absent'/)
  })
})
