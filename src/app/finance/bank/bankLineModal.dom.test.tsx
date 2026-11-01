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

/** `refusals` names the door that says no, and what it says. */
function open(line: BankLine, r: LineReview, refusals: Record<string, string> = {}) {
  const sent: { fn: string; args: unknown }[] = []
  const changed: [string, boolean | undefined][] = []
  const recorded_: number[] = []
  const supabase = {
    rpc: async (fn: string, args: unknown) => {
      sent.push({ fn, args })
      return { data: null, error: refusals[fn] ? { message: refusals[fn] } : null }
    },
  } as unknown as SupabaseClient
  const modal = (l: BankLine, rv: LineReview) => (
    <BankLineModal
      supabase={supabase}
      item={analyseLine(l, [], [], [], rv)}
      payments={[]}
      expenses={[]}
      canAdd
      onRecord={() => { recorded_.push(1) }}
      onClose={() => {}}
      onChanged={(message, close) => { changed.push([message, close]) }}
    />
  )
  const ui = mount(modal(line, r))
  cleanup = () => ui.unmount()
  /** What the page does after a reload: the same window, handed fresh data. */
  const show = (l: BankLine, rv: LineReview) => ui.render(modal(l, rv))
  return { ui, sent, changed, recorded_, show }
}

const buttonLabels = (ui: ReturnType<typeof open>['ui']) => ui.all('button').map(b => (b.textContent ?? '').trim())

const primaryLabels = (ui: ReturnType<typeof open>['ui']) => ui.all('.boe-btn-primary').map(b => (b.textContent ?? '').trim())

describe('a payment linked to another credit', () => {
  test('names the credit holding it, and offers Move, not Link, while it is held', () => {
    const { ui } = open(credit(), review([heldElsewhere()]))
    assert.match(ui.text(), /linked to the credit of 22 Oct 2026 from ANOTHER HOTEL/)
    assert.ok(!buttonLabels(ui).includes('Same payment, link them'))
    assert.ok(ui.button('Move this payment here'))
  })

  test('compares the full amount, not the nothing left to link', () => {
    const { ui } = open(credit(), review([heldElsewhere()]))
    const amount = ui.all('.bank-compare-table tbody tr').find(r => r.textContent?.startsWith('Amount'))!
    assert.match(amount.textContent ?? '', /Same$/)
  })

  test('needs a reason, then takes it off the other credit and links it here, in that order, and closes', async () => {
    const { ui, sent, changed } = open(credit(), review([heldElsewhere()]))
    ui.click(ui.button('Move this payment here'))
    const reason = ui.one<HTMLInputElement>('.bank-form input')
    const move = () => ui.button('Move it here')
    assert.equal(move().disabled, true, 'no reason yet')
    ui.type(reason, 'ab')
    assert.equal(move().disabled, true, 'too short')
    ui.type(reason, '  Paid by another customer  ')
    assert.equal(move().disabled, false)
    ui.click(move())
    await ui.settle()
    assert.deepEqual(sent, [
      { fn: 'unlink_bank_line_payment', args: { p_link_id: 'K9', p_reason: 'Paid by another customer' } },
      { fn: 'link_bank_line_to_payment', args: { p_line_id: 'L1', p_payment_id: 'P1' } },
    ])
    assert.deepEqual(changed, [['Moved P-AA-0001 to this credit', true]])
  })

  test('the reason box opens inside its own card, above the next one', () => {
    const other = recorded({ paymentId: 'P2', humanPaymentId: 'P-AA-0002', paymentDate: '2026-09-26' })
    const { ui } = open(credit(), review([heldElsewhere(), other]))
    ui.click(ui.button('Move this payment here'))
    const [first, second] = ui.all('.bank-compare')
    assert.ok(first.querySelector('.bank-form input'), 'in the card that asked')
    assert.equal(second.querySelector('.bank-form'), null)
  })

  test('if the unlink is refused, nothing is linked and the card says why', async () => {
    const { ui, sent, changed } = open(credit(), review([heldElsewhere()]), { unlink_bank_line_payment: 'BANK_LINK_NOT_FOUND: that link has gone' })
    ui.click(ui.button('Move this payment here'))
    ui.type(ui.one<HTMLInputElement>('.bank-form input'), 'Wrong credit')
    ui.click(ui.button('Move it here'))
    await ui.settle()
    assert.deepEqual(sent.map(s => s.fn), ['unlink_bank_line_payment'])
    assert.match(ui.one('.bank-compare [role="alert"]').textContent ?? '', /that link has gone/)
    assert.deepEqual(changed, [])
  })

  test('if the link is refused after the unlink, it says where the payment stands and the card offers the link', async () => {
    const line = credit()
    const { ui, changed, show } = open(line, review([heldElsewhere()]), { link_bank_line_to_payment: 'BANK_LINE_OVER_LINKED: this credit is already fully linked' })
    ui.click(ui.button('Move this payment here'))
    ui.type(ui.one<HTMLInputElement>('.bank-form input'), 'Wrong credit')
    ui.click(ui.button('Move it here'))
    await ui.settle()
    assert.deepEqual(changed, [['Unlinked. The payment stays recorded.', false]])
    // The page reloads: the payment is free now, an ordinary match on the same card.
    show(line, review([recorded()]))
    assert.match(ui.one('.bank-compare [role="alert"]').textContent ?? '', /^P-AA-0001 came off the other credit but did not link here: this credit is already fully linked/)
    assert.ok(ui.button('Yes, link them'))
    assert.equal(ui.all('.bank-form input').length, 0, 'no second reason')
  })

  test('Keep the link sends nothing', () => {
    const { ui, sent } = open(credit(), review([heldElsewhere()]))
    ui.click(ui.button('Move this payment here'))
    ui.click(ui.button('Keep the link'))
    assert.equal(ui.all('.bank-form').length, 0)
    assert.deepEqual(sent, [])
  })

  test('a person can still say it is a different payment: that opens the form and adds nothing here', () => {
    const other = recorded({ paymentId: 'P2', humanPaymentId: 'P-AA-0002', paymentDate: '2026-09-26' })
    const { ui, recorded_, sent } = open(credit(), review([heldElsewhere(), other]))
    ui.click(ui.button('Different payment, record it'))
    assert.equal(recorded_.length, 1)
    assert.deepEqual(sent, [])
  })

  test('a credit nobody recorded says so and offers Record it', () => {
    const { ui, recorded_, sent } = open(credit(), review([]))
    assert.ok((ui.container.textContent ?? '').includes('No request yet'))
    ui.click(ui.button('Record it'))
    assert.equal(recorded_.length, 1)
    assert.deepEqual(sent, [])
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
    assert.ok(!buttonLabels(ui).includes('Different payment, record it'))
  })

  test('a reference on a payment fully linked elsewhere offers neither Link nor Move', () => {
    const { ui } = open(credit(), review([recorded({ kind: 'reference_used', leftToLink: 0 })]))
    assert.ok(!buttonLabels(ui).includes('Same payment, link them'))
    assert.ok(!buttonLabels(ui).includes('Move this payment here'))
    assert.ok(ui.button('Different payment, record it'))
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

describe('a match with a doubt', () => {
  const wrongName = () => recorded({ paymentId: 'P2', humanPaymentId: 'P-AA-0002', clientName: 'Unrelated Hotel' })
  const tenDaysOff = () => recorded({ paymentId: 'P2', humanPaymentId: 'P-AA-0002', paymentDate: '2026-09-26' })

  test('the case that started this: the right payment is red, the wrong one is not', () => {
    const wrong = recorded({ paymentId: 'P2', humanPaymentId: 'P-AA-0002', clientName: 'Unrelated Hotel', paymentDate: '2026-09-26' })
    const { ui } = open(credit(), review([heldElsewhere(), wrong]))
    assert.deepEqual(primaryLabels(ui), ['Move this payment here'])
    const [, second] = ui.all('.bank-compare')
    assert.match(second.textContent ?? '', /Check first: the name does not match and the dates are 10 days apart\./)
    assert.ok(ui.button('Link anyway'))
  })

  for (const [what, match] of [['a name that does not match', wrongName], ['dates over 3 days apart', tenDaysOff]] as const) {
    test(`${what}: not red, one press sends nothing, and the question links it`, async () => {
      const { ui, sent, changed } = open(credit(), review([match()]))
      assert.deepEqual(primaryLabels(ui), [])
      assert.ok(!buttonLabels(ui).includes('Same payment, link them'))
      ui.click(ui.button('Link anyway'))
      assert.deepEqual(sent, [])
      assert.deepEqual(primaryLabels(ui), [], 'the question is not red either')
      ui.click(ui.button('Yes, link them'))
      await ui.settle()
      assert.deepEqual(sent, [{ fn: 'link_bank_line_to_payment', args: { p_line_id: 'L1', p_payment_id: 'P2' } }])
      assert.equal(changed[0][1], true)
    })
  }

  test('Keep it unlinked sends nothing and puts the button back', () => {
    const { ui, sent } = open(credit(), review([wrongName()]))
    ui.click(ui.button('Link anyway'))
    ui.click(ui.button('Keep it unlinked'))
    assert.deepEqual(sent, [])
    assert.ok(ui.button('Link anyway'))
  })

  test('a refusal shows on the card that asked', async () => {
    const { ui } = open(credit(), review([wrongName()]), { link_bank_line_to_payment: 'BANK_PAYMENT_OVER_LINKED: this payment is already fully linked' })
    ui.click(ui.button('Link anyway'))
    ui.click(ui.button('Yes, link them'))
    await ui.settle()
    assert.match(ui.one('.bank-compare [role="alert"]').textContent ?? '', /already fully linked/)
    assert.equal(ui.all('[role="alert"]').length, 1)
  })

  test('a payment held elsewhere with a doubt moves only on purpose, and never in red', async () => {
    const { ui, sent } = open(credit(), review([heldElsewhere({ clientName: 'Unrelated Hotel' })]))
    assert.deepEqual(primaryLabels(ui), [])
    ui.click(ui.button('Move anyway'))
    ui.type(ui.one<HTMLInputElement>('.bank-form input'), 'Wrong credit')
    assert.deepEqual(primaryLabels(ui), [])
    ui.click(ui.button('Move it here'))
    await ui.settle()
    assert.deepEqual(sent.map(s => s.fn), ['unlink_bank_line_payment', 'link_bank_line_to_payment'])
  })

  test('3 days apart and a partly matching name are still one press', () => {
    const { ui } = open(credit(), review([recorded({ clientName: 'Sample Exports', paymentDate: '2026-10-03' })]))
    assert.deepEqual(primaryLabels(ui), ['Same payment, link them'])
  })

  test('the bank\'s own reference outweighs a name and a date', () => {
    const { ui } = open(credit(), review([recorded({ kind: 'reference', clientName: 'Unrelated Hotel', paymentDate: '2026-09-26' })]))
    assert.deepEqual(primaryLabels(ui), ['Same payment, link them'])
    assert.ok(!ui.text().includes('Check first'))
  })
})
