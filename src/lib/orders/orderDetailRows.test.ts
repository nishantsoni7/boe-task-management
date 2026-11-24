/**
 * The Order page's quiet parts, in words: the three gates on the Order bar and
 * the one-line summaries of the folded rows below the products.
 *
 * Nothing here recomputes a figure; these check the WORDS for each state the
 * real builders can hand in, and the rule for when a row opens by itself.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderDetailRows.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DETAIL_ROW_ORDER,
  advanceGate,
  detailRows,
  orderBarGates,
  type DetailRowsInput,
} from './orderDetailRows'
import type { AdvanceReadiness } from './advanceReadiness'
import type { ApprovalKindStanding, ApprovalStatus } from './orderApprovals'

const advance = (over: Partial<AdvanceReadiness> = {}): AdvanceReadiness => ({
  order_value: 1240000, advance_base: 1240000, value_known: true, verified: 645000, awaiting: 0, required: 496000,
  shortfall: 0, percent: 52.01, threshold_percent: 40, below: false, ready: true, exception: null, hold: null,
  ...over,
})

const kind = (label: 'Fabric' | 'Finish', status: ApprovalStatus): ApprovalKindStanding => ({
  kind: label === 'Fabric' ? 'fabric' : 'finish', label, status,
  tone: status === 'fully_approved' ? 'green' : status === 'partially_approved' ? 'amber' : 'red',
  at: null, approver: null, actorId: null, evidencePath: null, history: [],
} as ApprovalKindStanding)

const base = (over: Partial<DetailRowsInput> = {}): DetailRowsInput => ({
  clientRows: [
    { key: 'client', label: 'Client', value: 'Aarav Interiors' },
    { key: 'location', label: 'Location', value: 'Pune' },
  ],
  salesRows: [
    { key: 'lead_source', label: 'Lead source', value: 'Instagram' },
    { key: 'salesperson', label: 'Salesperson', value: 'Meera Shah' },
  ],
  dates: { confirm: '17 Nov 2026', approved: '21 Nov 2026', due: '20 Dec 2026', daysToDue: 26 },
  payment: { loaded: true, verifiedPercent: '52.01', orderValue: '₹14,63,200', awaiting: '₹60,000', awaitingCount: 1 },
  advance: advance(),
  approvals: [kind('Fabric', 'fully_approved'), kind('Finish', 'fully_approved')],
  pendingFromClient: 0,
  internalRows: [
    { key: 'fabric_responsibility', label: 'Fabric responsibility', value: 'BOE supplies the fabric' },
    { key: 'billing_percentage', label: 'Bill / cash percentage', value: '60 / 40' },
    { key: 'middleman_commission', label: 'Middleman commission', value: 'Restricted', muted: true },
  ],
  termsCount: 3,
  commercial: [
    { label: 'Product value', value: '₹12,40,000', role: 'base' },
    { label: 'Order total', value: '₹14,63,200', role: 'final' },
  ],
  activity: { count: 14, latestLabel: 'Payment of ₹60,000 recorded', latestWhen: '24 Nov', newCount: 0 },
  acceptBlockedByAdvance: false,
  ...over,
})

const row = (rows: ReturnType<typeof detailRows>, key: string) => rows.find(r => r.key === key)!

describe('the advance gate', () => {
  test('is a dash until the readiness has been read', () => {
    const g = advanceGate(null)
    assert.equal(g.value, '—')
    assert.equal(g.chip, null)
  })

  test('met: the percentage and a green Met, with the base said in words', () => {
    const g = advanceGate(advance())
    assert.equal(g.value, '52.01%')
    assert.deepEqual(g.chip, { text: 'Met', tone: 'green' })
    assert.match(g.label, /of the Total before GST/)
    assert.match(g.label, /40% requirement is met/)
  })

  test('below: red, and the threshold is the database\'s, never a literal 40', () => {
    const g = advanceGate(advance({ percent: 25, below: true, ready: false, threshold_percent: 35 }))
    assert.deepEqual(g.chip, { text: 'Below 35%', tone: 'red' })
    assert.doesNotMatch(JSON.stringify(g), /40/)
  })

  test('approved below the threshold is amber, not red', () => {
    const g = advanceGate(advance({ percent: 30, below: true, ready: true, exception: { source: 'order', approved_by: 'u', approved_at: null } }))
    assert.deepEqual(g.chip, { text: 'Approved below 40%', tone: 'amber' })
  })

  test('a hold is red and says so', () => {
    const g = advanceGate(advance({ percent: 20, below: true, ready: false, hold: { id: 'h', cause: 'payment_changed', held_at: null, order_value: 1, previous_order_value: 1, verified: 1, percent: 20, shortfall: 1 } }))
    assert.deepEqual(g.chip, { text: 'On hold', tone: 'red' })
  })

  test('no Total before GST on record: says it cannot be measured instead of inventing a percentage', () => {
    const g = advanceGate(advance({ value_known: false, percent: null, below: true, ready: false }))
    assert.equal(g.value, '—')
    assert.equal(g.chip?.text, 'Cannot measure')
  })
})

describe('the due date on the bar', () => {
  test('counts down, and turns late once it has passed', () => {
    const ok = orderBarGates({ advance: advance(), dueDate: '20 Dec', daysToDue: 26 })
    assert.equal(ok.due.countdown, '26 days left')
    assert.equal(ok.due.late, false)
    const late = orderBarGates({ advance: advance(), dueDate: '1 Nov', daysToDue: -3 })
    assert.equal(late.due.countdown, '3 days overdue')
    assert.equal(late.due.late, true)
    const none = orderBarGates({ advance: null, dueDate: null, daysToDue: null })
    assert.equal(none.due.countdown, null)
  })
})

describe('the folded rows', () => {
  test('there are seven, in the agreed order', () => {
    const rows = detailRows(base())
    assert.deepEqual(rows.map(r => r.key), [...DETAIL_ROW_ORDER])
    assert.deepEqual(rows.map(r => r.title), [
      'Client and sale', 'Dates', 'Payment', 'Pendencies', 'Internal details and terms', 'Commercial breakdown', 'Activity',
    ])
  })

  test('a calm order: every row is folded and none carries a badge', () => {
    const rows = detailRows(base())
    for (const r of rows) {
      assert.equal(r.openByDefault, false, `${r.key} should be folded`)
      assert.equal(r.badge, null, `${r.key} should be quiet`)
      assert.equal(r.flag, null)
    }
  })

  test('summary lines say where each part stands', () => {
    const rows = detailRows(base())
    assert.equal(row(rows, 'client').summary, 'Aarav Interiors · Pune · Sales: Meera Shah · Lead: Instagram')
    assert.equal(row(rows, 'dates').summary, 'Confirmed 17 Nov 2026 · PI approved 21 Nov 2026 · Due 20 Dec 2026 (26 days left)')
    assert.equal(row(rows, 'pay').summary, '52.01% verified of the Total before GST · ₹60,000 waiting for Finance · advance met')
    assert.equal(row(rows, 'pend').summary, 'Fabric and Finish are fully approved · nothing pending from the client')
    assert.equal(row(rows, 'terms').summary, 'Fabric responsibility: BOE supplies the fabric · Bill / cash percentage: 60 / 40 · 3 general terms')
    assert.equal(row(rows, 'totals').summary, 'Order total ₹14,63,200')
    assert.equal(row(rows, 'act').summary, 'Latest: Payment of ₹60,000 recorded · 24 Nov')
  })

  test('restricted and missing values never reach a summary', () => {
    const rows = detailRows(base({
      internalRows: [{ key: 'middleman_commission', label: 'Middleman commission', value: 'Restricted', muted: true }],
      termsCount: 0,
    }))
    assert.equal(row(rows, 'terms').summary, 'Nothing is recorded on the PI')
  })

  test('a short advance: Payment carries a red badge and opens only when Accept is held up by it', () => {
    const short = advance({ percent: 25, verified: 310000, below: true, ready: false, shortfall: 186000 })
    const viewer = detailRows(base({ advance: short, acceptBlockedByAdvance: false }))
    assert.equal(row(viewer, 'pay').badge?.tone, 'red')
    assert.equal(row(viewer, 'pay').flag, 'red')
    assert.equal(row(viewer, 'pay').openByDefault, false, 'a viewer who cannot accept is not forced open')
    const reviewer = detailRows(base({ advance: short, acceptBlockedByAdvance: true }))
    assert.equal(row(reviewer, 'pay').openByDefault, true)
    assert.match(row(reviewer, 'pay').summary, /40% advance not met/)
  })

  test('open approvals and client items badge Pendencies; the count is announced in words', () => {
    const rows = detailRows(base({
      approvals: [kind('Fabric', 'partially_approved'), kind('Finish', 'not_approved')],
      pendingFromClient: 2,
    }))
    const pend = row(rows, 'pend')
    assert.equal(pend.summary, 'Fabric Partially Approved · Finish Not Approved · 2 pending from the client')
    assert.equal(pend.badge?.text, '2')
    assert.equal(pend.badge?.label, '2 items pending from the client')
    assert.equal(pend.flag, 'amber')
  })

  test('approvals open but nothing from the client: a words badge, not a number', () => {
    const rows = detailRows(base({ approvals: [kind('Fabric', 'fully_approved'), kind('Finish', 'partially_approved')], pendingFromClient: 0 }))
    assert.equal(row(rows, 'pend').badge?.text, 'Approvals open')
  })

  test('before the pendency read lands, nothing is claimed about the client', () => {
    const rows = detailRows(base({ pendingFromClient: null, approvals: [kind('Fabric', 'fully_approved'), kind('Finish', 'fully_approved')] }))
    assert.doesNotMatch(row(rows, 'pend').summary, /nothing pending/)
    assert.equal(row(rows, 'pend').badge, null)
  })

  test('payments still being read say so instead of a figure', () => {
    const rows = detailRows(base({ payment: { loaded: false, verifiedPercent: null, orderValue: null, awaiting: null, awaitingCount: 0 } }))
    assert.equal(row(rows, 'pay').summary, 'Reading payments…')
  })

  test('an overdue date flags Dates', () => {
    const rows = detailRows(base({ dates: { confirm: '1 Oct', approved: '3 Oct', due: '1 Nov', daysToDue: -4 } }))
    assert.equal(row(rows, 'dates').badge?.text, 'Overdue')
    assert.equal(row(rows, 'dates').flag, 'red')
    assert.match(row(rows, 'dates').summary, /4 days overdue/)
  })

  test('new activity since the last visit is a blue badge on the Activity row', () => {
    const rows = detailRows(base({ activity: { count: 14, latestLabel: 'X', latestWhen: '24 Nov', newCount: 3 } }))
    assert.deepEqual(row(rows, 'act').badge, { text: '3 new', tone: 'blue', label: '3 updates since your last visit' })
  })

  test('an order with no recorded facts still reads as words, never blank', () => {
    const rows = detailRows(base({
      clientRows: [], salesRows: [], dates: { confirm: null, approved: null, due: null, daysToDue: null },
      commercial: [], activity: { count: 0, latestLabel: null, latestWhen: null, newCount: 0 },
    }))
    assert.equal(row(rows, 'client').summary, 'No client details are recorded')
    assert.equal(row(rows, 'dates').summary, 'No dates are recorded')
    assert.equal(row(rows, 'totals').summary, 'No commercial lines are recorded')
    assert.equal(row(rows, 'act').summary, 'No activity yet')
  })
})
