/**
 * PAYMENT DETAILS ON A PI DRAFT, ACTUALLY RENDERED.
 *
 * The dialog behind "Payment details" is where a payment verifier can now
 * approve or reject a pending payment without leaving the PI. What these tests
 * hold is who is OFFERED that, on which rows, and that the figures above the
 * rows are the page's own — never a sum made here.
 *
 * Run:
 *   npx tsx --test src/components/orders/piPaymentDetails.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { colors } from '@/lib/tokens'

import {
  APPROVE_PAYMENT_LABEL,
  PAYMENT_BAR_COLORS,
  PAYMENT_DETAILS_TITLE,
  PiPaymentDetailsModal,
  PiPaymentProgress,
  PiPaymentRow,
  REJECT_PAYMENT_LABEL,
  type PiPaymentStatusFigures,
} from './PiPaymentCard'
import {
  countPiPaymentRows,
  describePiPaymentRow,
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

const ROWS: PiPaymentSummaryRow[] = [
  row({ allocation_id: 'a-pending', payment_id: 'p-pending', request_number: 'PAY-REQ-2026-0101' }),
  row({ allocation_id: 'a-clar', payment_id: 'p-clar', request_number: 'PAY-REQ-2026-0102', status: 'needs_clarification' }),
  row({ allocation_id: 'a-ok', payment_id: 'p-ok', request_number: 'PAY-REQ-2026-0103', status: 'approved_unlinked', is_verified: true }),
  row({ allocation_id: 'a-rej', payment_id: 'p-rej', request_number: 'PAY-REQ-2026-0104', status: 'rejected', admin_note: 'Duplicate of 0101' }),
  row({ allocation_id: 'a-rev', payment_id: 'p-rev', request_number: 'PAY-REQ-2026-0105', allocation_status: 'reversed' }),
  row({ allocation_id: 'a-split', payment_id: 'p-split', request_number: 'PAY-REQ-2026-0106', status: 'approved_linked', amount: '250000.00', allocated_amount: '150000.00' }),
]

const SUMMARY = {
  submission_id: 'sub-1',
  grand_total: '1180000.00',
  verified_amount: '250000.00',
  unverified_amount: '200000.00',
  verified_percent: '21.18',
  unverified_percent: '16.94',
  needed_for_standard: '222000.00',
  pending_balance: '930000.00',
  standard_percent: 40,
  can_view_all_finance: false,
  payments: ROWS,
} as PiPaymentSummary

const STATUS: PiPaymentStatusFigures = {
  confirmed: '₹2,50,000',
  required: '₹4,72,000',
  requiredNote: '40% of ₹11,80,000',
  percent: '21.18%',
  total: '₹11,80,000',
  barPercent: 21.18,
  thresholdPercent: 40,
  requirementMet: false,
  pendingCount: 2,
  pendingAmount: '₹2,00,000',
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
    assert.deepEqual(countPiPaymentRows(ROWS, OWN), { awaiting: 2, decidable: 0 })
  })
})

// ── 2. The figures above the rows ─────────────────────────────────────────────

describe('the dialog opens on the page’s own figures', () => {
  test('Confirmed, Pending verification and PI Total, with the bar under them', () => {
    const html = modal()
    const t = text(html)
    for (const part of ['Confirmed', '₹2,50,000', 'Pending verification', '₹2,00,000', 'PI Total']) {
      assert.ok(t.includes(part), `${part} missing`)
    }
    // The PI Total figure carries the PI's grand total, never the advance
    // requirement it replaced.
    assert.ok(t.includes('PI Total ₹11,80,000'), 'PI Total is the grand total')
    assert.ok(!t.includes('Required') && !t.includes('₹4,72,000'),
      'the requirement is neither labelled nor shown in the dialog')
    assert.ok(t.includes('21.18% confirmed of ₹11,80,000'))
    assert.ok(html.includes('role="progressbar"'))
    assert.ok(html.includes('aria-valuenow="21"'))
    assert.ok(html.includes(`aria-label="${PAYMENT_DETAILS_TITLE}"`), 'the dialog is named')
  })

  test('nothing pending reads as a dash, never ₹0 in amber', () => {
    const t = text(modal({ status: { ...STATUS, pendingCount: 0, pendingAmount: '₹0' } }))
    assert.ok(/Pending verification\s+—/.test(t))
  })

  test('the component sums nothing and calls nothing', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    for (const forbidden of ['.reduce(', 'supabase', '.rpc(', '.from(', 'fetch(']) {
      assert.ok(!source.includes(forbidden), `PiPaymentCard must not contain ${forbidden}`)
    }
  })

  test('counts are counts of rows: two with Finance, one decidable now', () => {
    assert.deepEqual(countPiPaymentRows(ROWS), { awaiting: 2, decidable: 1 },
      'the reversed pending allocation is history and counts for neither')
  })
})

describe('the progress bar: green is confirmed, red is everything else', () => {
  const bar = (barPercent: number, thresholdPercent: number | null = 40) =>
    renderToStaticMarkup(
      <PiPaymentProgress barPercent={barPercent} thresholdPercent={thresholdPercent} label="Confirmed payment" />)
  const segment = (html: string, name: 'confirmed' | 'unconfirmed') =>
    html.match(new RegExp(`data-segment="${name}" style="([^"]*)"`))?.[1] ?? null
  const GREEN = `background:${PAYMENT_BAR_COLORS.confirmed}`
  const RED = `background:${PAYMENT_BAR_COLORS.unconfirmed}`

  test('the two colours are the product’s green and red — never amber, never neutral', () => {
    assert.equal(PAYMENT_BAR_COLORS.confirmed, colors.green)
    assert.equal(PAYMENT_BAR_COLORS.unconfirmed, colors.red)
    assert.notEqual(PAYMENT_BAR_COLORS.unconfirmed, colors.amber, 'amber is reserved for awaiting verification')
  })

  test('0%: the whole track is red, and it is still announced', () => {
    const html = bar(0)
    assert.equal(segment(html, 'confirmed'), null)
    assert.ok(segment(html, 'unconfirmed')?.includes(RED))
    assert.ok(html.includes('aria-valuenow="0"'))
  })

  test('below the requirement: the green share, red for all the rest, the requirement ticked', () => {
    const html = bar(21.18)
    assert.ok(segment(html, 'confirmed')?.includes('width:21.18%'))
    assert.ok(segment(html, 'confirmed')?.includes(GREEN))
    assert.ok(segment(html, 'unconfirmed')?.includes(RED))
    assert.ok(html.includes('left:40%'), 'the requirement marker sits on the same scale')
  })

  test('above the requirement: the unconfirmed rest is STILL red', () => {
    const html = bar(65)
    assert.ok(segment(html, 'confirmed')?.includes('width:65%'))
    assert.ok(segment(html, 'unconfirmed')?.includes(RED), 'meeting the advance does not turn the rest neutral')
    assert.ok(html.includes('left:40%'), 'the tick stays, and changes no colour')
    assert.ok(!html.includes('#E8EBF0'))
  })

  test('100%: entirely green, with no red remainder at all', () => {
    const html = bar(100)
    assert.ok(segment(html, 'confirmed')?.includes('width:100%'))
    assert.equal(segment(html, 'unconfirmed'), null)
    assert.ok(!html.includes(RED))
    assert.ok(html.includes('aria-valuenow="100"'))
  })

  test('out-of-range widths are clamped: never overflowing, never inventing green', () => {
    assert.ok(segment(bar(140), 'confirmed')?.includes('width:100%'))
    assert.equal(segment(bar(140), 'unconfirmed'), null)
    assert.equal(segment(bar(-5), 'confirmed'), null)
    assert.equal(segment(bar(Number.NaN), 'confirmed'), null)
    assert.ok(segment(bar(Number.NaN), 'unconfirmed')?.includes(RED))
  })

  test('no requirement, no tick', () => {
    assert.ok(!bar(10, null).includes('left:'))
  })

  test('the requirement no longer decides any colour', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    const progress = source.slice(source.indexOf('export function PiPaymentProgress('),
      source.indexOf('/** The payment status figures'))
    assert.ok(progress.length > 0 && !progress.includes('requirementMet'))
    assert.ok(!source.includes('#E8EBF0') && !source.includes('#F4D9D9'), 'no neutral or alternate remainder colour remains')
  })
})

// ── 3. The rows ───────────────────────────────────────────────────────────────

describe('each row says when, how, how much and where it stands', () => {
  const t = text(modal())

  test('date, mode, reference, request number, who recorded it', () => {
    for (const part of ['05 Aug 2026', 'Ref UTR123', 'PAY-REQ-2026-0101', 'Recorded by Priya Rao']) {
      assert.ok(t.includes(part), `${part} missing`)
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
