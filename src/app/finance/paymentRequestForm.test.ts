/**
 * THE SEND PAYMENT REQUEST FORM — easy to fill, and still the same form.
 *
 * Presentation changes only: numbered steps, one-tap payment mode, Today and
 * Yesterday chips, a ₹ prefix, a closed-until-wanted proof section, a live
 * summary, and a Send button that names what is missing instead of going grey.
 * What this file holds is the other half of that sentence — every rule that
 * must NOT have moved: one submission, one payment, decided server-side.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentRequestForm.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localDateInput } from './components/PaymentFormParts'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

function modalSource(): string {
  const src = read('src/app/finance/page.tsx')
  const from = src.indexOf('function NewPaymentConfirmationModal(')
  const to = src.indexOf('function EditPaymentModal(')
  assert.ok(from > 0 && to > from, 'the modal is found')
  return src.slice(from, to)
}

describe('the date chips', () => {
  test('Today and Yesterday are read in the reader\'s own calendar', () => {
    // 00:30 IST on 17 October is still 16 October in UTC. toISOString() would
    // have said the 16th for the first five and a half hours of every morning.
    const earlyMorning = new Date(2026, 9, 17, 0, 30)
    assert.equal(localDateInput(0, earlyMorning), '2026-10-17')
    assert.equal(localDateInput(1, earlyMorning), '2026-10-16')
  })

  test('Yesterday crosses a month and a year correctly', () => {
    assert.equal(localDateInput(1, new Date(2026, 10, 1, 9, 0)), '2026-10-31')
    assert.equal(localDateInput(1, new Date(2027, 0, 1, 9, 0)), '2026-12-31')
  })
})

describe('the form is organised as steps', () => {
  const src = modalSource()

  test('what it is for, the payment, then where the money is now', () => {
    const one = src.indexOf('title="What is this payment for?"')
    const two = src.indexOf('title="Payment"')
    const three = src.indexOf('title="Where is this money now?"')
    assert.ok(one > 0 && two > one && three > two, 'steps appear in that order')
  })

  test('the payment mode is four one-tap buttons, not a dropdown', () => {
    assert.ok(src.includes('<PaymentModePicker'))
    assert.equal(/<select/.test(src), false, 'no dropdown is left in the modal')
    const parts = read('src/app/finance/components/PaymentFormParts.tsx')
    assert.ok(parts.includes('role="radiogroup"') && parts.includes('role="radio"'))
    assert.ok(parts.includes('paymentModeOptionsFor'), 'the options still come from the one shared list')
  })

  test('the custody step exists only for the two modes that carry a trail', () => {
    assert.ok(/modeRequiresCustodyTrail\(form\.paymentMode\) && \(/.test(src))
  })

  test('the amount carries the rupee sign and the search box takes the cursor', () => {
    assert.ok(src.includes('<AmountInput prefix="₹"'))
    assert.ok(src.includes('autoFocusSearch'))
  })
})

describe('Send names what is missing instead of going grey', () => {
  const src = modalSource()

  test('the button is never disabled by an unfinished form', () => {
    const button = src.slice(src.indexOf('onClick={reviewAndSend}'), src.indexOf('Submit Request') + 20)
    assert.ok(button.includes('disabled={saving}'))
    assert.equal(button.includes('canSubmit'), false)
  })

  test('an unfinished form reveals its problems and goes no further', () => {
    const gate = src.slice(src.indexOf('const reviewAndSend ='), src.indexOf('// The SAME search Record Payment'))
    assert.ok(gate.includes('if (saving || submitting.current) return'))
    assert.ok(/if \(!canSubmit\) \{[\s\S]*setShowProblems\(true\)[\s\S]*return\s*\}/.test(gate))
    assert.ok(/void handleSubmit\(\)/.test(gate), 'a finished form still goes through handleSubmit')
    assert.equal(/supabase\.rpc/.test(gate), false, 'the gate itself writes nothing')
  })

  test('handleSubmit keeps its own refusal of an unfinished or repeated send', () => {
    assert.ok(src.includes('if (!canSubmit || saving || submitting.current) return'))
  })

  test('each problem is named only after Send was pressed', () => {
    for (const name of ['targetProblem', 'amountProblem', 'dateProblem']) {
      assert.ok(new RegExp(`const ${name} = showProblems`).test(src), `${name} waits for showProblems`)
    }
  })

  test('the footer says what is about to be sent', () => {
    assert.ok(src.includes('const summary = ['))
    assert.ok(src.includes('aria-live="polite"'))
  })
})

describe('closing the proof section never loses what was typed', () => {
  const src = modalSource()

  test('the values live in the form, not in the section', () => {
    assert.ok(src.includes('<OptionalDisclosure'))
    // Typed text is form.proofNote / form.salesNote and the file is attachFile:
    // all three are state of the modal, so an unmounted section cannot drop them.
    assert.ok(src.includes('value={form.proofNote}') && src.includes('value={form.salesNote}'))
    assert.ok(src.includes('const [attachFile,  setAttachFile]'))
  })

  test('the collapsed title says when something is in it', () => {
    assert.ok(src.includes("'Proof attached'"))
  })

  test('a failed proof is shown, not hidden behind the closed section', () => {
    assert.ok(src.includes('if (attachError) setProofOpen(true)'))
  })
})

describe('what the redesign must not have touched', () => {
  const src = modalSource()

  test('one submission, one payment: the idempotency key and the guard are intact', () => {
    assert.ok(src.includes("new SubmissionAttempt('payment-request')"))
    assert.ok(src.includes('submitting.current = true'))
    assert.ok(src.includes("supabase.rpc('submit_payment_request'"))
    assert.ok(src.includes('p_idempotency_key: attempt.begin(args)'))
  })

  test('no customer name is sent: the server reads it from the chosen record', () => {
    const args = src.slice(src.indexOf('const args = {'), src.indexOf('const attempt = attemptRef.current'))
    assert.equal(/client|customer/i.test(args), false)
  })

  test('the unsaved-work guard still stands in front of Cancel and the close button', () => {
    assert.ok(src.includes('guard.requestClose'))
    assert.ok(src.includes('<DiscardConfirmation'))
  })

  test('a custody activity now starts at the current time, and the server still bounds it', () => {
    const control = read('src/app/finance/components/CustodyTrailFields.tsx')
    assert.ok(control.includes('draft.occurredAt = isoToLocalInput(new Date().toISOString())'))
    const sql = read('supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql')
    assert.ok(sql.includes('CUSTODY_EVENT_TIME_FUTURE'))
  })
})
