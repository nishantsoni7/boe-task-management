/**
 * THE BANK SECTION OF THE PAYMENT WINDOW — behaviour, run for real in a DOM.
 *
 * Where an HDFC payment is verified: what a person can press, and exactly what each
 * press sends. The rules behind it are the database's
 * (supabase/tests/bank_proof_before_verify_pglite.mjs proves them).
 *
 * Run: npm run test:file -- src/app/finance/bankMarkUi.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BANK_CHECK_ACTION, BANK_CHECK_DEFAULT_REASON, BankMatchPanel, bankMarkText } from './bankMarkUi'
import { deriveBankMarks, type BankMark, type MarkLine, type MarkLink, type MarkPayment } from '@/lib/finance/bankMarks'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const pay = (over: Partial<MarkPayment> = {}): MarkPayment => ({
  id: 'P1', human_payment_id: 'P-ZZ-0101', client_name: 'Sample Hotels LLP', amount: 375000, remaining: 375000,
  payment_date: '2026-10-06', payment_mode: 'hdfc', proof_note: 'SAMP26279000111', status: 'pending_approval', ...over,
})
const credit = (over: Partial<MarkLine> = {}): MarkLine => ({
  id: 'L1', account: 'hdfc', line_date: '2026-10-06',
  narration: 'NEFT CR-SAMP0000111-SAMPLE HOTELS LLP-BEST OF EXPORTS-SAMP26279000111',
  bank_ref: 'SAMP26279000111', deposit: 375000, linkedAmount: 0, ...over,
})
const other = (over: Partial<MarkLine> = {}) => credit({
  id: 'L2', line_date: '2026-10-07', narration: 'NEFT CR-SAMP0000222-DEMO FOODS PVT LTD-BEST OF EXPORTS-SAMP26280000222',
  bank_ref: 'SAMP26280000222', ...over,
})
const COVER = { hdfc: { first: '2026-09-01', last: '2026-10-28' } }
const markFor = (p: MarkPayment, lines: MarkLine[], links: MarkLink[] = []): BankMark => deriveBankMarks([p], links, lines, COVER).get(p.id)!

function open(p: MarkPayment, mark: BankMark | undefined, opts: { canVerify?: boolean; urgent?: boolean; refuse?: string; label?: string; failed?: boolean } = {}) {
  const sent: { fn: string; args: unknown }[] = []
  let verified = 0
  let changed = 0
  const supabase = {
    rpc: async (fn: string, args: unknown) => {
      sent.push({ fn, args })
      return { data: null, error: opts.refuse ? { message: opts.refuse } : null }
    },
  } as unknown as SupabaseClient
  const ui = mount(
    <BankMatchPanel
      supabase={supabase}
      payment={p}
      mark={mark}
      markFailed={opts.failed}
      canVerify={opts.canVerify ?? true}
      canVerifyUrgent={opts.urgent ?? false}
      confirmLabel={opts.label}
      onChanged={() => { changed++ }}
      onVerified={() => { verified++ }}
    />,
  )
  cleanup = () => ui.unmount()
  return { ui, sent, verified: () => verified, changed: () => changed }
}

const primary = (ui: ReturnType<typeof open>['ui']) => ui.all('.boe-btn-primary').map(b => (b.textContent ?? '').trim())

describe('verifying against the bank', () => {
  test('one clean match: the request and the credit side by side, and one press sends the credit and verifies', async () => {
    const p = pay()
    const { ui, sent, verified } = open(p, markFor(p, [credit()]))
    for (const row of ['Amount', 'Date', 'Account', 'Name', 'UTR']) assert.ok(ui.text().includes(row), row)
    assert.deepEqual(primary(ui), ['Verify'])
    ui.click(ui.button('Verify'))
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'verify_payment_with_bank', args: { p_payment_id: 'P1', p_line_ids: ['L1'] } }])
    assert.equal(verified(), 1)
  })

  test('a payment already fully linked verifies with no credit to name', async () => {
    const p = pay()
    const links = [{ payment_id: 'P1', line_id: 'L1', amount: 375000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' as const }]
    const { ui, sent } = open(p, markFor(p, [credit({ linkedAmount: 375000 })], links))
    ui.click(ui.button('Verify'))
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'verify_payment_with_bank', args: { p_payment_id: 'P1', p_line_ids: [] } }])
  })

  test('a refusal stays on the window, in a sentence, and nothing is announced', async () => {
    const p = pay()
    const { ui, verified } = open(p, markFor(p, [credit()]), { refuse: 'BANK_LINE_OVER_LINKED: this credit is already fully linked' })
    ui.click(ui.button('Verify'))
    await ui.settle()
    assert.equal(verified(), 0)
    assert.match(ui.one('[role="alert"]').textContent ?? '', /already used by another payment/)
  })

  test('without the right to verify there is no Verify button, only the link', async () => {
    const p = pay()
    const { ui, sent, changed } = open(p, markFor(p, [credit()]), { canVerify: false, label: 'Confirm match' })
    assert.deepEqual(primary(ui), [])
    ui.click(ui.button('Confirm match'))
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'link_bank_line_to_payment', args: { p_line_id: 'L1', p_payment_id: 'P1' } }])
    assert.equal(changed(), 1)
  })
})

describe('a credit that does not plainly fit never gets the red button', () => {
  test('no UTR and two credits of the same amount: the best is red, the other asks first', async () => {
    const p = pay({ proof_note: null })
    const { ui, sent } = open(p, markFor(p, [credit({ bank_ref: null, narration: 'NEFT CR-SAMPLE HOTELS LLP-BEST OF EXPORTS' }), other({ bank_ref: null, narration: 'NEFT CR-DEMO FOODS PVT LTD-BEST OF EXPORTS' })]))
    assert.ok(ui.text().includes('More than one credit fits'))
    assert.deepEqual(primary(ui), ['Verify'])
    ui.click(ui.button('Use this one anyway'))
    assert.deepEqual(sent, [], 'one press on a doubtful credit sends nothing')
    ui.click(ui.button('Yes, verify with this credit'))
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'verify_payment_with_bank', args: { p_payment_id: 'P1', p_line_ids: ['L2'] } }])
  })

  test('a name that does not fit is said, and the single match asks first too', () => {
    const p = pay({ client_name: 'Another Client', proof_note: null })
    const { ui } = open(p, markFor(p, [credit({ bank_ref: null })]))
    assert.ok(ui.text().includes('Check first: the name does not match.'))
    assert.deepEqual(primary(ui), [])
  })

  test('the other HDFC account offers no way to verify: the payment is corrected first', () => {
    const p = pay({ payment_mode: 'hdfc_sec' })
    const { ui } = open(p, markFor(p, [credit()]))
    assert.ok(ui.text().includes('Correct the payment'))
    assert.equal(ui.all('button').filter(b => /Verify|anyway/.test(b.textContent ?? '')).length, 0)
  })
})

describe('part of the money', () => {
  test('a smaller credit from the client links as a part, and verifies nothing', async () => {
    const p = pay({ amount: 500000, remaining: 500000, proof_note: null })
    const { ui, sent } = open(p, markFor(p, [credit({ deposit: 300000, bank_ref: null })]))
    assert.ok(ui.text().includes('₹2,00,000.00 short'))
    ui.click(ui.button('Link this part'))
    await ui.settle()
    assert.equal(sent[0].fn, 'link_bank_line_to_payment')
  })

  test('with one part linked it says what is left and offers the rest', () => {
    const p = pay({ amount: 500000, remaining: 500000, proof_note: null })
    const links = [{ payment_id: 'P1', line_id: 'L1', amount: 300000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' as const }]
    const { ui } = open(p, markFor(p, [credit({ deposit: 300000, linkedAmount: 300000, bank_ref: null }), other({ deposit: 200000, bank_ref: null, narration: 'NEFT CR-SAMPLE HOTELS LLP-BEST OF EXPORTS' })], links))
    assert.ok(ui.text().includes('₹2,00,000.00 of this payment still needs a bank credit.'))
    assert.deepEqual(primary(ui), ['Verify'])
  })

  test('a credit a little short of the payment says how to finish it', () => {
    const p = pay({ amount: 100000, remaining: 100000, proof_note: null })
    const { ui } = open(p, markFor(p, [credit({ deposit: 99950, bank_ref: null })]))
    assert.ok(ui.text().includes('edit this payment to ₹99,950.00'))
  })

  test('with part already linked it quotes the whole payment, not just this credit', () => {
    const p = pay({ amount: 100000, remaining: 100000, proof_note: null })
    const links = [{ payment_id: 'P1', line_id: 'L1', amount: 60000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' as const }]
    const { ui } = open(p, markFor(p, [credit({ deposit: 60000, linkedAmount: 60000, bank_ref: null }), other({ deposit: 39900, bank_ref: null, narration: 'NEFT CR-SAMPLE HOTELS LLP-BEST OF EXPORTS' })], links))
    assert.ok(ui.text().includes('edit this payment to ₹99,900.00'))
  })

  test('the list says the difference', () => {
    const p = pay({ amount: 100000, remaining: 100000, proof_note: null })
    assert.equal(bankMarkText(markFor(p, [credit({ deposit: 99950, bank_ref: null })])).text, '₹50.00 less in the bank')
  })
})

describe('Verify, bank check pending', () => {
  test('nothing in the bank yet: an admin sees it at once, with a reason ready, and it is not the red button', async () => {
    const p = pay()
    const { ui, sent, verified } = open(p, { kind: 'uncovered' }, { urgent: true })
    assert.equal(ui.one<HTMLInputElement>('.bank-form input').value, BANK_CHECK_DEFAULT_REASON)
    assert.deepEqual(primary(ui), [])
    ui.click(ui.button(BANK_CHECK_ACTION))
    await ui.settle()
    assert.deepEqual(sent, [{ fn: 'verify_payment_bank_check_pending', args: { p_payment_id: 'P1', p_reason: BANK_CHECK_DEFAULT_REASON } }])
    assert.equal(verified(), 1)
  })

  test('a reason is needed', () => {
    const { ui } = open(pay(), { kind: 'none' }, { urgent: true })
    ui.type(ui.one<HTMLInputElement>('.bank-form input'), '  ')
    assert.equal(ui.button(BANK_CHECK_ACTION).disabled, true)
  })

  test('with a match on the window it stays out of the way until asked for', () => {
    const p = pay()
    const { ui } = open(p, markFor(p, [credit()]), { urgent: true })
    assert.equal(ui.all('.bank-form').length, 0)
    ui.click(ui.button('The money is in the bank but not on a statement yet'))
    assert.equal(ui.all('.bank-form').length, 1)
  })

  test('nobody else is offered it', () => {
    const { ui } = open(pay(), { kind: 'uncovered' }, { urgent: false })
    assert.equal(ui.all('.bank-form').length, 0)
  })

  test('a payment already covered has nothing to wait for', () => {
    const p = pay()
    const links = [{ payment_id: 'P1', line_id: 'L1', amount: 375000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' as const }]
    const { ui } = open(p, markFor(p, [credit({ linkedAmount: 375000 })], links), { urgent: true })
    assert.equal(ui.all('.bank-form').length, 0)
  })
})

describe('no match', () => {
  test('a look-alike says it cannot be verified as it stands', () => {
    const { ui } = open(pay(), { kind: 'lookalike', lineDate: '2026-10-06', deposit: 375000, narration: 'NEFT' })
    assert.ok(ui.text().includes('May be a duplicate.'))
    assert.ok(ui.text().includes('cannot be verified'))
    assert.deepEqual(primary(ui), [])
  })

  test('a cash payment draws nothing', () => {
    const { ui } = open(pay({ payment_mode: 'paytm' }), undefined)
    assert.equal(ui.all('.bank-panel').length, 0)
  })

  test('an HDFC payment is never left blank: it says it is reading, or that the read failed', () => {
    const reading = open(pay(), undefined)
    assert.ok(reading.ui.text().includes('Reading the bank statement'))
    reading.ui.unmount(); cleanup = null
    const failed = open(pay(), undefined, { failed: true })
    assert.match(failed.ui.one('[role="alert"]').textContent ?? '', /could not be read/)
  })

  test('nothing on a statement says how to bring in a bigger transfer', () => {
    const { ui } = open(pay(), { kind: 'none' })
    assert.ok(ui.text().includes('add the UTR to this payment'))
  })

  test('a link in the other account says what to do, and an admin can still go on', () => {
    const p = pay({ payment_mode: 'hdfc_sec' })
    const links = [{ payment_id: 'P1', line_id: 'L1', amount: 375000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' as const }]
    const { ui } = open(p, markFor(p, [credit({ linkedAmount: 375000 })], links), { urgent: true })
    assert.ok(ui.text().includes('in the other HDFC account'))
    assert.deepEqual(primary(ui), [])
    assert.equal(ui.all('.bank-form').length, 1)
  })
})
