import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveBankMarks, isBankCheckable, type MarkLine, type MarkLink, type MarkPayment } from './bankMarks'
import { suggestLinesForPayment } from './bankMatching'

const pay = (over: Partial<MarkPayment>): MarkPayment => ({
  id: 'P1', human_payment_id: 'P-AA-0001', client_name: 'Green Sky Hospitality LLP', amount: 50000, remaining: 50000,
  payment_date: '2026-10-05', payment_mode: 'hdfc', proof_note: null, status: 'pending_approval', ...over,
})
const line = (over: Partial<MarkLine>): MarkLine => ({
  id: 'L1', account: 'hdfc', line_date: '2026-10-06',
  narration: 'NEFT CR-KKBK0000958-GREEN SKY HOSPITALITY LLP-BEST OF EXPORTS JODHPUR-KKBKH26279861023',
  bank_ref: 'KKBKH26279861023', deposit: 50000, linkedAmount: 0, ...over,
})
const COVER = { hdfc: { first: '2026-08-01', last: '2026-10-19' } }
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

describe('deriveBankMarks', () => {
  test('a payment that matches a credit is marked suggested, with the credit and the reasons', () => {
    const m = deriveBankMarks([pay({})], [], [line({})], COVER).get('P1')!
    assert.equal(m.kind, 'suggested')
    if (m.kind !== 'suggested') return
    assert.equal(m.candidates[0].lineId, 'L1')
    assert.equal(m.candidates[0].confidence, 'strong')
    assert.ok(m.candidates[0].reasons.includes('Exact amount'))
  })

  test('a payment already linked says so, and says whether the link is complete', () => {
    const links: MarkLink[] = [{ payment_id: 'P1', line_id: 'L1', amount: 50000, line_date: '2026-10-06', narration: 'x' }]
    const full = deriveBankMarks([pay({})], links, [line({ linkedAmount: 50000 })], COVER).get('P1')!
    assert.deepEqual(full.kind === 'linked' && full.complete, true)
    const part = deriveBankMarks([pay({ amount: 80000, remaining: 80000 })], links, [], COVER).get('P1')!
    assert.deepEqual(part.kind === 'linked' && part.complete, false)
  })

  test('a credit already used up by another payment is not offered again', () => {
    const m = deriveBankMarks([pay({})], [], [line({ linkedAmount: 50000 })], COVER).get('P1')!
    assert.equal(m.kind, 'none')
  })

  test('no match inside the stored statements is "none"; outside them it is "uncovered", never a false alarm', () => {
    assert.equal(deriveBankMarks([pay({})], [], [], COVER).get('P1')!.kind, 'none')
    assert.equal(deriveBankMarks([pay({ payment_date: '2026-10-25' })], [], [], COVER).get('P1')!.kind, 'uncovered')
    assert.equal(deriveBankMarks([pay({ payment_date: '2026-05-01' })], [], [], COVER).get('P1')!.kind, 'uncovered')
    assert.equal(deriveBankMarks([pay({ payment_mode: 'hdfc_sec' })], [], [], COVER).get('P1')!.kind, 'uncovered')
  })

  test('only HDFC payments that are not rejected are looked for in the bank', () => {
    for (const mode of ['pnb', 'paytm', 'canara', 'cash', 'upi']) {
      assert.equal(isBankCheckable({ payment_mode: mode, status: 'pending_approval' }), false)
      assert.equal(deriveBankMarks([pay({ payment_mode: mode })], [], [line({})], COVER).has('P1'), false)
    }
    assert.equal(deriveBankMarks([pay({ status: 'rejected' })], [], [line({})], COVER).has('P1'), false)
    assert.equal(isBankCheckable({ payment_mode: 'hdfc', status: 'approved_unlinked' }), true)
  })

  test('the same payment and credit score the same in both directions', () => {
    const [s] = suggestLinesForPayment(pay({}), [{
      id: 'L1', account: 'hdfc', line_date: '2026-10-06', narration: line({}).narration, bank_ref: 'KKBKH26279861023', remaining: 50000,
    }])
    assert.equal(s.confidence, 'strong')
  })
})

describe('the marker is information for reconcilers only, and never a decision', () => {
  test('the page loads and draws marks only for finance.reconcile', () => {
    const src = read('src/app/finance/page.tsx')
    assert.ok(src.includes('caps.canReconcileBank ? visible : []'))
    assert.ok(src.includes('const bankMarks = caps.canReconcileBank &&'))
  })

  test('the marker files call no verification, rejection, edit or allocation RPC and write no table', () => {
    for (const f of ['src/app/finance/bankMarkUi.tsx', 'src/lib/finance/bankMarks.ts']) {
      const src = read(f)
      for (const rpc of ['approve_finance_payment_request', 'reject_finance_payment_request', 'request_finance_payment_clarification',
        'allocate_payment_to_target', 'edit_payment_request', 'complete_payment_entry']) {
        assert.ok(!src.includes(rpc), `${f} must not call ${rpc}`)
      }
      assert.ok(!/\.(insert|update|delete|upsert)\(/.test(src), `${f} writes a table directly`)
      for (const m of src.matchAll(/\.rpc\('([a-z_]+)'/g)) assert.equal(m[1], 'link_bank_line_to_payment')
    }
  })

  test('the payment popup only draws the slot it is handed', () => {
    const src = read('src/app/finance/paymentRequestsDetails.tsx')
    assert.ok(src.includes('{bankPanel}'))
    assert.ok(!src.includes('bank_statement'))
  })
})
