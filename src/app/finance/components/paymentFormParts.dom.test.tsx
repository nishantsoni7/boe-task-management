/**
 * THE SHARED PAYMENT-FORM PARTS — behaviour, run for real in a DOM.
 *
 * FormDialog (the frame), PaymentDetailsFields (amount, date chips, one-tap mode), OptionalDisclosure.
 *
 * Run: npm run test:file -- src/app/finance/components/paymentFormParts.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, useState } from 'react'
import { FormDialog, OptionalDisclosure, PaymentDetailsFields, localDateInput } from './PaymentFormParts'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

function dialog(extra: Partial<Parameters<typeof FormDialog>[0]> = {}) {
  let closed = 0
  const ui = mount(
    <FormDialog
      title="Edit thing" subtitle="PR-1" onClose={() => { closed += 1 }}
      summary="₹5,000 · HDFC" actions={<button type="button">Save</button>}
      {...extra}
    >
      <p>the body</p>
    </FormDialog>,
  )
  cleanup = () => ui.unmount()
  return { ui, closed: () => closed }
}

describe('FormDialog — the frame', () => {
  test('is a labelled modal dialog with a header, the body, and a footer that carries the summary and the buttons', () => {
    const { ui } = dialog()
    const d = ui.one('[role="dialog"]')
    assert.equal(d.getAttribute('aria-modal'), 'true')
    assert.equal(d.getAttribute('aria-label'), 'Edit thing')
    assert.match(d.textContent ?? '', /PR-1/)
    assert.match(d.textContent ?? '', /the body/)
    const footer = ui.one('[aria-live="polite"]')
    assert.equal(footer.textContent, '₹5,000 · HDFC', 'the summary is announced as it changes')
    assert.ok(ui.button('Save'))
  })

  test('the body scrolls and the header and footer do not', () => {
    const { ui } = dialog()
    const d = ui.one<HTMLElement>('[role="dialog"]')
    const kids = [...d.children] as HTMLElement[]
    assert.equal(kids.length, 3, 'header, body, footer')
    assert.equal(kids[1].style.overflowY, 'auto')
    assert.equal(kids[0].style.flexShrink, '0')
    assert.equal(kids[2].style.flexShrink, '0')
    assert.match(d.style.maxWidth, /calc\(100vw - \d+px\)/, 'it fits a narrow screen')
  })

  test('the dialog takes focus on open', () => {
    const { ui } = dialog()
    assert.equal(document.activeElement, ui.one('[role="dialog"]'))
  })

  test('the backdrop is inert; Escape closes only when the form asks for it; a busy form cannot be closed', () => {
    const plain = dialog()
    plain.ui.click(plain.ui.one('[role="dialog"]').previousElementSibling as Element)
    plain.ui.press('Escape')
    assert.equal(plain.closed(), 0, 'by default neither the backdrop nor Escape closes it (a discard guard owns that)')
    cleanup?.()

    const esc = dialog({ closeOnEscape: true })
    esc.ui.press('Escape')
    assert.equal(esc.closed(), 1)
    cleanup?.()

    const busy = dialog({ closeOnEscape: true, closeDisabled: true })
    busy.ui.press('Escape')
    assert.equal(busy.closed(), 0)
    assert.equal(busy.ui.one<HTMLButtonElement>('[aria-label="Close"]').disabled, true)
  })

  test('without buttons or a summary there is no footer bar at all', () => {
    const { ui } = dialog({ actions: undefined, summary: undefined })
    assert.equal([...ui.one('[role="dialog"]').children].length, 2)
  })
})

describe('PaymentDetailsFields — amount, date, mode', () => {
  function Harness(props: { mode?: string }) {
    const [amount, setAmount] = useState('')
    const [date, setDate] = useState('')
    const [mode, setMode] = useState(props.mode ?? '')
    return createElement(PaymentDetailsFields, {
      amount, onAmount: setAmount, date, onDate: setDate, mode, onMode: setMode,
      amountProblem: null, dateProblem: null, modeHintId: 'hint',
    })
  }
  function fields(mode?: string) {
    const ui = mount(createElement(Harness, { mode }))
    cleanup = () => ui.unmount()
    return ui
  }

  test('one tap picks the mode; exactly one is selected', () => {
    const ui = fields()
    assert.equal(ui.all('[role="radio"]').length, 4)
    ui.click(ui.button('PNB'))
    const checked = ui.all('[role="radio"][aria-checked="true"]')
    assert.equal(checked.length, 1)
    assert.equal(checked[0].textContent, 'PNB')
    ui.click(ui.button('Paytm'))
    assert.equal(ui.one('[role="radio"][aria-checked="true"]').textContent, 'Paytm')
  })

  test('a payment recorded under a retired legacy mode keeps it as an option, marked, so editing something else does not move it', () => {
    const ui = fields('upi')
    const radios = ui.all('[role="radio"]')
    assert.equal(radios.length, 5, 'the four current modes plus the row\'s own')
    const selected = ui.one('[role="radio"][aria-checked="true"]')
    assert.equal(selected.textContent, paymentModeLabel('upi'), 'the mode the row already has is the selected one, under its own label')
    assert.equal(radios[0], selected, 'listed first, before the four current modes')
  })

  test('Today and Yesterday are one tap each and fill the date in the reader\'s own calendar', () => {
    const ui = fields()
    const date = ui.one<HTMLInputElement>('input[type="date"]')
    ui.click(ui.button('Today'))
    assert.equal(date.value, localDateInput(0))
    assert.equal(ui.button('Today').getAttribute('aria-pressed'), 'true')
    ui.click(ui.button('Yesterday'))
    assert.equal(date.value, localDateInput(1))
    assert.equal(ui.button('Today').getAttribute('aria-pressed'), 'false')
  })

  test('the date cannot be later than today', () => {
    const ui = fields()
    assert.equal(ui.one<HTMLInputElement>('input[type="date"]').max, localDateInput(0))
  })

  test('the amount carries the rupee sign and shows Indian grouping once it is left', () => {
    const ui = fields()
    assert.match(ui.text(), /₹/)
    const amount = ui.one<HTMLInputElement>('input[inputmode="decimal"]')
    ui.type(amount, '1250000')
    assert.equal(amount.value, '12,50,000', 'Indian grouping, not 1,250,000')
  })
})

describe('OptionalDisclosure — closed until wanted', () => {
  function Host() {
    const [open, setOpen] = useState(false)
    return (
      <OptionalDisclosure title="Add proof" hint="Optional" open={open} onToggle={() => setOpen(o => !o)}>
        <textarea aria-label="note" />
      </OptionalDisclosure>
    )
  }

  test('opens and closes on its heading, and reports its state', () => {
    const ui = mount(createElement(Host))
    cleanup = () => ui.unmount()
    const toggle = ui.button(/Add proof/)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(ui.all('textarea').length, 0, 'nothing is drawn while closed')
    ui.click(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(ui.all('textarea').length, 1)
    ui.click(toggle)
    assert.equal(ui.all('textarea').length, 0)
  })
})
