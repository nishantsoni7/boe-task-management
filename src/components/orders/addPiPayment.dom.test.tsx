/**
 * ADD PAYMENT (on a PI) — behaviour, run for real in a DOM.
 *
 * Replaces source-text checks of the form: what matters is what a person sees when they press
 * Record payment on an unfinished form, that nothing is sent until the form is valid, that a
 * stray click never throws their input away, and that one press sends one payment.
 *
 * Run: npm run test:file -- src/components/orders/addPiPayment.dom.test.tsx
 */
import { mount, scrolled } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { AddPiPaymentModal } from './PiPaymentCard'
import type { PiPaymentFormState } from '@/lib/finance/piPaymentView'

type Sent = { form: PiPaymentFormState; proof: File | null }

function open(over: { saving?: boolean; reply?: string | null } = {}) {
  const sent: Sent[] = []
  let closed = 0
  const ui = mount(createElement(AddPiPaymentModal, {
    todayIso: '2026-10-18',
    saving: over.saving ?? false,
    onClose: () => { closed += 1 },
    onSubmit: async (form: PiPaymentFormState, proof: File | null) => { sent.push({ form, proof }); return over.reply ?? null },
  }))
  return { ui, sent, closed: () => closed }
}

let current: ReturnType<typeof open> | null = null
afterEach(() => { current?.ui.unmount(); current = null })

describe('Add payment — an unfinished form', () => {
  test('the Record button is not greyed out, and pressing it names what is missing', () => {
    current = open()
    const { ui, sent } = current
    const record = ui.button('Record payment')
    assert.equal(record.disabled, false, 'an unfinished form never disables the button')
    ui.click(record)
    assert.equal(sent.length, 0, 'nothing is sent')
    assert.match(ui.text(), /Enter the amount received\./)
    assert.match(ui.text(), /Choose how the payment was made\./)
    assert.ok(ui.all('[role="alert"]').length >= 2, 'each problem is an alert under its field')
  })

  test('it takes the person to the first problem', () => {
    current = open()
    current.ui.click(current.ui.button('Record payment'))
    // scrollToFirstProblem waits one frame
    return new Promise<void>(resolve => setTimeout(() => {
      assert.ok(scrolled.length > 0, 'the first problem was scrolled into view')
      resolve()
    }, 20))
  })

  test('the problems clear as they are put right', () => {
    current = open()
    const { ui } = current
    ui.click(ui.button('Record payment'))
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '2500')
    assert.doesNotMatch(ui.text(), /Enter the amount received\./)
    ui.click(ui.button('HDFC PRI'))
    assert.doesNotMatch(ui.text(), /Choose how the payment was made\./)
  })
})

describe('Add payment — a finished form', () => {
  test('one press sends exactly one payment, with what was typed', async () => {
    current = open()
    const { ui, sent } = current
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '2500.50')
    ui.click(ui.button('Paytm'))
    const record = ui.button('Record payment')
    ui.click(record)
    ui.click(ui.button(/Recording|Record payment/)) // a second press, in the same tick
    await ui.settle()
    assert.equal(sent.length, 1, 'a second click inside the same tick is refused')
    assert.equal(sent[0].form.amount, '2500.50')
    assert.equal(sent[0].form.paymentMode, 'paytm')
    assert.equal(sent[0].form.paymentDate, '2026-10-18', 'the date defaults to today')
  })

  test('a failure comes back with what was typed intact, and the form can be sent again', async () => {
    current = open({ reply: 'The payment could not be recorded.' })
    const { ui, sent } = current
    const amount = ui.one<HTMLInputElement>('input[inputmode="decimal"]')
    ui.type(amount, '100')
    ui.click(ui.button('HDFC PRI'))
    ui.click(ui.button('Record payment'))
    await ui.settle()
    assert.match(ui.text(), /The payment could not be recorded\./)
    assert.equal(amount.value, '100', 'what was typed is still there')
    ui.click(ui.button('Record payment'))
    await ui.settle()
    assert.equal(sent.length, 2, 'the person can try again')
  })

  test('a payment that is already being recorded cannot be pressed again', () => {
    current = open({ saving: true })
    assert.equal(current.ui.button('Recording…').disabled, true)
  })
})

describe('Add payment — leaving the form', () => {
  test('a click on the dark area behind it does nothing: typed input is never thrown away', () => {
    current = open()
    const { ui, closed } = current
    const dialog = ui.one('[role="dialog"]')
    const backdrop = dialog.previousElementSibling as Element
    assert.ok(backdrop, 'the backdrop is drawn')
    ui.click(backdrop)
    assert.equal(closed(), 0)
  })

  test('Escape, the close button and Cancel all close it', () => {
    current = open()
    const { ui, closed } = current
    ui.press('Escape')
    assert.equal(closed(), 1, 'Escape')
    ui.click(ui.one('[aria-label="Close"]'))
    assert.equal(closed(), 2, 'the close button')
    ui.click(ui.button('Cancel'))
    assert.equal(closed(), 3, 'Cancel')
  })

  test('while a payment is being recorded the form cannot be closed', () => {
    current = open({ saving: true })
    const { ui, closed } = current
    ui.press('Escape')
    assert.equal(closed(), 0)
    assert.equal(ui.button('Cancel').disabled, true)
  })
})

describe('Add payment — the optional section', () => {
  test('reference, remarks and proof stay closed until wanted, and keep what was typed', () => {
    current = open()
    const { ui } = current
    assert.doesNotMatch(ui.text(), /Reference \/ UTR/, 'closed by default')
    ui.click(ui.button(/Add reference, remarks or proof/))
    assert.match(ui.text(), /Reference \/ UTR/)
    const inputs = ui.all<HTMLInputElement>('input:not([type="file"]):not([inputmode="decimal"]):not([type="date"])')
    ui.type(inputs[0], 'UTR-77')
    ui.click(ui.button(/Add reference, remarks or proof/)) // close it
    assert.match(ui.text(), /Added/, 'the heading says something was added')
    ui.click(ui.button(/Add reference, remarks or proof/)) // and open it again
    assert.equal(ui.all<HTMLInputElement>('input:not([type="file"]):not([inputmode="decimal"]):not([type="date"])')[0].value, 'UTR-77')
  })
})
