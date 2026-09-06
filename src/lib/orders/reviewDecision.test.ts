/**
 * The PI decision, the Confirmed-Order gate, and the attached-payment submission
 * rule, as the browser understands them (20261116000000).
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 *   * which door a reviewer is offered — approve-and-create, approve the PI
 *     only, create the Order the PI already earned — and when none is;
 *   * that an approved PI with unresolved payment offers NO Order-creating
 *     control, so unresolved payment cannot accidentally create a Confirmed Order
 *     from this screen;
 *   * that the PI decision's currency mirrors the database predicate;
 *   * that the submission rule reads ATTACHED payment: =40% asks nothing,
 *     <40% and 0% ask for a reason, and approved + pending both count;
 *   * that every figure is the server's — nothing here divides money.
 *
 * Pure. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/reviewDecision.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  APPROVE_ORDER_BUTTON_LABEL,
  APPROVE_PI_BUTTON_LABEL,
  APPROVE_PI_NOTE,
  CREATE_ORDER_BUTTON_LABEL,
  PI_DECISION_COLUMNS,
  describeReviewDecision,
  piApprovedLine,
  piDecisionIsCurrent,
  type ApprovalReadinessInput,
} from './finalApproval'
import {
  PAYMENT_ADMIN_APPROVAL_REQUIRED,
  PAYMENT_EXCEPTION_PENDING,
  SUBMISSION_POSITIONS,
  asSubmissionPosition,
  paymentPositionLines,
  submissionReasonPrompt,
  validateSubmissionTerms,
  EMPTY_SUBMISSION_TERMS,
} from './paymentGate'
import { piPaymentTiles, type PiPaymentSummary } from '../finance/piPaymentView'
import { PI_DRAFT_DETAIL_COLUMNS } from './draftsView'
import {
  APPROVE_PAYMENT_LABEL,
  buildApprovalSummary,
} from '@/app/orders/drafts/[submissionId]/piDetailView'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ready: ApprovalReadinessInput = {
  status: 'submitted',
  financeVerified: true,
  paymentPosition: 'standard_met',
  neededForStandard: '0.00',
  hasBlockingIssues: false,
  productCount: 3,
  deletionClaimed: false,
  incompleteSummary: null,
}

const decide = (over: Partial<ApprovalReadinessInput>, piApproved = false, canApprove = true) =>
  describeReviewDecision({ readiness: { ...ready, ...over }, piApproved, canApprove })

// ── Which door ────────────────────────────────────────────────────────────────

describe('which decision the reviewer is offered', () => {
  test('a verified PI whose payment condition is cleared: approve AND create, in one press', () => {
    const d = decide({})
    assert.equal(d.mode, 'approve_and_create')
    assert.equal(d.label, APPROVE_ORDER_BUTTON_LABEL)
    assert.equal(d.rpc, 'approve_order_submission')
    assert.equal(d.note, null)
  })

  test('an approved exception clears the gate the same way', () => {
    const d = decide({ paymentPosition: 'exception_approved', neededForStandard: '400000.00' })
    assert.equal(d.mode, 'approve_and_create')
  })

  test('payment unresolved, everything else in order: approve the PI ONLY', () => {
    for (const position of ['payment_required', 'verification_pending', 'exception_pending',
                            'exception_rejected', 'exception_stale'] as const) {
      const d = decide({ paymentPosition: position, neededForStandard: '400000.00' })
      assert.equal(d.mode, 'approve_pi', position)
      assert.equal(d.label, APPROVE_PI_BUTTON_LABEL)
      assert.equal(d.rpc, 'approve_pi_review', 'the PI door, never the Order door')
      assert.ok(d.note?.includes('waits for the payment condition'), d.note ?? '')
    }
  })

  test('the PI-only note names the payment blocker the reviewer would otherwise hit', () => {
    const d = decide({ paymentPosition: 'exception_pending', neededForStandard: '400000.00' })
    assert.ok(d.note?.includes(PAYMENT_EXCEPTION_PENDING), d.note ?? '')
    const short = decide({ paymentPosition: 'payment_required', neededForStandard: '400000.00' })
    assert.ok(short.note?.includes('₹4,00,000'), 'the shortfall is named')
    assert.ok(short.note?.includes(PAYMENT_ADMIN_APPROVAL_REQUIRED), 'and who can decide instead')
  })

  test('PI already approved, payment STILL unresolved: no control at all, and it says why', () => {
    // THE GATE, STATED AS A RULE: unresolved payment never produces an
    // Order-creating control, whatever the PI decision says.
    const d = decide({ paymentPosition: 'verification_pending', neededForStandard: '400000.00' }, true)
    assert.equal(d.mode, 'awaiting_payment')
    assert.equal(d.label, null)
    assert.equal(d.rpc, null, 'nothing on this screen can create the Order yet')
    assert.ok(d.note?.startsWith('PI approved.'), d.note ?? '')
    assert.ok(d.note?.includes('will be created once the payment condition is cleared'))
  })

  test('PI already approved and the payment condition has since cleared: create the Order', () => {
    const d = decide({}, true)
    assert.equal(d.mode, 'create_order')
    assert.equal(d.label, CREATE_ORDER_BUTTON_LABEL)
    assert.equal(d.rpc, 'approve_order_submission',
      'the SAME door as always — it finds the PI decision current and creates the Order')
  })

  test('anything other than payment blocks the PI decision too', () => {
    for (const over of [
      { financeVerified: false },
      { hasBlockingIssues: true },
      { productCount: 0 },
      { deletionClaimed: true },
      { incompleteSummary: 'A client name is missing.' },
      { paymentPosition: null },
    ] as Partial<ApprovalReadinessInput>[]) {
      const d = decide({ ...over, paymentPosition: over.paymentPosition === null ? null : 'payment_required' })
      assert.equal(d.mode, 'blocked', JSON.stringify(over))
      assert.equal(d.rpc, null)
      assert.ok(d.note, 'and the reason is stated')
    }
  })

  test('the finance CHECK comes before the PI decision, as it does in the RPC', () => {
    const d = decide({ financeVerified: false, paymentPosition: 'payment_required' })
    assert.equal(d.mode, 'blocked')
    assert.ok(/finance must verify/i.test(d.note ?? ''), d.note ?? '')
  })

  test('not a submitted record, or not this viewer\'s decision: nothing', () => {
    for (const status of ['draft', 'needs_changes', 'rejected', 'approved']) {
      assert.equal(decide({ status }).mode, 'none', status)
    }
    assert.equal(decide({}, false, false).mode, 'none')
  })
})

// ── The decision's currency ───────────────────────────────────────────────────

describe('the PI decision is current only for THIS submission', () => {
  const at = '2026-09-06T10:00:00.000Z'

  test('bound to this submitted_at is current', () => {
    assert.equal(piDecisionIsCurrent(
      { pi_approved_by: 'u', pi_approved_at: at, pi_approved_submission_at: '2026-09-06T09:00:00Z' },
      '2026-09-06T09:00:00.000+00:00'), true, 'the same instant written two ways')
  })

  test('a decision about an earlier submission is stale', () => {
    assert.equal(piDecisionIsCurrent(
      { pi_approved_by: 'u', pi_approved_at: at, pi_approved_submission_at: '2026-09-05T09:00:00Z' },
      '2026-09-06T09:00:00Z'), false)
  })

  test('no decision, or half a decision, is not current', () => {
    assert.equal(piDecisionIsCurrent({}, '2026-09-06T09:00:00Z'), false)
    assert.equal(piDecisionIsCurrent({ pi_approved_at: at }, '2026-09-06T09:00:00Z'), false)
    assert.equal(piDecisionIsCurrent(
      { pi_approved_at: at, pi_approved_submission_at: '2026-09-06T09:00:00Z' }, null), false)
  })

  test('the three columns are named, and the detail read selects them', () => {
    assert.deepEqual([...PI_DECISION_COLUMNS],
      ['pi_approved_by', 'pi_approved_at', 'pi_approved_submission_at'])
    // The detail read is one comma-joined select string; each column must be in it.
    for (const column of PI_DECISION_COLUMNS) {
      assert.ok(String(PI_DRAFT_DETAIL_COLUMNS).split(', ').includes(column), column)
    }
  })

  test('the approved line names the approver and the time, and copes with neither', () => {
    assert.equal(piApprovedLine('Ravi Menon', '6 Sep 2026'), 'PI approved by Ravi Menon · 6 Sep 2026')
    assert.equal(piApprovedLine(null, null), 'PI approved by a colleague · an earlier date')
  })

  test('the PI-only dialog says, out loud, that no Order and no number result', () => {
    assert.ok(/no Order number is assigned/i.test(APPROVE_PI_NOTE))
    assert.ok(/no Confirmed Order is created/i.test(APPROVE_PI_NOTE))
  })
})

// ── The submission rule: attached payment ─────────────────────────────────────

describe('the submission rule reads ATTACHED payment', () => {
  const terms = (over: Partial<typeof EMPTY_SUBMISSION_TERMS> = {}) => ({ ...EMPTY_SUBMISSION_TERMS, ...over })

  test('=40% attached: no reason is owed', () => {
    const r = validateSubmissionTerms({ meetsStandard: true, terms: terms() })
    assert.equal(r.ok, true)
  })

  test('<40% attached: a reason is mandatory', () => {
    const r = validateSubmissionTerms({ meetsStandard: false, terms: terms() })
    assert.equal(r.ok, false)
  })

  test('0% attached: the same rule, never a waiver', () => {
    const r = validateSubmissionTerms({ meetsStandard: false, terms: terms({ paymentTerms: '50% now' }) })
    assert.equal(r.ok, false, 'terms alone are not a reason')
  })

  test('the three submission positions are the three the server can return', () => {
    assert.deepEqual([...SUBMISSION_POSITIONS], ['attached_met', 'attached_partial', 'no_payment'])
    assert.equal(asSubmissionPosition('attached_partial'), 'attached_partial')
    assert.equal(asSubmissionPosition('standard_met'), null, 'an approval position is not a submission position')
    assert.equal(asSubmissionPosition(null), null)
  })

  test('the reason prompt names the attached figure, or says there is none', () => {
    assert.equal(submissionReasonPrompt('attached_partial', '27%'),
      'Only 27% payment is currently attached. Please explain why this PI should be sent for approval.')
    assert.equal(submissionReasonPrompt('no_payment', '0%'),
      'No payment is attached to this PI. Please explain why this PI should be sent for approval.')
    assert.ok(submissionReasonPrompt('attached_partial', null).includes('less than 40%'))
  })

  test('the position lines carry the attached pair when the server reports it', () => {
    const lines = paymentPositionLines({
      grandTotal: '100000.00', verifiedAmount: '20000.00', verifiedPercent: '20.00',
      unverifiedAmount: '25000.00', unverifiedPercent: '25.00',
      attachedAmount: '45000.00', attachedPercent: '45.00',
      neededForStandard: '0.00',
      formatFigure: v => String(v), formatPercentage: v => String(v),
    })
    assert.deepEqual(lines.map(l => l.key),
      ['grand', 'verified', 'percent', 'unverified', 'unverifiedPercent', 'attached', 'attachedPercent', 'needed'])
    // DELIBERATELY INCONSISTENT: 20000 + 25000 is 45000 here, but a browser
    // that recomputed would have "corrected" a deliberately wrong pair.
    const wrong = paymentPositionLines({
      grandTotal: '100000.00', verifiedAmount: '1.00', verifiedPercent: '1.00',
      unverifiedAmount: '1.00', attachedAmount: '99.00', attachedPercent: '99.00',
      neededForStandard: '0.00',
      formatFigure: v => String(v), formatPercentage: v => String(v),
    })
    assert.equal(wrong.find(l => l.key === 'attached')?.value, '99.00', 'the server\'s figure survives unchanged')
  })

  test('the position lines are unchanged for a summary that reports no attached figures', () => {
    const lines = paymentPositionLines({
      grandTotal: '1', verifiedAmount: '1', verifiedPercent: '1', unverifiedAmount: '1', neededForStandard: '1',
      formatFigure: v => String(v), formatPercentage: v => String(v),
    })
    assert.deepEqual(lines.map(l => l.key), ['grand', 'verified', 'percent', 'unverified', 'needed'])
  })

  test('this module still does no arithmetic', () => {
    const source = readFileSync('src/lib/orders/paymentGate.ts', 'utf8')
    for (const arithmetic of ['/ 100', '* 100', '* 0.4', 'parseFloat(']) {
      assert.ok(!source.includes(arithmetic), arithmetic)
    }
  })
})

// ── The payment card and the approval summary ─────────────────────────────────

describe('the approver sees the payment summary beside the PI', () => {
  const summary = (over: Partial<PiPaymentSummary> = {}): PiPaymentSummary => ({
    submission_id: 'pi-1',
    grand_total: '100000.00',
    verified_amount: '30000.00',
    unverified_amount: '10000.00',
    verified_percent: '30.00',
    unverified_percent: '10.00',
    needed_for_standard: '10000.00',
    pending_balance: '70000.00',
    standard_percent: 40,
    can_view_all_finance: false,
    payments: [],
    ...over,
  })

  test('the tiles gain the attached pair only when the server reports it', () => {
    assert.deepEqual(piPaymentTiles(summary()).map(t => t.key),
      ['grand', 'verified', 'unverified', 'percent', 'needed', 'balance'])
    const tiles = piPaymentTiles(summary({ attached_amount: '40000.00', attached_percent: '40.00' }))
    assert.deepEqual(tiles.map(t => t.key),
      ['grand', 'verified', 'unverified', 'percent', 'needed', 'balance', 'attached', 'attached_percent'])
    assert.equal(tiles[6].value, '₹40,000.00')
    assert.equal(tiles[7].value, '40%')
  })

  test('the approval dialog prints Order value, approved, pending, attached, the exception reason and the PI decision', () => {
    const rows = buildApprovalSummary({
      client: 'Kalyan Interiors', grandTotal: '₹1,00,000', advanceLabel: '₹30,000 · 30%',
      financeVerified: true, productCount: 3,
      payment: {
        orderValue: '₹1,00,000',
        approved: '₹30,000.00 · 30%',
        pending: '₹10,000.00 · 10%',
        attached: '₹40,000.00 · 40%',
        exceptionReason: 'Client pays on delivery',
        exceptionStatus: 'pending',
      },
      piApprovedLine: 'PI approved by Ravi Menon · 6 Sep 2026',
    })
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
    assert.equal(byKey.approved_payment.label, APPROVE_PAYMENT_LABEL.approved)
    assert.equal(byKey.approved_payment.value, '₹30,000.00 · 30%')
    assert.equal(byKey.pending_payment.value, '₹10,000.00 · 10%')
    assert.equal(byKey.attached_payment.value, '₹40,000.00 · 40%')
    assert.equal(byKey.exception.label, `${APPROVE_PAYMENT_LABEL.exception} (pending)`)
    assert.equal(byKey.exception.value, 'Client pays on delivery')
    assert.equal(byKey.pi_decision.value, 'PI approved by Ravi Menon · 6 Sep 2026')
  })

  test('without a payment summary the five original rows are exactly what they were', () => {
    const rows = buildApprovalSummary({
      client: 'K', grandTotal: '₹1', advanceLabel: 'a', financeVerified: false, productCount: 1,
    })
    assert.deepEqual(rows.map(r => r.key), ['client', 'total', 'advance', 'finance', 'lines'])
  })

  test('an attached figure the server did not report prints no attached row, never ₹0', () => {
    const rows = buildApprovalSummary({
      client: 'K', grandTotal: '₹1', advanceLabel: 'a', financeVerified: true, productCount: 1,
      payment: { orderValue: '₹1', approved: '₹0.00 · 0%', pending: '₹0.00 · 0%', attached: null,
                 exceptionReason: null, exceptionStatus: null },
    })
    assert.ok(!rows.some(r => r.key === 'attached_payment'))
    assert.ok(!rows.some(r => r.key === 'exception'))
  })
})
