/**
 * ALLOCATE FUNDS and EDIT RECEIVED PAYMENT — behaviour, run for real in a DOM.
 *
 * What a person sees when they press the main button on an unfinished form, that nothing reaches the
 * database until the form is valid, and that what is sent is what was typed.
 *
 * Run: npm run test:file -- src/app/finance/received/paymentForms.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { AllocateFundsModal, type AllocateFundsPayment } from './AllocateFundsModal'
import { EditPaymentModal } from './receivedPaymentsEdit'
import type { PaymentRequest } from './receivedPaymentsModel'

// ── A fake database client: records every call, answers with canned rows ─────────────────────────

type Call = { kind: 'rpc' | 'update'; name: string; args: unknown }

function fakeClient(opts: { updateError?: string } = {}) {
  const calls: Call[] = []
  const candidate = { id: 'ord-1', display_number: 'ORD-0524', client_name: 'Cafe Verde', status: 'confirmed', total_value: 50000 }
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: 'rpc', name, args })
      if (name === 'payment_allocation_ledger_for_correction') return { data: [], error: null }
      if (name === 'finance_order_search') return { data: [candidate], error: null }
      if (name === 'order_linked_payment_total') return { data: '0', error: null }
      if (name === 'allocate_payment_to_targets') return { data: null, error: null }
      return { data: null, error: null }
    },
    from: (table: string) => {
      // order_submissions search chain: select().or().in().order().limit()
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'or', 'in', 'order', 'limit', 'eq']) chain[m] = () => chain
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      chain.update = (payload: unknown) => {
        calls.push({ kind: 'update', name: table, args: payload })
        const done: Record<string, unknown> = {}
        done.eq = () => done
        done.select = () => done
        done.single = async () => (opts.updateError
          ? { data: null, error: { message: opts.updateError } }
          : { data: { id: 'pay-1' }, error: null })
        return done
      }
      return chain
    },
  }
  return { client: client as never, calls }
}

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

// ── Allocate Funds ────────────────────────────────────────────────────────────────────────────────

const PAYMENT: AllocateFundsPayment = {
  id: 'pay-1', human_payment_id: 'P-AA-0001', amount: 1000, allocated_total: 0, client_name: 'Cafe Verde',
}

function openFunds() {
  const fake = fakeClient()
  let closed = 0
  let allocated = 0
  const ui = mount(createElement(AllocateFundsModal, {
    payment: PAYMENT, supabase: fake.client,
    onClose: () => { closed += 1 }, onAllocated: () => { allocated += 1 },
  }))
  cleanup = () => ui.unmount()
  const sends = () => fake.calls.filter(c => c.name === 'allocate_payment_to_targets')
  return { ui, fake, sends, closed: () => closed, allocated: () => allocated }
}

describe('Allocate Funds', () => {
  test('the summary says how much is left, before anything is typed', async () => {
    const { ui } = openFunds()
    await ui.settle()
    assert.match(ui.text(), /Remaining unallocated/)
    assert.match(ui.text(), /₹0\.00 to allocate/)
    assert.match(ui.text(), /1,000\.00 left/)
  })

  test('pressing Allocate on an empty form is not blocked by a greyed-out button; it names what is missing', async () => {
    const { ui, sends } = openFunds()
    await ui.settle()
    const allocate = ui.button('Allocate Funds')
    assert.equal(allocate.disabled, false)
    ui.click(allocate)
    assert.equal(sends().length, 0, 'nothing reaches the database')
    assert.match(ui.text(), /Add at least one allocation\.|Choose an Order or a PI Draft/)
    assert.ok(ui.all('[role="alert"]').length >= 1)
  })

  test('choose an Order, give an amount, press once: exactly one atomic call with that target and amount', async () => {
    const { ui, sends, allocated } = openFunds()
    await ui.settle()
    ui.click(ui.button('Choose an Order or PI Draft'))
    ui.type(ui.one<HTMLInputElement>('input[placeholder^="Order number"]'), 'ORD')
    await ui.settle()
    ui.click(ui.button(/ORD-0524/))
    await ui.settle()
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount for allocation 1"]'), '400')
    assert.match(ui.text(), /600\.00 left/, 'the remaining figure follows what was typed')
    ui.click(ui.button('Allocate Funds'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args as { p_payment_request_id: string; p_targets: Array<{ order_id: string | null; allocated_amount: unknown }> }
    assert.equal(sent.p_payment_request_id, 'pay-1')
    assert.equal(sent.p_targets.length, 1)
    assert.equal(sent.p_targets[0].order_id, 'ord-1')
    assert.equal(String(sent.p_targets[0].allocated_amount), '400')
    assert.equal(allocated(), 1, 'the list is told only after the server answered')
  })

  test('an OLD order that is not in the system: type its number and client, give an amount, press once', async () => {
    const { ui, sends, allocated } = openFunds()
    await ui.settle()
    ui.click(ui.button('Old order (not in system)'))
    // the two typed fields appear; until both are filled the form names what is missing
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount for allocation 1"]'), '300')
    ui.click(ui.button('Allocate Funds'))
    assert.equal(sends().length, 0, 'nothing is sent without the old order number')
    assert.match(ui.text(), /enter the old order number/)
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Old order number for allocation 1"]'), ' ab-12 ')
    ui.click(ui.button('Allocate Funds'))
    assert.equal(sends().length, 0, 'nothing is sent without the client')
    assert.match(ui.text(), /enter the client/)
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Client name for allocation 1"]'), 'Old Client')
    assert.match(ui.text(), /700\.00 left/, 'the remaining figure counts an old order like any other')
    ui.click(ui.button('Allocate Funds'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args as { p_targets: Array<Record<string, unknown>> }
    assert.deepEqual(sent.p_targets, [
      { legacy_order_no: 'AB-12', legacy_client_name: 'Old Client', allocated_amount: 300 },
    ], 'no record id is sent for an order that is not in the system')
    assert.equal(allocated(), 1)
  })

  test('an old order and an Order go in one call, in the order listed', async () => {
    const { ui, sends } = openFunds()
    await ui.settle()
    ui.click(ui.button('Old order (not in system)'))
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Old order number for allocation 1"]'), 'OLD-1')
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Client name for allocation 1"]'), 'Cafe Verde')
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount for allocation 1"]'), '200')
    ui.click(ui.button('+ Add allocation'))
    ui.click(ui.all<HTMLButtonElement>('button').filter(b => b.textContent === 'Choose an Order or PI Draft')[0])
    ui.type(ui.one<HTMLInputElement>('input[placeholder^="Order number"]'), 'ORD')
    await ui.settle()
    ui.click(ui.button(/ORD-0524/))
    await ui.settle()
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount for allocation 2"]'), '300')
    ui.click(ui.button('Allocate Funds'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args as { p_targets: Array<Record<string, unknown>> }
    assert.equal(sent.p_targets.length, 2)
    assert.equal(sent.p_targets[0].legacy_order_no, 'OLD-1')
    assert.equal(sent.p_targets[1].order_id, 'ord-1')
  })

  test('"Change" takes an old-order row back to an unchosen one', async () => {
    const { ui } = openFunds()
    await ui.settle()
    ui.click(ui.button('Old order (not in system)'))
    assert.equal(ui.all('input[aria-label="Old order number for allocation 1"]').length, 1)
    ui.click(ui.button('Change'))
    assert.equal(ui.all('input[aria-label="Old order number for allocation 1"]').length, 0)
    assert.ok(ui.button('Choose an Order or PI Draft'))
  })

  test('more than is left is refused with a sentence, and nothing is sent', async () => {
    const { ui, sends } = openFunds()
    await ui.settle()
    ui.click(ui.button('Choose an Order or PI Draft'))
    ui.type(ui.one<HTMLInputElement>('input[placeholder^="Order number"]'), 'ORD')
    await ui.settle()
    ui.click(ui.button(/ORD-0524/))
    await ui.settle()
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount for allocation 1"]'), '1500')
    assert.match(ui.text(), /Over by/)
    ui.click(ui.button('Allocate Funds'))
    assert.equal(sends().length, 0)
    assert.match(ui.text(), /more than this payment has left unallocated/)
  })

  test('the backdrop is inert; Escape and Cancel close it', async () => {
    const { ui, closed } = openFunds()
    await ui.settle()
    ui.click(ui.one('[role="dialog"]').previousElementSibling as Element)
    assert.equal(closed(), 0)
    ui.press('Escape')
    assert.equal(closed(), 1)
    ui.click(ui.button('Cancel'))
    assert.equal(closed(), 2)
  })
})

// ── Edit Received Payment ─────────────────────────────────────────────────────────────────────────

const RECEIVED = {
  id: 'pay-1', request_number: 'PR-1', human_payment_id: 'P-AA-0001', client_name: 'Cafe Verde',
  amount: 5000, payment_date: '2026-10-01', payment_mode: 'hdfc', received_in: 'company_account',
  proof_note: null, sales_note: null, order_number: null, status: 'approved_unlinked',
} as unknown as PaymentRequest

function openEdit(updateError?: string) {
  const fake = fakeClient({ updateError })
  let saved = 0
  let closed = 0
  const ui = mount(createElement(EditPaymentModal, {
    request: RECEIVED, supabase: fake.client,
    onClose: () => { closed += 1 }, onSaved: () => { saved += 1 },
  }))
  cleanup = () => ui.unmount()
  const updates = () => fake.calls.filter(c => c.kind === 'update')
  return { ui, updates, saved: () => saved, closed: () => closed }
}

describe('Edit Received Payment', () => {
  test('opens on the payment as it is: amount, date and mode, with the customer read-only', () => {
    const { ui } = openEdit()
    assert.match(ui.text(), /Edit Received Payment/)
    assert.equal(ui.one<HTMLInputElement>('input[inputmode="decimal"]').value, '5,000', 'grouped when not focused')
    assert.equal(ui.one('[role="radio"][aria-checked="true"]').textContent, 'HDFC PRI')
    assert.match(ui.text(), /Cafe Verde/)
    assert.equal(ui.all<HTMLInputElement>('input').some(i => i.value === 'Cafe Verde'), false, 'the customer is text, not a field, so it cannot be typed over')
  })

  test('there is no Received In control: payment mode already names the account', () => {
    const { ui } = openEdit()
    assert.doesNotMatch(ui.text(), /Received in/i)
    assert.equal(ui.all('select').length, 0)
  })

  test('clearing the amount and pressing Save names the problem and writes nothing', () => {
    const { ui, updates } = openEdit()
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '')
    const save = ui.button('Save Changes')
    assert.equal(save.disabled, false)
    ui.click(save)
    assert.equal(updates().length, 0)
    assert.match(ui.text(), /Enter the amount received\./)
  })

  test('a change is saved once, to the one payment, with exactly the edited fields', async () => {
    const { ui, updates, saved } = openEdit()
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '5200.5')
    ui.click(ui.button('Paytm'))
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.equal(updates().length, 1)
    const payload = updates()[0].args as Record<string, unknown>
    assert.equal(payload.amount, 5200.5)
    assert.equal(payload.payment_mode, 'paytm')
    assert.equal(payload.payment_date, '2026-10-01')
    assert.equal('client_name' in payload, false, 'the customer is never in the payload')
    assert.equal('order_number' in payload, false, 'and neither is the Order Number of a linked payment')
    assert.equal('received_in' in payload, false, 'payment mode names the account, so received_in is left as stored')
    assert.equal(saved(), 1)
  })

  test('a refusal from the database is shown and the form stays open with what was typed', async () => {
    const { ui, saved } = openEdit('permission denied')
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '1')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.match(ui.text(), /permission denied/)
    assert.equal(saved(), 0)
  })

  test('proof and notes are closed until wanted; the backdrop is inert; Escape closes', () => {
    const { ui, closed } = openEdit()
    assert.doesNotMatch(ui.text(), /Sales note/)
    ui.click(ui.button(/Add proof or notes/))
    assert.match(ui.text(), /Sales note/)
    ui.click(ui.one('[role="dialog"]').previousElementSibling as Element)
    assert.equal(closed(), 0)
    ui.press('Escape')
    assert.equal(closed(), 1)
  })
})
