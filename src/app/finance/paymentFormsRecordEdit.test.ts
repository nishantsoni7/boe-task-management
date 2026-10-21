/**
 * RECORD PAYMENT AND EDIT PAYMENT — the same easy form as Send Payment Request.
 *
 * Presentation only. The frame, the numbered steps, the one-tap mode, the date
 * chips, the closed-until-wanted proof section and a Save that names what is
 * missing. What this file holds is what must NOT have moved: one recording, one
 * payment; nothing saved before the destination has loaded; every dismissal
 * still asks first.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentFormsRecordEdit.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const RECORD = 'src/app/finance/received/RecordSplitPaymentModal.tsx'

function editSource(): string {
  const src = read('src/app/finance/page.tsx')
  const from = src.indexOf('function EditPaymentModal(')
  // Up to the next top-level function (the review window that used to follow the
  // correction form no longer exists).
  const next = from < 0 ? -1 : src.slice(from + 1).search(/\n(?:export )?function [A-Za-z]/)
  const to = next < 0 ? -1 : from + 1 + next
  assert.ok(from > 0 && to > from)
  return src.slice(from, to)
}

// The shared frame (FormDialog) and parts are exercised for real in
// src/app/finance/components/paymentFormParts.dom.test.tsx.

describe('Record Payment', () => {
  const src = read(RECORD)

  test('steps: what it is for, the payment, who carried it, then the division', () => {
    const order = ['title="What is this payment for?"', 'title="Payment"', 'title="Who carried the money"', 'Divide it across']
      .map(t => src.indexOf(t))
    assert.ok(order.every(i => i > 0), 'every step exists')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order')
  })

  test('the amount, date and mode come from the one shared block', () => {
    assert.ok(src.includes('<PaymentDetailsFields'))
    assert.equal(/<select/.test(src), false)
  })

  test('the custody step exists only for the modes that carry a trail', () => {
    assert.ok(/\{carriesCustody && \(/.test(src))
    assert.ok(src.includes('const carriesCustody = modeRequiresCustodyTrail(paymentMode)'))
  })

  test('Record is never greyed out by an unfinished form', () => {
    const button = src.slice(src.indexOf('onClick={reviewAndRecord}'), src.indexOf('RECORD_PAYMENT_ACTION_LABEL}\n'))
    assert.ok(button.includes('disabled={saving}'))
    assert.equal(button.includes('blocked'), false)
  })

  test('an unfinished entry reveals its problems and goes no further', () => {
    const gate = src.slice(src.indexOf('const reviewAndRecord ='), src.indexOf('const changeDestination'))
    assert.ok(gate.includes('if (saving || submitting.current) return'))
    assert.ok(/if \(blocked\) \{[\s\S]*setShowProblems\(true\)[\s\S]*return\s*\}/.test(gate))
    assert.ok(gate.includes('void handleSave()'))
    assert.equal(/supabase\.rpc/.test(gate), false)
  })

  test('handleSave keeps its own refusal, and the idempotency key is intact', () => {
    assert.ok(src.includes('if (blocked || saving || submitting.current) return'))
    assert.ok(src.includes("new SubmissionAttempt('record-payment')"))
    assert.ok(src.includes("supabase.rpc('record_payment_with_allocations'"))
    assert.ok(src.includes('p_idempotency_key: attempt.begin(args)'))
  })

  test('a recorded payment whose proof failed cannot be recorded again', () => {
    assert.ok(src.includes('recordedWithoutProof ? ('), 'the footer collapses to Close and Retry')
    assert.ok(src.includes('open={proofOpen || recordedWithoutProof !== null}'), 'the file stays visible for the retry')
    assert.ok(src.includes('Retry proof upload'))
  })

  test('the running figures and the mixed-customer confirmation are still there', () => {
    assert.ok(src.includes('label="Left to allocate"') || src.includes("'Left to allocate'"))
    assert.ok(src.includes('<MixedCustomerWarning'))
  })

  test('closing still asks first, and the amount is never rounded by the form', () => {
    assert.ok(src.includes('guard.requestClose') && src.includes('<DiscardConfirmation'))
    assert.ok(src.includes('sanitizeAmountInput'))
  })
})

describe('Edit Payment', () => {
  const src = editSource()

  test('steps: what it is for, the payment, then who carried it', () => {
    const order = ['title="What is this payment for?"', 'title="Payment"', 'title="Who carried the money"']
      .map(t => src.indexOf(t))
    assert.ok(order.every(i => i > 0))
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })

  test('nothing can be saved before the destination has been read back', () => {
    assert.ok(src.includes('if (saving || submitting.current || entry === null) return'))
    assert.ok(src.includes('disabled={saving || entry === null}'))
    assert.ok(src.includes('const canSubmit = entry !== null'))
  })

  test('an unfinished form reveals its problems instead of greying out', () => {
    const gate = src.slice(src.indexOf('const reviewAndSave ='), src.indexOf('const handleSave ='))
    assert.ok(/if \(!canSubmit\) \{[\s\S]*setShowProblems\(true\)[\s\S]*return\s*\}/.test(gate))
    assert.ok(gate.includes('void handleSave()'))
  })

  test('an approval that won the race still collapses the form to one Close', () => {
    assert.ok(src.includes("PAYMENT_ALREADY_APPROVED"))
    assert.ok(src.includes('setStale(true)'))
    assert.ok(src.includes('actions={stale ? ('))
  })

  test('the clarification and rejection notices are kept', () => {
    assert.ok(src.includes('Clarification Required') && src.includes('Rejection Reason'))
    assert.ok(src.includes('banner={'))
  })

  test('the submitter, not the editor, is who collected the cash', () => {
    assert.ok(src.includes('defaultActorId={r.submitted_by}'))
  })

  test('closing still asks first, and the save is still one transaction', () => {
    assert.ok(src.includes('guard.requestClose') && src.includes('<DiscardConfirmation'))
    assert.ok(src.includes("supabase.rpc('edit_payment_request'"))
  })
})
