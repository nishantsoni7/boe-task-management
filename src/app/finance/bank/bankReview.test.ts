// What the Bank Statements page says about a credit. The rules themselves are the
// database's (supabase/tests/bank_line_review_pglite.mjs proves them); this file
// proves the page repeats them faithfully and fails closed.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SYNC_NOT_YET,
  SYNC_PILL,
  analyseLine,
  compareMatch,
  lookAlikeCredit,
  matchDoubts,
  paymentHref,
  recordCreditHref,
  rowAction,
  syncReason,
  syncState,
  type BankLine,
  type BankMatch,
  type BankPayment,
  type LineReview,
  type SyncIssue,
} from './bankStatementsModel'

const line = (over: Partial<BankLine> = {}): BankLine => ({
  id: 'L1', account: 'hdfc_sec', seq: 1, line_date: '2026-10-28', value_date: null,
  narration: 'NEFT CR-KKBK0000958-SAMPLE TRADERS-BESTOFEXPORTS-KKBKH26295886339', bank_ref: 'KKBKH26295886339',
  withdrawal: 0, deposit: 21000, balance: 100000, classification: null, non_customer_kind: null,
  old_order_customer: null, old_order_ref: null, debit_kind: null, debit_payee: null, note: null,
  sync_error: null, bank_line_payment_links: [], bank_line_expense_links: [], ...over,
})
const linked = (amount = 21000, paymentId = 'P1') => [{ id: 'K1', payment_id: paymentId, amount, unlinked_at: null }]
const pay = (over: Partial<BankPayment> = {}): BankPayment => ({
  id: 'P2', human_payment_id: 'P-AA-0002', client_name: 'Sample Traders', amount: 21000, remaining: 21000, linkedAmount: 0,
  payment_date: '2026-10-28', payment_mode: 'hdfc_sec', proof_note: null, status: 'approved_unlinked', ...over,
})
const match = (over: Partial<BankMatch> = {}): BankMatch => ({
  paymentId: 'P2', humanPaymentId: 'P-AA-0002', clientName: 'Sample Traders', amount: 21000, leftToLink: 21000,
  paymentDate: '2026-10-28', paymentMode: 'hdfc_sec', proofNote: null, status: 'approved_unlinked', kind: 'amount',
  linkedLinkId: null, linkedLineDate: null, linkedNarration: null, ...over,
})
const elsewhere = (over: Partial<BankMatch> = {}) => match({
  kind: 'linked_elsewhere', leftToLink: 0, linkedLinkId: 'K9', linkedLineDate: '2026-11-13',
  linkedNarration: 'NEFT CR-KKBK0000958-ANOTHER HOTEL-BESTOFEXPORTS-KKBKH26295886340', ...over,
})
const review = (issue: SyncIssue | null, over: Partial<LineReview> = {}): LineReview => ({
  issue, uncovered: issue === null ? 0 : 21000, paymentLabel: 'P-AA-0001', paymentMode: 'hdfc_sec', matches: [], ...over,
})
const read = (l: BankLine, r?: LineReview) => analyseLine(l, [], [], [], r)

describe('Synced is what the database says, and nothing else', () => {
  test('a link alone is not Synced: without the database\'s answer the credit is not in sync', () => {
    const a = read(line({ bank_line_payment_links: linked() }))
    assert.equal(syncState(a), 'not_synced')
  })

  test('every issue keeps a credit out of Synced', () => {
    const expected: Record<SyncIssue, string> = {
      no_payment: 'not_synced', part_linked: 'not_synced', payment_rejected: 'not_synced', payment_deleted: 'not_synced',
      other_account: 'not_synced', amount_changed: 'not_synced', waiting: 'waiting',
    }
    for (const [issue, state] of Object.entries(expected)) {
      assert.equal(syncState(read(line({ bank_line_payment_links: linked() }), review(issue as SyncIssue))), state, issue)
    }
    assert.equal(syncState(read(line({ bank_line_payment_links: linked() }), review(null))), 'synced')
  })

  test('only a person\'s mark makes a credit Not needed; a text guess does not', () => {
    assert.equal(syncState(read(line({ classification: 'not_customer_money' }))), 'not_needed')
    assert.equal(syncState(read(line({ classification: 'old_order' }))), 'not_needed')
    const guess = read(line({ narration: 'IMPS-626113596259-SAMPLE HOTEL-KKBK-XXXXXX2052-REFUNDABLE DEPOSIT' }), review('no_payment'))
    assert.ok(guess.nonCustomer)
    assert.equal(syncState(guess), 'not_synced')
    assert.match(syncReason(guess)!, /^Looks like: Refund or reversal/)
  })

  test('the pills say what is true', () => {
    assert.equal(SYNC_PILL.synced.label, 'Matched')
    assert.equal(SYNC_PILL.waiting.label, 'Waiting for Finance')
    assert.equal(SYNC_PILL.not_synced.tone, 'over')
  })
})

describe('the reason shown on a Not matched credit', () => {
  const says = (issue: SyncIssue, over: Partial<LineReview> = {}) => syncReason(read(line(), review(issue, over)))

  test('names the payment and what happened to it', () => {
    assert.equal(says('payment_rejected'), 'P-AA-0001 was rejected')
    assert.equal(says('payment_deleted'), 'P-AA-0001 was deleted')
    assert.equal(says('waiting'), 'P-AA-0001 is waiting for Finance')
    assert.equal(says('other_account', { paymentMode: 'hdfc' }), 'P-AA-0001 says HDFC PRI')
    assert.equal(says('amount_changed'), 'P-AA-0001 was changed and no longer covers this credit')
    assert.equal(says('part_linked', { uncovered: 40000 }), '₹40,000.00 of this credit has no payment')
  })

  test('a live match replaces the sentence stored by the last sync', () => {
    const a = read(line({ sync_error: 'this may already be recorded as P-AA-0099 (Old, 1 Oct 2026). Link that payment instead.' }),
      review('no_payment', { matches: [match()] }))
    assert.equal(syncReason(a), 'May already be P-AA-0002')
  })

  test('a payment linked elsewhere names the credit that holds it', () => {
    const a = read(line(), review('no_payment', { matches: [elsewhere()] }))
    assert.equal(syncReason(a), 'May be P-AA-0002, linked to the credit of 13 Nov 2026')
  })

  test('a stored duplicate sentence with no live match behind it is not repeated', () => {
    for (const sync_error of [
      'this may already be recorded as P-AA-0099 (Old, 1 Oct 2026).',
      'payment P-AA-0099 already carries this bank reference. Link it instead of adding another.',
      'this bank reference is already on P-AA-0099, which is linked to another bank line. Compare them before adding this one.',
      'this may be P-AA-0099, which is linked to another bank line further from its date. Compare them before adding this one.',
    ]) {
      assert.equal(syncReason(read(line({ sync_error }), review('no_payment'))), SYNC_NOT_YET)
    }
  })

  test('nothing the old sync stored is repeated: a statement no longer tries to add a credit', () => {
    assert.equal(syncReason(read(line({ sync_error: 'the amount has more than two decimals' }), review('no_payment'))), SYNC_NOT_YET)
  })

  test('a credit nobody has recorded says so', () => {
    assert.equal(SYNC_NOT_YET, 'No request yet')
  })
})

describe('what a credit offers', () => {
  test('one press opens the form only for a plain credit, and only for someone who may record a payment', () => {
    assert.equal(rowAction(read(line(), review('no_payment')), true), 'record')
    assert.equal(rowAction(read(line(), review('no_payment')), false), 'review')
  })

  test('the address carries the line, never its amount or reference', () => {
    assert.equal(recordCreditHref('L1'), '/finance?new=1&bankLine=L1')
  })

  test('anything that needs a person is opened first', () => {
    assert.equal(rowAction(read(line(), review('no_payment', { matches: [match()] })), true), 'review')
    assert.equal(rowAction(read(line(), review('no_payment', { matches: [elsewhere()] })), true), 'review')
    assert.equal(rowAction(read(line({ narration: 'REF-SAMPLE-1' }), review('no_payment')), true), 'review')
    for (const issue of ['part_linked', 'payment_rejected', 'payment_deleted', 'other_account', 'amount_changed'] as const) {
      assert.equal(rowAction(read(line({ bank_line_payment_links: linked() }), review(issue)), true), 'review', issue)
    }
  })

  test('a Matched, Waiting or marked credit offers nothing', () => {
    assert.equal(rowAction(read(line({ bank_line_payment_links: linked() }), review(null)), true), null)
    assert.equal(rowAction(read(line({ bank_line_payment_links: linked() }), review('waiting')), true), null)
    assert.equal(rowAction(read(line({ classification: 'old_order' })), true), null)
  })

})

describe('the comparison', () => {
  const row = (l: BankLine, m: BankMatch, label: string) => compareMatch(l, m).find(r => r.label === label)!

  test('the same money reads Same on every fact', () => {
    assert.deepEqual(
      compareMatch(line(), match()).map(r => [r.label, r.verdict, r.tone]),
      [
        ['Amount', 'Same', 'same'],
        ['Date', 'Same day', 'same'],
        ['Account', 'Same', 'same'],
        ['Name', 'Same', 'same'],
        ['Reference', '', 'plain'],
        ['Status', 'In Confirmed Payments', 'same'],
      ],
    )
  })

  test('a difference is said, with its size', () => {
    assert.equal(row(line(), match({ amount: 20950, leftToLink: 20950 }), 'Amount').verdict, 'Differs by ₹50.00')
    assert.equal(row(line(), match({ paymentDate: '2026-10-07' }), 'Date').verdict, '21 days apart')
    assert.equal(row(line(), match({ paymentDate: '2026-10-07' }), 'Date').tone, 'differs')
    const account = row(line(), match({ paymentMode: 'hdfc' }), 'Account')
    assert.equal(account.payment, 'HDFC PRI'); assert.equal(account.verdict, 'Different'); assert.equal(account.tone, 'differs')
    assert.equal(row(line(), match({ clientName: 'Unrelated Name' }), 'Name').verdict, 'No match')
    assert.equal(row(line(), match({ clientName: null }), 'Name').payment, 'Not identified')
    assert.equal(row(line(), match({ status: 'pending_approval' }), 'Status').verdict, 'Not verified yet')
  })

  test('a payment already part used shows what is left, and the money compared is what is left on both sides', () => {
    const r = row(line(), match({ amount: 42000, leftToLink: 21000 }), 'Amount')
    assert.equal(r.payment, '₹42,000.00 (₹21,000.00 left)'); assert.equal(r.verdict, 'Same')
    const part = row(line({ deposit: 100000, bank_line_payment_links: linked(60000) }), match({ amount: 40000, leftToLink: 40000 }), 'Amount')
    assert.equal(part.credit, '₹40,000.00'); assert.equal(part.verdict, 'Same')
  })

  test('a shared reference is named, and a used-up payment says so', () => {
    assert.equal(row(line(), match({ kind: 'reference', proofNote: 'UTR KKBKH26295886339' }), 'Reference').verdict, 'Same reference')
    assert.equal(row(line(), match({ kind: 'reference_used', leftToLink: 0 }), 'Amount').verdict, 'Already linked')
  })

  test('a payment linked elsewhere is compared on its full amount, and claims no shared reference', () => {
    const amount = row(line(), elsewhere(), 'Amount')
    assert.equal(amount.payment, '₹21,000.00'); assert.equal(amount.verdict, 'Same'); assert.equal(amount.tone, 'same')
    assert.equal(row(line(), elsewhere({ amount: 20000 }), 'Amount').verdict, 'Differs by ₹1,000.00')
    const reference = row(line(), elsewhere(), 'Reference')
    assert.equal(reference.verdict, ''); assert.equal(reference.tone, 'plain')
  })
})

describe('what should stop a person before linking', () => {
  test('nothing, when the name fits and the dates are within 3 days', () => {
    assert.deepEqual(matchDoubts(line(), match()), [])
    assert.deepEqual(matchDoubts(line(), match({ paymentDate: '2026-10-25' })), [])
    assert.deepEqual(matchDoubts(line(), match({ paymentDate: '2026-10-31' })), [], 'a date after the credit counts the same')
    assert.deepEqual(matchDoubts(line(), match({ clientName: 'Sample Exports' })), [], 'part of the name is enough')
  })

  test('a name that does not fit, or no name at all', () => {
    assert.deepEqual(matchDoubts(line(), match({ clientName: 'Unrelated Hotel' })), ['the name does not match'])
    assert.deepEqual(matchDoubts(line(), match({ clientName: null })), ['the payment has no client name'])
  })

  test('a fourth day apart, and both together', () => {
    assert.deepEqual(matchDoubts(line(), match({ paymentDate: '2026-10-24' })), ['the dates are 4 days apart'])
    assert.deepEqual(matchDoubts(line(), elsewhere({ clientName: 'Unrelated Hotel', paymentDate: '2026-10-18' })), ['the name does not match', 'the dates are 10 days apart'])
  })

  test('the bank\'s own reference outweighs both', () => {
    const far = { clientName: 'Unrelated Hotel', paymentDate: '2026-10-18' }
    assert.deepEqual(matchDoubts(line(), match({ kind: 'reference', ...far })), [])
    assert.deepEqual(matchDoubts(line(), match({ kind: 'reference_used', ...far })), [])
  })

  test('the words on the card and the colours in the comparison agree', () => {
    const tones = (m: BankMatch) => compareMatch(line(), m).filter(r => r.label === 'Date' || r.label === 'Name').map(r => r.tone)
    assert.deepEqual(tones(match({ paymentDate: '2026-10-25' })), ['same', 'same'])
    assert.deepEqual(tones(match({ paymentDate: '2026-10-24', clientName: 'Unrelated Hotel' })), ['differs', 'plain'])
  })
})

describe('a payment with no credit, beside a credit that already has one', () => {
  const done = (over: Partial<BankLine> = {}) => analyseLine(line({ bank_line_payment_links: linked(), ...over }), [], [], [], review(null))
  const other = pay({ id: 'P1', human_payment_id: 'P-AA-0001', remaining: 0, linkedAmount: 21000 })

  test('the same amount is flagged, naming the payment that holds the credit', () => {
    const r = lookAlikeCredit(pay(), [done()], [other, pay()])
    assert.equal(r?.line.id, 'L1'); assert.equal(r?.exact, true); assert.equal(r?.otherPayment, 'P-AA-0001')
  })

  test('a near amount is flagged as close', () => {
    const r = lookAlikeCredit(pay({ amount: 21100, remaining: 21100 }), [done()], [other])
    assert.equal(r?.exact, false)
  })

  test('an exact credit beats a near one, then the nearer date wins', () => {
    const near = done({ id: 'NEAR', deposit: 21100, bank_line_payment_links: linked(21100) })
    const exact = done({ id: 'FAR', line_date: '2026-10-20' })
    assert.equal(lookAlikeCredit(pay(), [near, exact], [other])?.line.id, 'FAR')
    const closer = done({ id: 'CLOSE', line_date: '2026-10-27' })
    assert.equal(lookAlikeCredit(pay(), [exact, closer], [other])?.line.id, 'CLOSE')
  })

  test('not flagged: its own credit, a free credit, far dates, or another amount', () => {
    assert.equal(lookAlikeCredit(pay({ id: 'P1' }), [done()], [other]), null)
    assert.equal(lookAlikeCredit(pay(), [read(line(), review('no_payment'))], [other]), null)
    assert.equal(lookAlikeCredit(pay({ payment_date: '2026-09-30' }), [done()], [other]), null)
    assert.equal(lookAlikeCredit(pay({ amount: 90000, remaining: 90000 }), [done()], [other]), null)
  })
})

describe('where a payment opens', () => {
  test('Confirmed Payments once verified, Payment Requests before that', () => {
    assert.equal(paymentHref('X', 'approved_unlinked'), '/finance/received?payment=X')
    assert.equal(paymentHref('X', 'approved_linked'), '/finance/received?payment=X')
    assert.equal(paymentHref('X', 'pending_approval'), '/finance?tab=all&request=X')
    assert.equal(paymentHref('X', 'needs_clarification'), '/finance?tab=all&request=X')
  })
})

describe('the migration', () => {
  const migration = readFileSync(join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '20270514000000_finance_bank_line_review.sql'), 'utf8')

  test('holds no account number (the repository is public)', () => {
    assert.ok(!/\b\d{10,}\b/.test(migration.replace(/\b2027\d{10}\b/g, '')))
  })

  test('takes the blanket override and the internals away from every browser', () => {
    for (const fn of [
      'bank_line_reference_tokens(text, text)', 'bank_line_payment_matches(uuid)', 'bank_line_sure_payment(uuid)',
      'bank_lines_sync_rows(uuid[])', 'create_payment_from_bank_line(uuid, boolean, text)',
    ]) {
      assert.ok(migration.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn)
    }
    assert.ok(migration.includes('drop function if exists public.create_payment_from_bank_line(uuid, boolean);'))
    assert.ok(migration.includes('drop function if exists public.unlink_bank_line_payment(uuid);'))
  })

  test('every door is definer with a fixed search_path, checks the bank door first, and has no anon execute', () => {
    for (const fn of ['add_bank_line_to_confirmed', 'unlink_bank_line_payment', 'bank_lines_sync_state', 'bank_lines_recorded_matches', 'bank_sync_overview']) {
      const at = migration.search(new RegExp(`create (or replace )?function public\\.${fn}\\(`))
      assert.ok(at >= 0, fn)
      const body = migration.slice(at, at + 2500)
      assert.match(body, /security definer\s*\r?\nset search_path = public, pg_temp/, fn)
      assert.match(body, /assert_bank_reconcile_door\(\)/, fn)
      assert.ok(migration.includes(`revoke all on function public.${fn}(`), fn)
    }
  })

  test('the file name avoids the word the BOE Credits ledger test reserves', () => {
    assert.ok(!/credit/i.test('20270514000000_finance_bank_line_review.sql'))
  })
})
