/**
 * THE DELETE PAYMENT CONFIRMATION, ACTUALLY RENDERED.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The reported problem was not a failed deletion. An admin deleting P-AA-0001
 * typed P-AA-0003 into the confirmation box, the Delete Payment button stayed
 * dead — correctly — and NOTHING ON SCREEN SAID WHY. The two IDs differ by one
 * character and read alike, so the dialog looked broken rather than refusing.
 *
 * A disabled button is not an explanation, and on a destructive dialog the
 * words are the whole affordance. So this renders the real
 * PaymentDeleteConfirmIdField — the same export the dialog mounts — at each of
 * its three states, and the whole DeletePaymentModal for the button, and reads
 * the markup that comes out.
 *
 * WHAT IS NOT TESTED HERE: authority. Who may delete, whether the reason is
 * acceptable and whether the typed ID is the right one are all re-derived by
 * begin_finance_payment_deletion on every attempt — paymentDeletion.test.ts
 * pins the client-side policy, and this file pins only what is SAID.
 *
 * THE ID IS NEVER THE ONE FROM THE BUG REPORT. Every fixture here uses
 * P-BB-0042, so a label or a message that hardcoded P-AA-0001 would fail
 * rather than pass by coincidence.
 *
 * Run:
 *   npx tsx --test src/components/finance/deletePaymentModal.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import { DeletePaymentModal, PaymentDeleteConfirmIdField } from './DeletePaymentModal'
import {
  PAYMENT_DELETE_CONFIRM_LABEL,
  PAYMENT_DELETE_REASON_LABEL,
  PAYMENT_DELETE_REASON_PLACEHOLDER,
  paymentDeleteConfirmIdLabel,
  paymentDeleteIdMismatchMessage,
} from '@/lib/finance/paymentDeletion'

const HUMAN_ID = 'P-BB-0042'
const WRONG_ID = 'P-BB-0044'

function field(value: string, humanPaymentId = HUMAN_ID): string {
  return renderToStaticMarkup(
    <PaymentDeleteConfirmIdField
      humanPaymentId={humanPaymentId}
      value={value}
      onChange={() => {}}
      disabled={false}
    />,
  )
}

function modal(over: { human_payment_id?: string; status?: string } = {}): string {
  return renderToStaticMarkup(
    <DeletePaymentModal
      payment={{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        human_payment_id: over.human_payment_id ?? HUMAN_ID,
        status: over.status ?? 'approved_unlinked',
        amount: 125000,
        payment_date: '2026-08-01',
        payment_mode: 'hdfc',
        client_name: 'Sharma Furnishings Pvt Ltd',
      }}
      allocationSummary={null}
      formatAmount={n => `Rs ${n}`}
      formatDate={iso => iso}
      modeLabel={m => m}
      onClose={() => {}}
      onDeleted={() => {}}
    />,
  )
}

/** The confirm button is the last one in the panel; Cancel sits before it. */
function confirmDisabled(html: string): boolean {
  const button = html.lastIndexOf('<button')
  assert.ok(button >= 0, 'the dialog must render a button')
  const tail = html.slice(button)
  return tail.slice(0, tail.indexOf('>')).includes('disabled=""')
}

// ── Nothing typed yet: the instruction, and no accusation ────────────────────

describe('before anything is typed, the box states what to type and nothing else', () => {
  const html = field('')

  test('the instruction names the exact Payment ID to type', () => {
    assert.ok(html.includes(paymentDeleteConfirmIdLabel(HUMAN_ID)))
    assert.ok(html.includes(`Type ${HUMAN_ID} to confirm`))
  })

  test('an empty box is not called a mismatch — nobody has made a mistake yet', () => {
    assert.ok(!html.includes('does not match'))
    assert.ok(!html.includes('aria-invalid="true"'))
  })

  /**
   * THE BOX IS NOT PRE-FILLED. A confirmation the person did not type is not a
   * confirmation; the ID appears as a placeholder, never as a value.
   */
  test('the field is empty, not pre-filled with the answer', () => {
    assert.ok(html.includes(`placeholder="${HUMAN_ID}"`))
    assert.ok(!html.includes(`value="${HUMAN_ID}"`))
  })

  test('whitespace alone is still an empty box, not a mismatch', () => {
    assert.ok(!field('   ').includes('does not match'))
  })
})

// ── The reported case: P-BB-0044 typed for P-BB-0042 ─────────────────────────

describe('a typed ID that is not this payment says so, in words, while typing', () => {
  const html = field(WRONG_ID)

  test('the mismatch is stated explicitly', () => {
    assert.ok(html.includes('Payment ID does not match.'),
      'a disabled button explains nothing; the sentence is the explanation')
  })

  test('and it repeats the ID that would be right, because the two look alike', () => {
    assert.ok(html.includes(`Type ${HUMAN_ID} exactly.`))
    assert.equal(
      paymentDeleteIdMismatchMessage(WRONG_ID, HUMAN_ID),
      `Payment ID does not match. Type ${HUMAN_ID} exactly.`)
  })

  test('the message is announced, not merely drawn', () => {
    assert.ok(/role="alert"/.test(html))
  })

  test('the box itself is marked invalid, and points at the message that says why', () => {
    assert.ok(html.includes('aria-invalid="true"'))
    const described = /aria-describedby="([^"]+)"/.exec(html)
    assert.ok(described, 'the input must name its error message')
    assert.ok(html.includes(`id="${described[1]}"`), 'and that message must be on screen')
  })

  /**
   * A PREFIX IS NOT A MATCH, and neither is the right ID in the wrong case.
   * These are the two ways a friendlier comparison would drift away from
   * begin_finance_payment_deletion, which trims and then compares exactly.
   */
  test('a prefix of the right ID is a mismatch', () => {
    assert.ok(field('P-BB-004').includes('does not match'))
  })

  test('the right ID in the wrong case is a mismatch', () => {
    assert.ok(field('p-bb-0042').includes('does not match'))
  })
})

// ── Corrected: the message goes, immediately ─────────────────────────────────

describe('the exact ID clears the mismatch at once, without submitting anything', () => {
  const html = field(HUMAN_ID)

  test('the mismatch message is gone', () => {
    assert.ok(!html.includes('does not match'))
    assert.equal(paymentDeleteIdMismatchMessage(HUMAN_ID, HUMAN_ID), null)
  })

  test('the field returns to normal styling and is no longer marked invalid', () => {
    assert.ok(!html.includes('aria-invalid="true"'))
    assert.ok(!html.includes('#DC2626'), 'the invalid border must be gone')
  })

  test('the instruction stays — it is the label, not the error', () => {
    assert.ok(html.includes(`Type ${HUMAN_ID} to confirm`))
  })

  test('surrounding whitespace is forgiven, exactly as the database forgives it', () => {
    assert.ok(!field(`  ${HUMAN_ID}  `).includes('does not match'))
  })
})

// ── The ID is this payment's, never a remembered one ─────────────────────────

describe('every ID on the dialog is the payment being deleted, not a hardcoded one', () => {
  test('a different payment carries its own ID into the label and the message', () => {
    const other = field('P-ZZ-9999', 'P-CC-0007')
    assert.ok(other.includes('Type P-CC-0007 to confirm'))
    assert.ok(other.includes('Type P-CC-0007 exactly.'))
    assert.ok(!other.includes('P-AA-0001'), 'the ID from the bug report must appear nowhere')
    assert.ok(!other.includes(HUMAN_ID), 'nor this file\'s other fixture')
  })

  test('the whole dialog names the payment it is about to delete', () => {
    const html = modal({ human_payment_id: 'P-CC-0007' })
    assert.ok(html.includes('Type P-CC-0007 to confirm'))
    assert.ok(!html.includes('P-AA-0001'))
  })
})

// ── The destructive button ───────────────────────────────────────────────────

describe('Delete Payment stays dead until the form is actually finished', () => {
  test('a freshly opened dialog offers a disabled Delete Payment', () => {
    const html = modal()
    assert.ok(html.includes(PAYMENT_DELETE_CONFIRM_LABEL))
    assert.equal(confirmDisabled(html), true,
      'neither a reason nor the ID has been given yet')
  })

  /**
   * THE BUTTON IS NOT WHAT THIS CHANGE TOUCHED. Its condition — a reason AND
   * the exact ID — is canSubmitPaymentDeletion, asserted against every input in
   * paymentDeletion.test.ts. What changed is that the dialog now SAYS why the
   * button is dead; the condition itself is unchanged and unweakened.
   */
  test('the dialog asks canSubmitPaymentDeletion, and keeps no second rule of its own', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/finance/DeletePaymentModal.tsx'), 'utf8')
    assert.ok(src.includes('canSubmitPaymentDeletion({'),
      'the enable condition is the shared predicate')
    assert.ok(!/const\s+idMatches\s*=/.test(src),
      'and not a second comparison written out again here')
    assert.ok(/disabled=\{deleting \|\| !canSubmit\}/.test(src),
      'the destructive button is disabled until it is satisfied')
  })

  /**
   * THE GUARD IS NOT COSMETIC. A mismatched ID must not reach the network — the
   * dialog refuses before it fetches, and the route would refuse anyway with
   * ID_MISMATCH.
   */
  test('confirm() refuses before it calls deletePaymentEntry', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/finance/DeletePaymentModal.tsx'), 'utf8')
    const guard = src.indexOf('if (deleting || settled || !canSubmit) return')
    assert.ok(guard > 0, 'the early return is what stops a wrong ID from being sent')
    assert.ok(src.indexOf('await deletePaymentEntry(') > guard,
      'and it must come before the request')
  })
})

// ── The reason box asks for a reason, not another number ─────────────────────

describe('the reason box says what kind of answer it wants', () => {
  const html = modal()

  test('the label is unchanged', () => {
    assert.ok(html.includes(PAYMENT_DELETE_REASON_LABEL))
  })

  /**
   * THE PLACEHOLDER IS AN EXAMPLE, not a second paragraph of instructions. The
   * dialog's other box wants a Payment ID typed back, and a bare "Why is this
   * payment being deleted?" left the two easy to confuse.
   */
  test('the placeholder offers an example of a real reason', () => {
    assert.ok(html.includes(PAYMENT_DELETE_REASON_PLACEHOLDER))
    assert.ok(/^e\.g\. /.test(PAYMENT_DELETE_REASON_PLACEHOLDER))
    assert.ok(!/P-[A-Z]{2}-\d{4}/.test(PAYMENT_DELETE_REASON_PLACEHOLDER),
      'the example must not itself look like a Payment ID')
  })
})

// ── The warning that must not soften ─────────────────────────────────────────

describe('a Confirmed Payment is still described as verified money', () => {
  test('the warning is present, and unhedged', () => {
    const html = modal({ status: 'approved_unlinked' })
    assert.ok(html.includes('This is a Confirmed Payment'))
    assert.ok(html.includes('money already verified as received'))
    assert.ok(html.includes('This cannot be undone'))
  })

  test('a Payment Request carries no Confirmed Payment warning', () => {
    const html = modal({ status: 'pending_approval' })
    assert.ok(!html.includes('This is a Confirmed Payment'))
    assert.ok(html.includes('This cannot be undone'))
  })
})
