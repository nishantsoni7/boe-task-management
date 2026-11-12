// Operations flags PI lines (20270616000000): the rules the review window and the Order page follow.
// The database behaviour is proved on an in-memory Postgres: supabase/tests/order_line_flags_pglite.mjs.
//
// Run with: npm run test:file -- src/lib/orders/lineFlags.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LINE_FLAG_REASONS,
  OK_MARK,
  composeLineRemarks,
  describeLineFlagFailure,
  lineFlagPayload,
  lineFlagStatus,
  lineMarkProblem,
  loadLineFlags,
  markFromFlag,
  parseSuggestedPrice,
  readLineFlags,
  summarizeLineReview,
  type LineMark,
} from './lineFlags'

const ROOT = join(__dirname, '..', '..', '..')
const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20270616000000_order_line_flags.sql'), 'utf8').replace(/\r/g, '')

const chair: LineMark = { kind: 'cannot_make', reasons: ['price_low', 'quantity_low'], note: ' Has to be made in-house. ', price: '7,000' }
const bench: LineMark = { kind: 'comment', reasons: ['complicated_design'], note: 'Lead time may be longer.', price: '' }

const api = (over: Record<string, unknown> = {}) => ({
  item_id: 'i-2', line_code: '700-BE0002', line_title: 'Dining Chair', kind: 'cannot_make',
  reasons: ['price_low', 'quantity_low'], note: 'Has to be made in-house.', suggested_price: 7000,
  flagged_at: '2026-11-12T04:11:00Z', by_name: 'Operations Reviewer', handoff_id: 'h-1', version_number: 1,
  handoff_status: 'clarification_needed', ...over,
})

describe('the reasons', () => {
  test('are the six the owner agreed, and the same six codes the database accepts', () => {
    assert.deepEqual(LINE_FLAG_REASONS.map(r => r.label),
      ['Price too low', 'Quantity too low', 'Complicated design', 'Size or dimension', 'Material or finish', 'Other'])
    for (const r of LINE_FLAG_REASONS) assert.ok(sql.includes(`'${r.code}'`), `${r.code} is in the migration`)
  })
})

describe('a marked line', () => {
  test('needs a reason and a note; an OK line needs nothing', () => {
    assert.equal(lineMarkProblem(OK_MARK), null)
    assert.equal(lineMarkProblem(chair), null)
    assert.match(lineMarkProblem({ ...chair, reasons: [] }) ?? '', /reason and .*note/)
    assert.match(lineMarkProblem({ ...chair, note: '   ' }) ?? '', /reason and .*note/)
    assert.match(lineMarkProblem({ ...chair, note: 'x'.repeat(1001) }) ?? '', /1000/)
  })

  test('takes a suggested price as written, or none; anything else is a problem only when price is a reason', () => {
    assert.equal(parseSuggestedPrice('7,000'), 7000)
    assert.equal(parseSuggestedPrice('₹ 7000.50'), 7000.5)
    assert.equal(parseSuggestedPrice(''), null)
    for (const bad of ['abc', '0', '-5', '7.123']) assert.ok(Number.isNaN(parseSuggestedPrice(bad)), bad)
    assert.match(lineMarkProblem({ ...chair, price: 'seven' }) ?? '', /number/)
    assert.equal(lineMarkProblem({ ...bench, price: 'seven' }), null, 'no price reason, the box is not asked')
  })
})

describe('the review button', () => {
  test('all OK accepts as today; comments only accept with comments; one Cannot make sends it back', () => {
    assert.equal(summarizeLineReview([OK_MARK, OK_MARK]).actionLabel, 'Accept for production')
    const c = summarizeLineReview([OK_MARK, bench])
    assert.equal(c.action, 'accept_with_comments')
    assert.match(c.note, /Aligns the Order/)
    const s = summarizeLineReview([OK_MARK, chair, bench])
    assert.deepEqual([s.ok, s.cannotMake, s.comments, s.action], [1, 1, 1, 'send_back'])
    assert.match(s.note, /stays not aligned until Sales answers/)
  })

  test('is not ready while a marked line is incomplete, and says how many', () => {
    const s = summarizeLineReview([chair, { ...bench, note: '' }, { ...chair, reasons: [] }])
    assert.equal(s.ready, false)
    assert.equal(s.incomplete, 2)
    assert.match(s.note, /^2 flagged lines still need a reason and a note\.$/)
  })
})

describe('what the database is sent', () => {
  test('marked lines only, trimmed, with a price only when price is a reason', () => {
    const payload = lineFlagPayload([
      { itemId: 'i-1', mark: OK_MARK },
      { itemId: 'i-2', mark: chair },
      { itemId: 'i-5', mark: { ...bench, price: '500' } },
    ])
    assert.deepEqual(payload, [
      { item_id: 'i-2', kind: 'cannot_make', reasons: ['price_low', 'quantity_low'], note: 'Has to be made in-house.', suggested_price: 7000 },
      { item_id: 'i-5', kind: 'comment', reasons: ['complicated_design'], note: 'Lead time may be longer.', suggested_price: null },
    ])
  })

  test('refuses to build from an incomplete mark', () => {
    assert.throws(() => lineFlagPayload([{ itemId: 'i-2', mark: { ...chair, note: '' } }]))
  })
})

describe('what the database answers', () => {
  test('is read into flags; anything unreadable throws rather than showing fewer flags', () => {
    const [f] = readLineFlags([api()])
    assert.equal(f.lineCode, '700-BE0002')
    assert.equal(f.suggestedPrice, 7000)
    assert.equal(f.handoffStatus, 'clarification_needed')
    assert.throws(() => readLineFlags({}))
    assert.throws(() => readLineFlags([api({ kind: 'maybe' })]))
    assert.throws(() => readLineFlags([api({ handoff_status: 'lost' })]))
  })

  test('a Cannot make that Operations later accepted reads as settled, not as still blocking', () => {
    assert.equal(lineFlagStatus({ kind: 'cannot_make', handoffStatus: 'clarification_needed' }).tone, 'red')
    assert.equal(lineFlagStatus({ kind: 'cannot_make', handoffStatus: 'awaiting' }).tone, 'red')
    assert.match(lineFlagStatus({ kind: 'cannot_make', handoffStatus: 'accepted' }).label, /then accepted/)
    assert.equal(lineFlagStatus({ kind: 'comment', handoffStatus: 'accepted' }).label, 'Comment')
  })

  test('a saved flag reopens as the same mark, so flagging again starts from what was said', () => {
    const [f] = readLineFlags([api()])
    assert.deepEqual(markFromFlag(f), { kind: 'cannot_make', reasons: ['price_low', 'quantity_low'], note: 'Has to be made in-house.', price: '7000' })
  })

  test('a database without the function, or a failed read, keeps the older window (available = false)', async () => {
    const missing = await loadLineFlags({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) }, 'o')
    assert.deepEqual(missing, { available: false, flags: [] })
    const failed = await loadLineFlags({ rpc: async () => ({ data: null, error: { message: 'boom' } }) }, 'o')
    assert.equal(failed.available, false)
    const ok = await loadLineFlags({ rpc: async (_fn, args) => ({ data: args.p_order_id === 'o' ? [api()] : null, error: null }) }, 'o')
    assert.equal(ok.available, true)
    assert.equal(ok.flags.length, 1)
  })
})

describe("Sales' answer", () => {
  test('one remark: a line per answered flag, then the general words; blank boxes are left out', () => {
    assert.equal(
      composeLineRemarks([
        { label: '700-BE0002 Dining Chair', text: ' Client agreed 7,000.\n' },
        { label: '700-BE0003 Outdoor Frame', text: '' },
      ], 'Revising the frame in Edit PI.'),
      '700-BE0002 Dining Chair: Client agreed 7,000.\nRevising the frame in Edit PI.')
    assert.equal(composeLineRemarks([{ label: 'X', text: '' }], ''), '')
  })
})

describe('refusals', () => {
  test("say flag_order_lines()' own refusals in a sentence and leave decide's to its own words", () => {
    assert.match(describeLineFlagFailure({ message: 'ORDER_LINE_FLAGS_UNKNOWN_LINE: a flagged line…' }) ?? '', /Refresh/)
    assert.match(describeLineFlagFailure({ message: 'ORDER_LINE_FLAGS_NOTE_REQUIRED: …' }) ?? '', /reason and a note/)
    assert.equal(describeLineFlagFailure({ message: 'ORDER_ADVANCE_BELOW_THRESHOLD: …' }), null)
  })
})
