// THE ADMIN'S ORDERS DASHBOARD (owner-approved layout, 2026-11-02): the rules in
// lib/orders/adminDashboard.ts, and the three zones as they are drawn.
//
// The database decides what counts (orders_dashboard_summary, pi_submission_payment_summary); these
// pin the other half: when a wait turns amber or red, that the payment chip is the database's own
// position and never a guess, that the decision list is one list sorted by wait, that a zero month is
// not drawn as a failure, that the board opens on the first list with rows, and that what the page
// keeps for everybody else is still there.
//
// Run with: npm run test:file -- src/lib/orders/adminDashboard.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ADMIN_BOARD_ORDER,
  CARD_DEFS,
  CHANGES_LOAD_FAILED,
  OPERATIONS_ANSWER_DAYS,
  awaitingReviewRow,
  changeRequestRow,
  documentRow,
  firstName,
  flaggedRow,
  formatCompactRupees,
  initialsOf,
  monthlyAverageNote,
  needsFollowUp,
  operationsAnswerRow,
  paymentChip,
  peopleOf,
  pipelineOf,
  reviewRow,
  revisionRow,
  sinceLabel,
  sortDecisionRows,
  splitCards,
  waitTone,
  type DecisionRow,
} from './adminDashboard'
import { PAYMENT_POSITIONS } from './paymentGate'
import { readFlaggedPis } from './flaggedPis'
import type { PersistedDocumentSubmission } from './orderDocumentSubmissions'
import type { AlignmentRow, DashboardSummary } from './orderDashboardSummary'
import type { ChangeResponse } from './operationsDashboard'
import {
  composeDecisionRows,
  loadDecisionRows,
  readDecisionData,
  startDecisionRead,
  usableEarlyRead,
} from '@/components/orders/dashboard/DecisionQueue'
import { DecisionCards } from '@/components/orders/dashboard/DecisionCards'
import { AdminRevenueCard } from '@/components/orders/dashboard/AdminRevenueCard'
import { AdminOrdersBoard } from '@/components/orders/dashboard/AdminOrdersBoard'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

const H = 3600
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

// ── Fixtures ─────────────────────────────────────────────────────────────────

const review = (n: number, over: Record<string, unknown> = {}) => ({
  id: `sub-${n}`, client_name: `Client ${n}`, bill_to_name: null, draft_reference: `PID-0000${n}`,
  subtotal_after_discount: '172350.00', submitted_by: 'u-sales', submitted_at: '2026-10-31T10:00:00Z', ...over,
})

const documentSubmission = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1', stage: 'amendment', order_id: 'o-1', includes_design_files: true, includes_client_po: false,
  status: 'pending_admin', file_count: 3, submitted_by: 'u-sales', submitted_at: '2026-11-01T10:00:00Z', ...over,
}) as unknown as PersistedDocumentSubmission

const revision = {
  id: 'v-1', orderId: 'o-9', orderNumber: '531', versionNumber: 2, status: 'pending' as const,
  uploadedBy: 'u-sales', uploadedAt: '2026-10-29T10:00:00Z', operationsReviewer: null,
  client: 'Aarav Interiors', reason: 'Change fabric on 4 chairs',
}

const changeRequest = (over: Record<string, unknown> = {}) => ({
  id: 'c-1', order_id: 'o-7', order_number_snapshot: '527', request_type: 'edit' as const, proposed_total_value: '250000.00',
  created_at: '2026-10-30T10:00:00Z', order: { client_name: 'Lakeview Resort' }, ...over,
})

const ref = (n: string) => ({ orderId: `id-${n}`, displayNumber: n, clientName: `Client ${n}`, status: 'running' })
const late = (n: string, daysLate: number) => ({
  ...ref(n), salesperson: 'Ashok Choudhary', dueDate: '2026-10-27', value: 310500, daysLate, daysLeft: null, aligned: true,
})

function summaryOf(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    today: '2026-11-02', now: '2026-11-02T08:00:00Z',
    viewer: { seesAllOrders: true, canViewRevenue: true, canManageFocus: true },
    reviewer: { userId: 'u-rev', name: 'Nitish Bansal' },
    notAligned: [{
      ...ref('541'), state: 'awaiting_reviewer', waitingOn: 'reviewer', since: '2026-10-30T08:00:00Z',
      waitingSeconds: 3 * 86400 + 4 * H, detail: null, advanceBlocks: false,
    }],
    advance: [], fabricFinish: [], fabricUnrecorded: [],
    overview: {
      running: { orders: 12, value: 13581352 }, aligned: { orders: 11, value: 13464665 },
      delayed: { orders: 2, value: 0, maxDaysLate: 6 }, dueSoon: { orders: 0, value: 0 }, noDueDate: 0,
      paymentsAwaiting: { orders: 0, amount: 0 }, advanceShort: { orders: 0, amount: 0 },
      delayedList: [late('531', 6), late('528', 2)], dueSoonList: [], alignedList: [],
    },
    gaps: { openOrders: 12, advanceValueUnknown: 0, advanceOutsideScope: 0, noConfirmDate: 0 },
    revenue: {
      currentMonth: { from: '2026-11-01', to: '2026-11-02', amount: 0, orders: 0 },
      lastSixMonths: { from: '2026-05-01', to: '2026-10-31', amount: 13581352, orders: 12 },
      currentYear: { from: '2026-01-01', to: '2026-11-02', amount: 13581352, orders: 12 },
      gaps: { noConfirmDate: 0, futureConfirmDate: 0, noProductValueInYear: 0, beforeDiscountInYear: 0 },
    },
    focus: { active: [], removedForYou: [], monthStart: '2026-11-01', monthUsed: null, monthLimit: 2, canManage: true },
    ...over,
  }
}

const emptyOverview = (s: DashboardSummary): DashboardSummary['overview'] => ({ ...s.overview!, delayedList: [] })

// ── The rules ────────────────────────────────────────────────────────────────

describe('a wait turns amber after a day and red after three', () => {
  test('the boundaries', () => {
    assert.equal(waitTone(0), 'normal')
    assert.equal(waitTone(24 * H - 1), 'normal')
    assert.equal(waitTone(24 * H), 'warn')
    assert.equal(waitTone(72 * H - 1), 'warn')
    assert.equal(waitTone(72 * H), 'danger')
  })
})

describe('the payment chip is the database position, never a guess', () => {
  test('every position the database can report has words, and none says "ready to approve"', () => {
    for (const p of PAYMENT_POSITIONS) {
      const chip = paymentChip({ approval_position: p, verified_percent: '40.00' })
      assert.ok(chip, p)
      assert.ok(chip.label.length > 0)
      assert.equal(/ready|approve now|can approve/i.test(chip.label), false, `${p}: "${chip.label}" promises an approval the position cannot`)
      assert.equal(chip.sub, 'Verified 40%')
    }
  })

  test('met and approved read green, refused reads red, awaiting Finance reads blue, short reads amber', () => {
    const tone = (p: string) => paymentChip({ approval_position: p })?.tone
    assert.equal(tone('standard_met'), 'ok')
    assert.equal(tone('exception_approved'), 'ok')
    assert.equal(tone('exception_rejected'), 'danger')
    assert.equal(tone('verification_pending'), 'info')
    assert.equal(tone('payment_required'), 'warn')
    assert.equal(tone('exception_pending'), 'warn')
    assert.equal(tone('exception_stale'), 'warn')
  })

  test('a summary that could not be read, or a position nobody knows, gets NO chip', () => {
    assert.equal(paymentChip(null), null)
    assert.equal(paymentChip({ approval_position: null }), null)
    assert.equal(paymentChip({ approval_position: 'something_new' }), null)
    assert.equal(paymentChip({}), null)
  })

  test('a missing verified percent leaves the sub line out, a zero is still said', () => {
    assert.equal(paymentChip({ approval_position: 'payment_required', verified_percent: null })?.sub, null)
    assert.equal(paymentChip({ approval_position: 'payment_required', verified_percent: 0 })?.sub, 'Verified 0%')
    assert.equal(paymentChip({ approval_position: 'payment_required', verified_percent: '12.5' })?.sub, 'Verified 12.5%')
  })
})

describe('the decision list is one list, longest waiting first', () => {
  const NOW = Date.parse('2026-11-02T08:00:00Z')
  const rows = [
    reviewRow(review(1, { submitted_at: '2026-10-31T10:00:00Z' }), 'Ashok Choudhary', null),
    revisionRow(revision, 'Ashok Choudhary'),
    documentRow({ submission: documentSubmission(), orderNumber: '534', mine: false, client: 'Lakeview Resort' }, 'Ashok Choudhary'),
    reviewRow(review(2, { submitted_at: '2026-10-31T10:00:00Z' }), 'Ashok Choudhary', null),
  ]

  test('sorted by wait, ties keep their order, the wait is filled in', () => {
    const sorted = sortDecisionRows(rows, NOW)
    assert.deepEqual(sorted.map(r => r.key), ['rev-v-1', 'pi-sub-1', 'pi-sub-2', 'doc-doc-1'])
    assert.equal(sorted[0].waitSeconds, Math.floor((NOW - Date.parse('2026-10-29T10:00:00Z')) / 1000))
  })

  test('a date that cannot be read waits zero, never NaN', () => {
    const [r] = sortDecisionRows([reviewRow(review(3, { submitted_at: null }), null, null)], NOW)
    assert.equal(r.waitSeconds, 0)
    assert.equal(sinceLabel(null), '—')
  })

  test('each kind opens where its decision is made', () => {
    assert.match(rows[0].href, /^\/orders\/drafts\/sub-1\?/)
    assert.match(rows[1].href, /^\/orders\/o-9\?/)
    assert.equal(rows[2].href, '/orders/o-1#documents')
    assert.equal(rows[2].kindLabel, 'Design Files')
    assert.equal(rows[2].chip?.label, 'Design Files')
    assert.equal(rows[2].chip?.sub, '3 files · Awaiting your decision')
    assert.equal(rows[1].chip?.sub, '“Change fabric on 4 chairs”')
  })

  test('a change request is one more kind: it opens the Order, says amend or cancel, and shows a dash for a cancellation', () => {
    const edit = changeRequestRow(changeRequest(), 'Ashok Choudhary')
    assert.equal(edit.kind, 'change_request')
    assert.equal(edit.kindLabel, 'Change request')
    assert.match(edit.href, /^\/orders\/o-7\?/)
    assert.equal(edit.client, 'Lakeview Resort')
    assert.equal(edit.ref, 'Order 527')
    assert.equal(edit.by, 'Ashok Choudhary')
    assert.equal(edit.value, 250000)
    assert.equal(edit.chip?.label, 'Amend this Order')
    assert.equal(edit.chip?.sub, 'Awaiting your decision')
    const cancel = changeRequestRow(changeRequest({ request_type: 'cancel', proposed_total_value: '250000.00' }), null)
    assert.equal(cancel.kindLabel, 'Cancellation request')
    assert.equal(cancel.chip?.label, 'Cancel this Order')
    assert.equal(cancel.value, null, 'a cancellation proposes no value, so it is a dash, never a rupee amount')
    assert.equal(changeRequestRow(changeRequest({ proposed_total_value: null }), null).value, null)
    assert.equal(changeRequestRow(changeRequest({ order: null }), null).client, 'Client not recorded')
  })

  test('a change request waits in the same list, longest first', () => {
    const sorted = sortDecisionRows([...rows, changeRequestRow(changeRequest({ created_at: '2026-10-28T10:00:00Z' }), null)], NOW)
    assert.equal(sorted[0].key, 'chg-c-1')
  })

  test('a PI with no client name falls back to the bill-to, then to a plain label', () => {
    assert.equal(reviewRow(review(4, { client_name: null, bill_to_name: 'Bill To Ltd' }), null, null).client, 'Bill To Ltd')
    assert.equal(reviewRow(review(5, { client_name: null }), null, null).client, 'Unnamed client')
    assert.equal(reviewRow(review(6, { subtotal_after_discount: null }), null, null).value, null)
  })

  test('the day a wait began is the Indian day, not the UTC one', () => {
    assert.equal(sinceLabel('2026-10-31T10:00:00Z'), '31 Oct')
    assert.equal(sinceLabel('2026-10-31T20:00:00Z'), '1 Nov')
  })
})

describe('revenue context', () => {
  test('compact rupees: crore, lakh, whole rupees', () => {
    assert.equal(formatCompactRupees(13581352), '₹1.36 Cr')
    assert.equal(formatCompactRupees(2263558.67), '₹22.6 L')
    assert.equal(formatCompactRupees(10000000), '₹1 Cr')
    assert.equal(formatCompactRupees(50000), '₹50,000')
  })

  test('the monthly average is six completed months, and nothing when there were none', () => {
    assert.equal(monthlyAverageNote(13581352), '≈ ₹22.6 L a month')
    assert.equal(monthlyAverageNote(0), null)
  })
})

describe('the pipeline bar', () => {
  const ov = summaryOf().overview!

  test('ready and not aligned are shares of the running orders', () => {
    const p = pipelineOf(ov, 1)
    assert.equal(p.running, 12)
    assert.equal(p.ready, 11)
    assert.ok(Math.abs(p.readyPct - 91.6667) < 0.001)
    assert.ok(Math.abs(p.notAlignedPct - 8.3333) < 0.001)
  })

  test('no running orders draws an empty bar, not a division by zero', () => {
    const p = pipelineOf({ ...ov, running: { orders: 0, value: 0 }, aligned: { orders: 0, value: 0 } }, 3)
    assert.deepEqual([p.readyPct, p.notAlignedPct], [0, 0])
  })

  test('the two shares never pass 100%', () => {
    const p = pipelineOf(ov, 12)
    assert.ok(p.readyPct + p.notAlignedPct <= 100.0001)
  })

  test('the tabs are the five lists to chase, "ready for production" is the bar', () => {
    assert.deepEqual([...ADMIN_BOARD_ORDER], ['delayed', 'due_soon', 'payments', 'fabric', 'not_aligned'])
  })
})

// ── The three zones, drawn ───────────────────────────────────────────────────

// ── Which card a row sits in (owner, 2026-11-20): who holds the next move RIGHT NOW ─────────────────────────

const flaggedPi = (over: Record<string, unknown> = {}) => readFlaggedPis([{
  handoff_id: 'h-546', order_id: 'o-546', order_number: '0546', client_name: 'Qavaali', version_number: 1,
  reason: 'Client wanted a visit from our side before aligning.', by_name: 'Nitish Bansal',
  since: '2026-10-30T08:00:00Z', waiting_seconds: 0, holder: 'coordinator', mine: true, round: 1, ...over,
}])[0]

const answer = (over: Partial<ChangeResponse> = {}): ChangeResponse => ({
  handoffId: 'h-a', orderId: 'o-a', displayNumber: '0552', clientName: 'Bluebell Interiors', versionNumber: 2,
  stillCurrent: true, answeredAt: '2026-11-01T06:00:00Z', answeredByName: 'Nitish Bansal',
  canDo: 1, cannotDo: 1, discuss: 1, lines: [], ...over,
})

const alignment = (over: Record<string, unknown> = {}) => ({
  ...ref('541'), state: 'awaiting_reviewer', waitingOn: 'reviewer', since: '2026-10-30T08:00:00Z',
  waitingSeconds: 0, detail: null, advanceBlocks: false, ...over,
}) as AlignmentRow

describe('which card a row sits in', () => {
  test('each kind of row lands in exactly one card, and a document submission is a change on an order', () => {
    assert.equal(reviewRow(review(1), 'Ashok Choudhary', null).card, 'new_pis')
    assert.equal(revisionRow(revision, null).card, 'changes')
    assert.equal(changeRequestRow(changeRequest(), null).card, 'changes')
    assert.equal(documentRow({ submission: documentSubmission(), orderNumber: '534', mine: false, client: 'Lakeview Resort' }, null).card, 'changes')
    assert.equal(operationsAnswerRow(answer()).card, 'from_ops')
    assert.equal(awaitingReviewRow(alignment(), 'Nitish Bansal')?.card, 'waiting')
  })

  test('a flagged PI follows whoever holds it: the approver, Sales, or the approver again once Sales has replied', () => {
    const mine = flaggedRow(flaggedPi())
    assert.equal(mine.card, 'from_ops')
    assert.deepEqual(mine.who, { name: 'Nitish Bansal', team: 'operations', caption: 'Operations' })
    assert.equal(mine.next, 'Respond')

    const withSales = flaggedRow(flaggedPi({ holder: 'sales', mine: false }), undefined, 'Ashok Choudhary')
    assert.equal(withSales.card, 'waiting')
    assert.deepEqual(withSales.who, { name: 'Ashok Choudhary', team: 'sales', caption: 'Sales' })

    const replied = flaggedRow(flaggedPi({ reply: 'Client agrees', reply_by_name: 'Ashok Choudhary', reply_at: '2026-11-01T08:00:00Z' }))
    assert.equal(replied.card, 'changes', 'the same PI moves from Waiting on others to Changes on running orders when Sales replies')
    assert.deepEqual(replied.who, { name: 'Ashok Choudhary', team: 'sales', caption: 'Replied' })
    assert.equal(replied.next, 'Forward')
  })

  test('with Sales and no salesperson on record the row still names the team, never a person it does not know', () => {
    const row = flaggedRow(flaggedPi({ holder: 'sales', mine: false }))
    assert.equal(row.who.name, null)
    assert.equal(row.who.team, 'sales')
  })

  test('an order waiting on the Operations reviewer is Waiting on others, named; with nobody assigned it says so', () => {
    const named = awaitingReviewRow(alignment(), 'Nitish Bansal')
    assert.deepEqual(named?.who, { name: 'Nitish Bansal', team: 'operations', caption: 'Operations' })
    assert.equal(named?.chip?.label, 'Awaiting operations review')
    assert.match(named?.href ?? '', /^\/orders\/id-541\?/)
    assert.equal(named?.ref, 'Order 541')
    const nobody = awaitingReviewRow(alignment({ state: 'awaiting_unassigned', waitingOn: 'administrator' }), null)
    assert.deepEqual(nobody?.who, { name: null, team: 'nobody', caption: 'No reviewer' })
    assert.equal(nobody?.chip?.tone, 'warn')
  })

  test('the other alignment states are not rows: a flagged PI is already a flagged row, and the rest wait on payment, not a person', () => {
    for (const state of ['clarification_needed', 'held_advance', 'accepted_not_aligned', 'no_handoff']) {
      assert.equal(awaitingReviewRow(alignment({ state }), 'Nitish Bansal'), null, state)
    }
  })

  test('Operations\' answers are rows only while they still ask something of the approver', () => {
    const NOW = Date.parse('2026-11-05T08:00:00Z')
    assert.equal(needsFollowUp(answer(), NOW), true, 'a cannot-do and a to-discuss')
    assert.equal(needsFollowUp(answer({ cannotDo: 0, discuss: 1 }), NOW), true)
    assert.equal(needsFollowUp(answer({ canDo: 3, cannotDo: 0, discuss: 0 }), NOW), false, 'a clean yes needs nothing')
    assert.equal(needsFollowUp(answer({ stillCurrent: false }), NOW), false, 'a later version replaced it')
    const limit = Date.parse('2026-11-01T06:00:00Z') + OPERATIONS_ANSWER_DAYS * 86400 * 1000
    assert.equal(needsFollowUp(answer(), limit), true)
    assert.equal(needsFollowUp(answer(), limit + 1), false, 'answers have no "done" state, so an old one leaves instead of turning red for ever')
    assert.equal(needsFollowUp(answer({ answeredAt: 'not a date' }), NOW), false)
  })

  test('an answer row says what Operations answered, in the dashboard\'s own words', () => {
    const row = operationsAnswerRow(answer())
    assert.equal(row.chip?.label, 'Answer on PI V2')
    assert.equal(row.chip?.sub, '1 can do · 1 cannot do · 1 to discuss')
    assert.equal(row.chip?.tone, 'danger')
    assert.equal(operationsAnswerRow(answer({ cannotDo: 0 })).chip?.tone, 'warn')
    assert.equal(row.ref, 'Order 552 · PI V2')
  })

  test('splitCards puts every row in one card and keeps the order it was given', () => {
    const NOW = Date.parse('2026-11-02T08:00:00Z')
    const rows = sortDecisionRows([
      reviewRow(review(1), null, null), revisionRow(revision, null), flaggedRow(flaggedPi()),
      flaggedRow(flaggedPi({ handoff_id: 'h-2', holder: 'sales', mine: false })),
      documentRow({ submission: documentSubmission(), orderNumber: '534', mine: false, client: 'Lakeview Resort' }, null),
    ], NOW)
    const cards = splitCards(rows)
    assert.deepEqual(cards.new_pis.map(r => r.key), ['pi-sub-1'])
    assert.deepEqual(cards.changes.map(r => r.key), ['rev-v-1', 'doc-doc-1'], 'a document submission is a change on an order')
    assert.deepEqual(cards.from_ops.map(r => r.key), ['flag-h-546'])
    assert.deepEqual(cards.waiting.map(r => r.key), ['flag-h-2'])
    const placed = [...cards.new_pis, ...cards.changes, ...cards.from_ops, ...cards.waiting]
    assert.equal(placed.length, rows.length)
    assert.equal(new Set(placed.map(r => r.key)).size, rows.length, 'no row is in two places')
  })

  test('the four cards are fixed, in the order the owner chose, three on the approver and one with others', () => {
    assert.deepEqual(CARD_DEFS.map(c => c.key), ['new_pis', 'changes', 'from_ops', 'waiting'])
    assert.deepEqual(CARD_DEFS.map(c => c.side), ['you', 'you', 'you', 'others'])
    assert.deepEqual(CARD_DEFS.map(c => c.title), ['New PIs to approve', 'Changes on running orders', 'Clarifications from Operations', 'Waiting on others'])
  })

  test('the people holding things, longest waiting first: who is not taking action', () => {
    const NOW = Date.parse('2026-11-05T08:00:00Z')
    const rows = sortDecisionRows([
      flaggedRow(flaggedPi({ handoff_id: 'a', holder: 'sales', mine: false, since: '2026-11-04T08:00:00Z' }), undefined, 'Prerna Singh'),
      flaggedRow(flaggedPi({ handoff_id: 'b', holder: 'sales', mine: false, since: '2026-10-28T08:00:00Z' }), undefined, 'Mohit Sharma'),
      flaggedRow(flaggedPi({ handoff_id: 'c', holder: 'sales', mine: false, since: '2026-11-01T08:00:00Z' }), undefined, 'Mohit Sharma'),
    ], NOW)
    const people = peopleOf(rows)
    assert.deepEqual(people.map(p => [p.name, p.count]), [['Mohit Sharma', 2], ['Prerna Singh', 1]])
    assert.equal(people[0].oldestSeconds, 8 * 86400)
  })

  test('names: first name for the row, two initials for the avatar, a dash when nobody is named', () => {
    assert.equal(firstName('Mohit Sharma'), 'Mohit')
    assert.equal(firstName(null), '')
    assert.equal(initialsOf('Mohit Sharma'), 'MS')
    assert.equal(initialsOf('Nitish Kumar Bansal'), 'NB')
    assert.equal(initialsOf('Ashok'), 'AS')
    assert.equal(initialsOf(null), '–')
  })
})

// ── The four cards, drawn ────────────────────────────────────────────────────

describe('The approver\'s dashboard, drawn', () => {
  const NOW = Date.parse('2026-11-02T08:00:00Z')
  const ready = (rows: DecisionRow[], extra: { flaggedFailed?: boolean; changesFailed?: boolean } = {}) =>
    html(createElement(DecisionCards, { state: { kind: 'ready', rows: sortDecisionRows(rows, NOW), ...extra } }))
  /** The markup of the section with this heading. */
  const sectionOf = (out: string, title: string) => out.split('<section').find(s => s.includes(`>${title}</h2>`)) ?? ''
  const rowsIn = (markup: string) => (markup.match(/class="row[ "]/g) ?? []).length

  test('only what has rows is drawn: no group, section or heading for an empty one', () => {
    const out = ready([flaggedRow(flaggedPi())])
    assert.match(out, />Needs your action</)
    assert.match(out, /Qavaali/)
    for (const gone of ['New PIs to approve', 'Changes on running orders', 'Watching']) {
      assert.equal(out.includes(gone), false, `${gone} has no rows, so it is not drawn`)
    }
    assert.equal(/Nothing here/.test(out), false)
  })

  test('when nothing waits anywhere one line says so, with no heading; a failed read never says it', () => {
    const none = ready([])
    assert.match(none, /Nothing is waiting on you, and nobody is holding anything for you\./)
    assert.equal(/<h2/.test(none), false)
    const failed = ready([], { flaggedFailed: true })
    assert.equal(/Nothing is waiting/.test(failed), false, 'a failed read is not "all clear"')
    assert.match(failed, /role="alert"[^>]*>PIs flagged by Operations could not be loaded/)
    assert.ok(ready([], { changesFailed: true }).includes(CHANGES_LOAD_FAILED))
  })

  test('PIs: number, client, who sent it, the wait and its day, the status, the button, and no value anywhere', () => {
    const out = ready([reviewRow(review(1), 'Ashok Choudhary', paymentChip({ approval_position: 'standard_met', verified_percent: 40 }))])
    const sheet = sectionOf(out, 'Needs your action')
    assert.match(sheet, />PID-00001</)
    assert.match(sheet, /Client 1/)
    assert.match(sheet, />Ashok</)
    assert.match(sheet, /title="Sales"/)
    assert.match(sheet, /1 d 22 h/)
    assert.match(sheet, /Since 31 Oct/)
    assert.match(sheet, /Payment met/)
    assert.match(sheet, /Verified 40%/)
    assert.match(sheet, />Review</)
    assert.equal(/₹/.test(out), false, 'the owner dropped the value column')
    assert.equal(/Value/.test(out), false)
  })

  test('the order number leads every kind of row', () => {
    const out = ready([
      revisionRow(revision, 'Ashok Choudhary'),
      changeRequestRow(changeRequest(), 'Ashok Choudhary'),
      flaggedRow(flaggedPi()),
    ])
    assert.match(out, />#531</)
    assert.match(out, />#527</)
    assert.match(out, />#546</)
  })

  test('"Start with" names the longest wait, and only that row has the solid button', () => {
    const out = ready([
      reviewRow(review(1, { submitted_at: '2026-10-31T10:00:00Z' }), null, null),
      reviewRow(review(2, { submitted_at: '2026-10-29T10:00:00Z' }), null, null),
      reviewRow(review(3, { submitted_at: '2026-11-02T01:00:00Z' }), null, null),
    ])
    assert.match(out, /Start with Client 2, waiting 3 d 22 h/)
    assert.equal((out.match(/doSolid/g) ?? []).length, 1)
    assert.ok(out.indexOf('Client 2') < out.indexOf('Client 1'), 'longest waiting first')
  })

  test('a day is amber and three is red with an icon; only the row to start with is tinted, never colour alone', () => {
    const out = ready([
      reviewRow(review(1, { submitted_at: '2026-10-31T10:00:00Z' }), null, null),
      reviewRow(review(2, { submitted_at: '2026-10-29T10:00:00Z' }), null, null),
    ])
    assert.match(out, /ageWarn/)
    assert.match(out, /ageDanger/)
    assert.equal((out.match(/class="row rowHot"/g) ?? []).length, 1, 'only the row to start with is tinted')
    assert.equal((out.match(/<svg/g) ?? []).length >= 3, true)
  })

  test('one header per section: no column-heading row, group names only when there is more than one group, "Start with" only when there is a choice', () => {
    const one = ready([reviewRow(review(1), null, null)])
    assert.equal(/class="cols"/.test(one), false)
    assert.equal(/New PIs to approve/.test(one), false, 'a single group needs no name of its own')
    assert.equal(/Start with/.test(one), false, 'one row: nothing to choose between')
    assert.match(one, /doSolid/, 'its button is still the one to press')
    const two = ready([reviewRow(review(1), null, null), flaggedRow(flaggedPi())])
    assert.match(two, /New PIs to approve/)
    assert.match(two, /Clarifications from Operations/)
    assert.match(two, /Start with/)
  })

  test('each kind is in its own group, and a cancellation and a round are named', () => {
    const out = ready([
      reviewRow(review(1), null, null),
      changeRequestRow(changeRequest({ request_type: 'cancel' }), 'Ashok Choudhary'),
      revisionRow(revision, 'Ashok Choudhary'),
      flaggedRow(flaggedPi({ round: 2 })),
    ])
    const sheet = sectionOf(out, 'Needs your action')
    const at = ['New PIs to approve', 'Changes on running orders', 'Clarifications from Operations'].map(t => sheet.indexOf(t))
    assert.ok(at.every(i => i >= 0) && at[0] < at[1] && at[1] < at[2], 'in the owner\'s order')
    assert.match(sheet, /Cancel this Order/)
    assert.match(sheet, /Change fabric on 4 chairs/)
    assert.match(sheet, /Operations cannot accept PI V1/)
    assert.match(sheet, />Round 2</)
  })

  test('Watching is flat: a wait bar where the button would be, the person buttons when two hold things', () => {
    const rows = [
      flaggedRow(flaggedPi({ handoff_id: 'a', holder: 'sales', mine: false }), undefined, 'Mohit Sharma'),
      flaggedRow(flaggedPi({ handoff_id: 'b', holder: 'sales', mine: false, since: '2026-10-31T08:00:00Z' }), undefined, 'Ashok Choudhary'),
    ]
    const out = ready(rows)
    const watch = sectionOf(out, 'Watching')
    assert.match(watch, /Held by Sales or Operations/)
    assert.match(watch, /aria-label="Filter by person"/)
    assert.match(watch, />Mohit</)
    assert.match(watch, />Ashok</)
    assert.match(watch, />Mohit</, 'the person is just a name')
    assert.match(watch, /lucide-chevron-right/, 'a quiet chevron stands where the button would be')
    assert.equal(/wbar/.test(watch), false, 'no wait bar: the number already says it')
    assert.equal(/rowHot/.test(watch), false, 'Watching has no tint')
    assert.equal(/class="do/.test(watch), false, 'nothing is asked of the reader')
    assert.equal(out.includes('Needs your action'), false, 'with only watched rows there is no action sheet')
    assert.equal(/Filter by person/.test(sectionOf(ready(rows.slice(0, 1)), 'Watching')), false, 'one person: nothing to filter')
  })

  test('Watching shows five rows and offers the rest', () => {
    const rows = Array.from({ length: 6 }, (_, i) => flaggedRow(flaggedPi({ handoff_id: `h${i}`, holder: 'sales', mine: false, since: `2026-10-2${i}T08:00:00Z` }), undefined, 'Mohit Sharma'))
    const watch = sectionOf(ready(rows), 'Watching')
    assert.match(watch, /Show all 6/)
    assert.equal(rowsIn(watch), 5)
    assert.equal(/Show all/.test(sectionOf(ready(rows.slice(0, 5)), 'Watching')), false)
  })

  test('Design Files and Client PO are rows of "Changes on running orders", with the files and where they stand', () => {
    const docs = [
      documentRow({ submission: documentSubmission({ id: 'doc-1', order_id: 'o-1', submitted_at: '2026-10-30T10:00:00Z' }), orderNumber: '534', mine: false, client: 'Lakeview Resort' }, 'Ashok Choudhary'),
      documentRow({ submission: documentSubmission({ id: 'doc-2', order_id: 'o-2', includes_design_files: false, includes_client_po: true, status: 'awaiting_operations', submitted_at: '2026-11-01T10:00:00Z' }), orderNumber: '535', mine: false, client: 'Other Client' }, null),
    ]
    const out = ready(docs)
    const sheet = sectionOf(out, 'Needs your action')
    assert.match(sheet, /Lakeview Resort/)
    assert.match(sheet, />#534</)
    assert.match(sheet, /Design Files/)
    assert.match(sheet, /3 files · Awaiting your decision/)
    assert.match(sheet, /Client PO/)
    assert.match(sheet, /3 files · Awaiting your acceptance/)
    assert.match(sheet, /href="\/orders\/o-1#documents"/)
    assert.equal(/also wait/.test(out), false, 'there is no separate documents line any more')
  })

  test('a failed read is an error, view-as is explained, loading is announced', () => {
    const error = html(createElement(DecisionCards, { state: { kind: 'error' } }))
    assert.match(error, /role="alert"[^>]*>What is waiting for you could not be loaded/)
    assert.equal(/Nothing is waiting/.test(error), false, 'an error is never "nothing"')
    assert.match(html(createElement(DecisionCards, { state: { kind: 'unavailable' } })), /view as someone else/)
    assert.match(html(createElement(DecisionCards, { state: { kind: 'loading' } })), /aria-busy="true"/)
  })
})

// ── Who is asked to decide a change request ───────────────────────────────────

describe('the change-request read', () => {
  // A table-by-table stand-in for the client: every chain call answers with the same builder, which resolves to
  // that table's answer. It records which tables were asked, because the point is who reads what.
  function fakeSupabase(answers: Record<string, { data?: unknown[]; error?: { message: string } }>, rpcData: Record<string, unknown> = {}) {
    const asked: string[] = []
    const chain = (table: string): unknown => {
      const answer = answers[table] ?? {}
      const builder: unknown = new Proxy({}, {
        get: (_t, prop) => (prop === 'then'
          ? (resolve: (v: unknown) => unknown) => resolve({ data: answer.data ?? [], error: answer.error ?? null })
          : () => builder),
      })
      return builder
    }
    return { asked, client: { from: (table: string) => { asked.push(table); return chain(table) }, rpc: async (fn: string) => ({ data: rpcData[fn] ?? [], error: null }) } }
  }
  const pending = [{ ...changeRequest(), requested_by_user: { full_name: 'Ashok Choudhary' } }]

  test('an acting administrator reads them and sees them, with who asked', async () => {
    const f = fakeSupabase({ order_change_requests: { data: pending } })
    const read = await loadDecisionRows(f.client as never, { viewerId: 'u-admin', isAdmin: true, canReviewChanges: true })
    assert.ok(read)
    assert.ok(f.asked.includes('order_change_requests'))
    assert.deepEqual(read.rows.map(r => r.key), ['chg-c-1'])
    assert.equal(read.rows[0].by, 'Ashok Choudhary')
    assert.equal(read.changesFailed, false)
  })

  test('anybody else is never asked: the table also returns a requester their own rows, so the read itself is withheld', async () => {
    const f = fakeSupabase({ order_change_requests: { data: pending } })
    const read = await loadDecisionRows(f.client as never, { viewerId: 'u-approver', isAdmin: true, canReviewChanges: false })
    assert.ok(read)
    assert.equal(f.asked.includes('order_change_requests'), false)
    assert.deepEqual(read.rows, [])
    assert.equal(read.changesFailed, false)
  })

  test('a failed read leaves the other rows and says it failed', async () => {
    const f = fakeSupabase({ order_change_requests: { error: { message: 'boom' } } })
    const read = await loadDecisionRows(f.client as never, { viewerId: 'u-admin', isAdmin: true, canReviewChanges: true })
    assert.ok(read, 'the PI read did not fail, so the list is still drawn')
    assert.equal(read.changesFailed, true)
    assert.deepEqual(read.rows, [])
  })
})

describe('the rows the cards add to the read (2026-11-20)', () => {
  function fakeSupabase(answers: Record<string, { data?: unknown[] }>, rpcData: Record<string, unknown> = {}) {
    const asked: string[] = []
    const chain = (table: string): unknown => new Proxy({}, {
      get: (_t, prop) => (prop === 'then'
        ? (resolve: (v: unknown) => unknown) => resolve({ data: answers[table]?.data ?? [], error: null })
        : () => chain(table)),
    })
    return { asked, client: { from: (table: string) => { asked.push(table); return chain(table) }, rpc: async (fn: string) => ({ data: rpcData[fn] ?? [], error: null }) } }
  }
  const viewer = { viewerId: 'u-admin', isAdmin: true, canReviewChanges: false }
  const flaggedApi = {
    handoff_id: 'h-546', order_id: 'o-546', order_number: '0546', client_name: 'Qavaali', version_number: 1,
    reason: 'Client wanted a visit first.', by_name: 'Nitish Bansal', since: '2026-10-30T08:00:00Z',
    waiting_seconds: 0, holder: 'sales', mine: false, round: 1,
  }

  test('a PI with Sales is named by the Order\'s salesperson, and the Orders are asked only when something is flagged', async () => {
    const f = fakeSupabase({ orders: { data: [{ id: 'o-546', salesperson: { full_name: 'Ashok Choudhary' } }] } }, { my_flagged_pis: [flaggedApi] })
    const read = await loadDecisionRows(f.client as never, viewer)
    assert.ok(read)
    assert.ok(f.asked.includes('orders'))
    const row = read.rows.find(r => r.key === 'flag-h-546')
    assert.equal(row?.card, 'waiting')
    assert.equal(row?.who.name, 'Ashok Choudhary')

    const none = fakeSupabase({})
    await loadDecisionRows(none.client as never, viewer)
    assert.equal(none.asked.includes('orders'), false, 'nothing flagged: no extra read')
  })

  test('a PI with Sales whose Order has no salesperson on record is still a row, naming the team', async () => {
    const f = fakeSupabase({ orders: { data: [{ id: 'o-546', salesperson: null }] } }, { my_flagged_pis: [flaggedApi] })
    const read = await loadDecisionRows(f.client as never, viewer)
    const row = read?.rows.find(r => r.key === 'flag-h-546')
    assert.equal(row?.who.name, null)
    assert.equal(row?.who.team, 'sales')
  })

  test('Operations\' answers and the orders waiting on Operations come from the page and cost no read of their own', async () => {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString()
    const f = fakeSupabase({})
    const read = await loadDecisionRows(f.client as never, {
      ...viewer,
      alignment: [alignment({ since: recent })], reviewerName: 'Nitish Bansal',
      answers: [answer({ answeredAt: recent }), answer({ handoffId: 'h-b', answeredAt: recent, canDo: 2, cannotDo: 0, discuss: 0 })],
    })
    assert.ok(read)
    assert.deepEqual(read.rows.map(r => r.key).sort(), ['ans-h-a', 'wait-id-541'], 'the clean yes is not a row')
    assert.equal(f.asked.some(t => /handoff|change_answers/.test(t)), false)
  })
})

describe('Revenue', () => {
  test('the three periods, the method, and a zero month that is not a failure', () => {
    const out = html(createElement(AdminRevenueCard, { revenue: summaryOf().revenue! }))
    assert.match(out, /Current month/)
    assert.match(out, /Last 6 completed months/)
    assert.match(out, /Current year/)
    assert.match(out, /₹0/)
    assert.match(out, /Nothing confirmed yet this month/)
    assert.match(out, /≈ ₹22\.6 L a month/)
    assert.match(out, /₹1,35,81,352/)
    assert.match(out, /1 May – 31 Oct 2026/)
    assert.match(out, /Product value, excl\. GST/)
    assert.equal(/danger|blocked/.test(out), false, 'a zero month is not drawn in an alarm colour')
  })

  test('a month with orders drops the "nothing yet" line; gaps are still said', () => {
    const s = summaryOf()
    const revenue = { ...s.revenue!, currentMonth: { ...s.revenue!.currentMonth, amount: 482500, orders: 3 }, gaps: { ...s.revenue!.gaps, noConfirmDate: 2 } }
    const out = html(createElement(AdminRevenueCard, { revenue }))
    assert.equal(/Nothing confirmed yet/.test(out), false)
    assert.match(out, /₹4,82,500/)
    assert.match(out, /2 orders with no confirmation date are not in any figure/)
  })
})

describe('Orders to watch', () => {
  test('opens on the first list with rows, and the pipeline says where the orders are', () => {
    const out = html(createElement(AdminOrdersBoard, { summary: summaryOf() }))
    assert.match(out, /Orders to watch/)
    assert.match(out, /<b>12<\/b> running orders/)
    assert.match(out, /11 ready for production · ₹1,34,64,665/)
    assert.match(out, /1 not aligned/)
    assert.match(out, /aria-selected="true"[^>]*>Delayed/)
    assert.match(out, /#531/)
    assert.match(out, /6 days late/)
    assert.match(out, /Salesperson: Ashok Choudhary/)
    assert.match(out, /₹3,10,500/)
    assert.match(out, /href="\/orders\/id-531\?/)
  })

  test('the tab counts are the headline figures', () => {
    const out = html(createElement(AdminOrdersBoard, { summary: summaryOf() }))
    for (const label of ['Delayed', 'Due in 7 days', 'Payments pending', 'Fabric / finish', 'Not aligned']) assert.match(out, new RegExp(label))
    assert.equal(/Ready for production<span/.test(out), false, 'ready for production is the bar, not a tab')
  })

  test('with nothing late the first list with rows opens, and an empty list says so in a sentence', () => {
    const s = summaryOf()
    const opened = html(createElement(AdminOrdersBoard, { summary: { ...s, overview: emptyOverview(s) } }))
    assert.match(opened, /aria-selected="true"[^>]*>Not aligned/)
    assert.match(opened, /#541/)
    const quiet = html(createElement(AdminOrdersBoard, { summary: { ...s, overview: emptyOverview(s), notAligned: [] } }))
    assert.match(quiet, /No running order is past its due date\./)
  })

  test('long lists show five and offer the rest', () => {
    const s = summaryOf()
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...ref(`5${i}0`), confirmDate: '2026-10-01', daysSinceConfirmation: 20 + i,
      pending: [{ kind: 'fabric' as const, status: 'not_approved' as const }], notRecorded: [],
    }))
    const out = html(createElement(AdminOrdersBoard, { summary: { ...s, overview: emptyOverview(s), notAligned: [], fabricFinish: many } }))
    assert.match(out, /Fabric not approved/)
    assert.match(out, /Show all 8 orders/)
    assert.equal((out.match(/class="brow"/g) ?? []).length, 5)
  })

  test('before the database offers the overview the board draws nothing', () => {
    assert.equal(html(createElement(AdminOrdersBoard, { summary: summaryOf({ overview: null }) })), '')
  })

  test('the payments chip says what is verified, the figure column says what is short', () => {
    const s = summaryOf()
    const advance = [{ ...ref('539'), orderValue: 1695633, verified: 474780, percent: 28, shortfall: 203476, exceptionApproved: false, held: false }]
    const out = html(createElement(AdminOrdersBoard, { summary: { ...s, overview: emptyOverview(s), notAligned: [], advance } }))
    assert.match(out, /28% verified/)
    assert.match(out, /₹2,03,476/)
    assert.match(out, /Short/)
  })
})

// ── What the page keeps, and what it drops ───────────────────────────────────

describe('the page', () => {
  const page = read('src/app/orders/page.tsx')

  test('the approver gets the new dashboard, and the old queue component is gone', () => {
    assert.ok(page.includes('<AdminDashboardView'))
    assert.equal(page.includes('PiReviewSections'), false)
    assert.equal(existsSync(join(ROOT, 'src/components/orders/dashboard/PiReviewSections.tsx')), false)
    assert.equal(/\.pi-q/.test(read('src/app/globals.css')), false, 'the retired queue styles are gone')
  })

  test('only the acting administrator is asked to decide change requests, and View As never lends that', () => {
    assert.ok(page.includes("canReviewChanges={profile?.role === 'admin' && !viewAsUserId}"))
    assert.ok(read('src/components/orders/dashboard/AdminDashboardView.tsx').includes('canReviewChanges={canReviewChanges}'))
    const src = read('src/components/orders/dashboard/DecisionQueue.tsx')
    assert.ok(src.includes('viewer.canReviewChanges'))
    assert.ok(src.includes("from('order_change_requests')"))
    assert.ok(src.includes(".eq('status', 'pending')"))
  })

  test('the approver\'s dashboard is the four cards and a revenue strip: no Orders to watch, and Operations\' answers are rows', () => {
    const view = read('src/components/orders/dashboard/AdminDashboardView.tsx')
    assert.equal(view.includes('<AdminOrdersBoard'), false, 'Orders to watch is no longer drawn')
    assert.equal(view.includes('AdminRevenueCard'), false, 'the revenue strip is off this page for now (owner, 2026-11-20)')
    assert.ok(view.includes('alignment={summary.notAligned}'))
    assert.ok(view.includes('answers={answers}'))
    assert.ok(page.includes("answers={operations.kind === 'ready' ? operations.read.responses : NO_ANSWERS}"))
    assert.match(page, /operations\.read\.viewer\.isApprover && !approverView/, 'the separate answers list is for readers who are not on the cards')
    assert.ok(page.includes('const NO_ANSWERS'), 'a stable empty list: a new one each render would re-run the cards\' read')
  })

  test('the approver branch no longer draws the three plain cards', () => {
    assert.equal(page.includes("only={['payments', 'fabric', 'aligned']}"), false)
  })

  test('the approver view hides only the "needs you" half of the document queue', () => {
    assert.ok(page.includes('hideNeedsYou={approverView}'))
    assert.ok(page.includes('<DocumentActionQueue'))
  })

  test('everything everybody else has is still there', () => {
    for (const keep of ['<ActionBoard', '<RevenueSection', '<StatusStrip', '<FactoryFocusSection', '<OperationsResponses',
      '<SalespersonDashboardView', '<OperationsDashboardView', "supabase.rpc('orders_dashboard_summary')"]) {
      assert.ok(page.includes(keep), keep)
    }
  })

  test('the decision list reads under the reader\'s own rights and takes the chip from the database', () => {
    const src = read('src/components/orders/dashboard/DecisionQueue.tsx')
    assert.ok(src.includes("from('order_submissions')"))
    // The revisions and documents reads are shared with the documents list (2026-11-12): same
    // client, the reader's own session, so still under the reader's own rights.
    assert.ok(src.includes('readOpenPiRevisions(supabase)'))
    assert.ok(src.includes('readOpenDocumentSubmissions(supabase)'))
    const shared = read('src/components/orders/DocumentActionQueue.tsx')
    assert.ok(shared.includes(".from('order_pi_versions')"))
    assert.ok(shared.includes(".from('order_document_submissions')"))
    assert.equal(/service|createClient/.test(shared), false, 'no service role in the shared reads')
    assert.ok(src.includes('loadPiPaymentSummaries'))
    assert.equal(/service|createClient|attached_percent/.test(src), false, 'no service role, and no percentage worked out for the chip')
    assert.ok(src.includes('viewingAs'), 'nothing is read under View As')
  })
})

// ── The approver's first paint: two rounds, the first beside the page's own reads (2026-11-21) ──────────────────────

describe('the approver\'s cards read in two rounds, and the first starts with the page', () => {
  // A stand-in for the client that records what is asked of it, and answers each table from `answers`. The documents
  // table is recognised by its ending so this file never needs to spell the whole name.
  function fakeClient(answers: Record<string, unknown[]>, opts: { failTable?: string } = {}) {
    const asked: string[] = []
    const selects: Record<string, string> = {}
    const answerFor = (table: string) => answers[table] ?? (table.endsWith('document_submissions') ? answers.documents ?? [] : [])
    const chain = (table: string): unknown => new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve(table === opts.failTable
            ? { data: null, error: { message: 'refused' } }
            : { data: answerFor(table), error: null })
        }
        if (prop === 'select') return (s: string) => { selects[table] = s; return chain(table) }
        return () => chain(table)
      },
    })
    const rpcs: string[] = []
    return {
      asked, selects, rpcs,
      client: {
        from: (table: string) => { asked.push(table); return chain(table) },
        rpc: async (fn: string) => { rpcs.push(fn); return { data: fn === 'my_flagged_pis' || fn === 'pi_submissions_payment_summaries' ? [] : null, error: null } },
      },
    }
  }
  const viewer = { viewerId: 'u-admin', isAdmin: true, canReviewChanges: true }
  const full = () => ({
    order_submissions: [review(1, { submitter: { full_name: 'Ashok Choudhary' } })],
    order_pi_versions: [{
      id: 'v-1', order_id: 'o-9', version_number: 2, status: 'pending', uploaded_by: 'u-up', uploaded_at: '2026-10-29T10:00:00Z',
      operations_reviewer: null, revision_reason: 'Change fabric', order: { display_number: '531', client_name: 'Aarav Interiors' },
      uploader: { full_name: 'Mohit Sharma' }, ops_reviewer: null,
    }],
    documents: [{
      ...documentSubmission({ submitted_by: 'u-doc' }), order: { display_number: '534', client_name: 'Lakeview Resort' },
      submitter: { full_name: 'Rohit Verma' }, ops_reviewer: null,
    }],
  })

  test('the people on every row are named by the row itself: users is never read, and the names are the embedded ones', async () => {
    const f = fakeClient(full())
    const read = await loadDecisionRows(f.client as never, viewer)
    assert.ok(read)
    assert.equal(f.asked.includes('users'), false, 'no second lookup of users')
    assert.deepEqual(read.rows.map(r => r.by).sort(), ['Ashok Choudhary', 'Mohit Sharma', 'Rohit Verma'])
    // The embeds are asked for on all three lists, over the foreign keys that exist on those tables.
    assert.ok(f.selects.order_submissions.includes('submitter:users!submitted_by(full_name)'))
    assert.ok(f.selects.order_pi_versions.includes('uploader:users!uploaded_by(full_name)'))
    assert.ok(f.selects.order_pi_versions.includes('ops_reviewer:users!operations_reviewer(full_name)'))
    const docsSelect = Object.entries(f.selects).find(([t]) => t.endsWith('document_submissions'))?.[1] ?? ''
    assert.ok(docsSelect.includes('submitter:users!submitted_by(full_name)'))
    assert.ok(docsSelect.includes('ops_reviewer:users!operations_reviewer(full_name)'))
  })

  test('a person the reader may not see comes back null and is left unnamed, as a missing lookup was', async () => {
    const answers = full()
    answers.order_submissions = [review(1, { submitter: null })]
    const read = await loadDecisionRows(fakeClient(answers).client as never, viewer)
    assert.equal(read?.rows.find(r => r.key === 'pi-sub-1')?.by, null)
  })

  test('the first round is the five lists beside each other; only the payment summaries wait for it', async () => {
    const f = fakeClient({ ...full() })
    const data = await readDecisionData(f.client as never, viewer)
    assert.ok(data)
    assert.deepEqual([...new Set(f.asked)].sort(), ['order_change_requests', 'order_pi_versions', 'order_submissions',
      ...f.asked.filter(t => t.endsWith('document_submissions'))].sort())
    assert.deepEqual(f.rpcs.sort(), ['my_flagged_pis', 'pi_submissions_payment_summaries'], 'the chips are one call, not one per PI')
  })

  test('the page\'s own answers are laid over rows already read: composing again reads nothing', async () => {
    const f = fakeClient(full())
    const data = await readDecisionData(f.client as never, viewer)
    assert.ok(data)
    const askedBefore = f.asked.length + f.rpcs.length
    const plain = composeDecisionRows(data, {})
    const recent = new Date(Date.now() - 3600 * 1000).toISOString()
    const withWaiting = composeDecisionRows(data, { alignment: [alignment({ since: recent })], reviewerName: 'Nitish Bansal' })
    assert.equal(withWaiting.rows.length, plain.rows.length + 1, 'the page\'s alignment list adds its row')
    assert.equal(f.asked.length + f.rpcs.length, askedBefore, 'and costs no read')
  })

  test('a failed PI read is still an error: null, never an empty list, and the early read never rejects', async () => {
    const f = fakeClient(full(), { failTable: 'order_submissions' })
    assert.equal(await readDecisionData(f.client as never, viewer), null)
    assert.equal(await startDecisionRead(fakeClient(full(), { failTable: 'order_submissions' }).client as never, viewer).read, null)
  })

  test('started early, each open-queue table is read once and the same reads are handed on', async () => {
    const reads: string[] = []
    const from = (table: string) => {
      const query: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'eq', 'order']) query[m] = () => query
      query.limit = () => { reads.push(table); return Promise.resolve({ data: [], error: null }) }
      return query
    }
    const client = { from, rpc: async () => ({ data: [], error: null }) } as never
    const early = startDecisionRead(client, viewer)
    await Promise.all([early.read, early.revisions, early.documents])
    assert.equal(reads.filter(t => t === 'order_pi_versions').length, 1, 'revised PIs: one read for both lists')
    assert.equal(reads.filter(t => t.endsWith('document_submissions')).length, 1, 'documents: one read for both lists')
    assert.equal(reads.filter(t => t === 'order_submissions').length, 1)
  })

  test('an early read is used only for the reader and the rights it was started for', () => {
    const f = fakeClient({})
    const early = startDecisionRead(f.client as never, viewer)
    assert.equal(usableEarlyRead(early, viewer), early.read)
    assert.equal(usableEarlyRead(early, { ...viewer, canReviewChanges: false }), null, 'change requests were read for an acting administrator only')
    assert.equal(usableEarlyRead(early, { ...viewer, isAdmin: false }), null)
    assert.equal(usableEarlyRead(early, { ...viewer, viewerId: 'u-other' }), null)
    assert.equal(usableEarlyRead(null, viewer), null)
    assert.equal(usableEarlyRead(undefined, viewer), null)
  })

  describe('in the page', () => {
    const page = read('src/app/orders/page.tsx')
    const view = read('src/components/orders/dashboard/AdminDashboardView.tsx')
    const queue = read('src/components/orders/dashboard/DecisionQueue.tsx')
    const documents = read('src/components/orders/DocumentActionQueue.tsx')

    test('it is started right after the dashboard\'s own reads are sent, and before they are awaited', () => {
      const group = page.indexOf('const dashboardReads = Promise.all([')
      const started = page.indexOf('startDecisionRead(supabase')
      const awaited = page.indexOf('] = await dashboardReads')
      assert.ok(group > 0 && started > group && awaited > started)
    })

    test('only a reader who can approve PIs starts it, never under View As, and it is kept only if the read is still the latest', () => {
      assert.ok(page.includes('ordersCaps.canApproveOrderSubmission && !viewAsUserId'))
      assert.ok(page.indexOf('if (ticket !== latest.current) return') < page.indexOf('setEarly(started)'))
      assert.equal(/\.from\(|\.rpc\(/.test(queue.slice(queue.indexOf('export function startDecisionRead'), queue.indexOf('export function DecisionQueue'))), false,
        'starting it asks for nothing outside the reads the list already made')
    })

    test('the list and the documents list are handed the same early reads, so nothing is read twice', () => {
      assert.ok(page.includes('early={early}'))
      assert.ok(page.includes('early={early ?? undefined}'))
      assert.ok(view.includes('early={early}'))
      assert.ok(documents.includes('early?.documents ?? readOpenDocumentSubmissions(supabase)'))
      assert.ok(documents.includes('early?.revisions ?? readOpenPiRevisions(supabase)'))
      assert.equal(documents.includes(".from('users')"), false, 'and the documents list names its people from the rows too')
    })

    test('the list falls back to reading for itself when the early read is not for this reader', () => {
      assert.ok(queue.includes('usableEarlyRead(early, viewer) ?? startDecisionRead(supabase, viewer).read'))
    })
  })
})
