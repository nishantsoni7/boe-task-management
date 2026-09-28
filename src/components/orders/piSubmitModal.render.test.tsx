/**
 * THE SUBMIT DIALOG, ACTUALLY RENDERED.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The dialog used to ask the employee to DECLARE an advance, and a whole phase's
 * worth of tests proved the declaration helpers were right while nobody had
 * checked that the choice was reachable on screen at all — which, for a while,
 * it was not. The lesson survives the rewrite: a helper can be right while the
 * screen is wrong, and markup cannot.
 *
 * WHAT THE DIALOG ASKS NOW. Nothing about a declared advance. It STATES the PI's
 * live verified-payment position — every figure computed in `numeric` by
 * pi_submission_payment_summary() — and asks for the two things the business
 * genuinely does not know: why an Order should be confirmed below the standard
 * requirement, and how the rest of the money will be collected.
 *
 * WHY renderToStaticMarkup AND NOT A BROWSER. There is no DOM in this repository
 * and no test runner that provides one. Every state this file needs is reachable
 * through the `payment` prop, which is exactly how the page reaches them — so
 * the states are real states, arrived at the real way.
 *
 * Run:
 *   npx tsx --test src/components/orders/piSubmitModal.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiSubmitConfirmModal } from './piReviewModals'
import {
  BILLING_TERMS_LABEL,
  EMPTY_SUBMISSION_TERMS,
  PAYMENT_POSITION_HINT,
  PAYMENT_POSITION_LABEL,
  PAYMENT_POSITION_UNKNOWN,
  PAYMENT_REASON_LABEL,
  EXCEPTION_REASON_NOT_A_DECISION,
  OTHER_REMARK_LABEL,
  OTHER_REMARK_REQUIRED,
  PAYMENT_REASON_REQUIRED,
  PAYMENT_STANDARD_PERCENT,
  PAYMENT_TERMS_LABEL,
  PAYMENT_TERMS_OPTIONAL_LABEL,
  ATTACHED_MET_AWAITING_VERIFICATION,
  SUBMISSION_POSITION_LABEL,
  type PiSubmissionTerms,
} from '@/lib/orders/paymentGate'
import type { PiPaymentSummary } from '@/lib/finance/piPaymentView'
import { SUBMIT_BUTTON_LABEL } from '@/lib/orders/submissionWorkflow'
import { formatInr } from '@/lib/pi/previewView'
import { SUBMISSION_DETAILS_INCOMPLETE, orderDetailsReview } from '@/lib/orders/salesOrderDetails'
import { SUBMISSION_CONFIRM_LABEL, type PiInternalDetailsRow } from '@/lib/orders/piInternalDetails'

const GRAND_TOTAL = 118000

/** The summary the RPC returns, as the page hands it to the dialog. */
const summary = (over: Partial<PiPaymentSummary> = {}): PiPaymentSummary => ({
  submission_id: 'pi-1',
  submission_status: 'draft',
  grand_total: '118000.00',
  verified_amount: '47200.00',
  unverified_amount: '0.00',
  verified_percent: '40.00',
  unverified_percent: '0.00',
  needed_for_standard: '0.00',
  required_payment: '47200.00',
  meets_standard: true,
  approval_position: 'standard_met',
  pending_balance: '70800.00',
  standard_percent: 40,
  can_view_all_finance: false,
  payments: [],
  ...over,
})

/** Below the requirement: ₹10,000 verified against a ₹1,18,000 total. */
const below = (over: Partial<PiPaymentSummary> = {}): PiPaymentSummary => summary({
  verified_amount: '10000.00',
  verified_percent: '8.47',
  needed_for_standard: '37200.00',
  meets_standard: false,
  approval_position: 'payment_required',
  ...over,
})

/**
 * The dialog with the props THE PI DETAIL PAGE PASSES IT.
 *
 * Every value here is named the same way the page names it, so a prop that
 * stops being supplied there fails to compile here.
 */
function render(over: {
  payment?: PiPaymentSummary | null
  initialTerms?: PiSubmissionTerms
  submitting?: boolean
  failure?: string | null
  offerReply?: boolean
  internalDetails?: PiInternalDetailsRow | null
  detailsReview?: ReturnType<typeof orderDetailsReview>
} = {}): string {
  return renderToStaticMarkup(
    <PiSubmitConfirmModal
      client="Kalyan Interiors"
      grandTotal={formatInr(GRAND_TOTAL)}
      payment={over.payment === undefined ? summary() : over.payment}
      initialTerms={over.initialTerms ?? EMPTY_SUBMISSION_TERMS}
      submitting={over.submitting ?? false}
      failure={over.failure ?? null}
      offerReply={over.offerReply ?? false}
      onCancel={() => {}}
      onConfirm={() => {}}
      internalDetails={over.internalDetails}
      detailsReview={over.detailsReview}
    />,
  )
}

/**
 * Whether the Submit button in this markup is disabled.
 *
 * Read from the SUBMIT button specifically, not from "does the word disabled
 * appear" — Cancel and the × control carry their own disabled state and would
 * make a naive check pass for the wrong reason.
 */
function submitDisabled(html: string): boolean {
  const button = html.lastIndexOf('<button')
  assert.ok(button >= 0, 'the Submit button must be on screen at all')
  const tail = html.slice(button)
  assert.ok(tail.includes(SUBMIT_BUTTON_LABEL) || tail.includes('Submitting'),
    'the last button in the dialog must be the confirm')
  const openTagEnd = tail.indexOf('>')
  return tail.slice(0, openTagEnd).includes('disabled=""')
}

// ── The position, stated rather than asked for ────────────────────────────────

describe('the dialog states the live verified-payment position', () => {
  const html = render()

  test('the five figures a salesperson needs are all on screen', () => {
    for (const label of ['Grand total', 'Verified payment', 'Verified payment %',
                         'Awaiting verification', 'Needed for standard approval']) {
      assert.ok(html.includes(label), `"${label}" is missing from the dialog`)
    }
  })

  test('every figure is the database’s, formatted and not recomputed', () => {
    assert.ok(html.includes('₹47,200.00'), 'the verified amount, as the RPC reported it')
    assert.ok(html.includes('40%'))
  })

  test('the client and the grand total are still there', () => {
    assert.ok(html.includes('Kalyan Interiors'))
    assert.ok(html.includes(formatInr(GRAND_TOTAL)))
  })

  test('NOTHING asks for, or mentions, a declared advance', () => {
    // The whole point of the phase: a declaration is not a payment, and the
    // dialog no longer offers one to make.
    assert.ok(!/declared advance|advance requirement|Reduced advance|No advance/i.test(html), html.slice(0, 400))
    assert.ok(!html.includes('type="radio"'), 'there is no advance choice to make any more')
  })

  test('it says only verified payment counts, without claiming any verification', () => {
    assert.ok(/Only payment Finance has verified counts/i.test(html))
    assert.ok(!/has been verified by Finance/i.test(html))
  })
})

// ── At or above the requirement ───────────────────────────────────────────────

describe('at or above the requirement the dialog asks for nothing mandatory', () => {
  const html = render()

  test('it says the standard requirement is met', () => {
    assert.ok(html.includes(PAYMENT_POSITION_LABEL.standard_met))
    assert.ok(html.includes(PAYMENT_POSITION_HINT.standard_met))
  })

  test('no reason is asked for', () => {
    assert.ok(!html.includes(PAYMENT_REASON_LABEL))
  })

  test('the terms are OFFERED and both optional', () => {
    assert.ok(html.includes(PAYMENT_TERMS_OPTIONAL_LABEL))
    assert.ok(html.includes(BILLING_TERMS_LABEL))
  })

  test('Submit is available immediately', () => {
    assert.equal(submitDisabled(html), false)
  })
})

// ── Below the requirement ─────────────────────────────────────────────────────

describe('below the requirement the dialog asks for exactly one of three reasons (20270114000000)', () => {
  const html = render({ payment: below() })

  test('it says Admin approval is required to proceed', () => {
    assert.ok(html.includes(`Admin approval required to proceed below ${PAYMENT_STANDARD_PERCENT}%`))
  })

  test('three radio options, marked mandatory, and nothing else to fill in', () => {
    assert.ok(html.includes(PAYMENT_REASON_LABEL))
    assert.ok(PAYMENT_REASON_LABEL.endsWith('*'))
    assert.equal((html.match(/type="radio"/g) ?? []).length, 3)
    for (const label of ['Against client PO', 'Sample order', 'Other']) assert.ok(html.includes(label))
    assert.ok(!html.includes(PAYMENT_TERMS_LABEL), 'Payment terms are no longer demanded here')
    assert.ok(!html.includes(BILLING_TERMS_LABEL), 'and no terms boxes clutter the request')
    assert.ok(html.includes(EXCEPTION_REASON_NOT_A_DECISION), 'and it says a reason decides nothing')
  })

  test('"Other" reveals a remark box, and only "Other" does', () => {
    const other = render({ payment: below(), initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other' } })
    assert.ok(other.includes(OTHER_REMARK_LABEL))
    const po = render({ payment: below(), initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'against_client_po' } })
    assert.ok(!po.includes(OTHER_REMARK_LABEL))
  })

  test('Submit is disabled until a reason is chosen, and Other has its remark', () => {
    assert.equal(submitDisabled(html), true)
    assert.equal(submitDisabled(render({
      payment: below(), initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'sample_order' },
    })), false, 'Sample order alone is enough — no payment terms needed')
    assert.equal(submitDisabled(render({
      payment: below(), initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'short' },
    })), true, 'Other needs a real remark')
    assert.equal(submitDisabled(render({
      payment: below(), initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'long-standing client, pays on delivery' },
    })), false)
  })

  test('the shortfall is named, so the salesperson knows what would close it', () => {
    assert.ok(html.includes('₹37,200.00'))
  })

  test('an untouched form is not scolded', () => {
    // Somebody who has just opened the dialog has not made a mistake yet.
    assert.ok(!html.includes(PAYMENT_REASON_REQUIRED))
    const typed = render({
      payment: below(),
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'short' },
    })
    assert.ok(typed.includes(OTHER_REMARK_REQUIRED),
      'but once they have started, what is missing is named')
  })
})

// ── Money Finance has not decided ─────────────────────────────────────────────

describe('unverified payment is shown and said not to count', () => {
  const html = render({
    payment: below({
      unverified_amount: '40000.00',
      unverified_percent: '33.90',
      approval_position: 'verification_pending',
    }),
  })

  test('the figure is on screen', () => {
    assert.ok(html.includes('₹40,000.00'))
  })

  test('and it is stated that Finance has not decided it', () => {
    assert.ok(html.includes(PAYMENT_POSITION_HINT.verification_pending))
  })

  test('it does not close the gate on its own', () => {
    assert.equal(submitDisabled(html), true, 'the mandatory fields are still required')
  })
})

// ── An unreadable position ────────────────────────────────────────────────────

describe('a PI whose payment position cannot be read fails CLOSED', () => {
  const html = render({ payment: null })

  test('the reason is said immediately, before anything is typed', () => {
    assert.ok(html.includes(PAYMENT_POSITION_UNKNOWN),
      'no amount of typing fixes this one, so it is not withheld')
  })

  test('and Submit stays disabled', () => {
    assert.equal(submitDisabled(html), true)
  })
})

// ── In flight ─────────────────────────────────────────────────────────────────

describe('a submission in flight cannot be started twice', () => {
  const html = render({
    payment: below(),
    initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'agreed with the client directly' },
    submitting: true,
  })

  test('Submit is disabled and says so', () => {
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes('Submitting…'))
  })

  test('and every field is frozen with it', () => {
    assert.ok(/<textarea[^>]*disabled=""/.test(html))
    assert.ok(/<input[^>]*type="radio"[^>]*disabled=""/.test(html))
  })
})

describe('a failed submission keeps the words on screen', () => {
  test('the typed terms survive, and the failure is shown beside them', () => {
    const html = render({
      payment: below(),
      initialTerms: {
        ...EMPTY_SUBMISSION_TERMS,
        reasonChoice: 'other',
        otherRemark: 'client pays on delivery',
      },
      failure: 'This PI could not be submitted just now. Try again in a moment.',
    })
    assert.ok(html.includes('client pays on delivery'))
    const otherInput = (html.match(/<input[^>]*value="other"[^>]*>/) ?? [''])[0]
    assert.ok(/ checked=""/.test(otherInput), 'the choice survives too: ' + otherInput)
    assert.ok(html.includes('could not be submitted just now'))
  })
})

// ── The page that opens it ────────────────────────────────────────────────────

describe('this is the dialog the PI detail page opens, and the RPC it sends to', () => {
  const page = readFileSync(
    join(process.cwd(), 'src', 'app', 'orders', 'drafts', '[submissionId]', 'page.tsx'), 'utf8')
  // The submit door's call lives in the supporting-documents sender (20270112000000 §11).
  const supportingSource = readFileSync(
    join(process.cwd(), 'src', 'components', 'orders', 'PiSupportingDocuments.tsx'), 'utf8')
  const documentsMigration = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20270112000000_order_document_submissions.sql'), 'utf8').replace(/\r\n/g, '\n')

  test('the page imports THIS component, and there is no second submit modal', () => {
    assert.ok(/import \{[\s\S]*?\bPiSubmitConfirmModal\b[\s\S]*?\} from '@\/components\/orders\/piReviewModals'/
      .test(page))
    assert.ok(page.includes('<PiSubmitConfirmModal'))
    assert.equal((page.match(/<PiSubmitConfirmModal/g) ?? []).length, 1)
  })

  test('it hands the dialog the LIVE payment summary, not the record’s declaration', () => {
    assert.ok(page.includes('payment={payments}'))
    assert.ok(!page.includes('initialAdvance='),
      'the declared advance no longer reaches this dialog')
    assert.ok(!page.includes('standardAdvance='))
  })

  test('it hands the dialog the terms the record already agreed', () => {
    assert.ok(page.includes('initialTerms={{'))
    assert.ok(page.includes('payments?.payment_terms'))
    assert.ok(page.includes('payments?.billing_terms'))
  })

  test('submission goes through the ONE Phase 3 door, and no earlier one', () => {
    // The dialog's submit goes through the supporting-documents sender, which
    // calls ONE wrapper that runs submit_pi_for_review() unchanged and records
    // the attached Design Files / Client PO in the same transaction
    // (20270112000000 §11).
    assert.ok(page.includes('supporting.send({ note, terms, acknowledgedMissing })'),
      'one door, whichever route the database chooses')
    assert.ok(supportingSource.includes("supabase.rpc('submit_pi_for_review_with_documents'"))
    assert.ok(/v_result := public.submit_pi_for_review\(p_submission_id, p_note, p_reason, p_payment_terms, p_billing_terms\);/
      .test(documentsMigration), 'and that wrapper delegates to the one Phase 3 door')
    for (const retired of ['submit_order_submission', 'submit_order_submission_with_note',
                           'submit_order_submission_with_advance',
                           'submit_order_submission_with_advance_amount']) {
      assert.ok(!page.includes(`supabase.rpc('${retired}'`),
        `the ${retired} door must not be reachable from this screen`)
    }
  })

  test('the payload carries the reason and the terms, and no advance figure', () => {
    assert.ok(supportingSource.includes('p_reason: input.terms.reason'))
    assert.ok(supportingSource.includes('p_payment_terms: input.terms.paymentTerms'))
    assert.ok(supportingSource.includes('p_billing_terms: input.terms.billingTerms'))
    for (const forbidden of ['p_advance_amount', 'p_advance_percent', 'p_advance_condition']) {
      assert.ok(!page.includes(forbidden) && !supportingSource.includes(forbidden),
        `${forbidden} must not be sent: the database decides the route from verified payment`)
    }
  })

  test('the dialog opens for a draft AND for a returned PI', () => {
    assert.ok(page.includes("dialog === 'submit'"))
    assert.ok(page.includes('offerReply={submissionOffersReply(submission.status)}'),
      'the reply field is the only difference between the two paths')
  })

  test('the approver is told only when a decision is actually waiting', () => {
    assert.ok(page.includes('exception_requested'),
      'the RPC reports whether a fresh exception was raised')
    assert.ok(page.includes("notifyPiSubmission({ event: 'pi_exception_requested'"))
  })
})

// ── The submission rule reads ATTACHED payment (20261119000000) ───────────────
//
// Verified plus awaiting verification decides whether a reason is owed. The
// dialog reads the server's `attached_meets_standard` first and the older
// `meets_standard` only when the server did not report the attached answer.

describe('the submission rule reads attached payment', () => {
  test('approved AND pending money together reach 40%: no reason is asked, even though verified alone is short', () => {
    const html = render({ payment: below({
      unverified_amount: '37200.00', unverified_percent: '31.52',
      attached_amount: '47200.00', attached_percent: '40.00',
      attached_meets_standard: true, submission_position: 'attached_met',
    }) })
    assert.ok(!html.includes(PAYMENT_REASON_LABEL))
    // MET BY ATTACHED MONEY, NOT BY VERIFIED MONEY (acceptance review,
    // 2026-09-26): the dialog must not say "Verified payment is at or above
    // 40%" while verified alone is short. It names the attached position and
    // says Finance must still verify before the Order can be created.
    assert.ok(!html.includes(PAYMENT_POSITION_LABEL.standard_met))
    assert.ok(!html.includes(PAYMENT_POSITION_HINT.standard_met))
    assert.ok(html.includes(SUBMISSION_POSITION_LABEL.attached_met))
    assert.ok(html.includes(ATTACHED_MET_AWAITING_VERIFICATION))
    assert.equal(submitDisabled(html), false)
  })

  test('below 40% attached the dialog names the attached figure and asks for the reason', () => {
    const html = render({ payment: below({
      unverified_amount: '20000.00', unverified_percent: '16.94',
      attached_amount: '30000.00', attached_percent: '25.42',
      attached_meets_standard: false, submission_position: 'attached_partial',
    }) })
    assert.ok(html.includes('Only 25.42% payment is currently attached'))
    assert.ok(html.includes(PAYMENT_REASON_LABEL))
    assert.equal(submitDisabled(html), true)
  })

  test('no payment at all says so, and still asks', () => {
    const html = render({ payment: below({
      verified_amount: '0.00', verified_percent: '0.00',
      attached_amount: '0.00', attached_percent: '0.00',
      attached_meets_standard: false, submission_position: 'no_payment',
    }) })
    assert.ok(html.includes('No payment is attached to this PI'))
    assert.ok(html.includes(PAYMENT_REASON_LABEL))
  })

  test('the attached pair is printed as the database\'s own figures', () => {
    const html = render({ payment: below({
      attached_amount: '30000.00', attached_percent: '25.42',
      attached_meets_standard: false, submission_position: 'attached_partial',
    }) })
    assert.ok(html.includes('Total attached payment'))
    assert.ok(html.includes('₹30,000.00'))
    assert.ok(html.includes('25.42%'))
  })

  test('a summary from before the migration still behaves exactly as it did', () => {
    // No attached fields at all: `meets_standard` decides, as before.
    assert.equal(submitDisabled(render({ payment: summary() })), false)
    assert.equal(submitDisabled(render({ payment: below() })), true)
  })
})

// ── The two internal dates, asked for at Submit (2026-09-27) ─────────────────
//
// Sales leaves Date of Order Confirmation and Dispatch Date Finalized off the
// client-facing workbook; this dialog is where they are required. Static
// markup cannot press a button, so the press itself is held by reading the
// dialog's own source below — the same way the page wiring is held above.
describe('the Submit dialog REVIEWS the internal order details — it never asks for them again', () => {
  const blank: PiInternalDetailsRow = { status: 'draft', middleman_commission: 'no' }
  const dated: PiInternalDetailsRow = { status: 'draft', middleman_commission: 'no',
    order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }
  const reviewOf = (row: PiInternalDetailsRow) => orderDetailsReview({ ...row, lead_source: 'website', billing_terms: '50% on dispatch' }, [])

  test('the values Sales entered are stated, and there is no date input left to type in', () => {
    const html = render({ internalDetails: dated, detailsReview: reviewOf(dated) })
    const review = html.slice(html.indexOf('data-testid="pi-submit-details-review"'), html.indexOf('</dl>'))
    for (const expected of ['Date of Order Confirmation', '20 Sep 2026', 'Dispatch Date Finalized', '20 Nov 2026',
      'Lead source', 'Website', 'Billing terms', '50% on dispatch', 'Fabric responsibility', 'Middleman commission', 'No']) {
      assert.ok(review.includes(expected), `${expected} is reviewed`)
    }
    assert.ok(!html.includes('type="date"'), 'no second place to type a date')
    assert.ok(html.includes('Internal order details on the PI'), 'and it says where to change them')
  })

  test('missing dates are said, and Submit waits — the fix is the section, not this dialog', () => {
    const html = render({ internalDetails: blank, detailsReview: reviewOf(blank) })
    assert.ok(html.includes(SUBMISSION_DETAILS_INCOMPLETE))
    assert.equal(submitDisabled(html), true)
    assert.ok(!html.includes('type="checkbox"'), 'nothing to confirm until they are complete')
  })

  test('without the prop the dialog is exactly what it was', () => {
    const html = render({})
    assert.ok(!html.includes('Dispatch Date Finalized'))
    assert.ok(!html.includes('type="date"'))
    assert.ok(!html.includes('type="checkbox"'))
  })

  test('the dates handed up are the record\'s own, never typed here', () => {
    const modal = readFileSync(join(process.cwd(), 'src/components/orders/piReviewModals.tsx'), 'utf8').replace(/\r/g, '')
    assert.ok(modal.includes('const dates: SubmissionDates | null = internalDetails ? submissionDatesFrom(internalDetails) : null'))
    const confirm = modal.slice(modal.indexOf('  const confirm = () => {'), modal.indexOf('  return (', modal.indexOf('  const confirm = () => {')))
    // An incomplete record blocks Submit, and a blocked confirm returns before anything is handed up.
    assert.ok(modal.includes('|| (!!dates && datesInvalid)'), 'missing or out-of-order dates block the button')
    const check = confirm.indexOf('if (blocked || !checked.ok) return')
    assert.ok(check > -1 && check < confirm.indexOf('onConfirm('), 'an incomplete record hands nothing up')
    assert.ok(confirm.includes('dates ?? undefined, needsAcknowledgement && acknowledged)'))
  })

  test('the page hands the dialog the section\'s own review', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8')
    assert.ok(page.includes('detailsReview={orderDetailsReview(detailsRow, salespeople)}'))
  })
})

// ── Confirming the internal details is the submitter's act (#247 review) ──────
//
// Saving the dates from this dialog also confirms the middleman answer, so the
// dialog shows that answer beside the dates and asks for an unticked, required
// confirmation whenever Submit would write them.
describe('the Submit dialog never confirms the internal details silently', () => {
  const unconfirmed: PiInternalDetailsRow = { status: 'draft', middleman_commission: 'yes',
    middleman_recipient: 'Site agent', middleman_commission_basis: 'amount', middleman_commission_amount: '25000',
    order_confirmation_date: '2026-09-20', due_date: '2026-11-20' }

  test('the CURRENT middleman answer is shown with the dates, with where to change it', () => {
    const html = render({ internalDetails: unconfirmed, detailsReview: orderDetailsReview(unconfirmed, []) })
    const fieldset = html.slice(html.indexOf('<fieldset'), html.indexOf('</fieldset>'))
    assert.ok(fieldset.includes('Middleman commission'))
    assert.ok(fieldset.includes('Yes — Site agent, ₹25,000.00'), 'the answer as the reviewer will read it')
    assert.ok(fieldset.includes('To change any of them, Cancel and use Internal order details on the PI.'))
    const noAnswer = render({ internalDetails: { status: 'draft' }, detailsReview: orderDetailsReview({ status: 'draft' }, []) })
    assert.ok(noAnswer.includes('Not added yet'), 'an unanswered question is said, not hidden')
  })

  test('when Submit would write them, a confirmation is asked for — UNTICKED, and saying what it confirms', () => {
    const html = render({ internalDetails: unconfirmed })
    assert.ok(html.includes(SUBMISSION_CONFIRM_LABEL.replace('\u2019', '’')) || html.includes('Submitting confirms them as this PI'))
    const box = html.slice(html.indexOf('id="pi-submit-confirm-internal"') - 20, html.indexOf('id="pi-submit-confirm-internal"') + 200)
    assert.ok(box.includes('type="checkbox"'))
    assert.ok(!/checked=""/.test(box), 'never pre-ticked')
    assert.ok(!html.includes(SUBMISSION_CONFIRM_REQUIRED_TEXT), 'and not scolded before Submit is pressed')
  })

  test('already confirmed with the same dates: nothing to tick, and the dialog says nothing will change', () => {
    const html = render({ internalDetails: { ...unconfirmed, internal_details_confirmed_at: '2026-09-26T10:00:00Z' } })
    assert.ok(!html.includes('type="checkbox"'))
    assert.ok(html.includes('Confirmed 26 Sep 2026 — nothing here will change.'))
  })

  test('pressing Submit without the tick hands nothing up and says why', () => {
    const modal = readFileSync(join(process.cwd(), 'src/components/orders/piReviewModals.tsx'), 'utf8').replace(/\r/g, '')
    const confirm = modal.slice(modal.indexOf('  const confirm = () => {'), modal.indexOf('  return (', modal.indexOf('  const confirm = () => {')))
    const gate = confirm.indexOf('if (needsAcknowledgement && !acknowledged) {')
    assert.ok(gate > -1 && gate < confirm.indexOf('onConfirm('), 'the tick is checked before anything is handed up')
    assert.ok(confirm.slice(gate, confirm.indexOf('onConfirm(')).includes('return'))
    assert.ok(modal.includes('const [acknowledged, setAcknowledged] = useState(false)'), 'it starts unticked')
    assert.ok(modal.includes('error: datesAttempted && needsAcknowledgement && !acknowledged ? SUBMISSION_CONFIRM_REQUIRED : null'))
  })
})

const SUBMISSION_CONFIRM_REQUIRED_TEXT = 'Tick the box to confirm the internal details'
