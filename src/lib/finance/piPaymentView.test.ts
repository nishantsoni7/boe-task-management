/**
 * The PI payment card's pure half.
 *
 * WHY THESE ARE WORTH TESTING. Almost everything here is a BOUNDARY, and a
 * boundary is what stops being checked on the third read of a form:
 *
 *   * a recorded payment must never be WORDED as a received-and-verified one;
 *   * "12.345" must be REFUSED, not quietly rounded — the figure that reaches
 *     the ledger has to be the figure somebody typed;
 *   * a total must never be recomputed in the browser, because a percentage of
 *     a grand total is an eligibility figure;
 *   * the Add Payment control must not be offered to somebody the database
 *     would refuse, and must not be hidden from somebody it would allow;
 *   * a payment is not idempotent, so a second click must not record it twice.
 *
 * NONE OF THIS IS THE ACCESS CONTROL. record_pi_submission_payment() re-derives
 * the actor, the permission, the ownership, the PI state and every numeric rule
 * inside the database, under a row lock, on every call.
 *
 * Pure functions only. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/finance/piPaymentView.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  EMPTY_PI_PAYMENT_FORM,
  PI_PAYMENT_MODES,
  PI_PAYMENT_PROOF_FAILED,
  PI_PAYMENT_RECORDED_BODY,
  PI_PAYMENT_RECORDED_TITLE,
  PI_PAYMENT_STATUS_LABEL,
  buildPiPaymentPayload,
  canAddPiPayment,
  canSubmitPiPayment,
  formatMoney,
  formatPercent,
  isAwaitingVerification,
  isPiPaymentFormValid,
  paymentModeLabel,
  piPaymentErrorMessage,
  piPaymentStatusLabel,
  piPaymentStatusTone,
  piPaymentTiles,
  validatePiPaymentForm,
  type PiPaymentFormState,
  type PiPaymentSummary,
} from './piPaymentView'

const TODAY = '2026-08-19'

const form = (over: Partial<PiPaymentFormState> = {}): PiPaymentFormState => ({
  ...EMPTY_PI_PAYMENT_FORM,
  amount: '1000',
  paymentDate: TODAY,
  paymentMode: 'upi',
  ...over,
})

// ── Status wording ────────────────────────────────────────────────────────────

describe('status wording maps the database vocabulary to the product one', () => {
  test('pending_approval reads as Awaiting Verification', () => {
    assert.equal(piPaymentStatusLabel('pending_approval'), 'Awaiting Verification')
  })

  test('both approved statuses read simply Verified', () => {
    assert.equal(piPaymentStatusLabel('approved_unlinked'), 'Verified')
    assert.equal(piPaymentStatusLabel('approved_linked'), 'Verified')
  })

  test('needs_clarification and rejected keep their own words', () => {
    assert.equal(piPaymentStatusLabel('needs_clarification'), 'Needs Clarification')
    assert.equal(piPaymentStatusLabel('rejected'), 'Rejected')
  })

  test('every database status has a label — none can render blank', () => {
    for (const s of ['pending_approval', 'needs_clarification', 'rejected',
                     'approved_unlinked', 'approved_linked']) {
      assert.ok(PI_PAYMENT_STATUS_LABEL[s], `${s} has no label`)
      assert.notEqual(piPaymentStatusTone(s), 'neutral', `${s} has no tone`)
    }
  })

  test('an unknown status says what it is rather than being relabelled', () => {
    assert.equal(piPaymentStatusLabel('some_future_status'), 'some_future_status')
    assert.equal(piPaymentStatusTone('some_future_status'), 'neutral')
    assert.equal(piPaymentStatusLabel(null), '—')
  })

  test('no label claims money was received or confirmed', () => {
    for (const label of Object.values(PI_PAYMENT_STATUS_LABEL)) {
      assert.ok(!/received|confirmed|cleared|settled/i.test(label),
        `"${label}" implies the money is confirmed`)
    }
  })

  test('awaiting-verification mirrors the database unverified branch exactly', () => {
    assert.equal(isAwaitingVerification('pending_approval'), true)
    assert.equal(isAwaitingVerification('needs_clarification'), true)
    assert.equal(isAwaitingVerification('rejected'), false)
    assert.equal(isAwaitingVerification('approved_unlinked'), false)
    assert.equal(isAwaitingVerification('approved_linked'), false)
  })
})

// ── The summary is formatted, never recomputed ────────────────────────────────

describe('the card formats the database totals and never recalculates them', () => {
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

  test('the six confirmed tiles, in order', () => {
    // The GRAND TOTAL leads since Phase 3: every other figure on the card is a
    // part of it, and a reader who cannot see the whole cannot judge the parts.
    const tiles = piPaymentTiles(summary())
    assert.deepEqual(tiles.map(t => t.key),
      ['grand', 'verified', 'unverified', 'percent', 'needed', 'balance'])
    assert.equal(tiles[0].value, '₹1,00,000.00')
    assert.equal(tiles[1].value, '₹30,000.00')
    assert.equal(tiles[2].value, '₹10,000.00')
    assert.equal(tiles[3].value, '30%')
    assert.equal(tiles[4].value, '₹10,000.00')
    assert.equal(tiles[5].value, '₹70,000.00')
  })

  test('DELIBERATELY INCONSISTENT figures survive unchanged', () => {
    // The decisive test: if the browser recomputed anything, these would be
    // "corrected". They must not be — the database is the authority, and a
    // second implementation here is how the two come to disagree.
    const tiles = piPaymentTiles(summary({
      verified_amount: '1.00',
      verified_percent: '99.00',
      needed_for_standard: '12345.67',
      pending_balance: '0.01',
    }))
    assert.equal(tiles[1].value, '₹1.00')
    assert.equal(tiles[3].value, '99%')
    assert.equal(tiles[4].value, '₹12,345.67')
    assert.equal(tiles[5].value, '₹0.01')
  })

  test('an uncomputable percentage reads as a dash, never as zero', () => {
    // A PI with no stored grand total. 0% would say "nothing received", which is
    // a different and false statement.
    const tiles = piPaymentTiles(summary({ grand_total: null, verified_percent: null }))
    assert.equal(tiles[3].value, '—')
    assert.equal(formatPercent(null), '—')
    assert.equal(formatMoney(null), '—')
  })

  test('numeric arrives as a string and keeps its paise', () => {
    assert.equal(formatMoney('1234567.89'), '₹12,34,567.89')
    assert.equal(formatMoney(0), '₹0.00')
    assert.equal(formatMoney('not a number'), '—')
  })

  test('the standard percentage comes from the summary, not from a literal', () => {
    const tiles = piPaymentTiles(summary({ standard_percent: 55 }))
    assert.match(tiles[4].hint ?? '', /55%/)
  })

  test('no tile mentions the declared advance', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/finance/piPaymentView.ts'), 'utf8')
    for (const forbidden of ['advance_declared_amount', 'advance_condition',
                             'advance_exception_percent', 'declaredAdvance']) {
      assert.ok(!source.includes(forbidden),
        `the payment view must not read ${forbidden} — a declaration is not a payment`)
    }
    for (const t of piPaymentTiles(summary())) {
      assert.ok(!/advance/i.test(t.label), `tile "${t.label}" mentions the advance`)
    }
  })

  test('no summary is offered when there is none', () => {
    assert.deepEqual(piPaymentTiles(null), [])
  })
})

// ── Who is offered the control ────────────────────────────────────────────────

describe('the Add Payment control is offered to exactly whom the database allows', () => {
  const ME = 'user-me'
  const OTHER = 'user-other'
  const actor = (over = {}) => ({ userId: ME, isAdmin: false, canAllocatePayment: false, ...over })
  const pi = (over = {}) => ({
    status: 'draft', submittedBy: OTHER, createdBy: OTHER, assignedTo: null,
    orderId: null, deletionClaimed: false, ...over,
  })

  test('the PI uploader, on every open stage', () => {
    for (const status of ['draft', 'submitted', 'needs_changes']) {
      assert.equal(canAddPiPayment(actor(), pi({ status, submittedBy: ME })), true, status)
    }
  })

  test('the creator and the named reviewer too', () => {
    assert.equal(canAddPiPayment(actor(), pi({ createdBy: ME })), true)
    assert.equal(canAddPiPayment(actor(), pi({ assignedTo: ME })), true)
  })

  test('an admin, and an explicit finance.allocate holder', () => {
    assert.equal(canAddPiPayment(actor({ isAdmin: true }), pi()), true)
    assert.equal(canAddPiPayment(actor({ canAllocatePayment: true }), pi()), true)
  })

  test('an unrelated user with no allocate action is not offered it', () => {
    assert.equal(canAddPiPayment(actor(), pi()), false)
  })

  test('a null viewer never matches a null column', () => {
    // The same three-valued trap the server-side check coalesces away: a PI with
    // no reviewer must not become writable by an unauthenticated reader.
    assert.equal(canAddPiPayment(actor({ userId: null }), pi({ assignedTo: null })), false)
    assert.equal(canAddPiPayment(actor({ userId: null }), pi({ submittedBy: null })), false)
  })

  test('a PI that has become an Order sends the user to the Order route', () => {
    assert.equal(canAddPiPayment(actor({ isAdmin: true }), pi({ orderId: 'order-1' })), false)
    assert.equal(canAddPiPayment(actor({ isAdmin: true }), pi({ status: 'approved' })), false)
  })

  test('a rejected or deletion-claimed PI is closed to payment', () => {
    assert.equal(canAddPiPayment(actor({ isAdmin: true }), pi({ status: 'rejected' })), false)
    assert.equal(canAddPiPayment(actor({ isAdmin: true }), pi({ deletionClaimed: true })), false)
  })
})

// ── The form ──────────────────────────────────────────────────────────────────

describe('only amount, date and mode are mandatory', () => {
  test('the three alone are enough', () => {
    assert.equal(isPiPaymentFormValid(form(), TODAY), true)
    assert.deepEqual(validatePiPaymentForm(form(), TODAY), {})
  })

  test('reference, remarks and proof never block', () => {
    assert.equal(isPiPaymentFormValid(form({ reference: '', remarks: '' }), TODAY), true)
  })

  test('each of the three is required on its own', () => {
    assert.ok(validatePiPaymentForm(form({ amount: '' }), TODAY).amount)
    assert.ok(validatePiPaymentForm(form({ paymentDate: '' }), TODAY).paymentDate)
    assert.ok(validatePiPaymentForm(form({ paymentMode: '' }), TODAY).paymentMode)
  })

  test('an over-precise amount is REFUSED, never rounded', () => {
    assert.ok(validatePiPaymentForm(form({ amount: '12.345' }), TODAY).amount)
    assert.equal(isPiPaymentFormValid(form({ amount: '12.34' }), TODAY), true)
  })

  test('zero, negative and non-numeric amounts fail', () => {
    for (const amount of ['0', '0.00', '-5', 'abc', '1e3', ' ']) {
      assert.equal(isPiPaymentFormValid(form({ amount }), TODAY), false, amount)
    }
  })

  test('a future date fails; today and the past pass', () => {
    assert.ok(validatePiPaymentForm(form({ paymentDate: '2026-08-20' }), TODAY).paymentDate)
    assert.equal(isPiPaymentFormValid(form({ paymentDate: TODAY }), TODAY), true)
    assert.equal(isPiPaymentFormValid(form({ paymentDate: '2020-01-01' }), TODAY), true)
    assert.ok(validatePiPaymentForm(form({ paymentDate: 'not-a-date' }), TODAY).paymentDate)
  })

  test('the mode list is exactly the existing database domain', () => {
    assert.deepEqual(PI_PAYMENT_MODES.map(m => m.value),
      ['bank_transfer', 'cash', 'upi', 'cheque', 'other'])
    for (const m of PI_PAYMENT_MODES) {
      assert.equal(isPiPaymentFormValid(form({ paymentMode: m.value }), TODAY), true, m.value)
    }
    assert.equal(isPiPaymentFormValid(form({ paymentMode: 'crypto' }), TODAY), false)
    assert.equal(paymentModeLabel('bank_transfer'), 'Bank Transfer')
    assert.equal(paymentModeLabel('unknown_mode'), 'unknown_mode')
  })
})

describe('the payload carries only what the RPC accepts', () => {
  test('optional blanks collapse to null, not empty strings', () => {
    const p = buildPiPaymentPayload('pi-1', form({ reference: '  ', remarks: '' }))
    assert.equal(p.p_reference, null)
    assert.equal(p.p_remarks, null)
  })

  test('there is no client, actor, status or allocation field to forge', () => {
    const p = buildPiPaymentPayload('pi-1', form()) as Record<string, unknown>
    assert.deepEqual(Object.keys(p).sort(), [
      'p_amount', 'p_payment_date', 'p_payment_mode', 'p_reference', 'p_remarks', 'p_submission_id',
    ])
    for (const forbidden of ['p_client_name', 'p_status', 'p_actor', 'p_submitted_by',
                             'p_approved_by', 'p_allocation_status', 'p_verified']) {
      assert.equal(forbidden in p, false, `${forbidden} must not be sendable`)
    }
  })

  test('the amount crosses as a number the server re-validates', () => {
    assert.equal(buildPiPaymentPayload('pi-1', form({ amount: ' 250.50 ' })).p_amount, 250.5)
  })
})

// ── Double submission ─────────────────────────────────────────────────────────

describe('a payment cannot be recorded twice by a second click', () => {
  const base = { form: form(), todayIso: TODAY, saving: false, submitted: false }

  test('a valid, idle form may submit', () => {
    assert.equal(canSubmitPiPayment(base), true)
  })

  test('nothing submits while a request is in flight', () => {
    assert.equal(canSubmitPiPayment({ ...base, saving: true }), false)
    assert.equal(canSubmitPiPayment({ ...base, submitted: true }), false)
    assert.equal(canSubmitPiPayment({ ...base, saving: true, submitted: true }), false)
  })

  test('an invalid form never submits, in flight or not', () => {
    assert.equal(canSubmitPiPayment({ ...base, form: form({ amount: '' }) }), false)
  })
})

// ── Wording ───────────────────────────────────────────────────────────────────

describe('nothing tells the user the money has been verified', () => {
  test('the success wording says recorded, and names what happens next', () => {
    assert.match(PI_PAYMENT_RECORDED_TITLE, /recorded/i)
    assert.match(PI_PAYMENT_RECORDED_BODY, /awaiting verification/i)
    assert.ok(!/verified\b(?!.*until)/i.test(PI_PAYMENT_RECORDED_BODY.replace(/nothing is confirmed[^.]*\./i, '')),
      'the success wording must not claim the payment is verified')
  })

  test('a proof failure keeps the payment and says so', () => {
    assert.match(PI_PAYMENT_PROOF_FAILED, /payment was recorded/i)
    assert.match(PI_PAYMENT_PROOF_FAILED, /proof/i)
  })

  test('every coded refusal becomes something a salesperson can act on', () => {
    const cases: [string, RegExp][] = [
      ['PAYMENT_AMOUNT_INVALID: …',            /positive amount/i],
      ['PAYMENT_DATE_FUTURE: …',               /future/i],
      ['PAYMENT_MODE_INVALID: …',              /payment modes/i],
      ['PI_PAYMENT_NOT_PERMITTED: …',          /permission/i],
      ['ORDER_SUBMISSION_CONVERTED: …',        /Order instead/i],
      ['ORDER_SUBMISSION_DELETION_CLAIMED: …', /deletion/i],
    ]
    for (const [raw, expected] of cases) {
      assert.match(piPaymentErrorMessage(raw), expected, raw)
    }
  })

  test('an unrecognised failure does not leak database text', () => {
    const msg = piPaymentErrorMessage('duplicate key value violates unique constraint "x_pkey"')
    assert.ok(!msg.includes('constraint'), 'raw database text must not reach the user')
    assert.match(msg, /try again/i)
    assert.match(piPaymentErrorMessage(null), /try again/i)
  })
})

// ── The card computes no money ────────────────────────────────────────────────

describe('the browser performs no financial arithmetic', () => {
  test('the view module contains no money arithmetic on summary figures', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/finance/piPaymentView.ts'), 'utf8')
    // The only Number() calls permitted are at the formatting boundary and in
    // form validation of what the user just typed — never on a stored total.
    for (const forbidden of ['verified_amount *', 'grand_total *', '/ 100', '* 0.4', '* 40']) {
      assert.ok(!source.includes(forbidden),
        `the view must not compute ${forbidden} — the database owns every total`)
    }
  })

  test('the card component never sums a payment list', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orders/PiPaymentCard.tsx'), 'utf8')
    assert.ok(!/\.reduce\(/.test(source), 'the card must not sum anything client-side')
  })
})

// ── The formatting boundary, at the same exact values ────────────────────────
//
// The database owns every figure and returns `numeric` AS A STRING, which is
// what stops a JSON double from touching an approval figure. These cases prove
// the browser then renders those strings faithfully — and, just as importantly,
// that it does not recompute any of them.
//
// The five rows are the same ones pi_submission_payment_assertions.sql drives
// end to end through the RPC, so if the two ever disagree one of them is wrong.

describe('the card renders the database figures exactly', () => {
  const CASES = [
    { grand: '33333.33', verified: '0.00',     needed: '13333.33', pending: '33333.33', pct: '0.00'  },
    { grand: '33333.33', verified: '10000.00', needed: '3333.33',  pending: '23333.33', pct: '30.00' },
    { grand: '10000.00', verified: '4000.00',  needed: '0.00',     pending: '6000.00',  pct: '40.00' },
    { grand: '0.30',     verified: '0.10',     needed: '0.02',     pending: '0.20',     pct: '33.33' },
    // The sub-paise row: 40% of 33,333.33 is 13,333.332 and 0.30 is already
    // verified, so 13,333.032 rounds to 13,333.03. The value a careless reading
    // of "40% of 33,333.33" gets wrong.
    { grand: '33333.33', verified: '0.30',     needed: '13333.03', pending: '33333.03', pct: '0.00'  },
  ] as const

  const EXPECTED = [
    { verified: '₹0.00',      needed: '₹13,333.33', pending: '₹33,333.33', pct: '0%'     },
    { verified: '₹10,000.00', needed: '₹3,333.33',  pending: '₹23,333.33', pct: '30%'    },
    { verified: '₹4,000.00',  needed: '₹0.00',      pending: '₹6,000.00',  pct: '40%'    },
    { verified: '₹0.10',      needed: '₹0.02',      pending: '₹0.20',      pct: '33.33%' },
    { verified: '₹0.30',      needed: '₹13,333.03', pending: '₹33,333.03', pct: '0%'     },
  ] as const

  for (const [i, c] of CASES.entries()) {
    test(`grand ${c.grand}, verified ${c.verified} renders faithfully`, () => {
      const tiles = piPaymentTiles({
        submission_id: 'pi-1',
        grand_total: c.grand,
        verified_amount: c.verified,
        unverified_amount: '0.00',
        verified_percent: c.pct,
        unverified_percent: '0.00',
        needed_for_standard: c.needed,
        pending_balance: c.pending,
        standard_percent: 40,
        can_view_all_finance: false,
        payments: [],
      })
      const e = EXPECTED[i]
      assert.equal(tiles.find(t => t.key === 'verified')!.value,   e.verified)
      assert.equal(tiles.find(t => t.key === 'needed')!.value,     e.needed)
      assert.equal(tiles.find(t => t.key === 'balance')!.value,    e.pending)
      assert.equal(tiles.find(t => t.key === 'percent')!.value,    e.pct)
    })
  }

  test('a paise value never loses its second decimal', () => {
    // The failure this guards against is a formatter defaulting to 0 fraction
    // digits, which would print ₹13,333 and read as a different requirement.
    assert.equal(formatMoney('13333.33'), '₹13,333.33')
    assert.equal(formatMoney('13333.03'), '₹13,333.03')
    assert.equal(formatMoney('0.02'), '₹0.02')
    assert.equal(formatMoney('0.30'), '₹0.30')
  })

  test('the string the database sends is never re-derived from another field', () => {
    // needed and pending are printed from their OWN fields. If the browser
    // recomputed either from grand_total and verified it would "correct" these
    // deliberately inconsistent inputs — and must not.
    const tiles = piPaymentTiles({
      submission_id: 'pi-1',
      grand_total: '33333.33',
      verified_amount: '0.00',
      unverified_amount: '0.00',
      verified_percent: '99.99',
      unverified_percent: '0.00',
      needed_for_standard: '1.11',
      pending_balance: '2.22',
      standard_percent: 40,
      can_view_all_finance: false,
      payments: [],
    })
    assert.equal(tiles.find(t => t.key === 'needed')!.value, '₹1.11')
    assert.equal(tiles.find(t => t.key === 'balance')!.value, '₹2.22')
    assert.equal(tiles.find(t => t.key === 'percent')!.value, '99.99%')
  })
})
