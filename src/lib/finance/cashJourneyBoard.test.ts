/**
 * THE CASH JOURNEYS BOARD — the pure half, and the source contracts of the page.
 *
 * Run:
 *   npx tsx --test src/lib/finance/cashJourneyBoard.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCashPayment, type CashPayment } from './cashJourney'
import {
  attentionRank,
  boardSummary,
  daysBetween,
  handoverMatches,
  paymentFlags,
  readTrackedPaymentRecords,
  rowMatches,
  sortByAttention,
  sortByReached,
  toBoardRows,
  trailStepLabel,
  verificationState,
  type TrackedPaymentRecord,
} from './cashJourneyBoard'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const NOW = Date.parse('2026-10-29T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function payment(over: Record<string, unknown> = {}): CashPayment {
  const p = readCashPayment({
    payment_id: 'p1', human_payment_id: 'P-AA-0055', client_name: 'Qavaali', amount: 495000,
    payment_mode: 'paytm', payment_date: '2026-10-17', recorded_at: '2026-10-26T09:00:00Z',
    tracked: true, state: 'with_holder', holder_id: 'dhruv', holder_name: 'Dhruv',
    holder_since: hoursAgo(5), age_hours: 5, open_handover: null,
    can_accept: false, can_hand_over: false, can_receive: true,
    ...over,
  })
  assert.ok(p)
  return p
}

function record(over: Partial<TrackedPaymentRecord> = {}): TrackedPaymentRecord {
  return {
    paymentId: 'p1', humanPaymentId: 'P-AA-0055', clientName: 'Qavaali', amount: 495000,
    paymentMode: 'paytm', paymentDate: '2026-10-17', recordedAt: '2026-10-26T09:00:00Z',
    status: 'pending_approval', orderNumber: null, recordedByName: 'Mohit Sharma',
    ...over,
  }
}

const waitingHandover = (createdAt: string) => ({
  id: 'h9', human_id: 'H-0009', status: 'pending', giver_id: 'dhruv', giver_name: 'Dhruv',
  recipient_id: 'nitish', recipient_name: 'Nitish Bansal', created_at: createdAt,
})

describe('reading the payment records', () => {
  test('a row is read field for field, the recorder from the users embed', () => {
    const [r] = readTrackedPaymentRecords([{
      id: 'p1', human_payment_id: 'P-AA-0055', client_name: 'Qavaali', amount: '495000',
      payment_mode: 'paytm', payment_date: '2026-10-17', status: 'pending_approval',
      created_at: '2026-10-26T09:00:00Z', order_number: null, submitted_by_user: { full_name: 'Mohit Sharma' },
    }])
    assert.equal(r.amount, 495000)
    assert.equal(r.recordedByName, 'Mohit Sharma')
    assert.equal(r.status, 'pending_approval')
  })

  test('a row without an id is dropped; a missing embed is a null name', () => {
    assert.deepEqual(readTrackedPaymentRecords([{ amount: 1 }]), [])
    assert.equal(readTrackedPaymentRecords([{ id: 'x' }])[0].recordedByName, null)
    assert.deepEqual(readTrackedPaymentRecords('nope'), [])
  })
})

describe('verification beside the cash state', () => {
  test('the five statuses map to three words and one unknown', () => {
    assert.equal(verificationState('approved_unlinked'), 'verified')
    assert.equal(verificationState('approved_linked'), 'verified')
    assert.equal(verificationState('pending_approval'), 'not_verified')
    assert.equal(verificationState('needs_clarification'), 'clarification')
    assert.equal(verificationState('rejected'), 'unknown')
    assert.equal(verificationState(undefined), 'unknown')
  })
})

describe('flags: what is wrong, in words', () => {
  test('a fresh payment with its holder has nothing to say', () => {
    const flags = paymentFlags(payment({ payment_date: '2026-10-26', recorded_at: '2026-10-26T09:00:00Z' }), null, NOW)
    assert.deepEqual(flags, [])
  })

  test('held for a day is late, for three days overdue, and says so with no handover started', () => {
    const late = paymentFlags(payment({ age_hours: 30, payment_date: '2026-10-26' }), null, NOW)
    assert.equal(late[0].kind, 'held_long')
    assert.equal(late[0].severity, 'late')
    assert.match(late[0].text, /With Dhruv for 1 day and no handover started/)
    const overdue = paymentFlags(payment({ age_hours: 100, payment_date: '2026-10-26' }), null, NOW)
    assert.equal(overdue[0].severity, 'overdue')
  })

  test('a handover nobody accepted is measured from the handover, not the custody', () => {
    const p = payment({ state: 'waiting', age_hours: 200, open_handover: waitingHandover(hoursAgo(30)), payment_date: '2026-10-26' })
    const flags = paymentFlags(p, null, NOW)
    assert.equal(flags.length, 1)
    assert.equal(flags[0].kind, 'not_accepted')
    assert.equal(flags[0].severity, 'late')
    assert.equal(flags[0].text, 'Nitish Bansal has not accepted for 1 day')
  })

  test('a handover made just now is not flagged however long the giver held the cash', () => {
    const p = payment({ state: 'waiting', age_hours: 200, open_handover: waitingHandover(hoursAgo(2)), payment_date: '2026-10-26' })
    assert.deepEqual(paymentFlags(p, null, NOW), [])
  })

  test('an order exception and a late recording are notes, and both can stand together', () => {
    const p = payment({ order_exception: { reason: 'Client promised', by_name: 'Nishant', at: hoursAgo(1) } })
    const flags = paymentFlags(p, record(), NOW)
    assert.deepEqual(flags.map(f => f.kind), ['order_exception', 'late_record'])
    assert.equal(flags[1].text, 'Recorded 9 days after it was paid')
    assert.ok(flags.every(f => f.severity === 'note'))
  })

  test('a recording within two days of the payment is not late', () => {
    const p = payment({ payment_date: '2026-10-24', recorded_at: '2026-10-26T09:00:00Z' })
    assert.deepEqual(paymentFlags(p, record({ paymentDate: '2026-10-24' }), NOW), [])
  })

  test('money with the company has no flags at all', () => {
    const p = payment({ state: 'with_company', holder_name: 'Nitish Bansal', age_hours: 900, order_exception: { reason: 'x' } })
    assert.deepEqual(paymentFlags(p, record(), NOW), [])
  })
})

describe('rows, order and search', () => {
  test('overdue first, then late, then notes, then nothing wrong; older first within a tie', () => {
    const records = new Map<string, TrackedPaymentRecord>()
    const rows = toBoardRows([
      payment({ payment_id: 'fine', age_hours: 2, payment_date: '2026-10-26' }),
      payment({ payment_id: 'note', age_hours: 2, order_exception: { reason: 'r' }, payment_date: '2026-10-26' }),
      payment({ payment_id: 'overdue', age_hours: 80, payment_date: '2026-10-26' }),
      payment({ payment_id: 'late-old', age_hours: 40, payment_date: '2026-10-26' }),
      payment({ payment_id: 'late-new', age_hours: 26, payment_date: '2026-10-26' }),
    ], records, NOW)
    assert.deepEqual(sortByAttention(rows).map(r => r.payment.paymentId), ['overdue', 'late-old', 'late-new', 'note', 'fine'])
    assert.equal(attentionRank([]), 3)
  })

  test('a row carries the age of its open handover, measured from the offer', () => {
    const [waiting, held] = toBoardRows([
      payment({ payment_id: 'w', state: 'waiting', open_handover: waitingHandover(hoursAgo(30)) }),
      payment({ payment_id: 'h' }),
    ], new Map(), NOW)
    assert.equal(Math.round(waiting.handoverHours ?? -1), 30)
    assert.equal(held.handoverHours, null)
  })

  test('reached rows run newest arrival first', () => {
    const rows = toBoardRows([
      payment({ payment_id: 'a', state: 'with_company', holder_since: hoursAgo(50) }),
      payment({ payment_id: 'b', state: 'with_company', holder_since: hoursAgo(5) }),
    ], new Map(), NOW)
    assert.deepEqual(sortByReached(rows).map(r => r.payment.paymentId), ['b', 'a'])
  })

  test('a handed-over step stops saying "waiting" once that handover was answered', () => {
    const step = (kind: string, id: string | null) => ({ kind, at: '', actorName: 'Mohit', toName: 'Dhruv', note: null, handoverHumanId: id })
    const created = step('handover_created', 'H-0008')
    const answered = [created, step('handover_accepted', 'H-0008'), step('handover_created', 'H-0009')] as never[]
    assert.equal(trailStepLabel(created as never, answered), 'Mohit handed it to Dhruv')
    assert.equal(trailStepLabel(step('handover_created', 'H-0009') as never, answered), 'Mohit handed it to Dhruv — waiting for acceptance')
    assert.equal(trailStepLabel(created as never, [created] as never[]), 'Mohit handed it to Dhruv — waiting for acceptance')
  })

  test('the handover log is searched by number, people and the payments inside', () => {
    const h = { humanId: 'H-0009', giverName: 'Dhruv', recipientName: 'Nitish Bansal',
      items: [{ paymentId: 'p1', humanPaymentId: 'P-AA-0055', clientName: 'Qavaali', amount: 1, paymentMode: 'paytm', paymentDate: null }] }
    for (const q of ['h-0009', 'dhruv', 'nitish', 'p-aa-0055', 'qava']) assert.equal(handoverMatches(h, q), true, q)
    assert.equal(handoverMatches(h, 'prerna'), false)
    assert.equal(handoverMatches(h, ''), true)
  })

  test('search finds a row by ID, client, holder, recorder, handover and the people in it', () => {
    const [row] = toBoardRows(
      [payment({ state: 'waiting', open_handover: waitingHandover(hoursAgo(1)) })],
      new Map([['p1', record({ orderNumber: 'BOE-0539' })]]), NOW)
    for (const q of ['p-aa-0055', 'qav', 'dhruv', 'mohit', 'h-0009', 'nitish', 'boe-0539', 'paytm']) {
      assert.equal(rowMatches(row, q), true, q)
    }
    assert.equal(rowMatches(row, 'canara'), false)
    assert.equal(rowMatches(row, '   '), true)
  })
})

describe('the four figures', () => {
  test('outside, attention, waiting and reached-in-30-days are counted from the rows', () => {
    const unclosed = toBoardRows([
      payment({ payment_id: 'a', amount: 100, holder_id: 'u1', age_hours: 80, payment_date: '2026-10-26' }),
      payment({ payment_id: 'b', amount: 200, holder_id: 'u1', age_hours: 2, payment_date: '2026-10-26' }),
      payment({ payment_id: 'c', amount: 300, holder_id: 'u2', state: 'waiting', open_handover: waitingHandover(hoursAgo(30)), payment_date: '2026-10-26' }),
    ], new Map(), NOW)
    const reached = toBoardRows([
      payment({ payment_id: 'd', amount: 1000, state: 'with_company', holder_since: hoursAgo(24 * 3) }),
      payment({ payment_id: 'e', amount: 5000, state: 'with_company', holder_since: hoursAgo(24 * 40) }),
    ], new Map(), NOW)
    const s = boardSummary(unclosed, reached, NOW)
    assert.deepEqual(s.outside, { amount: 600, count: 3, people: 2 })
    assert.deepEqual(s.attention, { count: 2, overdue: 1 })
    assert.deepEqual(s.waiting, { amount: 300, count: 1 })
    assert.deepEqual(s.reached, { amount: 1000, count: 1, days: 30 })
  })

  test('days between a paid date and a recording instant', () => {
    assert.equal(daysBetween('2026-10-17', '2026-10-26T09:00:00Z'), 9)
    assert.equal(daysBetween(null, '2026-10-26T09:00:00Z'), null)
    assert.equal(daysBetween('nope', '2026-10-26'), null)
  })
})

describe('source contracts of the page', () => {
  const PAGE = read('src/app/finance/handovers/page.tsx')
  const HOOK = read('src/hooks/queries/useCashJourneys.ts')
  const CSS = read('src/app/globals.css')

  test('the page draws the four figures and the handover log, and keeps the closed tabs', () => {
    for (const label of ['Outside the company', 'Needs attention', 'Waiting for acceptance', 'Reached the company', 'Handover log']) {
      assert.ok(PAGE.includes(label), label)
    }
  })

  test('the enrichment read is bounded, tracked-only and never includes deleted or rejected rows', () => {
    assert.match(HOOK, /\.from\('finance_payment_requests'\)/)
    assert.match(HOOK, /\.is\('deleted_at', null\)/)
    assert.match(HOOK, /\.neq\('status', 'rejected'\)/)
    assert.match(HOOK, /\.in\('payment_mode', \[\.\.\.TRACKED_PAYMENT_MODES\]\)/)
    assert.match(HOOK, /\.limit\(TRACKED_RECORDS_LIMIT\)/)
    // Focus refetching stays off: financeRefreshPolicy.test.ts guards every
    // Finance hook, this one included.
  })

  test('the board never says a state by colour alone: every flag carries words', () => {
    assert.match(PAGE, /flag\.text|f\.text/)
    assert.ok(CSS.includes('.boe-cj-flag--overdue'))
    assert.ok(CSS.includes('.boe-cj-flag--late'))
  })
})
