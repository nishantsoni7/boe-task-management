/**
 * The verified-payment gate, as the browser applies it.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * The rule exists twice: once in SQL, where it decides whether an Order comes
 * into existence, and once here, where it decides what a person is shown and
 * what the submit dialog is allowed to send. This proves the second copy behaves
 * like the first — the mandatory fields below the requirement, the wording of
 * every refusal, and the one thing that matters most: that this module never
 * computes money.
 *
 * The SQL half is covered by verifiedPaymentGateSchema.test.ts, which reads the
 * migration itself, and by supabase/tests/pi_verified_payment_gate_assertions.sql,
 * which runs against a real database.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/paymentGate.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  EMPTY_SUBMISSION_TERMS,
  PAYMENT_ADMIN_APPROVAL_REQUIRED,
  PAYMENT_AWAITING_VERIFICATION,
  PAYMENT_EXCEPTION_PENDING,
  PAYMENT_EXCEPTION_REJECTED,
  PAYMENT_EXCEPTION_STALE,
  PAYMENT_GATE_FAILURES,
  PAYMENT_POSITIONS,
  PAYMENT_POSITION_HINT,
  PAYMENT_POSITION_LABEL,
  PAYMENT_POSITION_TONE,
  PAYMENT_POSITION_UNKNOWN,
  PAYMENT_REASON_MAX_LENGTH,
  PAYMENT_REASON_REQUIRED,
  OTHER_REMARK_REQUIRED,
  OTHER_REMARK_MIN_LENGTH,
  EXCEPTION_REASON_OPTIONS,
  composeExceptionReason,
  readExceptionReason,
  keptExceptionReason,
  exceptionReasonKept,
  PAYMENT_REASON_TOO_LONG,
  PAYMENT_STANDARD_PERCENT,
  PAYMENT_TERMS_MAX_LENGTH,
  PAYMENT_TERMS_TOO_LONG,
  asPaymentPosition,
  paymentPositionLines,
  shortfallSentence,
  submissionTermsUntouched,
  validateSubmissionTerms,
  type PaymentPosition,
} from './paymentGate'

const source = readFileSync('src/lib/orders/paymentGate.ts', 'utf8')

// ── The requirement is one number, in one place ───────────────────────────────

describe('the standard requirement has a single source', () => {
  test('it is 40, and it comes from the shared constant', () => {
    assert.equal(PAYMENT_STANDARD_PERCENT, 40)
    assert.ok(source.includes('ADVANCE_STANDARD_PERCENT'),
      'the percentage is imported, never restated as a literal')
  })

  test('the migration states the same number', () => {
    const sql = readFileSync(
      'supabase/migrations/20260913000000_order_submission_advance_exceptions.sql', 'utf8')
    assert.ok(sql.includes('select 40::numeric'),
      'order_submission_standard_advance_percent() and the browser must agree')
  })
})

// ── The positions ─────────────────────────────────────────────────────────────

describe('the six positions, and no seventh', () => {
  test('every position has words, a tone and an actionable hint', () => {
    for (const position of PAYMENT_POSITIONS) {
      assert.ok(PAYMENT_POSITION_LABEL[position], `${position} has no label`)
      assert.ok(PAYMENT_POSITION_TONE[position], `${position} has no tone`)
      assert.ok(PAYMENT_POSITION_HINT[position], `${position} has no hint`)
      assert.ok(!PAYMENT_POSITION_LABEL[position].includes('_'),
        `${position} must never be shown as a database value`)
    }
  })

  test('the six are exactly the six the RPC can return', () => {
    const sql = readFileSync(
      'supabase/migrations/20260921000000_order_submission_verified_payment_gate.sql', 'utf8')
    for (const position of PAYMENT_POSITIONS) {
      assert.ok(sql.includes(`'${position}'`),
        `${position} is named in the browser but the database never returns it`)
    }
  })

  test('a stale approval is its own position, never folded into "not enough"', () => {
    // A salesperson told "payment required" would go and collect money. What is
    // actually needed is for the approver to look at the terms that changed.
    assert.ok(PAYMENT_POSITIONS.includes('exception_stale'))
    assert.notEqual(PAYMENT_POSITION_LABEL.exception_stale,
                    PAYMENT_POSITION_LABEL.payment_required)
    assert.match(PAYMENT_POSITION_HINT.exception_stale, /approved again/i)
  })

  test('an unknown position is refused rather than relabelled', () => {
    assert.equal(asPaymentPosition('standard_met'), 'standard_met')
    assert.equal(asPaymentPosition('something_else'), null)
    assert.equal(asPaymentPosition(null), null)
    assert.equal(asPaymentPosition(undefined), null)
    assert.equal(asPaymentPosition(''), null)
  })

  test('nothing claims that an exception verified a payment', () => {
    // The single most consequential thing this vocabulary must not say.
    const words = Object.values(PAYMENT_POSITION_LABEL)
      .concat(Object.values(PAYMENT_POSITION_HINT))
      .join(' ').toLowerCase()
    for (const forbidden of ['payment verified by admin', 'approval verifies',
                             'exception verifies', 'counts as verified']) {
      assert.ok(!words.includes(forbidden), `no wording may say "${forbidden}"`)
    }
  })
})

// ── What the submit dialog may send ───────────────────────────────────────────

describe('what the submit dialog may send', () => {
  const terms = (over: Partial<typeof EMPTY_SUBMISSION_TERMS> = {}) => ({
    ...EMPTY_SUBMISSION_TERMS, ...over,
  })

  test('at or above the requirement, nothing is mandatory', () => {
    const result = validateSubmissionTerms({ meetsStandard: true, terms: terms() })
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.value,
      { reason: null, paymentTerms: null, billingTerms: null })
  })

  test('below the requirement, one of the three reasons is required — and only that (20270102000000)', () => {
    const none = validateSubmissionTerms({ meetsStandard: false, terms: terms() })
    assert.equal(none.ok, false)
    assert.equal(none.ok === false && none.message, PAYMENT_REASON_REQUIRED)

    // Payment Terms are no longer demanded: a chosen reason is enough.
    for (const [choice, stored] of [['against_client_po', 'Against client PO'], ['sample_order', 'Sample order']] as const) {
      const r = validateSubmissionTerms({ meetsStandard: false, terms: terms({ reasonChoice: choice }) })
      assert.equal(r.ok, true)
      assert.equal(r.ok && r.value.reason, stored, 'the stored words are the database’s words')
      assert.equal(r.ok && r.value.paymentTerms, null)
    }
  })

  test('"Other" needs a real remark, and is stored as "Other: <remark>"', () => {
    for (const remark of ['', '   ', 'too short']) {
      const r = validateSubmissionTerms({ meetsStandard: false, terms: terms({ reasonChoice: 'other', otherRemark: remark }) })
      assert.equal(r.ok, false)
      assert.equal(r.ok === false && r.message, OTHER_REMARK_REQUIRED)
    }
    const ok = validateSubmissionTerms({
      meetsStandard: false, terms: terms({ reasonChoice: 'other', otherRemark: '  repeat client, pays on delivery ' }),
    })
    assert.equal(ok.ok && ok.value.reason, 'Other: repeat client, pays on delivery')
    assert.equal(OTHER_REMARK_MIN_LENGTH, 10, 'the database’s own minimum')
  })

  test('exactly three options, in this order, with these words', () => {
    assert.deepEqual(EXCEPTION_REASON_OPTIONS.map(o => o.label), ['Against client PO', 'Sample order', 'Other'])
  })

  test('a stored reason reads back into the same choice; free text from before opens unchosen', () => {
    assert.deepEqual(readExceptionReason('Against client PO'), { choice: 'against_client_po', remark: '' })
    assert.deepEqual(readExceptionReason('Sample order'), { choice: 'sample_order', remark: '' })
    assert.deepEqual(readExceptionReason('Other: long-standing client'), { choice: 'other', remark: 'long-standing client' })
    assert.deepEqual(readExceptionReason('client pays on delivery'), { choice: '', remark: '' })
    assert.deepEqual(readExceptionReason(null), { choice: '', remark: '' })
    assert.equal(composeExceptionReason('other', 'short'), null)
  })

  test('ZERO payment is the same rule — a reason, never a waiver', () => {
    const zero = validateSubmissionTerms({ meetsStandard: false, terms: terms() })
    assert.equal(zero.ok, false)
  })

  test('terms stay optional on both routes, and are sent TRIMMED when present', () => {
    for (const meetsStandard of [true, false]) {
      const result = validateSubmissionTerms({
        meetsStandard,
        terms: terms({ reasonChoice: 'sample_order', paymentTerms: '  50% now ', billingTerms: '   ' }),
      })
      assert.equal(result.ok, true, `terms must not be required (meets=${meetsStandard})`)
      assert.equal(result.ok && result.value.paymentTerms, '50% now')
      assert.equal(result.ok && result.value.billingTerms, null)
    }
  })

  test('a reason chosen before the payment landed is NOT sent as an exception', () => {
    const result = validateSubmissionTerms({
      meetsStandard: true, terms: terms({ reasonChoice: 'against_client_po' }),
    })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.value.reason, null)
  })

  test('the caps are the database’s caps', () => {
    assert.equal(PAYMENT_REASON_MAX_LENGTH, 1000)
    assert.equal(PAYMENT_TERMS_MAX_LENGTH, 500)
    const long = validateSubmissionTerms({
      meetsStandard: false,
      terms: terms({ reasonChoice: 'sample_order', paymentTerms: 'x'.repeat(PAYMENT_TERMS_MAX_LENGTH + 1) }),
    })
    assert.equal(long.ok === false && long.message, PAYMENT_TERMS_TOO_LONG)
    const longRemark = validateSubmissionTerms({
      meetsStandard: false, terms: terms({ reasonChoice: 'other', otherRemark: 'x'.repeat(PAYMENT_REASON_MAX_LENGTH) }),
    })
    assert.equal(longRemark.ok === false && longRemark.message, PAYMENT_REASON_TOO_LONG)
  })

  test('an unreadable payment position fails CLOSED', () => {
    const result = validateSubmissionTerms({ meetsStandard: null, terms: terms() })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.message, PAYMENT_POSITION_UNKNOWN)
  })

  test('an untouched form is recognised, so nobody is scolded for not typing', () => {
    assert.equal(submissionTermsUntouched(EMPTY_SUBMISSION_TERMS), true)
    assert.equal(submissionTermsUntouched({ ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other' }), false)
    assert.equal(submissionTermsUntouched({ ...EMPTY_SUBMISSION_TERMS, otherRemark: '   ' }), true)
  })
})

// ── No arithmetic ─────────────────────────────────────────────────────────────

describe('this module never computes money', () => {
  test('the position lines are a projection of the summary, unchanged', () => {
    // DELIBERATELY INCONSISTENT FIGURES. If anything here recomputed, these
    // would be "corrected" — and the browser would have an opinion about
    // eligibility, which is exactly what must never happen.
    const lines = paymentPositionLines({
      grandTotal: '100000.00',
      verifiedAmount: '1.00',
      verifiedPercent: '99.00',
      unverifiedAmount: '5.00',
      neededForStandard: '12345.67',
      formatFigure: v => String(v),
      formatPercentage: v => String(v),
    })
    assert.deepEqual(lines.map(l => l.key),
      ['grand', 'verified', 'percent', 'unverified', 'needed'])
    assert.deepEqual(lines.map(l => l.value),
      ['100000.00', '1.00', '99.00', '5.00', '12345.67'])
  })

  test('there is no division, no percentage arithmetic and no threshold literal', () => {
    for (const arithmetic of ['/ 100', '* 100', '* 0.4', 'parseFloat(']) {
      assert.ok(!source.includes(arithmetic),
        `${arithmetic} must not appear: eligibility figures are computed in numeric, in the database`)
    }
    // The one place 40 may appear is the shared constant's own re-export.
    assert.ok(!/>=\s*40\b/.test(source), 'no threshold comparison in the browser')
  })

  test('the shortfall sentence names a real outstanding figure, or says nothing', () => {
    assert.equal(shortfallSentence('400000.00'),
      '₹4,00,000 more verified payment is required for standard approval.')
    assert.equal(shortfallSentence('0.00'), null, 'nothing outstanding says nothing')
    assert.equal(shortfallSentence(null), null)
    assert.equal(shortfallSentence('not a number'), null)
  })
})

// ── The refusals ──────────────────────────────────────────────────────────────

describe('every refusal is business language, and never the database’s own', () => {
  test('the five confirmed sentences exist, word for word', () => {
    assert.equal(PAYMENT_AWAITING_VERIFICATION, 'Payment is awaiting Finance verification.')
    assert.equal(PAYMENT_ADMIN_APPROVAL_REQUIRED, 'Admin approval is required to proceed below 40%.')
    assert.equal(PAYMENT_EXCEPTION_PENDING, 'The reduced-payment exception is still pending.')
    assert.equal(PAYMENT_EXCEPTION_REJECTED,
      'The reduced-payment exception was rejected. Update the PI before resubmitting.')
    assert.equal(PAYMENT_EXCEPTION_STALE,
      'The reduced-payment approval was given for different commercial terms and must be approved again.')
    assert.ok(shortfallSentence('1.00')?.endsWith('more verified payment is required for standard approval.'))
  })

  test('every coded refusal the RPCs raise has a sentence here', () => {
    const sql = readFileSync(
      'supabase/migrations/20260921000000_order_submission_verified_payment_gate.sql', 'utf8')
    const raised = [...sql.matchAll(/raise exception\s*\n?\s*'(ORDER_SUBMISSION_[A-Z_]+):/g)]
      .map(m => m[1])
    const mapped = new Set(PAYMENT_GATE_FAILURES.map(f => f.marker))
    const workflow = readFileSync('src/lib/orders/submissionWorkflow.ts', 'utf8')
    // ORDER_SUBMISSION_NOT_AVAILABLE is the payment summary's refusal to a
    // caller who may not open the PI. loadPiPaymentSummary() answers it with
    // NULL — no card content — which is not a page failure and not a sentence.
    // Codes the SCREENS never show, each for a stated reason.
    const SILENT = new Set([
      // The payment summary's refusal to a caller who cannot open the PI.
      // loadPiPaymentSummary() answers it with NULL — no card content — which is
      // not a page failure and not a sentence.
      'ORDER_SUBMISSION_NOT_AVAILABLE',
      // Guard-trigger refusals. Nothing a browser can reach produces them: they
      // exist to refuse a direct UPDATE, and the RPC in front of each one has
      // already said the same thing in business language.
      'ORDER_SUBMISSION_EXCEPTION_BASIS_IMMUTABLE',
      'ORDER_SUBMISSION_ADVANCE_INVALID',
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING',
    ])
    for (const code of new Set(raised)) {
      if (SILENT.has(code)) continue
      assert.ok(mapped.has(code) || workflow.includes(code),
        `${code} is raised by the migration but no screen knows what to say about it`)
    }
  })

  test('no sentence leaks a database code to the reader', () => {
    for (const entry of PAYMENT_GATE_FAILURES) {
      assert.ok(!/ORDER_SUBMISSION_|errcode|P0001|42501/.test(entry.message), entry.message)
    }
  })

  test('the more specific code is matched first', () => {
    // 'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION' must not be answered by
    // the sentence for an ordinary shortfall.
    const markers = PAYMENT_GATE_FAILURES.map(f => f.marker)
    assert.ok(markers.indexOf('ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION')
            < markers.indexOf('ORDER_SUBMISSION_PAYMENT_INSUFFICIENT'))
  })
})

// ── The boundary this module must not cross ───────────────────────────────────

describe('a declaration is not a payment, and this module never reads one', () => {
  test('it reads no declared-advance column', () => {
    for (const column of ['advance_declared_amount', 'advance_exception_percent',
                          'advance_condition']) {
      assert.ok(!source.includes(column),
        `paymentGate must not read ${column}: what was declared decides nothing`)
    }
  })

  test('it names the exception STATE, which is the one thing it does share', () => {
    // The reduced-payment exception reuses 20260913000000's workflow rather than
    // building a second one, so the exception's state legitimately appears in the
    // positions — as a decision about payment, never as a declared figure.
    assert.ok(PAYMENT_POSITIONS.includes('exception_approved' as PaymentPosition))
    assert.ok(PAYMENT_POSITIONS.includes('exception_pending' as PaymentPosition))
    assert.ok(PAYMENT_POSITIONS.includes('exception_rejected' as PaymentPosition))
  })
})

// ── A returned PI keeps an approved exception in its old words (review) ───────

describe('a returned PI with an approved exception written before the three reasons', () => {
  const summary = { exception_status: 'approved', exception_current: true, exception_reason: 'client pays on delivery' }
  test('is carried forward as it is', () => {
    assert.equal(keptExceptionReason(summary), 'client pays on delivery')
    const v = validateSubmissionTerms({
      meetsStandard: false, keptReason: keptExceptionReason(summary),
      terms: { reasonChoice: '', otherRemark: '', paymentTerms: '', billingTerms: '' },
    })
    assert.ok(v.ok && v.value.reason === 'client pays on delivery', JSON.stringify(v))
  })
  test('choosing a new reason replaces it (and an admin decides again)', () => {
    const v = validateSubmissionTerms({
      meetsStandard: false, keptReason: 'client pays on delivery',
      terms: { reasonChoice: 'sample_order', otherRemark: '', paymentTerms: '', billingTerms: '' },
    })
    assert.ok(v.ok && v.value.reason === 'Sample order')
  })
  test('nothing is kept for a pending, stale, or already-categorised exception', () => {
    assert.equal(keptExceptionReason({ ...summary, exception_status: 'pending' }), null)
    assert.equal(keptExceptionReason({ ...summary, exception_current: false }), null)
    assert.equal(keptExceptionReason({ ...summary, exception_reason: 'Sample order' }), null, 'the dialog pre-selects it instead')
    assert.equal(keptExceptionReason(null), null)
  })
  test('without one, a reason must still be chosen', () => {
    const v = validateSubmissionTerms({ meetsStandard: false, terms: { reasonChoice: '', otherRemark: '', paymentTerms: '', billingTerms: '' } })
    assert.ok(!v.ok && v.message === PAYMENT_REASON_REQUIRED)
  })
  test('the dialog says so', () => {
    assert.match(exceptionReasonKept('client pays on delivery'), /^The approved exception stands: “client pays on delivery”\. Resubmitting keeps it\./)
  })
})
