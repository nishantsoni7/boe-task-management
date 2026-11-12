/**
 * EDIT RECEIVED PAYMENT — correct the client of an OLD order (20270701000000),
 * run for real in a DOM.
 *
 * An old order is not a record in this system, so the client typed with it lives
 * on the allocation only. The Edit window lists each active old order of the
 * payment with its client; a change goes to correct_legacy_order_client on its
 * own and never writes the payment row (so a payment locked by a cash handover
 * can still be corrected).
 *
 * Run: npm run test:file -- src/app/finance/received/editPaymentOldOrderClient.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { EditPaymentModal } from './receivedPaymentsEdit'
import type { PaymentRequest } from './receivedPaymentsModel'
import type { LegacyOrderRow } from '@/lib/finance/allocatedAgainst'

type Call = { kind: 'rpc' | 'update'; name: string; args: unknown }

function fakeClient(opts: { rpcError?: string; cashLocked?: boolean } = {}) {
  const calls: Call[] = []
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: 'rpc', name, args })
      if (name === 'finance_payment_cash_locks') {
        return { data: opts.cashLocked ? [{ payment_id: 'pay-1', reason: 'accepted_transfer', handover: 'H-0001' }] : [], error: null }
      }
      if (name === 'correct_legacy_order_client' && opts.rpcError) return { data: null, error: { message: opts.rpcError } }
      return { data: null, error: null }
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'or', 'in', 'order', 'limit', 'eq']) chain[m] = () => chain
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      chain.update = (payload: unknown) => {
        calls.push({ kind: 'update', name: table, args: payload })
        const done: Record<string, unknown> = {}
        done.eq = () => done
        done.select = () => done
        done.single = async () => ({ data: { id: 'pay-1' }, error: null })
        return done
      }
      return chain
    },
  }
  return { client: client as never, calls }
}

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const RECEIVED = {
  id: 'pay-1', request_number: 'PR-1', human_payment_id: 'P-AA-0089', client_name: 'Hotel Sunrise',
  amount: 5000, payment_date: '2026-10-01', payment_mode: 'hdfc', received_in: 'company_account',
  proof_note: null, sales_note: null, order_number: null, status: 'approved_unlinked',
} as unknown as PaymentRequest

const OLD: LegacyOrderRow[] = [
  { allocationId: 'al-1', orderNo: 'AB-12', clientName: 'Hotel Sunrise' },
  { allocationId: 'al-2', orderNo: 'CD-9', clientName: 'Cafe Moon' },
]

function openEdit(legacyOrders: LegacyOrderRow[], opts: { rpcError?: string; cashLocked?: boolean } = {}) {
  const fake = fakeClient(opts)
  let saved = 0
  const ui = mount(createElement(EditPaymentModal, {
    request: RECEIVED, legacyOrders, supabase: fake.client, onClose: () => {}, onSaved: () => { saved += 1 },
  }))
  cleanup = () => ui.unmount()
  const corrections = () => fake.calls.filter(c => c.name === 'correct_legacy_order_client')
  const updates = () => fake.calls.filter(c => c.kind === 'update')
  return { ui, corrections, updates, saved: () => saved, fake }
}

const inputs = (ui: ReturnType<typeof mount>) =>
  ui.all<HTMLInputElement>('section[aria-label="Old orders"] input')

describe('Edit Received Payment · Old orders', () => {
  test('a payment with no old order has no such section', () => {
    const { ui } = openEdit([])
    assert.equal(ui.all('section[aria-label="Old orders"]').length, 0)
  })

  test('each active old order is listed with its number and its client, ready to change', () => {
    const { ui } = openEdit(OLD)
    assert.match(ui.text(), /Old order AB-12 · client/)
    assert.match(ui.text(), /Old order CD-9 · client/)
    assert.deepEqual(inputs(ui).map(i => i.value), ['Hotel Sunrise', 'Cafe Moon'])
  })

  test('changing one client sends ONE correction for that old order, and writes no payment row', async () => {
    const { ui, corrections, updates, saved } = openEdit(OLD)
    ui.type(inputs(ui)[1], '  Cafe   Moon Pvt Ltd ')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.equal(corrections().length, 1)
    assert.deepEqual(corrections()[0].args, { p_allocation_id: 'al-2', p_client_name: 'Cafe Moon Pvt Ltd' })
    assert.equal(updates().length, 0, 'only the client changed: the payment row is not written')
    assert.equal(saved(), 1)
  })

  test('an unchanged client is not sent again', async () => {
    const { ui, corrections } = openEdit(OLD)
    ui.type(inputs(ui)[0], 'Hotel Sunrise')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.equal(corrections().length, 0)
  })

  test('a blank client is named and nothing is sent', async () => {
    const { ui, corrections, saved } = openEdit(OLD)
    ui.type(inputs(ui)[0], '   ')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.equal(corrections().length, 0)
    assert.match(ui.text(), /Enter the client for old order AB-12\./)
    assert.equal(saved(), 0)
  })

  test('a change to the payment and to a client saves both: the client first, then the payment', async () => {
    const { ui, fake, saved } = openEdit(OLD)
    ui.type(inputs(ui)[0], 'Hotel Sunrise Pvt Ltd')
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '6000')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    const order = fake.calls.filter(c => c.name === 'correct_legacy_order_client' || c.kind === 'update').map(c => c.name)
    assert.deepEqual(order, ['correct_legacy_order_client', 'finance_payment_requests'])
    assert.equal(saved(), 1)
  })

  test('a refusal is shown in words, without the code, and nothing else is saved', async () => {
    const { ui, saved, updates } = openEdit(OLD, { rpcError: 'LEGACY_CLIENT_NOT_PERMITTED: you do not have permission to correct a received payment.' })
    ui.type(inputs(ui)[0], 'Hotel Sunrise Pvt Ltd')
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '6000')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.match(ui.text(), /Old order AB-12: you do not have permission to correct a received payment\./)
    assert.doesNotMatch(ui.text(), /LEGACY_CLIENT_NOT_PERMITTED/)
    assert.equal(updates().length, 0, 'the payment was not saved after the refusal')
    assert.equal(saved(), 0)
  })

  test('a payment locked by a cash handover can still have a client corrected, and nothing else', async () => {
    const { ui, corrections, updates, saved } = openEdit(OLD, { cashLocked: true })
    await ui.settle()
    assert.equal(ui.button('Save Changes').disabled, true, 'nothing changed yet: the lock still holds Save')
    ui.type(inputs(ui)[0], 'Hotel Sunrise Pvt Ltd')
    assert.equal(ui.button('Save Changes').disabled, false, 'a client-only change is allowed')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.equal(corrections().length, 1)
    assert.equal(updates().length, 0)
    assert.equal(saved(), 1)
    // …but a payment change under the lock is still refused.
  })

  test('under the lock, changing the payment as well keeps Save disabled', async () => {
    const { ui } = openEdit(OLD, { cashLocked: true })
    await ui.settle()
    ui.type(inputs(ui)[0], 'Hotel Sunrise Pvt Ltd')
    ui.type(ui.one<HTMLInputElement>('input[inputmode="decimal"]'), '6000')
    assert.equal(ui.button('Save Changes').disabled, true)
  })
})
