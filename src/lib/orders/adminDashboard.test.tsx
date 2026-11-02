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
  documentRow,
  formatCompactRupees,
  isMixed,
  monthlyAverageNote,
  paymentChip,
  pipelineOf,
  reviewRow,
  revisionRow,
  sinceLabel,
  sortDecisionRows,
  waitTone,
  type DecisionRow,
} from './adminDashboard'
import { PAYMENT_POSITIONS } from './paymentGate'
import type { PersistedDocumentSubmission } from './orderDocumentSubmissions'
import type { DashboardSummary } from './orderDashboardSummary'
import { DecisionCard } from '@/components/orders/dashboard/DecisionQueue'
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

  test('the kind tag is drawn only when the list mixes kinds', () => {
    assert.equal(isMixed(rows), true)
    assert.equal(isMixed([rows[0], rows[3]]), false)
    assert.equal(isMixed([]), false)
  })

  test('each kind opens where its decision is made', () => {
    assert.match(rows[0].href, /^\/orders\/drafts\/sub-1\?/)
    assert.match(rows[1].href, /^\/orders\/o-9\?/)
    assert.equal(rows[2].href, '/orders/o-1#documents')
    assert.equal(rows[2].kindLabel, 'Design Files')
    assert.equal(rows[2].chip?.label, '3 files')
    assert.equal(rows[2].chip?.sub, 'Awaiting your decision')
    assert.equal(rows[1].chip?.sub, '“Change fabric on 4 chairs”')
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

describe('Needs your decision', () => {
  const NOW = Date.parse('2026-11-02T08:00:00Z')
  const ready = (rows: DecisionRow[]) => html(createElement(DecisionCard, { state: { kind: 'ready', rows: sortDecisionRows(rows, NOW) } }))

  test('PIs: client, who sent it, the wait, the chip, the value', () => {
    const out = ready([reviewRow(review(1), 'Ashok Choudhary', paymentChip({ approval_position: 'standard_met', verified_percent: 40 }))])
    assert.match(out, /Needs your decision/)
    assert.match(out, /Client 1/)
    assert.match(out, /PID-00001 · by Ashok Choudhary/)
    assert.match(out, /1 d 22 h/)
    assert.match(out, /Since 31 Oct/)
    assert.match(out, /Payment met/)
    assert.match(out, /Verified 40%/)
    assert.match(out, /₹1,72,350/)
    assert.equal(/PI review<\/span>/.test(out), false, 'one kind: no tag')
  })

  test('a day is amber with an icon, three days is red with an icon, never colour alone', () => {
    const out = ready([
      reviewRow(review(1, { submitted_at: '2026-10-31T10:00:00Z' }), null, null),
      revisionRow(revision, null),
    ])
    assert.match(out, /ageWarn/)
    assert.match(out, /ageDanger/)
    assert.equal((out.match(/<svg/g) ?? []).length >= 3, true)
  })

  test('a mixed list tags each row, and non-PI rows show a dash for the value', () => {
    const out = ready([
      reviewRow(review(1), null, null),
      documentRow({ submission: documentSubmission(), orderNumber: '534', mine: false, client: 'Lakeview Resort' }, null),
    ])
    assert.match(out, /PI review/)
    assert.match(out, /Design Files/)
    assert.match(out, /—/)
  })

  test('nothing waiting is said, a failed read is an error, view-as is explained', () => {
    assert.match(ready([]), /Nothing is waiting for your decision/)
    assert.match(html(createElement(DecisionCard, { state: { kind: 'error' } })), /role="alert"[^>]*>What is waiting for your decision could not be loaded/)
    assert.equal(/Nothing is waiting/.test(html(createElement(DecisionCard, { state: { kind: 'error' } }))), false, 'an error is never "nothing"')
    assert.match(html(createElement(DecisionCard, { state: { kind: 'unavailable' } })), /view as someone else/)
    assert.match(html(createElement(DecisionCard, { state: { kind: 'loading' } })), /aria-busy="true"/)
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
    assert.ok(src.includes("from('order_pi_versions')"))
    assert.ok(src.includes("from('order_document_submissions')"))
    assert.ok(src.includes('loadPiPaymentSummary'))
    assert.equal(/service|createClient|attached_percent/.test(src), false, 'no service role, and no percentage worked out for the chip')
    assert.ok(src.includes('viewingAs'), 'nothing is read under View As')
  })
})
