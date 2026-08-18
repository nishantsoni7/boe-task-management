/**
 * THE SUBMIT DIALOG, ACTUALLY RENDERED.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Phase B shipped a complete advance workflow — a validated three-way
 * declaration, an RPC that stores it, a management decision, an activity trail —
 * and every part of it was covered by tests over the pure helpers. What no test
 * looked at was the DIALOG. A helper that formats "No advance (0%)" correctly
 * proves nothing about whether anybody can ever see it, and the one thing an
 * employee reported was that they could not: the modal they opened offered a
 * client, a grand total, a warning and two buttons.
 *
 * So these tests render the REAL PiSubmitConfirmModal — the same export the PI
 * detail page imports, with the same props that page passes it — and read the
 * markup that comes out. A helper can be right while the screen is wrong; markup
 * cannot.
 *
 * WHY renderToStaticMarkup AND NOT A BROWSER. There is no DOM in this repository
 * and no test runner that provides one; adding either to assert on a dialog's
 * contents would be a larger change than the dialog. Every state this file needs
 * is reachable through `initialAdvance`, which is exactly how the page reaches
 * them on a resubmission — so the states are real states, arrived at the real
 * way, rather than a harness poking at internals.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: what happens when a radio is clicked.
 * That is one call to `onChoice`, and what it produces is asserted over
 * validateAdvanceDeclaration and advanceDeclarationUntouched in
 * advanceRequirement.test.ts, at every boundary.
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
  ADVANCE_AMOUNT_LABEL,
  ADVANCE_NONE_HINT,
  ADVANCE_NONE_LABEL,
  ADVANCE_PERCENT_LABEL,
  ADVANCE_PERCENT_REQUIRED,
  ADVANCE_PERCENT_ZERO_USE_NONE,
  ADVANCE_REASON_LABEL,
  ADVANCE_REASON_REQUIRED,
  ADVANCE_REDUCED_LABEL,
  ADVANCE_SECTION_TITLE,
  ADVANCE_STANDARD_HINT,
  ADVANCE_STANDARD_LABEL,
  ADVANCE_TOTAL_MISSING,
  ADVANCE_ZERO_EXPLANATION,
  initialAdvanceSelection,
  type AdvanceDeclaration,
  type PersistedAdvance,
} from '@/lib/orders/advanceRequirement'
import { SUBMIT_BUTTON_LABEL } from '@/lib/orders/submissionWorkflow'
import { formatInr } from '@/lib/pi/previewView'

const GRAND_TOTAL = 118000
const STANDARD_AMOUNT = formatInr(47200) // 40% of 118000

/**
 * The dialog with the props THE PI DETAIL PAGE PASSES IT.
 *
 * Every value here is named the same way the page names it, so a prop that
 * stops being supplied there fails to compile here.
 */
function render(over: {
  initialAdvance?: AdvanceDeclaration
  grandTotalValue?: number | null
  submitting?: boolean
  failure?: string | null
  offerReply?: boolean
} = {}): string {
  return renderToStaticMarkup(
    <PiSubmitConfirmModal
      client="Kalyan Interiors"
      grandTotal={formatInr(GRAND_TOTAL)}
      grandTotalValue={over.grandTotalValue === undefined ? GRAND_TOTAL : over.grandTotalValue}
      standardAdvance={STANDARD_AMOUNT}
      initialAdvance={over.initialAdvance ?? { choice: 'standard', percentText: '', reason: '' }}
      submitting={over.submitting ?? false}
      failure={over.failure ?? null}
      offerReply={over.offerReply ?? false}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )
}

/** A persisted record, so the initial state is derived the way the page derives it. */
const persisted = (over: Partial<PersistedAdvance> = {}): PersistedAdvance => ({
  advance_condition: null,
  advance_exception_percent: null,
  advance_exception_reason: null,
  advance_exception_status: null,
  advance_exception_requested_by: null,
  advance_exception_requested_at: null,
  advance_exception_decided_by: null,
  advance_exception_decided_at: null,
  advance_exception_rejection_reason: null,
  ...over,
})

/**
 * Whether the Submit button in this markup is disabled.
 *
 * Read from the SUBMIT button specifically, not from "does the word disabled
 * appear" — Cancel and the × control carry their own disabled state and would
 * make a naive check pass for the wrong reason.
 */
function submitDisabled(html: string): boolean {
  // The confirm button is the LAST one in the panel — Cancel sits before it, and
  // the × control before that. Anchoring on the label alone would find the
  // dialog's own aria-label and heading instead, and while it is in flight the
  // button does not carry the label at all.
  const button = html.lastIndexOf('<button')
  assert.ok(button >= 0, 'the Submit button must be on screen at all')
  const tail = html.slice(button)
  assert.ok(tail.includes(SUBMIT_BUTTON_LABEL) || tail.includes('Submitting'),
    'the last button in the dialog must be the confirm')
  const openTagEnd = tail.indexOf('>')
  return tail.slice(0, openTagEnd).includes('disabled=""')
}

// ── The defect itself ─────────────────────────────────────────────────────────

describe('the dialog an employee actually opens carries the advance choice', () => {
  const html = render()

  test('it has an Advance requirement section, which is what was missing', () => {
    assert.ok(html.includes(ADVANCE_SECTION_TITLE),
      'the dialog used to show a client, a total, a warning and two buttons')
  })

  test('all THREE choices are on screen at once', () => {
    assert.ok(html.includes(ADVANCE_STANDARD_LABEL), 'Standard advance (40%)')
    assert.ok(html.includes(ADVANCE_REDUCED_LABEL), 'Reduced advance')
    assert.ok(html.includes(ADVANCE_NONE_LABEL), 'No advance (0%)')
  })

  test('they are radios in one group, so exactly one can be chosen', () => {
    const radios = html.match(/type="radio"/g) ?? []
    assert.equal(radios.length, 3, 'three choices, three radios')
    const named = html.match(/name="advance-choice"/g) ?? []
    assert.equal(named.length, 3, 'and one group, so choosing one clears the others')
  })

  test('the client and the grand total are still there', () => {
    assert.ok(html.includes('Kalyan Interiors'))
    assert.ok(html.includes(formatInr(GRAND_TOTAL)))
  })

  test('and it still says no payment is being recorded', () => {
    assert.ok(/No payment has been recorded, requested or received/.test(html))
  })
})

// ── Standard ──────────────────────────────────────────────────────────────────

describe('Standard advance is the default for a PI that has declared nothing', () => {
  const html = render({ initialAdvance: initialAdvanceSelection(persisted()) })

  test('the standard radio is the checked one', () => {
    const first = html.indexOf('type="radio"')
    assert.ok(html.slice(first, first + 120).includes('checked=""'),
      'the first choice — Standard — opens selected')
    assert.equal((html.match(/checked=""/g) ?? []).length, 1)
  })

  test('it shows the calculated 40% amount', () => {
    assert.ok(html.includes(STANDARD_AMOUNT))
  })

  test('its helper is the short one, and promises nothing else', () => {
    assert.ok(html.includes(ADVANCE_STANDARD_HINT))
  })

  test('it reveals no percentage box and no reason box', () => {
    assert.ok(!html.includes(`aria-label="${ADVANCE_PERCENT_LABEL}"`))
    assert.ok(!html.includes('<textarea'), 'the commonest submission stays one click')
  })

  test('and Submit is enabled, because nothing more is needed', () => {
    assert.equal(submitDisabled(html), false)
  })
})

// ── Reduced ───────────────────────────────────────────────────────────────────

describe('Reduced advance asks for a percentage, an amount and a reason', () => {
  const filled = render({
    initialAdvance: { choice: 'reduced', percentText: '12.5', reason: 'client pays on delivery' },
  })

  test('the percentage field is present, and holds what was typed', () => {
    assert.ok(filled.includes(`aria-label="${ADVANCE_PERCENT_LABEL}"`))
    assert.ok(filled.includes('value="12.5"'))
  })

  test('the calculated rupee amount is beside it, from the one formula', () => {
    assert.ok(filled.includes(ADVANCE_AMOUNT_LABEL))
    assert.ok(filled.includes(formatInr(14750)), '12.5% of ₹1,18,000')
  })

  test('the reason is a mandatory field, marked as one', () => {
    assert.ok(filled.includes(`aria-label="${ADVANCE_REASON_LABEL}"`))
    assert.ok(ADVANCE_REASON_LABEL.endsWith('*'))
    assert.ok(filled.includes('client pays on delivery'))
  })

  test('a complete declaration enables Submit', () => {
    assert.equal(submitDisabled(filled), false)
  })

  test('a blank reason disables Submit and says why', () => {
    const html = render({ initialAdvance: { choice: 'reduced', percentText: '12.5', reason: '' } })
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes(ADVANCE_REASON_REQUIRED))
  })

  test('a whitespace-only reason is not a reason', () => {
    const html = render({ initialAdvance: { choice: 'reduced', percentText: '12.5', reason: '   ' } })
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes(ADVANCE_REASON_REQUIRED))
  })

  test('ZERO here is refused, and the message names the choice to press', () => {
    const html = render({ initialAdvance: { choice: 'reduced', percentText: '0', reason: 'agreed' } })
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes(ADVANCE_PERCENT_ZERO_USE_NONE))
    assert.ok(html.includes(ADVANCE_NONE_LABEL))
  })

  test('an out-of-range, over-precise or malformed figure all disable Submit', () => {
    for (const percentText of ['40', '41', '-3', '12.345', '1,5', '12%', '1e1', 'NaN', 'Infinity']) {
      const html = render({ initialAdvance: { choice: 'reduced', percentText, reason: 'agreed' } })
      assert.equal(submitDisabled(html), true, `"${percentText}" must not be submittable`)
    }
  })

  test('a blank percentage asks for one instead of assuming zero', () => {
    const html = render({ initialAdvance: { choice: 'reduced', percentText: '', reason: 'agreed' } })
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes(ADVANCE_PERCENT_REQUIRED))
  })

  test('a freshly pressed choice is not scolded, but is still not submittable', () => {
    const html = render({ initialAdvance: { choice: 'reduced', percentText: '', reason: '' } })
    assert.equal(submitDisabled(html), true)
    assert.ok(!html.includes(ADVANCE_PERCENT_REQUIRED),
      'nothing has been typed yet, so there is nothing to be told off about')
  })
})

// ── No advance ────────────────────────────────────────────────────────────────

describe('No advance (0%) is a choice, not a percentage anybody has to guess', () => {
  const html = render({ initialAdvance: { choice: 'none', percentText: '', reason: 'repeat buyer' } })

  test('it states 0% and ₹0 rather than offering a box to type them into', () => {
    assert.ok(html.includes('0%'))
    assert.ok(html.includes(formatInr(0)))
    assert.ok(!html.includes(`aria-label="${ADVANCE_PERCENT_LABEL}"`),
      'there is no figure to get wrong, so there is no field for one')
  })

  test('it says management approval is required to proceed', () => {
    assert.ok(html.includes(ADVANCE_NONE_HINT))
    assert.ok(html.includes(ADVANCE_ZERO_EXPLANATION))
  })

  test('it never calls this a payment, a waiver or a receipt', () => {
    for (const word of ['paid', 'payment received', 'waived', 'receipt', 'collected']) {
      assert.ok(!new RegExp(word, 'i').test(html), `"${word}" must not appear`)
    }
  })

  test('the reason is mandatory here too', () => {
    assert.ok(html.includes(`aria-label="${ADVANCE_REASON_LABEL}"`))
    assert.equal(submitDisabled(html), false)

    const blank = render({ initialAdvance: { choice: 'none', percentText: '', reason: '' } })
    assert.equal(submitDisabled(blank), true)
  })

  test('a leftover percentage cannot make it submittable or unsubmittable', () => {
    const html2 = render({ initialAdvance: { choice: 'none', percentText: '99', reason: 'agreed' } })
    assert.equal(submitDisabled(html2), false, 'the choice is the declaration')
  })
})

// ── Resubmission ──────────────────────────────────────────────────────────────

describe('a resubmission opens on what the record already says', () => {
  const approvedReduced = persisted({
    advance_condition: 'exception',
    advance_exception_percent: '15.00',
    advance_exception_reason: 'client is a repeat buyer',
    advance_exception_status: 'approved',
  })

  const approvedZero = persisted({
    advance_condition: 'exception',
    advance_exception_percent: 0,
    advance_exception_reason: 'long-standing account',
    advance_exception_status: 'approved',
  })

  test('an approved reduced exception reopens filled in, and submittable unchanged', () => {
    const html = render({
      initialAdvance: initialAdvanceSelection(approvedReduced),
      offerReply: true,
    })
    assert.ok(html.includes('value="15"'))
    assert.ok(html.includes('client is a repeat buyer'))
    assert.equal(submitDisabled(html), false,
      'resubmitting it untouched must preserve the approval rather than be refused')
  })

  test('an approved 0% exception reopens on No advance, not on a reduced zero', () => {
    const html = render({
      initialAdvance: initialAdvanceSelection(approvedZero),
      offerReply: true,
    })
    assert.ok(!html.includes(`aria-label="${ADVANCE_PERCENT_LABEL}"`),
      'a 0 in the reduced box would be a declaration this dialog refuses')
    assert.ok(html.includes(ADVANCE_ZERO_EXPLANATION))
    assert.ok(html.includes('long-standing account'))
    assert.equal(submitDisabled(html), false)
  })

  test('a rejected exception may be replaced by any of the three', () => {
    // Nothing is locked: all three radios are enabled on a returned PI.
    const html = render({
      initialAdvance: initialAdvanceSelection(persisted({
        advance_condition: 'exception',
        advance_exception_percent: '5.00',
        advance_exception_reason: 'was refused',
        advance_exception_status: 'rejected',
        advance_exception_rejection_reason: 'too low for a first order',
      })),
      offerReply: true,
    })
    assert.equal((html.match(/type="radio"/g) ?? []).length, 3)
    assert.ok(!/type="radio"[^>]*disabled/.test(html))
  })

  test('the optional employee reply appears only on a resubmission', () => {
    assert.ok(render({ offerReply: true }).includes('Reply to management'))
    assert.ok(!render({ offerReply: false }).includes('Reply to management'))
  })
})

// ── The record itself failing closed ──────────────────────────────────────────

describe('a PI with no stored grand total cannot declare anything', () => {
  test('every choice is refused, and the reason is about the record', () => {
    for (const initialAdvance of [
      { choice: 'standard', percentText: '', reason: '' },
      { choice: 'reduced', percentText: '12', reason: 'agreed' },
      { choice: 'none', percentText: '', reason: 'agreed' },
    ] as AdvanceDeclaration[]) {
      const html = render({ initialAdvance, grandTotalValue: null })
      assert.equal(submitDisabled(html), true)
      assert.ok(html.includes(ADVANCE_TOTAL_MISSING))
    }
  })

  test('it is said immediately, even before anything is typed', () => {
    const html = render({
      initialAdvance: { choice: 'reduced', percentText: '', reason: '' },
      grandTotalValue: null,
    })
    assert.ok(html.includes(ADVANCE_TOTAL_MISSING),
      'no amount of typing fixes this one, so it is not withheld')
  })
})

// ── In flight ─────────────────────────────────────────────────────────────────

describe('a submission in flight cannot be started twice', () => {
  const html = render({
    initialAdvance: { choice: 'none', percentText: '', reason: 'agreed' },
    submitting: true,
  })

  test('Submit is disabled and says so', () => {
    assert.equal(submitDisabled(html), true)
    assert.ok(html.includes('Submitting…'))
  })

  test('and every field is frozen with it', () => {
    assert.equal((html.match(/type="radio"[^>]*disabled=""/g) ?? []).length, 3)
    assert.ok(/<textarea[^>]*disabled=""/.test(html))
  })
})

describe('a failed submission keeps the words on screen', () => {
  test('the declaration survives, and the failure is shown beside it', () => {
    const html = render({
      initialAdvance: { choice: 'reduced', percentText: '12.5', reason: 'client pays on delivery' },
      failure: 'This PI could not be submitted just now. Try again in a moment.',
    })
    assert.ok(html.includes('value="12.5"'))
    assert.ok(html.includes('client pays on delivery'))
    assert.ok(html.includes('could not be submitted just now'))
  })
})

// ── The page that opens it ────────────────────────────────────────────────────

describe('this is the dialog the PI detail page opens, and the RPC it sends to', () => {
  const page = readFileSync(
    join(process.cwd(), 'src', 'app', 'orders', 'drafts', '[submissionId]', 'page.tsx'), 'utf8')

  test('the page imports THIS component, and there is no second submit modal', () => {
    assert.ok(page.includes("import { PiSubmitConfirmModal, PiNoteModal"))
    assert.ok(page.includes("from '@/components/orders/piReviewModals'"))
    assert.ok(page.includes('<PiSubmitConfirmModal'))
  })

  test('it hands the dialog the record’s own declaration', () => {
    assert.ok(page.includes('initialAdvance={initialAdvanceSelection(submission)}'))
    assert.ok(page.includes('grandTotalValue={grandTotalValue}'))
    assert.ok(page.includes('standardAdvance={standardAdvanceLabel}'))
  })

  test('all three choices go through the PHASE B RPC, and never the Phase A one', () => {
    assert.ok(page.includes("supabase.rpc('submit_order_submission_with_advance'"),
      'one door, whatever was chosen')
    assert.ok(!page.includes("supabase.rpc('submit_order_submission'"),
      'the Phase A RPC must not be reachable from this screen')
    assert.ok(!page.includes("supabase.rpc('submit_order_submission_with_note'"))
  })

  test('the payload carries the condition, and a percentage only for an exception', () => {
    assert.ok(page.includes('p_advance_condition: advance.condition'))
    assert.ok(page.includes("p_advance_percent: advance.condition === 'exception' ? advance.percent : null"))
    assert.ok(page.includes("p_advance_reason: advance.condition === 'exception' ? advance.reason : null"))
  })

  test('the dialog opens for a draft AND for a returned PI', () => {
    assert.ok(page.includes("dialog === 'submit'"))
    assert.ok(page.includes('offerReply={submissionOffersReply(submission.status)}'),
      'the reply field is the only difference between the two paths')
  })
})
