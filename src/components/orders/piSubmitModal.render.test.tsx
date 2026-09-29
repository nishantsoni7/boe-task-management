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
 * THE DIALOG IS A SEQUENCE NOW (Complete PI details redesign):
 *
 *   1  optional  what is still empty, named, and one question — only when
 *                something optional is missing
 *   2  advance   the existing exception request — only when the PI is below the
 *                advance requirement, or the position could not be read
 *   3  final     the read-only warning and Submit — always
 *
 * Static markup cannot press Continue, so each step is drawn in isolation with
 * `stage`, and the order and the skipping are held by submitStages() in
 * piCompletion.test.ts.
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
  PROCEED_CONTINUE_LABEL,
  PROCEED_GO_BACK_LABEL,
  PROCEED_WITHOUT_QUESTION,
  SUBMIT_FINAL_WARNING,
  type SubmitStage,
} from '@/lib/orders/piCompletion'
import {
  BILLING_TERMS_LABEL,
  EMPTY_SUBMISSION_TERMS,
  PAYMENT_POSITION_HINT,
  PAYMENT_POSITION_UNKNOWN,
  PAYMENT_REASON_LABEL,
  EXCEPTION_REASON_NOT_A_DECISION,
  OTHER_REMARK_LABEL,
  OTHER_REMARK_REQUIRED,
  PAYMENT_REASON_REQUIRED,
  PAYMENT_STANDARD_PERCENT,
  PAYMENT_TERMS_LABEL,
  PAYMENT_TERMS_OPTIONAL_LABEL,
  type PiSubmissionTerms,
} from '@/lib/orders/paymentGate'
import type { PiPaymentSummary } from '@/lib/finance/piPaymentView'
import { SUBMIT_BUTTON_LABEL } from '@/lib/orders/submissionWorkflow'
import { SUBMISSION_BELOW_HINT } from '@/lib/orders/paymentGate'
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
  optionalMissing?: string[]
  laterMissing?: string[]
  stage?: SubmitStage
  supportingBlocked?: string | null
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
      optionalMissing={over.optionalMissing}
      laterMissing={over.laterMissing}
      initialStage={over.stage}
      supportingBlocked={over.supportingBlocked}
      internalDetails={over.internalDetails}
      detailsReview={over.detailsReview}
    />,
  )
}

/** The advance step, for a PI below the requirement. */
const advance = (over: Parameters<typeof render>[0] = {}) => render({ payment: below(), ...over })

/** Which step the markup is. */
const stageOf = (html: string) => html.match(/data-submit-stage="([a-z]+)"/)?.[1]

/**
 * Whether the primary control in this markup is disabled: Continue on the first
 * two steps, Submit on the last. Read from that button specifically, not from
 * "does the word disabled appear" — Cancel and the × control carry their own
 * disabled state and would make a naive check pass for the wrong reason.
 */
function primaryDisabled(html: string): boolean {
  const button = html.lastIndexOf('<button')
  assert.ok(button >= 0, 'the primary control must be on screen at all')
  const tail = html.slice(button)
  assert.ok(tail.includes(SUBMIT_BUTTON_LABEL) || tail.includes('Submitting') || tail.includes(PROCEED_CONTINUE_LABEL),
    'the last button in the dialog must be the primary control')
  return tail.slice(0, tail.indexOf('>')).includes('disabled=""')
}

/** The final step's Submit control. */
const submitDisabled = (html: string) => {
  assert.equal(stageOf(html), 'final', 'this is the last step')
  return primaryDisabled(html)
}

// ── Where the sequence begins ─────────────────────────────────────────────────

describe('the sequence begins where the rules say it does', () => {
  test('nothing optional missing and the requirement met: straight to the final confirmation', () => {
    assert.equal(stageOf(render()), 'final')
  })

  test('something optional missing: the first step names it and asks', () => {
    const html = render({ optionalMissing: ['Client PO', 'Order highlight'] })
    assert.equal(stageOf(html), 'optional')
    const list = html.slice(html.indexOf('data-testid="pi-submit-optional-list"'), html.indexOf('</ul>'))
    assert.ok(list.includes('Client PO') && list.includes('Order highlight'), 'each unfilled item is named')
    assert.ok(html.includes(PROCEED_WITHOUT_QUESTION))
    assert.ok(html.includes(PROCEED_GO_BACK_LABEL) && html.includes(PROCEED_CONTINUE_LABEL))
    assert.ok(!html.includes(SUBMIT_FINAL_WARNING), 'the warning belongs to the last step')
  })

  test('below the requirement with nothing optional missing: the advance step comes first', () => {
    assert.equal(stageOf(render({ payment: below() })), 'advance')
  })

  test('the two questions are asked in order: optional first, then the advance', () => {
    assert.equal(stageOf(render({ payment: below(), optionalMissing: ['Billing terms'] })), 'optional')
    assert.equal(stageOf(render({ payment: below(), optionalMissing: ['Billing terms'], stage: 'advance' })), 'advance')
  })

  test('a step that does not apply is not entered even when asked for', () => {
    assert.equal(stageOf(render({ stage: 'advance' })), 'final', 'the requirement is met: no exception step')
    assert.equal(stageOf(render({ stage: 'optional' })), 'final', 'nothing optional is missing: no question')
  })
})

// ── The advance step: the position, stated rather than asked for ─────────────

describe('the advance step states the live payment position', () => {
  const html = advance()

  test('the figures a salesperson needs are all on screen', () => {
    for (const label of ['Verified payment', 'Verified payment %', 'Awaiting verification', 'Needed for standard approval']) {
      assert.ok(html.includes(label), `"${label}" is missing from the step`)
    }
  })

  test('every figure is the database’s, formatted and not recomputed', () => {
    assert.ok(html.includes('₹10,000.00'), 'the verified amount, as the RPC reported it')
    assert.ok(html.includes('8.47%'))
  })

  test('NOTHING asks for, or mentions, a declared advance', () => {
    // The whole point of the phase: a declaration is not a payment, and the
    // dialog no longer offers one to make.
    assert.ok(!/declared advance|advance requirement|Reduced advance|No advance/i.test(html), html.slice(0, 400))
    assert.equal((html.match(/type="radio"/g) ?? []).length, 3, 'only the three reasons are asked for')
  })

  test('it says only verified payment counts, without claiming any verification', () => {
    assert.ok(/payment awaiting Finance verification is counted as attached/i.test(html))
    // Two later gates, each named: the Order (verified payment or an approved exception) and production acceptance.
    assert.ok(html.includes('only verified payment counts later — to create the Order (unless an exception is approved) and to accept it for production (unless an administrator approves production below 40%)'))
    assert.ok(!/has been verified by Finance/i.test(html))
  })

  test('it is the exception request, and the final warning is not here yet', () => {
    assert.ok(html.includes(`Admin approval required to proceed below ${PAYMENT_STANDARD_PERCENT}%`))
    assert.ok(!html.includes(SUBMIT_FINAL_WARNING))
    assert.ok(!html.includes(SUBMIT_BUTTON_LABEL + '</button>'), 'nothing can be submitted from this step')
  })
})

// ── At or above the requirement ───────────────────────────────────────────────

describe('at or above the requirement there is no exception step', () => {
  const html = render()

  test('the dialog goes straight to the final confirmation', () => {
    assert.equal(stageOf(html), 'final')
  })

  test('no reason is asked for, and no payment box is drawn', () => {
    assert.ok(!html.includes(PAYMENT_REASON_LABEL))
    assert.ok(!html.includes('type="radio"'))
    assert.ok(!html.includes('Verified payment %'))
  })

  test('the stored payment and billing terms are carried as they are — not asked for again', () => {
    assert.ok(!html.includes(PAYMENT_TERMS_OPTIONAL_LABEL))
    assert.ok(!html.includes(BILLING_TERMS_LABEL))
  })

  test('the client and the grand total are on the last step', () => {
    assert.ok(html.includes('Kalyan Interiors'))
    assert.ok(html.includes(formatInr(GRAND_TOTAL)))
  })

  test('Submit is available immediately', () => {
    assert.equal(submitDisabled(html), false)
  })
})

// ── Below the requirement ─────────────────────────────────────────────────────

describe('below the requirement the dialog asks for exactly one of three reasons (20270114000000)', () => {
  const html = advance()

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
    const other = advance({ initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other' } })
    assert.ok(other.includes(OTHER_REMARK_LABEL))
    const po = advance({ initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'against_client_po' } })
    assert.ok(!po.includes(OTHER_REMARK_LABEL))
  })

  test('Continue is disabled until a reason is chosen, and Other has its remark', () => {
    assert.equal(primaryDisabled(html), true)
    assert.equal(primaryDisabled(advance({
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'sample_order' },
    })), false, 'Sample order alone is enough — no payment terms needed')
    assert.equal(primaryDisabled(advance({
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'short' },
    })), true, 'Other needs a real remark')
    assert.equal(primaryDisabled(advance({
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'long-standing client, pays on delivery' },
    })), false)
  })

  test('the exception step is followed by the final confirmation, never by a silent send', () => {
    const done = render({
      payment: below(),
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'sample_order' },
      stage: 'final',
    })
    assert.equal(stageOf(done), 'final')
    assert.ok(done.includes(SUBMIT_FINAL_WARNING), 'the warning appears after the exception step too')
    assert.equal(submitDisabled(done), false)
  })

  test('the final step stays closed while the reason is missing or too thin', () => {
    assert.equal(submitDisabled(render({ payment: below(), stage: 'final' })), true, 'no reason chosen')
    assert.equal(submitDisabled(render({
      payment: below(), stage: 'final',
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'short' },
    })), true, 'Other needs a real remark')
  })

  test('the shortfall is named, so the salesperson knows what would close it', () => {
    assert.ok(html.includes('₹37,200.00'))
  })

  test('an untouched form is not scolded', () => {
    // Somebody who has just opened the dialog has not made a mistake yet.
    assert.ok(!html.includes(PAYMENT_REASON_REQUIRED))
    const typed = advance({ initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'short' } })
    assert.ok(typed.includes(OTHER_REMARK_REQUIRED),
      'but once they have started, what is missing is named')
  })
})

// ── The final confirmation ────────────────────────────────────────────────────

describe('the final confirmation says what submitting does, and offers Cancel or Submit', () => {
  const html = render()

  test('the warning is the one sentence the owner specified', () => {
    assert.equal(SUBMIT_FINAL_WARNING,
      'After submission, you cannot edit this PI while it is with management. You can request a change from management.')
    assert.ok(html.includes(SUBMIT_FINAL_WARNING))
  })

  test('Cancel and Submit for Approval are the two ways on', () => {
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
    assert.deepEqual(buttons.slice(-2), ['Cancel', SUBMIT_BUTTON_LABEL])
  })

  test('Submit is refused while the attachments or the internal details say it must wait', () => {
    const blocked = render({ supportingBlocked: 'One of the files is not valid.' })
    assert.equal(submitDisabled(blocked), true)
    assert.ok(blocked.includes('One of the files is not valid.'), 'and the reason is said')
  })
})

// ── Money Finance has not decided ─────────────────────────────────────────────

describe('unverified payment is shown and said not to count', () => {
  const html = advance({
    payment: below({
      unverified_amount: '40000.00',
      unverified_percent: '33.90',
      approval_position: 'verification_pending',
    }),
  })

  test('the figure is on screen', () => {
    assert.ok(html.includes('₹40,000.00'))
  })

  test('and it is stated that Finance has not decided it — in the submission rule\'s terms, not the Order gate\'s', () => {
    assert.ok(html.includes(SUBMISSION_BELOW_HINT))
    assert.ok(html.includes('Payment awaiting verification is not verified payment.'))
    assert.ok(!html.includes(PAYMENT_POSITION_HINT.verification_pending), 'that sentence says awaiting money does not count, which is the Order gate')
  })

  test('it does not close the gate on its own', () => {
    assert.equal(primaryDisabled(html), true, 'the mandatory fields are still required')
  })
})

// ── Payment awaiting Finance verification is never called verified ───────────
//
// The submission rule counts verified PLUS awaiting-verification payment; the Order
// gate counts verified only. Neither the exception step nor the final confirmation
// may let one word stand for the other.

describe('payment awaiting Finance verification is never described as verified', () => {
  // ₹0 verified, ₹1,00,000 awaiting: attached is 15.9% of ₹6,28,350 — short of 40%.
  const awaiting = () => below({
    verified_amount: '0.00', verified_percent: '0.00',
    unverified_amount: '100000.00', unverified_percent: '15.92',
    attached_amount: '100000.00', attached_percent: '15.92',
    attached_meets_standard: false, submission_position: 'attached_partial', approval_position: 'verification_pending',
  })
  test('the payment panel puts the awaiting amount on the awaiting and attached lines, and ₹0 on the verified one', () => {
    const html = advance({ payment: awaiting() })
    const t = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|')
    assert.ok(/Verified payment\|₹0\.00/.test(t), 'verified stays ₹0.00')
    assert.ok(/Awaiting verification\|₹1,00,000\.00/.test(t))
    assert.ok(/Total attached payment\|₹1,00,000\.00/.test(t))
  })

  test('the below-40% step says attached payment is short, says awaiting payment is not verified, and never the reverse', () => {
    const text = advance({ payment: awaiting() }).replace(/<[^>]+>/g, ' ')
    assert.ok(text.includes('has not reached 40%') && text.includes('is not verified payment'))
    for (const wrong of ['has been verified', 'is verified', 'verified payment is at or above', 'Unverified payment does not count']) {
      assert.ok(!text.toLowerCase().includes(wrong.toLowerCase()), `must not say "${wrong}"`)
    }
  })

  test('the final confirmation makes no payment claim at all', () => {
    const text = render({ payment: awaiting(), stage: 'final', initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'sample_order' } }).replace(/<[^>]+>/g, ' ')
    assert.ok(!/verif/i.test(text), 'the last step says nothing about verification, so it cannot get it wrong')
  })

  test('met by attached money (awaiting Finance) skips the step, and the final confirmation still claims nothing', () => {
    const met = below({
      verified_amount: '0.00', verified_percent: '0.00',
      unverified_amount: '251340.00', unverified_percent: '40.00',
      attached_amount: '251340.00', attached_percent: '40.00',
      attached_meets_standard: true, submission_position: 'attached_met', approval_position: 'verification_pending',
    })
    const html = render({ payment: met })
    assert.equal(stageOf(html), 'final')
    assert.ok(!/verif/i.test(html.replace(/<[^>]+>/g, ' ')))
  })
})

// ── Everything empty that does not block: two groups, named accurately ───────

describe('the first step lists every empty item that does not block submission', () => {
  const html = render({ optionalMissing: ['Billing terms', 'Payment terms', 'Client PO'], laterMissing: ['BOE salesperson assigned to Order', 'Lead source'] })
  const group = (name: string) => {
    const start = html.indexOf(`data-testid="pi-submit-${name}-group"`)
    return html.slice(start, html.indexOf('</ul>', start)).replace(/<[^>]+>/g, '|').replace(/\|+/g, '|')
  }

  test('two groups, each under its own accurate heading', () => {
    assert.equal(stageOf(html), 'optional')
    assert.ok(group('optional').startsWith('|Optional|') || group('optional').includes('Optional|Billing terms|Payment terms|Client PO'))
    assert.ok(group('later').includes('Required later to create the Order|BOE salesperson assigned to Order|Lead source'))
  })

  test('no item is in the wrong group', () => {
    assert.ok(!group('optional').includes('Lead source') && !group('optional').includes('BOE salesperson'))
    assert.ok(!group('later').includes('Client PO') && !group('later').includes('Payment terms'))
  })

  test('with only later items empty there is one group and the step is still there', () => {
    const only = render({ laterMissing: ['Lead source'] })
    assert.equal(stageOf(only), 'optional')
    assert.ok(only.includes('pi-submit-later-group') && !only.includes('pi-submit-optional-group'))
  })

  test('it asks one question, with the same two ways on', () => {
    assert.ok(html.includes(PROCEED_WITHOUT_QUESTION) && html.includes(PROCEED_GO_BACK_LABEL) && html.includes(PROCEED_CONTINUE_LABEL))
  })
})

// ── An unreadable position ────────────────────────────────────────────────────

describe('a PI whose payment position cannot be read fails CLOSED', () => {
  const html = render({ payment: null })

  test('it lands on the advance step, where the reason is said immediately', () => {
    assert.equal(stageOf(html), 'advance')
    assert.ok(html.includes(PAYMENT_POSITION_UNKNOWN),
      'no amount of typing fixes this one, so it is not withheld')
  })

  test('and Continue stays disabled — there is no way on to Submit', () => {
    assert.equal(primaryDisabled(html), true)
    assert.equal(submitDisabled(render({ payment: null, stage: 'final' })), true, 'even reached directly')
  })
})

// ── In flight ─────────────────────────────────────────────────────────────────

describe('a submission in flight cannot be started twice', () => {
  const inFlight = render({ submitting: true })

  test('Submit is disabled and says so', () => {
    assert.equal(submitDisabled(inFlight), true)
    assert.ok(inFlight.includes('Submitting…'))
  })

  test('the two earlier steps are frozen too', () => {
    const first = render({ submitting: true, optionalMissing: ['Client PO'] })
    assert.equal(stageOf(first), 'optional')
    assert.equal(primaryDisabled(first), true)
    const exception = advance({
      submitting: true,
      initialTerms: { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'agreed with the client directly' },
    })
    assert.ok(/<textarea[^>]*disabled=""/.test(exception))
    assert.ok(/<input[^>]*type="radio"[^>]*disabled=""/.test(exception))
  })
})

describe('a failed submission keeps the words on screen', () => {
  test('the typed terms survive, and the failure is shown beside them', () => {
    const terms = { ...EMPTY_SUBMISSION_TERMS, reasonChoice: 'other', otherRemark: 'client pays on delivery' } as const
    const html = render({
      payment: below(), stage: 'final', initialTerms: terms,
      failure: 'This PI could not be submitted just now. Try again in a moment.',
    })
    assert.ok(html.includes('could not be submitted just now'))
    // The exception step still holds what was typed, so going back finds it.
    const exception = advance({ initialTerms: terms })
    assert.ok(exception.includes('client pays on delivery'))
    const otherInput = (exception.match(/<input[^>]*value="other"[^>]*>/) ?? [''])[0]
    assert.ok(/ checked=""/.test(otherInput), 'the choice survives too: ' + otherInput)
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

  test('it hands the dialog the names of what is optional and still empty, and a way back', () => {
    assert.ok(page.includes('optionalMissing={completion.optionalMissing.map(item => item.label)}'))
    assert.ok(page.includes('onGoBack={() => {'))
    assert.ok(!page.includes('PiSupportingDocumentsPicker'), 'files are attached in Complete PI details, not in the dialog')
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
  test('approved AND pending money together reach 40%: there is no exception step, even though verified alone is short', () => {
    const html = render({ payment: below({
      unverified_amount: '37200.00', unverified_percent: '31.52',
      attached_amount: '47200.00', attached_percent: '40.00',
      attached_meets_standard: true, submission_position: 'attached_met',
    }) })
    assert.equal(stageOf(html), 'final')
    assert.ok(!html.includes(PAYMENT_REASON_LABEL))
    assert.equal(submitDisabled(html), false)
  })

  test('below 40% attached the step names the attached figure and asks for the reason', () => {
    const html = advance({ payment: below({
      unverified_amount: '20000.00', unverified_percent: '16.94',
      attached_amount: '30000.00', attached_percent: '25.42',
      attached_meets_standard: false, submission_position: 'attached_partial',
    }) })
    assert.ok(html.includes('Only 25.42% payment is currently attached'))
    assert.ok(html.includes(PAYMENT_REASON_LABEL))
    assert.equal(primaryDisabled(html), true)
  })

  test('no payment at all says so, and still asks', () => {
    const html = advance({ payment: below({
      verified_amount: '0.00', verified_percent: '0.00',
      attached_amount: '0.00', attached_percent: '0.00',
      attached_meets_standard: false, submission_position: 'no_payment',
    }) })
    assert.ok(html.includes('No payment is attached to this PI'))
    assert.ok(html.includes(PAYMENT_REASON_LABEL))
  })

  test('the attached pair is printed as the database\'s own figures', () => {
    const html = advance({ payment: below({
      attached_amount: '30000.00', attached_percent: '25.42',
      attached_meets_standard: false, submission_position: 'attached_partial',
    }) })
    assert.ok(html.includes('Total attached payment'))
    assert.ok(html.includes('₹30,000.00'))
    assert.ok(html.includes('25.42%'))
  })

  test('a summary from before the migration still behaves exactly as it did', () => {
    // No attached fields at all: `meets_standard` decides, as before.
    assert.equal(stageOf(render({ payment: summary() })), 'final')
    assert.equal(stageOf(render({ payment: below() })), 'advance')
    assert.equal(primaryDisabled(render({ payment: below() })), true)
  })
})

// ── The internal order details, reviewed on the last step ────────────────────
//
// The values are entered in Complete PI details; the final step states them for
// a last look and asks for the existing explicit confirmation. Static markup
// cannot press a button, so the press itself is held by reading the dialog's own
// source below — the same way the page wiring is held above.
describe('the final step REVIEWS the internal order details — it never asks for them again', () => {
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
    const confirm = modal.slice(modal.indexOf('  const confirm = () => {'), modal.indexOf('  const title =', modal.indexOf('  const confirm = () => {')))
    // An incomplete record blocks Submit, and a blocked confirm returns before anything is handed up.
    assert.ok(modal.includes('|| (!!dates && datesInvalid)'), 'missing or out-of-order dates block the button')
    const check = confirm.indexOf('if (finalBlocked || !checked.ok) return')
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

  test('the CURRENT middleman answer is shown with the dates — reported, not asked for again', () => {
    const html = render({ internalDetails: unconfirmed, detailsReview: orderDetailsReview(unconfirmed, []) })
    const fieldset = html.slice(html.indexOf('<fieldset'), html.indexOf('</fieldset>'))
    assert.ok(fieldset.includes('Middleman commission'))
    assert.ok(fieldset.includes('Yes — Site agent, ₹25,000.00'), 'the answer as the reviewer will read it')
    assert.ok(!fieldset.includes('Cancel and use Internal order details'), 'no call to action: it is edited in Complete PI details')
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
    const confirm = modal.slice(modal.indexOf('  const confirm = () => {'), modal.indexOf('  const title =', modal.indexOf('  const confirm = () => {')))
    const gate = confirm.indexOf('if (needsAcknowledgement && !acknowledged) {')
    assert.ok(gate > -1 && gate < confirm.indexOf('onConfirm('), 'the tick is checked before anything is handed up')
    assert.ok(confirm.slice(gate, confirm.indexOf('onConfirm(')).includes('return'))
    assert.ok(modal.includes('const [acknowledged, setAcknowledged] = useState(false)'), 'it starts unticked')
    assert.ok(modal.includes('error: datesAttempted && needsAcknowledgement && !acknowledged ? SUBMISSION_CONFIRM_REQUIRED : null'))
  })
})

const SUBMISSION_CONFIRM_REQUIRED_TEXT = 'Tick the box to confirm the internal details'
