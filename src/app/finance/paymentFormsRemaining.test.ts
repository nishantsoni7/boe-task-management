import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The payment forms' BEHAVIOUR (never greyed out by an unfinished form, names what is missing, inert
// backdrop, one press = one send, the payloads) is exercised in a real DOM by:
//   src/components/orders/addPiPayment.dom.test.tsx
//   src/app/finance/received/paymentForms.dom.test.tsx          (Allocate Funds, Edit Received Payment)
//   src/app/finance/components/paymentFormParts.dom.test.tsx    (FormDialog, date chips, mode picker, disclosure)
//   src/app/finance/received/correctAllocation.render.test.tsx  (Correct Allocation)
//
// What stays as a source check is a structural guarantee a DOM test cannot observe: which server door the
// Correct Allocation screen sends through.

describe('Correct Allocation keeps its one server door', () => {
  test('the reversal goes through performAllocationReversal, and the screen reads no allocation table itself', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/finance/received/CorrectAllocationModal.tsx'), 'utf8')
    assert.ok(src.includes('performAllocationReversal('))
    assert.ok(!src.includes("from('finance_payment_allocations')"))
  })
})
