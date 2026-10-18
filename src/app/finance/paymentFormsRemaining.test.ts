import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The remaining payment-section forms were restyled onto the shared frame
// (FormDialog) the Send Payment Request form introduced. PRESENTATION ONLY: this
// pins that each one kept its server door and that none greys its primary button
// out because the form is unfinished.

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')

const FORMS = [
  ['AllocateFundsModal', read('src', 'app', 'finance', 'received', 'AllocateFundsModal.tsx')],
  ['CorrectAllocationModal', read('src', 'app', 'finance', 'received', 'CorrectAllocationModal.tsx')],
  ['PiPaymentCard', read('src', 'components', 'orders', 'PiPaymentCard.tsx')],
] as const

describe('the remaining payment forms share the frame', () => {
  for (const [name, src] of FORMS) {
    test(`${name} is drawn by FormDialog`, () => {
      assert.ok(src.includes('<FormDialog'), 'on the shared frame')
      assert.ok(src.includes("from '@/app/finance/components/PaymentFormParts'"))
    })
  }

  test('Edit Received Payment is drawn by FormDialog and keeps its single UPDATE', () => {
    const view = read('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx')
    const edit = view.slice(view.indexOf('function EditPaymentModal('), view.indexOf('// ── Table ───'))
    assert.ok(edit.includes('<FormDialog'))
    assert.ok(edit.includes('<PaymentDetailsFields'), 'amount, date and one-tap mode, with the mode hint')
    assert.equal((edit.match(/\.update\(/g) ?? []).length, 1)
    assert.ok(edit.includes(".from('finance_payment_requests')"))
  })
})

describe('an unfinished form never greys out its primary button', () => {
  test('Allocate Funds, Add payment and Edit Received Payment name what is missing and scroll to it', () => {
    const view = read('src', 'app', 'finance', 'received', 'ReceivedPaymentsView.tsx')
    const edit = view.slice(view.indexOf('function EditPaymentModal('), view.indexOf('// ── Table ───'))
    for (const src of [FORMS[0][1], FORMS[2][1], edit]) {
      assert.ok(src.includes('scrollToFirstProblem('))
      assert.ok(!/disabled=\{blocked/.test(src), 'no button is disabled by the blocked reason')
      assert.ok(!/disabled=\{!allowed\}/.test(src))
      assert.ok(!/disabled=\{!canSubmit/.test(src))
    }
  })

  test('Review reversal is only ever disabled by nothing, and says what is missing', () => {
    const src = FORMS[1][1]
    assert.ok(!/onClick=\{props\.onReview\} disabled/.test(src))
    assert.ok(src.includes('props.attempted ? blocked : null'))
  })
})

describe('every server door is unchanged', () => {
  test('the RPC names', () => {
    assert.ok(FORMS[0][1].includes("supabase.rpc('allocate_payment_to_targets'"))
    assert.ok(FORMS[1][1].includes('performAllocationReversal('))
  })

  test('the backdrop is inert: no form passes a click handler to the overlay', () => {
    for (const [, src] of FORMS) assert.ok(!src.includes('closeOnBackdropClick={true}'))
    const parts = read('src', 'app', 'finance', 'components', 'PaymentFormParts.tsx')
    assert.ok(/zIndex: FINANCE_MODAL_OVERLAY_Z \}\} \/>/.test(parts), 'the overlay has no onClick')
  })
})
