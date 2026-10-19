/**
 * CORRECTING A PAYMENT THAT IS ALREADY ATTACHED TO A PI (20270322000000).
 *
 * A payment recorded from a PI Draft carries an ALLOCATION, not an intent. The
 * Edit form used to read only the intent, so it drew such a payment as a
 * Suspense Entry and the save failed with a generic "could not be submitted".
 * Now the form reads the allocation, shows the real destination locked, and the
 * database's refusals are said in words.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentEditAllocated.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { paymentEntryErrorMessage } from '@/lib/finance/paymentEntry'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('the refusals of a correction are said in words', () => {
  const GENERIC = 'The payment request could not be submitted. Nothing was saved — refresh and try again.'

  for (const [code, includes] of [
    ['PAYMENT_EDIT_SPLIT_ALLOCATED: payment 7 is split', 'split across more than one'],
    ['PAYMENT_EDIT_DESTINATION_LOCKED: payment 7 is already attached', 'already attached'],
    ['PAYMENT_BELOW_ALLOCATED: payment 7 cannot be reduced', 'lower than what is already attached'],
    ['PAYMENT_EDIT_NOT_PERMITTED: only the person', 'Only the person who recorded'],
    ['ALLOCATION_TARGET_CONVERTED: this PI has been approved', 'now an Order'],
    ['ALLOCATION_TARGET_NOT_ACTIVE: a rejected PI', 'can no longer take it'],
  ] as const) {
    test(`${code.split(':')[0]} is not the generic message`, () => {
      const message = paymentEntryErrorMessage(code)
      assert.notEqual(message, GENERIC)
      assert.ok(message.includes(includes), message)
    })
  }

  test('an unknown failure still falls back to the generic sentence', () => {
    assert.equal(paymentEntryErrorMessage('boom'), GENERIC)
  })
})

describe('the Edit form reads the allocation when there is no intent', () => {
  const form = read('src/app/finance/paymentRequestsEdit.tsx')
  const intents = read('src/app/finance/paymentIntents.ts')

  test('the allocation is read only when the payment has no intent, one payment, bounded', () => {
    assert.ok(form.includes('const attached = found ? null : await loadPaymentAllocation(supabase, r.id)'))
    assert.ok(intents.includes("export async function loadPaymentAllocation("))
    assert.ok(intents.includes(".eq('status', 'active')"))
    assert.ok(intents.includes('.limit(2)'))
  })

  test('an attached payment shows its REAL destination, locked, and sends it back unchanged', () => {
    assert.ok(form.includes("allocation?.kind === 'attached' && entry.target"))
    assert.ok(form.includes('the destination cannot be changed in this form'))
    // The destination and target it sends are the ones it loaded: the database
    // refuses anything else (PAYMENT_EDIT_DESTINATION_LOCKED).
    assert.ok(form.includes("destination: attached.targetType"))
    assert.ok(form.includes('id: attached.targetId'))
    assert.ok(form.includes("p_destination:     entry.destination"))
  })

  test('a payment split across several records is named, and cannot be saved here', () => {
    assert.ok(form.includes("allocation?.kind === 'split'"))
    assert.ok(form.includes('&& !splitBlocked'))
    assert.ok(form.includes('Ask Finance to correct its allocations first'))
  })

  test('the form still writes through the one protected door and never the allocation table', () => {
    assert.ok(form.includes(".rpc('edit_payment_request'"))
    for (const forbidden of ['.insert(', '.update(', '.delete(', '.upsert(']) {
      assert.ok(!form.includes(forbidden), `${forbidden} must not appear in the Edit form`)
      assert.ok(!intents.includes(forbidden), `${forbidden} must not appear in paymentIntents`)
    }
  })
})

describe('the migration', () => {
  const dir = join(process.cwd(), 'supabase/migrations')
  const file = readdirSync(dir).find(f => f.endsWith('_finance_payment_edit_reallocates.sql'))!
  const sql = readFileSync(join(dir, file), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))

  test('it restates edit_payment_request, same signature, and is not an edit of an applied file', () => {
    assert.ok(file)
    assert.ok(sql.includes('create or replace function public.edit_payment_request('))
    assert.ok(sql.includes('grant execute on function public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)'))
  })

  test('only a payment with exactly ONE allocation is newly editable, destination locked', () => {
    assert.ok(sql.includes('PAYMENT_EDIT_SPLIT_ALLOCATED'))
    assert.ok(sql.includes('PAYMENT_EDIT_DESTINATION_LOCKED'))
    assert.ok(sql.includes('PAYMENT_ALREADY_APPROVED'), 'a verified payment is still refused')
  })

  test('the allocation is reversed with a reason and re-created through the shared implementation', () => {
    assert.ok(sql.includes("set status          = 'reversed'"))
    assert.ok(sql.includes('Payment corrected before verification'))
    assert.ok(sql.includes('public.allocate_payment_to_target_internal('))
    assert.equal(sql.includes('update public.finance_payment_allocations\n       set allocated_amount'), false,
      'an allocation is immutable: its amount is never edited in place')
  })

  test('the PI is locked before the payment, the project-wide order', () => {
    const pi = sql.indexOf('from public.order_submissions s')
    const pay = sql.indexOf('from public.finance_payment_requests\n  where id = p_payment_request_id\n  for update')
    assert.ok(pi > -1 && pay > -1 && pi < pay)
  })
})
