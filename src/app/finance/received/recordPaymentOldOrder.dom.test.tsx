/**
 * RECORD PAYMENT — an OLD order that is not in the system (20270407000000),
 * run for real in a DOM.
 *
 * Under "Confirmed Order" a row may be an old order typed by number and client
 * instead of picked; it is sent in the same allocation list as {kind:'legacy'}.
 *
 * Run: npm run test:file -- src/app/finance/received/recordPaymentOldOrder.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { RecordSplitPaymentModal } from './RecordSplitPaymentModal'

type Call = { name: string; args: unknown }

function fakeClient() {
  const calls: Call[] = []
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args })
      if (name === 'record_payment_with_allocations') {
        return { data: { payment_request_id: 'pay-1', request_number: 'PAY-REQ-1', allocation_count: 2 }, error: null }
      }
      return { data: null, error: null }
    },
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'or', 'in', 'order', 'limit', 'eq', 'update', 'single']) chain[m] = () => chain
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      return chain
    },
  }
  return { client: client as never, calls }
}

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

function open() {
  const fake = fakeClient()
  let recorded = 0
  const ui = mount(createElement(RecordSplitPaymentModal, {
    supabase: fake.client, userId: 'u1', onClose: () => {}, onRecorded: () => { recorded += 1 },
  }))
  cleanup = () => ui.unmount()
  const sends = () => fake.calls.filter(c => c.name === 'record_payment_with_allocations')
  return { ui, sends, recorded: () => recorded }
}

const radio = (ui: ReturnType<typeof mount>, text: RegExp) =>
  ui.all<HTMLButtonElement>('[role="radio"]').find(b => text.test(b.textContent ?? ''))!

describe('Record Payment with an old order', () => {
  test('the option is offered under Confirmed Order, and under no other destination', async () => {
    const { ui } = open()
    await ui.settle()
    assert.equal(ui.all('button').some(b => /Old order \(not in system\)/.test(b.textContent ?? '')), false, 'nothing before a destination is chosen')
    ui.click(radio(ui, /PI Draft/))
    assert.equal(ui.all('button').some(b => /Old order \(not in system\)/.test(b.textContent ?? '')), false, 'not under PI Draft')
    ui.click(radio(ui, /Confirmed Order/))
    assert.ok(ui.button('Old order (not in system)'))
  })

  test('type the number and client, and the entry is recorded with {kind:legacy} in the one allocation list', async () => {
    const { ui, sends, recorded } = open()
    await ui.settle()
    ui.click(radio(ui, /Confirmed Order/))
    ui.type(ui.all<HTMLInputElement>('input[inputmode="decimal"]')[0], '5000')
    ui.click(ui.button('Today'))
    ui.click(ui.button('Old order (not in system)'))
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount for allocation 1"]'), '3000')

    ui.click(ui.button('Record Payment'))
    assert.equal(sends().length, 0, 'nothing is sent without the old order number')
    assert.match(ui.text(), /enter the old order number/)

    ui.type(ui.one<HTMLInputElement>('input[aria-label="Old order number for allocation 1"]'), ' ab-12 ')
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Client name for allocation 1"]'), 'Old Client')
    assert.match(ui.text(), /2,000\.00 left to allocate/, 'the arithmetic counts an old order like any other')

    ui.click(ui.button('Record Payment'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args as { p_allocations: unknown; p_client_name: unknown }
    assert.deepEqual(sent.p_allocations, [
      { kind: 'legacy', order_no: 'AB-12', client_name: 'Old Client', amount: 3000 },
    ])
    assert.equal(sent.p_client_name, null, 'the customer is still derived by the server, never sent')
    await ui.settle()
    assert.equal(recorded(), 1)
  })

  test('"Change" takes the row back to an unchosen one', async () => {
    const { ui } = open()
    await ui.settle()
    ui.click(radio(ui, /Confirmed Order/))
    ui.click(ui.button('Old order (not in system)'))
    assert.equal(ui.all('input[aria-label="Old order number for allocation 1"]').length, 1)
    ui.click(ui.button('Change'))
    assert.equal(ui.all('input[aria-label="Old order number for allocation 1"]').length, 0)
    assert.ok(ui.button('Choose an Order'))
  })

  test('switching the destination clears an old-order row, so it cannot ride into a PI entry', async () => {
    const { ui } = open()
    await ui.settle()
    ui.click(radio(ui, /Confirmed Order/))
    ui.click(ui.button('Old order (not in system)'))
    ui.click(radio(ui, /PI Draft/))
    assert.equal(ui.all('input[aria-label="Old order number for allocation 1"]').length, 0)
  })
})
