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
  PAYMENT_REASON_REQUIRED,
  PAYMENT_STANDARD_PERCENT,
  PAYMENT_TERMS_LABEL,
  PAYMENT_TERMS_OPTIONAL_LABEL,
  PAYMENT_TERMS_REQUIRED,
  type PiSubmissionTerms,
} from '@/lib/orders/paymentGate'
import type { PiPaymentSummary } from '@/lib/finance/piPaymentView'
import { SUBMIT_BUTTON_LABEL } from '@/lib/orders/submissionWorkflow'
import { formatInr } from '@/lib/pi/previewView'

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

describe('below the requirement the dialog asks for a reason and payment terms', () => {
  const html = render({ payment: below() })

  test('it says Admin approval is required to proceed', () => {
    assert.ok(html.includes(`Admin approval required to proceed below ${PAYMENT_STANDARD_PERCENT}%`))
  })

  test('both mandatory fields are on screen, marked mandatory', () => {
    assert.ok(html.includes(PAYMENT_REASON_LABEL))
    assert.ok(PAYMENT_REASON_LABEL.endsWith('*'))
    assert.ok(html.includes(PAYMENT_TERMS_LABEL))
    assert.ok(PAYMENT_TERMS_LABEL.endsWith('*'))
  })

  test('billing terms stay optional', () => {
    assert.ok(html.includes(BILLING_TERMS_LABEL))
    assert.ok(!BILLING_TERMS_LABEL.endsWith('*'))
  })

  test('Submit is disabled until both are given', () => {
    assert.equal(submitDisabled(html), true)
    assert.equal(
      submitDisabled(render({
        payment: below(),
        initialTerms: { reason: 'client pays on delivery', paymentTerms: '', billingTerms: '' },
      })),
      true,
      'a reason alone is not enough',
    )
    assert.equal(
      submitDisabled(render({
        payment: below(),
        initialTerms: {
          reason: 'client pays on delivery',
          paymentTerms: '30% advance, 30% during production, 40% before dispatch',
          billingTerms: '',
        },
      })),
      false,
    )
  })

  test('the shortfall is named, so the salesperson knows what would close it', () => {
    assert.ok(html.includes('₹37,200.00'))
  })

  test('an untouched form is not scolded', () => {
    // Somebody who has just opened the dialog has not made a mistake yet.
    assert.ok(!html.includes(PAYMENT_REASON_REQUIRED))
    const typed = render({
      payment: below(),
      initialTerms: { reason: 'client pays on delivery', paymentTerms: '', billingTerms: '' },
    })
    assert.ok(typed.includes(PAYMENT_TERMS_REQUIRED),
      'but once they have started, the missing field is named')
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
    initialTerms: { reason: 'agreed', paymentTerms: '50% before dispatch', billingTerms: '' },
    submitting: true,
  })

  test('Submit is disabled and says so', () => {
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes('Submitting…'))
  })

  test('and every field is frozen with it', () => {
    assert.ok(/<textarea[^>]*disabled=""/.test(html))
  })
})

describe('a failed submission keeps the words on screen', () => {
  test('the typed terms survive, and the failure is shown beside them', () => {
    const html = render({
      payment: below(),
      initialTerms: {
        reason: 'client pays on delivery',
        paymentTerms: '30% advance, 70% before dispatch',
        billingTerms: '',
      },
      failure: 'This PI could not be submitted just now. Try again in a moment.',
    })
    assert.ok(html.includes('client pays on delivery'))
    assert.ok(html.includes('30% advance, 70% before dispatch'))
    assert.ok(html.includes('could not be submitted just now'))
  })
})

// ── The page that opens it ────────────────────────────────────────────────────

describe('this is the dialog the PI detail page opens, and the RPC it sends to', () => {
  const page = readFileSync(
    join(process.cwd(), 'src', 'app', 'orders', 'drafts', '[submissionId]', 'page.tsx'), 'utf8')

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
    assert.ok(page.includes("supabase.rpc('submit_pi_for_review'"),
      'one door, whichever route the database chooses')
    for (const retired of ['submit_order_submission', 'submit_order_submission_with_note',
                           'submit_order_submission_with_advance',
                           'submit_order_submission_with_advance_amount']) {
      assert.ok(!page.includes(`supabase.rpc('${retired}'`),
        `the ${retired} door must not be reachable from this screen`)
    }
  })

  test('the payload carries the reason and the terms, and no advance figure', () => {
    assert.ok(page.includes('p_reason: terms.reason'))
    assert.ok(page.includes('p_payment_terms: terms.paymentTerms'))
    assert.ok(page.includes('p_billing_terms: terms.billingTerms'))
    for (const forbidden of ['p_advance_amount', 'p_advance_percent', 'p_advance_condition']) {
      assert.ok(!page.includes(forbidden),
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
    assert.ok(html.includes(PAYMENT_POSITION_LABEL.standard_met))
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
