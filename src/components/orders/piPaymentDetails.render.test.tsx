/**
 * PAYMENT DETAILS ON A PI DRAFT, ACTUALLY RENDERED.
 *
 * The dialog behind "Payment details" is where a payment verifier can now
 * approve or reject a pending payment without leaving the PI, and where the
 * status card's Confirmed and Awaiting verification figures open the rows they
 * are made of. What these tests hold is who is OFFERED a decision, on which
 * rows, which rows each view lists, and that every figure above the rows is the
 * page's own — never a sum made here.
 *
 * Run:
 *   npx tsx --test src/components/orders/piPaymentDetails.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { colors } from '@/lib/tokens'

import {
  APPROVE_PAYMENT_LABEL,
  PAYMENT_BAR_COLORS,
  PAYMENT_DETAILS_TITLE,
  PAYMENT_FILTER_TITLE,
  PiPaymentDetailsModal,
  PiPaymentProgress,
  PiPaymentRow,
  REJECT_PAYMENT_LABEL,
  type PiPaymentStatusFigures,
} from './PiPaymentCard'
import {
  countPiPaymentRows,
  describePaymentCount,
  describePiPaymentRow,
  filterPiPaymentRows,
  OWN_PAYMENT_DECISION_NOTE,
  type PiPaymentSummary,
  type PiPaymentSummaryRow,
} from '@/lib/finance/piPaymentView'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function row(over: Partial<PiPaymentSummaryRow>): PiPaymentSummaryRow {
  return {
    allocation_id: 'alloc-1',
    allocation_status: 'active',
    allocated_amount: '100000.00',
    payment_id: 'pay-1',
    request_number: 'PAY-REQ-2026-0001',
    amount: '100000.00',
    payment_date: '2026-08-05',
    payment_mode: 'hdfc',
    reference: 'UTR123',
    remarks: null,
    status: 'pending_approval',
    is_verified: false,
    admin_note: null,
    entered_by: 'Priya Rao',
    verified_by: null,
    created_at: '2026-08-05T06:00:00Z',
    verified_at: null,
    rejected_at: null,
    proof_count: 0,
    can_view_proof: false,
    ...over,
  }
}

// One of every kind of row the summary can return. `is_verified` is what the
// database's finance_payment_status_is_verified() answered for the status.
const ROWS: PiPaymentSummaryRow[] = [
  row({ allocation_id: 'a-pending', payment_id: 'p-pending', request_number: 'PAY-REQ-2026-0101' }),
  row({ allocation_id: 'a-clar', payment_id: 'p-clar', request_number: 'PAY-REQ-2026-0102', status: 'needs_clarification' }),
  row({ allocation_id: 'a-ok', payment_id: 'p-ok', request_number: 'PAY-REQ-2026-0103', status: 'approved_unlinked', is_verified: true, remarks: 'Advance via NEFT' }),
  row({ allocation_id: 'a-rej', payment_id: 'p-rej', request_number: 'PAY-REQ-2026-0104', status: 'rejected', admin_note: 'Duplicate of 0101' }),
  row({ allocation_id: 'a-rev', payment_id: 'p-rev', request_number: 'PAY-REQ-2026-0105', allocation_status: 'reversed' }),
  row({ allocation_id: 'a-split', payment_id: 'p-split', request_number: 'PAY-REQ-2026-0106', status: 'approved_linked', is_verified: true, amount: '250000.00', allocated_amount: '150000.00' }),
  row({ allocation_id: 'a-rev-ok', payment_id: 'p-rev-ok', request_number: 'PAY-REQ-2026-0107', status: 'approved_unlinked', is_verified: true, allocation_status: 'reversed' }),
]

const SUMMARY = {
  submission_id: 'sub-1',
  grand_total: '1180000.00',
  verified_amount: '250000.00',
  unverified_amount: '200000.00',
  attached_amount: '450000.00',
  verified_percent: '21.18',
  unverified_percent: '16.94',
  attached_percent: '38.13',
  needed_for_standard: '222000.00',
  pending_balance: '930000.00',
  standard_percent: 40,
  can_view_all_finance: false,
  payments: ROWS,
} as PiPaymentSummary

const STATUS: PiPaymentStatusFigures = {
  received: '₹4,50,000',
  receivedPercent: '38.13%',
  confirmed: '₹2,50,000',
  confirmedCount: 2,
  percent: '21.18%',
  total: '₹11,80,000',
  barPercent: 21.18,
  receivedBarPercent: 38.13,
  thresholdPercent: 40,
  pendingCount: 2,
  pendingAmount: '₹2,00,000',
  pendingPercent: '16.94%',
}

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const buttonLabels = (html: string): string[] =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]).trim())

const modal = (over: Partial<Parameters<typeof PiPaymentDetailsModal>[0]> = {}) => renderToStaticMarkup(
  <PiPaymentDetailsModal
    summary={SUMMARY}
    status={STATUS}
    loading={false}
    onOpenProof={() => {}}
    onClose={() => {}}
    canVerify={false}
    onDecide={null}
    {...over}
  />,
)

const decide = async () => null

// ── 1. Who is offered a decision ──────────────────────────────────────────────

describe('approve and reject are offered only to a payment verifier', () => {
  test('a viewer without the authority sees no decision control at all', () => {
    const labels = buttonLabels(modal())
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL))
    assert.ok(!labels.includes(REJECT_PAYMENT_LABEL))
    assert.ok(!/Confirm (approval|rejection)/.test(text(modal())))
  })

  test('the capability alone is not enough — without a handler nothing is drawn', () => {
    const labels = buttonLabels(modal({ canVerify: true, onDecide: null }))
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL) && !labels.includes(REJECT_PAYMENT_LABEL))
  })

  test('nor is a handler without the capability', () => {
    const labels = buttonLabels(modal({ canVerify: false, onDecide: decide }))
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL) && !labels.includes(REJECT_PAYMENT_LABEL))
  })

  test('a verifier gets exactly one Approve and one Reject — on the one pending, active row', () => {
    const labels = buttonLabels(modal({ canVerify: true, onDecide: decide }))
    assert.equal(labels.filter(l => l === APPROVE_PAYMENT_LABEL).length, 1)
    assert.equal(labels.filter(l => l === REJECT_PAYMENT_LABEL).length, 1)
  })

  test('the row rule is the shared Finance rule, plus an allocation that still counts', () => {
    const decidable = ROWS.map(r => describePiPaymentRow(r, { canVerify: true }))
      .filter(v => v.canDecide).map(v => v.requestNumber)
    assert.deepEqual(decidable, ['PAY-REQ-2026-0101'],
      'needs clarification, verified, rejected and a reversed allocation are all decided elsewhere')
    assert.deepEqual(ROWS.map(r => describePiPaymentRow(r, { canVerify: false })).filter(v => v.canDecide), [])
    const routing = readFileSync(join(process.cwd(), 'src/lib/finance/piPaymentView.ts'), 'utf8')
    assert.ok(routing.includes("import { canVerifyPayment } from '@/app/finance/paymentRouting'"),
      'the row reuses canVerifyPayment rather than restating it')
  })
})

describe('a verifier never decides a payment they recorded', () => {
  const OWN = new Set(['p-pending'])

  test('their own pending row draws no Approve or Reject, and says why', () => {
    const html = modal({ canVerify: true, onDecide: decide, ownPaymentIds: OWN })
    const labels = buttonLabels(html)
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL) && !labels.includes(REJECT_PAYMENT_LABEL))
    assert.ok(text(html).includes(OWN_PAYMENT_DECISION_NOTE))
  })

  test('somebody else’s pending row is still decidable, with no such note', () => {
    const html = modal({ canVerify: true, onDecide: decide, ownPaymentIds: new Set(['p-clar']) })
    assert.equal(buttonLabels(html).filter(l => l === APPROVE_PAYMENT_LABEL).length, 1)
    assert.ok(!text(html).includes(OWN_PAYMENT_DECISION_NOTE))
  })

  test('the row rule and the count agree', () => {
    const view = describePiPaymentRow(ROWS[0], { canVerify: true, ownPayment: true })
    assert.equal(view.canDecide, false)
    assert.equal(view.ownPending, true)
    assert.equal(describePiPaymentRow(ROWS[0], { canVerify: false, ownPayment: true }).ownPending, false,
      'a viewer who could not decide anyway is told nothing')
    assert.equal(describePiPaymentRow(ROWS[1], { canVerify: true, ownPayment: true }).ownPending, false,
      'only a pending payment is a decision withheld')
    assert.deepEqual(countPiPaymentRows(ROWS, OWN), { confirmed: 2, awaiting: 2, decidable: 0 })
  })
})

// ── 2. The figures above the rows ─────────────────────────────────────────────

describe('the dialog opens on the page’s own figures', () => {
  test('Received, Confirmed, Awaiting verification and PI Total, with the bar under them', () => {
    const html = modal()
    const t = text(html)
    for (const part of [
      'Received ₹4,50,000', 'Confirmed ₹2,50,000', 'Awaiting verification ₹2,00,000', 'PI Total ₹11,80,000',
    ]) {
      assert.ok(t.includes(part), `${part} missing`)
    }
    assert.ok(!t.includes('Required') && !t.includes('₹4,72,000'),
      'the requirement is neither labelled nor shown in the dialog')
    assert.ok(t.includes('38.13% received of ₹11,80,000 · 21.18% confirmed'))
    assert.ok(html.includes('role="progressbar"'))
    assert.ok(html.includes('aria-valuenow="38"'), 'the bar announces what has been received')
    assert.ok(html.includes(`aria-label="${PAYMENT_DETAILS_TITLE}"`), 'the dialog is named')
  })

  test('nothing pending reads as a dash, never ₹0 in amber', () => {
    const t = text(modal({ status: { ...STATUS, pendingCount: 0, pendingAmount: '₹0' } }))
    assert.ok(/Awaiting verification\s+—/.test(t))
  })

  test('the component sums nothing and calls nothing', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    for (const forbidden of ['.reduce(', 'supabase', '.rpc(', '.from(', 'fetch(']) {
      assert.ok(!source.includes(forbidden), `PiPaymentCard must not contain ${forbidden}`)
    }
  })

  test('counts are counts of rows: two confirmed, two with Finance, one decidable now', () => {
    assert.deepEqual(countPiPaymentRows(ROWS), { confirmed: 2, awaiting: 2, decidable: 1 },
      'reversed allocations are history and count for nothing; a rejected payment counts for nothing')
  })

  test('a count is worded once', () => {
    assert.equal(describePaymentCount(0), '0 payments')
    assert.equal(describePaymentCount(1), '1 payment')
    assert.equal(describePaymentCount(3), '3 payments')
  })
})

// ── 3. Which rows each figure is made of ──────────────────────────────────────

describe('each view lists exactly the rows its figure was summed from', () => {
  const numbers = (rows: PiPaymentSummaryRow[]) => rows.map(r => r.request_number)

  test('confirmed: active allocations of verified payments — never a reversed one', () => {
    assert.deepEqual(numbers(filterPiPaymentRows(ROWS, 'confirmed')), ['PAY-REQ-2026-0103', 'PAY-REQ-2026-0106'])
  })

  test('awaiting verification: active allocations still with Finance — rejected and reversed excluded', () => {
    assert.deepEqual(numbers(filterPiPaymentRows(ROWS, 'awaiting')), ['PAY-REQ-2026-0101', 'PAY-REQ-2026-0102'])
  })

  test('no row is in both, and rejected or reversed rows are in neither', () => {
    const confirmed = new Set(numbers(filterPiPaymentRows(ROWS, 'confirmed')))
    const awaiting = numbers(filterPiPaymentRows(ROWS, 'awaiting'))
    assert.ok(awaiting.every(n => !confirmed.has(n)), 'no payment is counted twice')
    for (const excluded of ['PAY-REQ-2026-0104', 'PAY-REQ-2026-0105', 'PAY-REQ-2026-0107']) {
      assert.ok(!confirmed.has(excluded) && !awaiting.includes(excluded), `${excluded} is not received money`)
    }
    assert.equal(filterPiPaymentRows(ROWS, 'all').length, ROWS.length, 'All is every row, history included')
  })

  test('the predicates are the canonical summary’s own, in its latest definition', () => {
    const dir = join(process.cwd(), 'supabase/migrations')
    const defining = readdirSync(dir)
      .filter(name => name.endsWith('.sql'))
      .filter(name => readFileSync(join(dir, name), 'utf8')
        .includes('create or replace function public.pi_submission_payment_summary('))
      .sort()
    const latest = readFileSync(join(dir, defining[defining.length - 1]), 'utf8')
    const body = latest.slice(latest.indexOf('create or replace function public.pi_submission_payment_summary('))
    assert.ok(body.includes("where public.finance_payment_status_is_verified(f.status)), 0)"),
      'verified_amount sums the rows is_verified reports')
    assert.ok(body.includes("where f.status in ('pending_approval', 'needs_clarification')), 0)"),
      'unverified_amount sums pending and needs-clarification rows — the awaiting filter')
    assert.ok(body.includes("and a.status = 'active';"), 'only active allocations are summed')
    assert.ok(body.includes('v_attached := v_verified + v_unverif;'), 'received is the two parts, added in numeric')
    assert.ok(body.includes("'is_verified',       public.finance_payment_status_is_verified(f.status)"))
  })
})

describe('the Confirmed view', () => {
  const html = modal({ initialFilter: 'confirmed', canVerify: true, onDecide: decide })
  const t = text(html)

  test('is titled for what it holds', () => {
    assert.equal(PAYMENT_FILTER_TITLE.confirmed, 'Confirmed payments')
    assert.ok(html.includes('aria-label="Confirmed payments"'))
  })

  test('shows only confirmed rows, and the database’s total for them', () => {
    assert.ok(t.includes('PAY-REQ-2026-0103') && t.includes('PAY-REQ-2026-0106'))
    for (const other of ['PAY-REQ-2026-0101', 'PAY-REQ-2026-0102', 'PAY-REQ-2026-0104', 'PAY-REQ-2026-0105', 'PAY-REQ-2026-0107']) {
      assert.ok(!t.includes(other), `${other} is not a confirmed payment`)
    }
    assert.ok(t.includes('Confirmed total ₹2,50,000'))
    assert.ok(t.includes('2 payments · 21.18% of ₹11,80,000 PI Total'))
    assert.ok(!t.includes('Awaiting verification total'))
  })

  test('is read-only, even for a payment verifier', () => {
    const labels = buttonLabels(html)
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL) && !labels.includes(REJECT_PAYMENT_LABEL))
  })

  test('says so plainly when there is nothing confirmed', () => {
    const empty = text(modal({
      initialFilter: 'confirmed',
      summary: { ...SUMMARY, payments: filterPiPaymentRows(ROWS, 'awaiting') },
      status: { ...STATUS, confirmed: '₹0', confirmedCount: 0, percent: '0%' },
    }))
    assert.ok(empty.includes('No payment against this PI has been confirmed yet.'))
  })
})

describe('the Awaiting verification view', () => {
  test('is titled for what it holds, and lists only pending rows with their total', () => {
    const html = modal({ initialFilter: 'awaiting' })
    const t = text(html)
    assert.equal(PAYMENT_FILTER_TITLE.awaiting, 'Payments awaiting verification')
    assert.ok(html.includes('aria-label="Payments awaiting verification"'))
    assert.ok(t.includes('PAY-REQ-2026-0101') && t.includes('PAY-REQ-2026-0102'))
    for (const other of ['PAY-REQ-2026-0103', 'PAY-REQ-2026-0104', 'PAY-REQ-2026-0105', 'PAY-REQ-2026-0106', 'PAY-REQ-2026-0107']) {
      assert.ok(!t.includes(other), `${other} is not awaiting verification`)
    }
    assert.ok(t.includes('Awaiting verification total ₹2,00,000'))
    assert.ok(t.includes('2 payments · 16.94% of ₹11,80,000 PI Total'))
    assert.ok(!/failed|unpaid|non-confirmed/i.test(t), 'waiting money is never called failed or unpaid')
  })

  test('keeps Approve and Reject for a verifier, on the decidable row only', () => {
    const labels = buttonLabels(modal({ initialFilter: 'awaiting', canVerify: true, onDecide: decide }))
    assert.equal(labels.filter(l => l === APPROVE_PAYMENT_LABEL).length, 1)
    assert.equal(labels.filter(l => l === REJECT_PAYMENT_LABEL).length, 1)
  })

  test('grants nothing to a viewer without the authority', () => {
    const labels = buttonLabels(modal({ initialFilter: 'awaiting', canVerify: false, onDecide: decide }))
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL) && !labels.includes(REJECT_PAYMENT_LABEL))
  })

  test('keeps the self-decision restriction', () => {
    const html = modal({ initialFilter: 'awaiting', canVerify: true, onDecide: decide, ownPaymentIds: new Set(['p-pending']) })
    const labels = buttonLabels(html)
    assert.ok(!labels.includes(APPROVE_PAYMENT_LABEL) && !labels.includes(REJECT_PAYMENT_LABEL))
    assert.ok(text(html).includes(OWN_PAYMENT_DECISION_NOTE))
  })
})

describe('the views switch inside the one dialog', () => {
  test('All, Confirmed and Awaiting verification, with their row counts, the chosen one pressed', () => {
    const html = modal({ initialFilter: 'awaiting' })
    const toggles = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .filter(m => m[1].includes('pi-detail-payfilter'))
    assert.deepEqual(toggles.map(m => text(m[2]).trim()), ['All 7', 'Confirmed 2', 'Awaiting verification 2'])
    assert.deepEqual(toggles.map(m => /aria-pressed="true"/.test(m[1])), [false, false, true])
    for (const m of toggles) assert.ok(m[1].includes('type="button"'))
    assert.ok(html.includes('role="group" aria-label="Show payments"'))
  })

  test('All still lists every row, rejected and reversed history included', () => {
    const t = text(modal())
    for (let n = 101; n <= 107; n += 1) assert.ok(t.includes(`PAY-REQ-2026-0${n}`))
  })

  test('the dialog is reused, not duplicated, and a switch is held while a decision is open', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    assert.equal((source.match(/<FinanceModal\b/g) ?? []).length, 2, 'Add payment and Payment details — no third dialog')
    assert.ok(source.includes('title={PAYMENT_FILTER_TITLE[filter]}'))
    assert.ok(source.includes('if (busyRef.current || armed !== null) return'))
  })
})

// ── 4. The progress bar ───────────────────────────────────────────────────────

describe('the progress bar: green confirmed, amber awaiting verification, red not yet received', () => {
  const bar = (confirmedPercent: number, receivedPercent: number, thresholdPercent: number | null = 40) =>
    renderToStaticMarkup(
      <PiPaymentProgress
        confirmedPercent={confirmedPercent}
        receivedPercent={receivedPercent}
        thresholdPercent={thresholdPercent}
        label="Payment received"
      />)
  const segment = (html: string, name: 'confirmed' | 'awaiting' | 'unpaid') =>
    html.match(new RegExp(`data-segment="${name}" style="([^"]*)"`))?.[1] ?? null
  const GREEN = `background:${PAYMENT_BAR_COLORS.confirmed}`
  const AMBER = `background:${PAYMENT_BAR_COLORS.awaiting}`
  const RED = `background:${PAYMENT_BAR_COLORS.unpaid}`

  test('the three colours are the product’s green, amber and red', () => {
    assert.equal(PAYMENT_BAR_COLORS.confirmed, colors.green)
    assert.equal(PAYMENT_BAR_COLORS.awaiting, colors.amber)
    assert.equal(PAYMENT_BAR_COLORS.unpaid, colors.red)
  })

  test('no payments: the whole track is red, and it is still announced', () => {
    const html = bar(0, 0)
    assert.equal(segment(html, 'confirmed'), null)
    assert.equal(segment(html, 'awaiting'), null)
    assert.ok(segment(html, 'unpaid')?.includes(RED))
    assert.ok(html.includes('aria-valuenow="0"'))
  })

  test('confirmed only: green, then red for the rest', () => {
    const html = bar(21.18, 21.18)
    assert.ok(segment(html, 'confirmed')?.includes('width:21.18%'))
    assert.ok(segment(html, 'confirmed')?.includes(GREEN))
    assert.equal(segment(html, 'awaiting'), null)
    assert.ok(segment(html, 'unpaid')?.includes(RED))
  })

  test('awaiting verification only: amber for that share, red for the balance', () => {
    const html = bar(0, 16.94)
    assert.equal(segment(html, 'confirmed'), null)
    assert.ok(segment(html, 'awaiting')?.includes('width:16.94%'))
    assert.ok(segment(html, 'awaiting')?.includes(AMBER))
    assert.ok(segment(html, 'unpaid')?.includes(RED))
    assert.ok(html.includes('aria-valuenow="17"'))
  })

  test('mixed: green, then amber for the gap to received, then red', () => {
    const html = bar(21.18, 38.13)
    assert.ok(segment(html, 'confirmed')?.includes('width:21.18%'))
    assert.ok(segment(html, 'awaiting')?.includes('width:16.95%'))
    assert.ok(segment(html, 'unpaid')?.includes(RED))
    assert.ok(html.indexOf('data-segment="confirmed"') < html.indexOf('data-segment="awaiting"'))
    assert.ok(html.indexOf('data-segment="awaiting"') < html.indexOf('data-segment="unpaid"'))
  })

  test('the 40% tick is a reference only: below, exactly at and above it, no colour changes', () => {
    for (const [confirmed, received] of [[10, 39.99], [25, 40], [60, 75]] as const) {
      const html = bar(confirmed, received)
      assert.ok(html.includes('left:40%'), 'the requirement marker sits on the same scale')
      assert.ok(segment(html, 'confirmed')?.includes(GREEN))
      assert.ok(segment(html, 'awaiting')?.includes(AMBER))
      assert.ok(segment(html, 'unpaid')?.includes(RED), 'meeting the advance does not stop the rest being red')
    }
  })

  test('100% confirmed: entirely green, with no amber and no red', () => {
    const html = bar(100, 100)
    assert.ok(segment(html, 'confirmed')?.includes('width:100%'))
    assert.equal(segment(html, 'awaiting'), null)
    assert.equal(segment(html, 'unpaid'), null)
    assert.ok(!html.includes(RED) && !html.includes(AMBER))
    assert.ok(html.includes('aria-valuenow="100"'))
  })

  test('100% received with some still pending: green and amber, no red', () => {
    const html = bar(60, 100)
    assert.ok(segment(html, 'awaiting')?.includes('width:40%'))
    assert.equal(segment(html, 'unpaid'), null)
  })

  test('overpayment fills the track and never overflows it', () => {
    assert.ok(segment(bar(140, 140), 'confirmed')?.includes('width:100%'))
    assert.equal(segment(bar(140, 140), 'awaiting'), null)
    assert.equal(segment(bar(140, 140), 'unpaid'), null)
    const mixed = bar(80, 125)
    assert.ok(segment(mixed, 'confirmed')?.includes('width:80%'))
    assert.ok(segment(mixed, 'awaiting')?.includes('width:20%'))
    assert.equal(segment(mixed, 'unpaid'), null)
  })

  test('received never draws short of confirmed, and nonsense widths are clamped', () => {
    const short = bar(50, 30)
    assert.equal(segment(short, 'awaiting'), null)
    assert.ok(segment(short, 'confirmed')?.includes('width:50%'))
    assert.equal(segment(bar(-5, -5), 'confirmed'), null)
    assert.equal(segment(bar(Number.NaN, Number.NaN), 'confirmed'), null)
    assert.ok(segment(bar(Number.NaN, Number.NaN), 'unpaid')?.includes(RED))
  })

  test('no requirement, no tick', () => {
    assert.ok(!bar(10, 20, null).includes('left:'))
  })

  test('the requirement no longer decides any colour', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    const progress = source.slice(source.indexOf('export function PiPaymentProgress('),
      source.indexOf('/** The payment status figures'))
    assert.ok(progress.length > 0 && !progress.includes('requirementMet'))
    assert.ok(!source.includes('#E8EBF0') && !source.includes('#F4D9D9'), 'no neutral or alternate remainder colour remains')
  })
})

// ── 5. The rows ───────────────────────────────────────────────────────────────

describe('each row says when, how, how much and where it stands', () => {
  const t = text(modal())

  test('date, mode, reference, request number, who recorded it', () => {
    for (const part of ['05 Aug 2026', 'Ref UTR123', 'PAY-REQ-2026-0101', 'Recorded by Priya Rao']) {
      assert.ok(t.includes(part), `${part} missing`)
    }
  })

  test('the remarks typed with the payment', () => {
    assert.ok(t.includes('Remarks: Advance via NEFT'))
  })

  test('no internal identifier reaches the reader', () => {
    for (const id of ['a-pending', 'p-pending', 'a-ok', 'p-ok', 'sub-1', 'alloc-']) {
      assert.ok(!t.includes(id), `${id} is an internal id`)
    }
  })

  test('statuses in the product’s words', () => {
    for (const label of ['Awaiting Verification', 'Needs Clarification', 'Verified', 'Rejected']) {
      assert.ok(t.includes(label), `${label} missing`)
    }
  })

  test('a split payment shows the allocation and the payment it came from', () => {
    assert.ok(t.includes('₹1,50,000'))
    assert.ok(t.includes('Part of a ₹2,50,000 payment'))
  })

  test('a rejection keeps its reason; a reversed allocation says so', () => {
    assert.ok(t.includes('Rejection reason: Duplicate of 0101'))
    assert.ok(t.includes('Allocation reversed'))
  })
})

describe('deciding one row', () => {
  const view = describePiPaymentRow(ROWS[0], { canVerify: true })
  const armed = (over: Partial<Parameters<typeof PiPaymentRow>[0]>) => renderToStaticMarkup(
    <PiPaymentRow
      row={view} armed={null} note="" busy={false} error={null}
      onOpenProof={() => {}} onArm={() => {}} onNote={() => {}} onCancel={() => {}} onConfirm={() => {}}
      {...over}
    />,
  )

  test('reject asks for a reason, and cannot be confirmed without one', () => {
    const html = armed({ armed: 'reject' })
    assert.ok(text(html).includes('Reason for rejecting (required)'))
    const confirm = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .find(m => text(m[2]).includes('Confirm rejection'))
    assert.ok(confirm && confirm[1].includes('disabled=""'))
  })

  test('approve takes an optional note and can be confirmed straight away', () => {
    const html = armed({ armed: 'approve' })
    assert.ok(text(html).includes('Note (optional)'))
    const confirm = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
      .find(m => text(m[2]).includes('Confirm approval'))
    assert.ok(confirm && !confirm[1].includes('disabled=""'))
  })

  test('while a decision is in flight every control on the row is dead', () => {
    const html = armed({ armed: 'approve', busy: true, note: 'ok' })
    const opens = [...html.matchAll(/<button\b([^>]*)>/g)].map(m => m[1])
    assert.ok(opens.length >= 2)
    for (const attrs of opens) assert.ok(attrs.includes('disabled=""'))
    assert.ok(text(html).includes('Approving…'))
  })

  test('a refusal is shown on the row, as an alert', () => {
    const html = armed({ armed: 'reject', note: 'x', error: 'You do not have permission to verify payments.' })
    assert.ok(html.includes('role="alert"'))
    assert.ok(text(html).includes('You do not have permission to verify payments.'))
  })

  test('the dialog guards a double submit and a dismissal mid-decision', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    assert.ok(source.includes('if (!armed || !onDecide || busyRef.current) return'))
    assert.ok(source.includes('busyRef.current = true'))
    assert.ok(source.includes('closeOnBackdropClick={armed === null}'),
      'a typed reason is not discarded by a stray click on the backdrop')
    assert.ok(/const close = useCallback\(\(\) => \{\s*if \(busyRef\.current\) return/.test(source))
  })
})
