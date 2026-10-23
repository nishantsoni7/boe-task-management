/**
 * CASH JOURNEYS (20270413000000) — the pure half, and the source contracts that
 * keep the loophole closed and the money untouched.
 *
 * NONE OF THIS IS THE AUTHORIZATION. Who may hand over, accept or receive is
 * decided in SQL; the PGlite harness proves those rules on a real engine.
 *
 * Run:
 *   npx tsx --test src/lib/finance/cashJourney.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cashStateLabel,
  isTrackedPaymentMode,
  journeyStepLabel,
  moneyNowError,
  readCashPayment,
  readJourney,
  readUnclosedFunds,
  sumAmounts,
  totalsByHolder,
} from './cashJourney'
import { modeRequiresCustodyTrail } from './paymentEntry'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SQL = read('supabase/migrations/20270413000000_finance_cash_journeys.sql')
const code = (s: string) => s.replace(/--.*$/gm, '')

function raw(over: Record<string, unknown> = {}) {
  return {
    payment_id: 'p1', human_payment_id: 'P-AA-0001', client_name: 'Acme', amount: 5000,
    payment_mode: 'paytm', payment_date: '2026-10-20', recorded_at: '2026-10-20T10:00:00Z',
    tracked: true, state: 'with_holder', holder_id: 'u1', holder_name: 'Ashok',
    holder_since: '2026-10-20T10:00:00Z', age_hours: 30, open_handover: null,
    can_accept: false, can_hand_over: true, can_receive: false,
    ...over,
  }
}

describe('modes', () => {
  test('everything except the two HDFC accounts is tracked, in TS and SQL alike', () => {
    for (const m of ['pnb', 'paytm', 'canara']) {
      assert.equal(isTrackedPaymentMode(m), true, m)
      assert.equal(modeRequiresCustodyTrail(m), true, m)
    }
    for (const m of ['hdfc', 'hdfc_sec', '', 'cash']) {
      assert.equal(isTrackedPaymentMode(m), false, m)
      assert.equal(modeRequiresCustodyTrail(m), false, m)
    }
    assert.match(code(SQL), /in \('pnb', 'paytm', 'canara'\);/)
  })
})

describe('reading the RPC JSON', () => {
  test('a payment state is read field for field', () => {
    const p = readCashPayment(raw({ state: 'waiting', can_accept: true,
      open_handover: { id: 'h1', human_id: 'H-0001', status: 'pending', giver_id: 'u1', giver_name: 'Ashok', recipient_id: 'u2', recipient_name: 'Nitish', created_at: 'x' } }))
    assert.ok(p)
    assert.equal(p.state, 'waiting')
    assert.equal(p.openHandover?.recipientName, 'Nitish')
    assert.equal(p.canAccept, true)
  })

  test('an unknown state or a missing id is dropped, never guessed', () => {
    assert.equal(readCashPayment(raw({ state: 'lost' })), null)
    assert.equal(readCashPayment(raw({ payment_id: null })), null)
    assert.equal(readCashPayment(null), null)
  })

  test('a can_* flag is true only when the server said exactly true', () => {
    const p = readCashPayment(raw({ can_hand_over: 'yes', can_receive: 1 }))
    assert.equal(p?.canHandOver, false)
    assert.equal(p?.canReceive, false)
  })

  test('the unclosed list keeps its scope and drops bad rows', () => {
    const u = readUnclosedFunds({ scope: 'all', viewer_is_custodian: true, custodians: [{ id: 'n', full_name: 'Nitish Bansal' }],
      payments: [raw(), raw({ state: 'nope' })] })
    assert.equal(u.scope, 'all')
    assert.equal(u.viewerIsCustodian, true)
    assert.equal(u.payments.length, 1)
    assert.equal(readUnclosedFunds('x').scope, 'none')
  })

  test('a journey keeps known steps in order', () => {
    const j = readJourney({ payment: raw(), steps: [
      { kind: 'recorded', at: '1', actor_name: 'Ashok' },
      { kind: 'mystery', at: '2' },
      { kind: 'handover_accepted', at: '3', actor_name: 'Nitish Bansal' },
    ] })
    assert.deepEqual(j?.steps.map(s => s.kind), ['recorded', 'handover_accepted'])
  })
})

describe('words', () => {
  test('one phrase per state', () => {
    const p = readCashPayment(raw())!
    assert.equal(cashStateLabel(p), 'With Ashok')
    assert.equal(cashStateLabel({ ...p, state: 'with_company' }), 'With company')
    const w = { ...p, state: 'waiting' as const, openHandover: { id: 'h', humanId: 'H', status: 'pending' as const, giverId: '', giverName: 'Ashok', recipientId: '', recipientName: 'Nitish', createdAt: '' } }
    assert.equal(cashStateLabel(w), 'Waiting for Nitish to accept')
    assert.equal(cashStateLabel({ ...w, state: 'disputed' }), 'Disputed by Nitish')
  })

  test('journey steps read as sentences', () => {
    assert.equal(journeyStepLabel({ kind: 'handover_created', at: '', actorName: 'Ashok', toName: 'Senior', note: null, handoverHumanId: null }),
      'Ashok handed it to Senior — waiting for acceptance')
    assert.equal(journeyStepLabel({ kind: 'received_directly', at: '', actorName: 'Ashok', toName: 'Nitish Bansal', note: null, handoverHumanId: null }),
      'Nitish Bansal received it directly from Ashok')
  })

  test('totals by holder: largest first, paise-exact, oldest age kept', () => {
    const a = readCashPayment(raw({ payment_id: 'a', holder_id: 'u1', holder_name: 'Ashok', amount: 0.1, age_hours: 5 }))!
    const b = readCashPayment(raw({ payment_id: 'b', holder_id: 'u1', holder_name: 'Ashok', amount: 0.2, age_hours: 50 }))!
    const c = readCashPayment(raw({ payment_id: 'c', holder_id: 'u2', holder_name: 'Senior', amount: 10, age_hours: 1 }))!
    const t = totalsByHolder([a, b, c])
    assert.deepEqual(t.map(x => [x.holderName, x.amount, x.count, x.oldestAgeHours]), [['Senior', 10, 1, 1], ['Ashok', 0.3, 2, 50]])
    assert.equal(sumAmounts([a, b, c]), 10.3)
  })

  test('the "where is this money now" choice', () => {
    assert.equal(moneyNowError({ choice: 'with_me' }, 'u1'), null)
    assert.match(moneyNowError({ choice: 'handed_to', recipientId: '' }, 'u1') ?? '', /Choose who/)
    assert.match(moneyNowError({ choice: 'handed_to', recipientId: 'u1' }, 'u1') ?? '', /other than yourself/)
    assert.equal(moneyNowError({ choice: 'handed_to', recipientId: 'u2' }, 'u1'), null)
  })
})

describe('source contracts', () => {
  const c = code(SQL)

  test('a "handed over" event needs the acceptance marker, set only by accept and receive', () => {
    assert.match(c, /v_type = 'handed_over'\s+and coalesce\(current_setting\('boe\.cash_handover_accept', true\), ''\) <> 'on'/)
    const setters = c.match(/set_config\('boe\.cash_handover_accept', 'on', true\)/g) ?? []
    assert.equal(setters.length, 2)
  })

  test('the custodian setting is admin only, never empty, seeded with exactly one Nitish Bansal', () => {
    assert.match(c, /only an administrator can change who receives cash/)
    assert.match(c, /CUSTODIAN_REQUIRED/)
    assert.match(c, /full_name = 'Nitish Bansal'[\s\S]{0,200}v_count <> 1/)
    assert.match(c, /revoke all on public\.finance_cash_custodians from public, anon, authenticated;/)
  })

  test('only a custodian can receive directly', () => {
    assert.match(c, /not public\.finance_is_cash_custodian\(v_actor\) then\s+raise exception 'HANDOVER_NOT_ALLOWED/)
  })

  test('internal helpers are closed to clients', () => {
    for (const fn of ['finance_is_cash_custodian(uuid)', 'finance_payment_is_closed(uuid)', 'finance_cash_sees_all(uuid)',
                      'finance_cash_payment_readable(uuid, uuid)', 'finance_cash_payment_state(uuid, uuid)']) {
      assert.ok(SQL.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn)
    }
  })

  test('not financial: no payment amount, status or allocation is written', () => {
    assert.doesNotMatch(c, /finance_payment_allocations/)
    assert.doesNotMatch(c, /update\s+public\.finance_payment_requests/i)
    assert.doesNotMatch(c, /insert\s+into\s+public\.finance_payment_requests/i)
  })

  test('every security definer function pins its search_path', () => {
    const defs = SQL.match(/security definer\s+set search_path = public, pg_temp/g) ?? []
    const all = SQL.match(/security definer/g) ?? []
    assert.equal(defs.length, all.length)
  })
})
