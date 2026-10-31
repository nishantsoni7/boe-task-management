/**
 * THE BANK CREDIT WINDOW — behaviour, run for real in a DOM.
 *
 * What a person can press on a credit that may already be recorded, and exactly
 * what each press sends. The rules behind it are the database's
 * (supabase/tests/bank_line_review_pglite.mjs proves them).
 *
 * Run: npm run test:file -- src/app/finance/bank/bankLineModal.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BankLineModal } from './bankLineModal'
import { analyseLine, type BankLine, type BankMatch, type LineReview } from './bankStatementsModel'

// next/link reads `self`, which the DOM harness does not define.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true })

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const credit = (over: Partial<BankLine> = {}): BankLine => ({
  id: 'L1', account: 'hdfc', seq: 1, line_date: '2026-10-06', value_date: null,
  narration: 'RTGS CR-SBIN0000001-SAMPLE TRADERS-BEST OF EXPORTS-SBINR00000000000001', bank_ref: null,
  withdrawal: 0, deposit: 500000, balance: 900000, classification: null, non_customer_kind: null,
  old_order_customer: null, old_order_ref: null, debit_kind: null, debit_payee: null, note: null,
  sync_error: null, bank_line_payment_links: [], bank_line_expense_links: [], ...over,
})

const recorded = (over: Partial<BankMatch> = {}): BankMatch => ({
  paymentId: 'P1', humanPaymentId: 'P-AA-0001', clientName: 'Sample Traders', amount: 500000, leftToLink: 500000,
  paymentDate: '2026-10-06', paymentMode: 'hdfc', proofNote: null, status: 'approved_unlinked', kind: 'amount',
  linkedLinkId: null, linkedLineDate: null, linkedNarration: null, ...over,
})

const heldElsewhere = (over: Partial<BankMatch> = {}) => recorded({
  kind: 'linked_elsewhere', leftToLink: 0, linkedLinkId: 'K9', linkedLineDate: '2026-10-22',
  linkedNarration: 'NEFT CR-KKBK0000958-ANOTHER HOTEL-BEST OF EXPORTS-KKBKH00000000002', ...over,
})

const review = (matches: BankMatch[], over: Partial<LineReview> = {}): LineReview => ({
  issue: 'no_payment', uncovered: 500000, paymentLabel: null, paymentMode: null, matches, ...over,
})

function open(line: BankLine, r: LineReview, refusal: string | null = null) {
  const sent: { fn: string; args: unknown }[] = []
  const changed: [string, boolean | undefined][] = []
  const added: BankMatch[][] = []
  const supabase = {
    rpc: async (fn: string, args: unknown) => {
      sent.push({ fn, args })
      return { data: null, error: refusal ? { message: refusal } : null }
    },
  } as unknown as SupabaseClient
  const ui = mount(
    <BankLineModal
      supabase={supabase}
      item={analyseLine(line, [], [], [], r)}
      payments={[]}
      expenses={[]}
      canAdd
      onAddNew={compared => { added.push(compared) }}
      onClose={() => {}}
      onChanged={(message, close) => { changed.push([message, close]) }}
    />,
  )
  cleanup = () => ui.unmount()
  return { ui, sent, changed, added }
}

const buttonLabels = (ui: ReturnType<typeof open>['ui']) => ui.all('button').map(b => (b.textContent ?? '').trim())

describe('a payment linked to another credit', () => {
  test('names the credit holding it, and offers no Link while it is held', () => {
    const { ui } = open(credit(), review([heldElsewhere()]))
    assert.match(ui.text(), /linked to the credit of 22 Oct 2026 from ANOTHER HOTEL/)
    assert.ok(!buttonLabels(ui).includes('Same payment, link them'))
    assert.ok(ui.button('Unlink it from that credit'))
  })

  test('compares the full amount, not the nothing left to link', () => {
    const { ui } = open(credit(), review([heldElsewhere()]))
    const amount = ui.all('.bank-compare-table tbody tr').find(r => r.textContent?.startsWith('Amount'))!
    assert.match(amount.textContent ?? '', /Same$/)
  })

  test('needs a reason, sends only the link and the reason, and keeps the window open', async () => {
    const { ui, sent, changed } = open(credit(), review([heldElsewhere()]))
    ui.click(ui.button('Unlink it from that credit'))
    const reason = ui.one<HTMLInputElement>('.bank-form input')
    const unlink = () => ui.button('Unlink')
    assert.equal(unlink().disabled, true, 'no reason yet')
    ui.type(reason, 'ab')
    assert.equal(unlink().disabled, true, 'too short')
    ui.type(reason, '  Paid by another customer  ')
    assert.equal(unlink().disabled, false)
    ui.click(unlink())
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'unlink_bank_line_payment', args: { p_link_id: 'K9', p_reason: 'Paid by another customer' } }])
    assert.deepEqual(changed, [['Unlinked. The payment stays recorded.', false]])
  })

  test('a refusal shows why and reports no change', async () => {
    const { ui, changed } = open(credit(), review([heldElsewhere()]), 'BANK_LINK_NOT_FOUND: that link has gone')
    ui.click(ui.button('Unlink it from that credit'))
    ui.type(ui.one<HTMLInputElement>('.bank-form input'), 'Wrong credit')
    ui.click(ui.button('Unlink'))
    await ui.settle()
    assert.match(ui.one('[role="alert"]').textContent ?? '', /that link has gone/)
    assert.deepEqual(changed, [])
  })

  test('Keep the link sends nothing', () => {
    const { ui, sent } = open(credit(), review([heldElsewhere()]))
    ui.click(ui.button('Unlink it from that credit'))
    ui.click(ui.button('Keep the link'))
    assert.equal(ui.all('.bank-form').length, 0)
    assert.deepEqual(sent, [])
  })

  test('a person can still say it is a different payment, naming every payment compared', () => {
    const other = recorded({ paymentId: 'P2', humanPaymentId: 'P-AA-0002', paymentDate: '2026-09-26' })
    const { ui, added } = open(credit(), review([heldElsewhere(), other]))
    ui.click(ui.button('Different payment, add it'))
    assert.deepEqual(added[0].map(m => m.paymentId), ['P1', 'P2'])
  })
})

describe('the other cards', () => {
  test('the same money links, without an amount, and closes the window', async () => {
    const { ui, sent, changed } = open(credit(), review([recorded()]))
    ui.click(ui.button('Same payment, link them'))
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'link_bank_line_to_payment', args: { p_line_id: 'L1', p_payment_id: 'P1' } }])
    assert.equal(changed[0][1], true)
  })

  test('a bank reference on a payment with room can only be linked', () => {
    const { ui } = open(credit(), review([recorded({ kind: 'reference' })]))
    assert.ok(ui.button('Same payment, link them'))
    assert.ok(!buttonLabels(ui).includes('Different payment, add it'))
  })

  test('a reference on a payment fully linked elsewhere offers neither Link nor Unlink', () => {
    const { ui } = open(credit(), review([recorded({ kind: 'reference_used', leftToLink: 0 })]))
    assert.ok(!buttonLabels(ui).includes('Same payment, link them'))
    assert.ok(!buttonLabels(ui).includes('Unlink it from that credit'))
    assert.ok(ui.button('Different payment, add it'))
  })

  test('a credit\'s own link is still unlinked from its own section', async () => {
    const line = credit({ bank_line_payment_links: [{ id: 'K1', payment_id: 'P1', amount: 500000, unlinked_at: null }] })
    const { ui, sent } = open(line, review([], { issue: 'amount_changed', paymentLabel: 'P-AA-0001' }))
    ui.click(ui.button('Unlink'))
    ui.type(ui.one<HTMLInputElement>('.bank-form input'), 'Wrong payment')
    ui.click(ui.all<HTMLButtonElement>('.bank-form button').find(b => b.textContent === 'Unlink')!)
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'unlink_bank_line_payment', args: { p_link_id: 'K1', p_reason: 'Wrong payment' } }])
  })
})
