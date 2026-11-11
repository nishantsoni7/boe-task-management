/**
 * CANARA (owner 2026-11-11): the recorder gives the paying account (holder and
 * number required, bank optional), saved as lines at the top of the note to
 * Finance. Later the same day the owner brought the handover journey back: Canara
 * asks "Where is this money now?" like PNB and Paytm (20270612000000), and the
 * payment is Confirmed when the company cash custodian accepts it.
 *
 * Run:
 *   npm run test:file -- src/lib/finance/canaraAccount.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EMPTY_CANARA_ACCOUNT,
  canaraAccountIsComplete,
  canaraAccountProblems,
  composeCanaraNote,
  isCanaraMode,
} from './canaraAccount'
import { cashStateLabel, readCashPayment } from './cashJourney'
import { readHandoverCandidates } from './handover'
import { modeAsksWhereMoneyIs, modeRequiresCustodyTrail } from './paymentEntry'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const acct = (over: Partial<typeof EMPTY_CANARA_ACCOUNT> = {}) => ({ holder: 'Sumeet Babar', number: '1234 5678 9012', bank: '', ...over })

describe('which modes ask the question', () => {
  test('PNB, Paytm and Canara ask; the HDFC accounts do not', () => {
    for (const m of ['pnb', 'paytm', 'canara']) assert.equal(modeAsksWhereMoneyIs(m), true, m)
    for (const m of ['hdfc', 'hdfc_sec', '', null, undefined]) assert.equal(modeAsksWhereMoneyIs(m), false, String(m))
  })
  test('Canara is tracked until the company accepts it', () => {
    assert.equal(modeRequiresCustodyTrail('canara'), true)
    assert.equal(isCanaraMode(' canara '), true)
    assert.equal(isCanaraMode('pnb'), false)
  })
})

describe('the account the money came from', () => {
  test('holder and number are required; bank is not', () => {
    assert.deepEqual(Object.keys(canaraAccountProblems(EMPTY_CANARA_ACCOUNT)).sort(), ['holder', 'number'])
    assert.equal(canaraAccountIsComplete(acct()), true)
    assert.equal(canaraAccountIsComplete(acct({ bank: 'SBI' })), true)
  })
  test('a blank holder is refused even with a number', () => {
    assert.deepEqual(Object.keys(canaraAccountProblems(acct({ holder: '   ' }))), ['holder'])
  })
  test('the number may carry spaces and hyphens; junk and too-short numbers are refused', () => {
    assert.equal(canaraAccountProblems(acct({ number: '1234-5678-9012' })).number, undefined)
    assert.equal(canaraAccountProblems(acct({ number: 'GB29NWBK60161331926819' })).number, undefined)
    assert.ok(canaraAccountProblems(acct({ number: '12' })).number)
    assert.ok(canaraAccountProblems(acct({ number: '1234 5678 #' })).number)
    assert.ok(canaraAccountProblems(acct({ number: ' - ' })).number)
  })
})

describe('the note that is saved', () => {
  test('account lines first, a blank line, then the person’s own note', () => {
    assert.equal(
      composeCanaraNote('canara', acct({ bank: 'SBI' }), '  Paid by cheque  '),
      'Account holder: Sumeet Babar\nAccount number: 1234 5678 9012\nBank: SBI\n\nPaid by cheque',
    )
  })
  test('an empty bank line is left out, and no own note means no trailing blank', () => {
    assert.equal(composeCanaraNote('canara', acct(), ''), 'Account holder: Sumeet Babar\nAccount number: 1234 5678 9012')
  })
  test('any other mode saves only the person’s own note, even with stale account text', () => {
    assert.equal(composeCanaraNote('pnb', acct(), ' hi '), 'hi')
    assert.equal(composeCanaraNote('hdfc', acct(), ''), '')
  })
  test('nothing typed saves the own note untouched', () => {
    assert.equal(composeCanaraNote('canara', EMPTY_CANARA_ACCOUNT, 'x'), 'x')
  })
})

describe('after it is saved', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    payment_id: 'p1', human_payment_id: 'P-AA-0001', client_name: 'Acme', amount: 5000,
    payment_mode: 'canara', payment_date: '2026-11-11', recorded_at: '2026-11-11T10:00:00Z',
    tracked: true, state: 'with_holder', holder_id: 'u1', holder_name: 'Prerna',
    holder_since: '2026-11-11T10:00:00Z', age_hours: 3, open_handover: null,
    can_accept: false, can_hand_over: true, can_receive: false,
    ...over,
  })

  test('a Canara payment can be handed over, exactly like Paytm', () => {
    assert.equal(readCashPayment(raw())!.canHandOver, true)
    assert.equal(readCashPayment(raw({ payment_mode: 'paytm' }))!.canHandOver, true)
  })
  test('the custodian’s Receive is untouched', () => {
    assert.equal(readCashPayment(raw({ can_receive: true }))!.canReceive, true)
  })
  test('it reads as held by its holder until it reaches the company, as every cash payment does', () => {
    assert.equal(cashStateLabel(readCashPayment(raw())!), 'With Prerna')
    assert.equal(cashStateLabel(readCashPayment(raw({ payment_mode: 'paytm' }))!), 'With Prerna')
    assert.equal(cashStateLabel(readCashPayment(raw({ state: 'with_company' }))!), 'With company')
  })
  test('the hand-over picker lists a Canara payment', () => {
    const rows = [
      { payment_id: 'a', payment_mode: 'canara', amount: 1 },
      { payment_id: 'b', payment_mode: 'paytm', amount: 2 },
    ]
    assert.deepEqual(readHandoverCandidates(rows).map(c => c.paymentId), ['a', 'b'])
  })
})

describe('the forms ask the question where the mode asks it', () => {
  const FORMS = [
    'src/app/finance/paymentRequestsNew.tsx',
    'src/app/finance/received/RecordSplitPaymentModal.tsx',
    'src/app/finance/paymentRequestsEdit.tsx',
    'src/components/orders/PiPaymentCard.tsx',
  ]
  for (const f of FORMS) {
    test(`${f} gates on modeAsksWhereMoneyIs, never on the wider tracked rule`, () => {
      const src = read(f)
      assert.match(src, /modeAsksWhereMoneyIs/)
      assert.doesNotMatch(src, /modeRequiresCustodyTrail\(|isTrackedPaymentMode\(/)
    })
  }
  for (const f of FORMS.filter(x => !x.endsWith('Edit.tsx'))) {
    test(`${f} asks for the paying account and saves it through composeCanaraNote`, () => {
      const src = read(f)
      assert.match(src, /<CanaraAccountFields/)
      assert.match(src, /composeCanaraNote\(/)
    })
  }
})
