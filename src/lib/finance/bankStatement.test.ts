import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BankStatementError,
  cellAmount,
  isoFromBankDate,
  parseHdfcStatement,
  suggestNonCustomerKind,
} from './bankStatement'
import { nameOverlap, payerFromNarration, referenceTokens, suggestPaymentsForLine, type MatchPayment } from './bankMatching'

function sheet(lines: unknown[][], summary: unknown[] = [-1000, 500, 1500, 0]): unknown[][] {
  return [
    ['HDFC BANK Ltd.', '', '', '', '', '', 'Statement of accounts'],
    ['Nomination  :  Not Registered | Account No :99982000009999   Imperia'],
    ['Statement From  :  01/10/2026         To  :  19/10/2026 | A/C Open Date :15/01/2024'],
    [],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['********', '*****', '*****', '*****', '*****', '*****', '*****'],
    ...lines,
    [],
    ['STATEMENT SUMMARY  :-'],
    ['Opening Balance', 'Debits', 'Credits', 'Closing Bal'],
    summary,
  ]
}

const GOOD = sheet([
  ['01/10/26', 'NEFT CR-ICIC0SF0002-NUEVO DIGITAL SOLUTIONS PRIVATE LIMITED-BESTOFEXPORTS-IN42627454754824', 'IN42627454754824', '01/10/26', '', 1500, 500],
  ['02/10/26', 'NEFT DR-HSBC0560002-SOMEONE', 'HDFCH01', '02/10/26', 500, '', 0],
], [-1000, 500, 1500, 0])

describe('parseHdfcStatement', () => {
  test('reads the account, the period, the lines and the balances', () => {
    const s = parseHdfcStatement(GOOD)
    assert.equal(s.accountNumber, '99982000009999')
    assert.equal(s.periodFrom, '2026-10-01')
    assert.equal(s.periodTo, '2026-10-19')
    assert.equal(s.openingBalance, -1000)
    assert.equal(s.closingBalance, 0)
    assert.equal(s.lines.length, 2)
    assert.equal(s.lines[0].deposit, 1500)
    assert.equal(s.lines[1].withdrawal, 500)
    assert.equal(s.lines[0].line_date, '2026-10-01')
  })

  test('an all-zero reference is no reference', () => {
    const rows = sheet([['01/10/26', 'REF-RAZP', '000000000000000', '01/10/26', '', 1500, 500]], [-1000, 0, 1500, 500])
    assert.equal(parseHdfcStatement(rows).lines[0].bank_ref, null)
  })

  test('a balance that does not follow from the line before is refused', () => {
    const rows = sheet([
      ['01/10/26', 'A', 'R1', '01/10/26', '', 1500, 500],
      ['02/10/26', 'B', 'R2', '02/10/26', 500, '', 1],
    ])
    assert.throws(() => parseHdfcStatement(rows), (e: unknown) => e instanceof BankStatementError && /do not add up/.test(String(e)))
  })

  test('summary totals that disagree with the lines are refused', () => {
    assert.throws(() => parseHdfcStatement(sheet(GOOD.slice(6, 8), [-1000, 501, 1500, 0])), BankStatementError)
  })

  test('a file that is not a statement is refused in words', () => {
    assert.throws(() => parseHdfcStatement([['hello']]), /account number/)
  })

  test('a line with both columns filled is refused', () => {
    const rows = sheet([['01/10/26', 'A', 'R1', '01/10/26', 5, 5, 500]])
    assert.throws(() => parseHdfcStatement(rows), BankStatementError)
  })

  test('amounts may arrive as strings with commas', () => {
    assert.equal(cellAmount('1,23,456.50'), 123456.5)
    assert.equal(cellAmount(''), 0)
    assert.throws(() => cellAmount('abc'), BankStatementError)
  })

  test('dates', () => {
    assert.equal(isoFromBankDate('09/10/26'), '2026-10-09')
    assert.equal(isoFromBankDate('09/10/2026'), '2026-10-09')
    assert.equal(isoFromBankDate('x'), null)
  })
})

describe('suggestNonCustomerKind', () => {
  const k = (s: string) => suggestNonCustomerKind(s)?.kind ?? null
  test('the credits seen in the September and October statements', () => {
    assert.equal(k('INT. AUTO_REDEMPTION  50301161284274'), 'fd_redemption')
    assert.equal(k('IB FUNDS TRANSFER CR-99982000009999-BEST OF EXPORTS'), 'own_transfer')
    assert.equal(k('RTGS CR-BKID0008409-BEST OF EXPORTS-BEDT OF EXPORTS-BKIDR52026092400220125'), 'own_transfer')
    assert.equal(k('IMPS-627428012737-APIBANKING-RATN-XXXXXXXXXXXX0168-ACCOUNTVALIDATION'), 'bank_test')
    assert.equal(k('REF-RAZPBALTICL-TXVTNZMYOGRXJK-3/9/26'), 'refund')
    assert.equal(k('UPI-AMAZON INDIA-AMAZON.REFUNDS@RAPL-RATN000RAPL-625153729884-REFUND FOR YOUR AM'), 'refund')
    assert.equal(k('CRV POS 403875******4533      GOOGLE CLO'), 'refund')
  })
  test('a customer payment is never suggested as non-customer', () => {
    assert.equal(k('NEFT CR-PUNB0196000-SHREE RAM WOODEN INDUSTRIES PVT LTD-BEST OF EXPORTS-PUNBQ26246025396'), null)
    assert.equal(k('RTGS CR-SBIN0005166-MAHANTESH ENTERPRISES PROP M S NARA-BEST OF EXPORTS-SBINR12026100645079909'), null)
    assert.equal(k('IMPS-626113596259-M S LOGISTICS-KKBK-XXXXXX2052-TABLE  BASE'), null)
    assert.equal(k('IMPS-626113596259-M S LOGISTICS-KKBK-XXXXXX2052-PRINT PD'), null)
  })
  test('the company paying itself is recognised however the bank spells it', () => {
    assert.equal(k('NEFT CR-KKBK0000958-BESTOFEXPORTS-BESTOFEXPORTS-KKBKH26295886339'), 'own_transfer')
    assert.equal(k('NEFT CR-KKBK0000958-BEST OF EXPORT-BESTOFEXPORTS-KKBKH26295886339'), 'own_transfer')
  })
  test('interest is still recognised', () => {
    assert.equal(k('INT PD 01-07-2026 TO 30-09-2026'), 'interest')
    assert.equal(k('INT. PD 01-07-2026'), 'interest')
  })
})

describe('payer and name matching', () => {
  test('payer is read from each narration style', () => {
    assert.equal(payerFromNarration('NEFT CR-SBIN0007260-HOTEL BHARAT PALACE-BEST OF EXPORTS-SBIN126254515580'), 'HOTEL BHARAT PALACE')
    assert.equal(payerFromNarration('IMPS-626113596259-M S LOGISTICS-KKBK-XXXXXX2052-TABLE  BASE'), 'M S LOGISTICS')
    assert.equal(payerFromNarration('FT - CR - 50200110346877 - RAJ LEISURE PRIVATE LIMITED'), 'RAJ LEISURE PRIVATE LIMITED')
    assert.equal(payerFromNarration('UPI-PAVAN M R-PAVAN.PLANETREE@OKAXIS-KKBK0008344-662709981459-UNDEFINED'), 'PAVAN M R')
    assert.equal(payerFromNarration('99999047729686-TPT-FURNITURE ADVANCE-HOTEL ALANKAR PRIVATE LIMITED'), 'HOTEL ALANKAR PRIVATE LIMITED')
  })
  test('a truncated bank name still matches, an unrelated one does not', () => {
    assert.ok(nameOverlap('Magdale Resorts', '50200062837463-TPT-NBKXFLRLFEXIWNZN-MAGDALE') >= 0.5)
    assert.equal(nameOverlap('Green Sky Hospitality LLP', 'NEFT CR-KKBK0000958-GREEN SKY HOSPITALITY LLP-BEST OF EXPORTS JODHPUR'), 1)
    assert.equal(nameOverlap('Hotel Alankar', 'NEFT CR-X-SOMEONE ELSE-BEST OF EXPORTS'), 0)
  })
  test('reference tokens', () => {
    assert.deepEqual(
      referenceTokens({ narration: 'NEFT CR-KKBK0000958-GREEN SKY-BEST OF EXPORTS-KKBKH26273906288', bank_ref: 'KKBKH26273906288' }),
      ['KKBKH26273906288'],
    )
  })
})

describe('suggestPaymentsForLine', () => {
  const line = {
    id: 'L1', account: 'hdfc' as const, line_date: '2026-10-06',
    narration: 'NEFT CR-KKBK0000958-GREEN SKY HOSPITALITY LLP-BEST OF EXPORTS JODHPUR-KKBKH26279861023',
    bank_ref: 'KKBKH26279861023', remaining: 50000,
  }
  const pay = (over: Partial<MatchPayment>): MatchPayment => ({
    id: 'P', human_payment_id: 'P-AA-0001', client_name: 'Green Sky Hospitality LLP', amount: 50000, remaining: 50000,
    payment_date: '2026-10-05', payment_mode: 'hdfc', proof_note: null, status: 'pending_approval', ...over,
  })

  test('exact amount + name + near date is strong and explains itself', () => {
    const [s] = suggestPaymentsForLine(line, [pay({})])
    assert.equal(s.confidence, 'strong')
    assert.ok(s.reasons.includes('Exact amount'))
    assert.ok(s.reasons.some(r => r.startsWith('Name matches')))
  })

  test('a changed date is still found, with a warning', () => {
    const [s] = suggestPaymentsForLine(line, [pay({ payment_date: '2026-09-22' })])
    assert.ok(s)
    assert.ok(s.warnings.some(w => /days/.test(w)))
  })

  test('a typed reference outweighs a different name', () => {
    const [s] = suggestPaymentsForLine(line, [pay({ client_name: 'Someone Else', proof_note: 'UTR KKBKH26279861023' })])
    assert.equal(s.confidence, 'strong')
    assert.ok(s.reasons.includes('Reference matches the bank reference'))
  })

  test('the other account is allowed but warned', () => {
    const [s] = suggestPaymentsForLine(line, [pay({ payment_mode: 'hdfc_sec' })])
    assert.ok(s.warnings.some(w => /HDFC SEC/.test(w)))
  })

  test('different amount and no reference is not suggested; rejected and used-up payments never are', () => {
    assert.equal(suggestPaymentsForLine(line, [pay({ amount: 70000, remaining: 70000, client_name: 'Another Client' })]).length, 0)
    assert.equal(suggestPaymentsForLine(line, [pay({ status: 'rejected' })]).length, 0)
    assert.equal(suggestPaymentsForLine(line, [pay({ remaining: 0 })]).length, 0)
  })

  test('best first, and capped', () => {
    const list = suggestPaymentsForLine(line, [
      pay({ id: 'a', client_name: 'Other', payment_date: '2026-09-01' }),
      pay({ id: 'b' }),
    ])
    assert.equal(list[0].paymentId, 'b')
  })

  test('a credit smaller than the payment is offered only as one part, when it carries the client\'s name', () => {
    const [s] = suggestPaymentsForLine(line, [pay({ amount: 70000, remaining: 70000 })])
    assert.ok(s.reasons.includes('Could be one part of this payment'))
    assert.equal(s.amountExact, false)
  })

  test('a payment that is part of a bigger credit is offered as possible', () => {
    const [s] = suggestPaymentsForLine({ ...line, remaining: 80000 }, [pay({ amount: 50000, remaining: 50000 })])
    assert.ok(s)
    assert.equal(s.amountExact, false)
    assert.ok(s.reasons.includes('Could be part of this credit'))
  })
})
