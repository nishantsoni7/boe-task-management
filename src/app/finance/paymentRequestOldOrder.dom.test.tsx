/**
 * PAYMENT REQUEST and EDIT PAYMENT REQUEST — the Old Order destination
 * (20270607000000), run for real in a DOM.
 *
 * Sales send money for approval. An order that predates BOE One is not a record
 * anyone can pick, so the fourth card asks for its number and its client, and
 * the request goes to the database as destination 'old_order' with those two
 * facts. Every other destination is sent exactly as before.
 *
 * Run: npm run test:file -- src/app/finance/paymentRequestOldOrder.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { NewPaymentConfirmationModal } from './paymentRequestsNew'
import { EditPaymentModal } from './paymentRequestsEdit'

type Call = { name: string; args: Record<string, unknown> }

type FakeOptions = { intents?: Record<string, unknown>[] }

function fakeClient(opts: FakeOptions = {}) {
  const calls: Call[] = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      if (name === 'submit_payment_request') {
        return {
          data: { payment_request_id: 'pay-1', request_number: 'PAY-REQ-1', client_name: String(args.p_legacy_client_name ?? 'Kalyan Interiors') },
          error: null,
        }
      }
      if (name === 'edit_payment_request') return { data: { client_name: String(args.p_legacy_client_name ?? '') }, error: null }
      if (name === 'finance_payment_cash_locks') return { data: [], error: null }
      return { data: null, error: null }
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'or', 'in', 'order', 'limit', 'eq', 'not']) chain[m] = () => chain
      chain.maybeSingle = async () => ({ data: null, error: null })
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === 'finance_payment_allocation_intents' ? (opts.intents ?? []) : [], error: null })
      return chain
    },
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  }
  return { client: client as never, calls }
}

const realFetch = globalThis.fetch
beforeEach(() => {
  // notifyFinance posts to a relative URL; there is no server here.
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never
})
let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null; globalThis.fetch = realFetch })

// The destination cards, not the payment-mode radios beside them.
const CARD = '.boe-destination-card'
const radio = (ui: ReturnType<typeof mount>, text: RegExp) =>
  ui.all<HTMLButtonElement>(CARD).find(b => text.test(b.textContent ?? ''))!

function openNew() {
  const fake = fakeClient()
  let saved = 0
  const ui = mount(createElement(NewPaymentConfirmationModal, {
    userId: 'u1', supabase: fake.client, onClose: () => {}, onSaved: () => { saved += 1 },
  }))
  cleanup = () => ui.unmount()
  const sends = () => fake.calls.filter(c => c.name === 'submit_payment_request')
  return { ui, fake, sends, saved: () => saved }
}

function oldOrderFields(ui: ReturnType<typeof mount>) {
  const byLabel = (label: RegExp) => {
    const l = ui.all<HTMLLabelElement>('label').find(x => label.test(x.textContent ?? ''))
    return l ? (document.getElementById(l.htmlFor) as HTMLInputElement | null) ?? undefined : undefined
  }
  return { number: byLabel(/Old order number/), client: byLabel(/^Client/) }
}

describe('Send Payment Request with an Old Order', () => {
  test('four cards, Old Order last; its two fields appear only once it is chosen', async () => {
    const { ui } = openNew()
    await ui.settle()
    const cards = ui.all<HTMLButtonElement>(CARD).map(b => (b.textContent ?? '').trim())
    assert.equal(cards.length, 4)
    assert.match(cards[0], /PI Draft/)
    assert.match(cards[1], /Confirmed Order/)
    assert.match(cards[2], /Suspense Entry/)
    assert.match(cards[3], /Old Order/)
    assert.equal(oldOrderFields(ui).number, undefined, 'nothing to type before the card is chosen')

    ui.click(radio(ui, /Old Order/))
    assert.ok(oldOrderFields(ui).number, 'the old order number field')
    assert.ok(oldOrderFields(ui).client, 'the client field')
    assert.match(ui.text(), /not in BOE One/)
    assert.equal(ui.all('input[placeholder^="Search PI number"]').length, 0, 'there is no record to search for')
  })

  test('an unfinished Old Order request names what is missing and sends nothing', async () => {
    const { ui, sends } = openNew()
    await ui.settle()
    ui.click(radio(ui, /Old Order/))
    ui.click(ui.button('Submit Request'))
    assert.equal(sends().length, 0)
    assert.match(ui.text(), /Enter the old order number\./)
    assert.match(ui.text(), /Enter the client the old order belongs to\./)
    assert.ok(ui.all('[role="alert"]').length >= 2)
  })

  test('type the number and client, the amount and the date, press once: one call with the old order and no record id', async () => {
    const { ui, fake, sends, saved } = openNew()
    await ui.settle()
    ui.click(radio(ui, /Old Order/))
    const f = oldOrderFields(ui)
    ui.type(f.number!, ' ab-12 ')
    ui.type(f.client!, 'Mehta   Furnishings ')
    ui.type(ui.all<HTMLInputElement>('input[inputmode="decimal"]')[0], '5000')
    ui.click(ui.button('Today'))

    ui.click(ui.button('Submit Request'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args
    assert.equal(sent.p_destination, 'old_order')
    assert.equal(sent.p_target_id, null, 'an old order names no PI Draft and no Order')
    assert.equal(sent.p_legacy_order_no, 'AB-12', 'the number goes in its normal form')
    assert.equal(sent.p_legacy_client_name, 'Mehta Furnishings')
    assert.equal(sent.p_amount, 5000)
    assert.equal('p_client_name' in sent, false, 'no other customer is sent')
    assert.ok(fake.calls.some(c => c.name === 'complete_payment_entry'), 'the last call is still made')
    await ui.settle()
    assert.equal(saved(), 1)
  })

  test('a PI Draft request carries no old-order arguments at all', async () => {
    const { ui, sends } = openNew()
    await ui.settle()
    // Suspense needs no record, so it is the shortest way to a complete form.
    ui.click(radio(ui, /Suspense Entry/))
    ui.type(ui.all<HTMLInputElement>('input[inputmode="decimal"]')[0], '700')
    ui.click(ui.button('Today'))
    ui.click(ui.button('Submit Request'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args
    assert.equal(sent.p_destination, 'suspense')
    assert.equal('p_legacy_order_no' in sent, false)
    assert.equal('p_legacy_client_name' in sent, false)
  })

  test('typed old-order facts survive a slip to another card and back', async () => {
    const { ui } = openNew()
    await ui.settle()
    ui.click(radio(ui, /Old Order/))
    ui.type(oldOrderFields(ui).number!, 'K-77')
    ui.type(oldOrderFields(ui).client!, 'Kapoor Hotels')
    ui.click(radio(ui, /Suspense Entry/))
    assert.equal(oldOrderFields(ui).number, undefined)
    ui.click(radio(ui, /Old Order/))
    assert.equal(oldOrderFields(ui).number!.value, 'K-77')
    assert.equal(oldOrderFields(ui).client!.value, 'Kapoor Hotels')
  })
})

describe('Edit Payment Request on an Old Order request', () => {
  const REQUEST = {
    id: 'pay-1', request_number: 'PAY-REQ-1', amount: 5000, payment_date: '2027-06-01',
    proof_note: null, sales_note: null, client_name: 'Mehta Furnishings', payment_mode: 'hdfc',
    status: 'pending_approval', admin_note: null, submitted_by: 'u1',
  }
  const LIVE = {
    id: 'int-2', target_type: 'legacy_order', order_submission_id: null, order_id: null,
    legacy_order_no: 'AB-12', legacy_client_name: 'Mehta Furnishings', intended_amount: 5000, status: 'pending',
  }
  const OLDER_CANCELLED = {
    id: 'int-1', target_type: 'confirmed_order', order_submission_id: null, order_id: 'ord-1',
    legacy_order_no: null, legacy_client_name: null, intended_amount: 5000, status: 'cancelled',
  }

  function openEdit() {
    // Newest first, as the form asks for them: the live one is NOT the first row here
    // only if the oldest were read; either order must land on the pending intent.
    const fake = fakeClient({ intents: [OLDER_CANCELLED, LIVE] })
    let saved = 0
    const ui = mount(createElement(EditPaymentModal, {
      request: REQUEST as never, isAdmin: false, supabase: fake.client,
      onClose: () => {}, onSaved: () => { saved += 1 },
    }))
    cleanup = () => ui.unmount()
    const sends = () => fake.calls.filter(c => c.name === 'edit_payment_request')
    return { ui, sends, saved: () => saved }
  }

  test('opens on the live old-order intent, with its number and client filled in', async () => {
    const { ui } = openEdit()
    await ui.settle()
    const f = oldOrderFields(ui)
    assert.equal(f.number!.value, 'AB-12', 'the pending old order, not the cancelled Order intent')
    assert.equal(f.client!.value, 'Mehta Furnishings')
    assert.equal(ui.all<HTMLButtonElement>(CARD).find(b => b.getAttribute('aria-checked') === 'true')?.textContent?.includes('Old Order'), true)
  })

  test('changing the client and saving sends the old order again, with no record id', async () => {
    const { ui, sends, saved } = openEdit()
    await ui.settle()
    ui.type(oldOrderFields(ui).client!, 'Mehta Furnishing House')
    ui.click(ui.button('Save Changes'))
    await ui.settle()
    assert.equal(sends().length, 1)
    const sent = sends()[0].args
    assert.equal(sent.p_destination, 'old_order')
    assert.equal(sent.p_target_id, null)
    assert.equal(sent.p_legacy_order_no, 'AB-12')
    assert.equal(sent.p_legacy_client_name, 'Mehta Furnishing House')
    await ui.settle()
    assert.equal(saved(), 1)
  })

  test('clearing the number names the problem and saves nothing', async () => {
    const { ui, sends } = openEdit()
    await ui.settle()
    ui.type(oldOrderFields(ui).number!, '   ')
    ui.click(ui.button('Save Changes'))
    assert.equal(sends().length, 0)
    assert.match(ui.text(), /Enter the old order number\./)
  })
})
