// What a person is told about a payment and the bank, and the pins that keep the
// rule in place. The rule itself is the database's:
// supabase/tests/bank_proof_before_verify_pglite.mjs runs it against the real doors.
//
// Run: npm run test:file -- src/lib/finance/bankProofBeforeVerify.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BANK_CHECK_LATE_DAYS, bankCheckState, bankMarkSummary, bankVerifyRefusal, candidateDoubts, compareCandidate,
  deriveBankMarks, isBankAccountMode, isExactCandidate, markCandidates, pendingBankView, statementsRunTo,
  type BankCandidate, type BankMark, type MarkLine, type MarkPayment,
} from './bankMarks'
import { describePaymentDecisionError } from './paymentDecision'
import { suggestPaymentsForLine } from './bankMatching'
import { creditHref } from '@/app/finance/bank/bankStatementsModel'

const pay = (over: Partial<MarkPayment> = {}): MarkPayment => ({
  id: 'P1', human_payment_id: 'P-ZZ-0101', client_name: 'Sample Hotels LLP', amount: 375000, remaining: 375000,
  payment_date: '2026-10-06', payment_mode: 'hdfc', proof_note: 'SAMP26279000111', status: 'pending_approval', ...over,
})
const credit = (over: Partial<MarkLine> = {}): MarkLine => ({
  statementNo: 412, id: 'L1', account: 'hdfc', line_date: '2026-10-06',
  narration: 'NEFT CR-SAMP0000111-SAMPLE HOTELS LLP-BEST OF EXPORTS-SAMP26279000111',
  bank_ref: 'SAMP26279000111', deposit: 375000, linkedAmount: 0, ...over,
})
const COVER = { hdfc: { first: '2026-09-01', last: '2026-10-28' } }
const mark = (p: MarkPayment, lines: MarkLine[]) => deriveBankMarks([p], [], lines, COVER).get(p.id)!
const best = (p: MarkPayment, lines: MarkLine[]): BankCandidate => markCandidates(mark(p, lines))[0]

describe('how a payment stands against the bank', () => {
  test('everything agrees: Exact match', () => {
    assert.ok(isExactCandidate(best(pay(), [credit()])))
    assert.deepEqual(bankMarkSummary(mark(pay(), [credit()])), { text: 'Exact match', tone: 'ok' })
  })

  test('the same amount without the UTR is a match to check, not an exact one', () => {
    const p = pay({ proof_note: null })
    assert.equal(isExactCandidate(best(p, [credit()])), false)
    assert.equal(bankMarkSummary(mark(p, [credit()])).text, 'Match found, check it')
  })

  test('two credits of the same amount say so', () => {
    const lines = [credit(), credit({ id: 'L2', line_date: '2026-10-07', bank_ref: null })]
    assert.equal(bankMarkSummary(mark(pay({ proof_note: null }), lines)).text, '2 credits fit')
  })

  test('a credit in the other HDFC account is never exact', () => {
    assert.equal(isExactCandidate(best(pay({ payment_mode: 'hdfc_sec' }), [credit()])), false)
  })

  test('a date four days off is never exact', () => {
    assert.equal(isExactCandidate(best(pay({ payment_date: '2026-10-02' }), [credit()])), false)
  })

  test('a bigger credit reads as part of it', () => {
    const p = pay({ amount: 600000, remaining: 600000, proof_note: null })
    assert.equal(bankMarkSummary(mark(p, [credit({ deposit: 1000000, bank_ref: null })])).text, 'Part of a bigger amount')
  })

  test('a credit marked or used by nobody else, and nothing found: what the statements cover decides the words', () => {
    assert.equal(bankMarkSummary(mark(pay(), [])).text, 'Not found in the bank')
    assert.equal(bankMarkSummary(mark(pay({ payment_date: '2026-10-30' }), [])).text, 'Statement not uploaded')
  })
})

describe('the views of Pending', () => {
  const m = (k: BankMark['kind']) => ({ kind: k }) as BankMark

  test('a payment is in exactly one', () => {
    assert.equal(pendingBankView('hdfc', m('suggested')), 'match_found')
    assert.equal(pendingBankView('hdfc_sec', m('linked')), 'match_found')
    for (const k of ['none', 'uncovered', 'lookalike'] as const) assert.equal(pendingBankView('hdfc', m(k)), 'waiting_for_bank')
    assert.equal(pendingBankView('hdfc', undefined), 'waiting_for_bank')
    for (const mode of ['pnb', 'paytm', 'canara']) assert.equal(pendingBankView(mode, undefined), 'cash')
  })

  test('only the two HDFC accounts are bank accounts here', () => {
    assert.deepEqual(['hdfc', 'hdfc_sec', 'pnb', 'paytm', 'canara', null].map(isBankAccountMode), [true, true, false, false, false, false])
  })
})

describe('part payments', () => {
  test('a payment with part linked is offered credits for what is left', () => {
    const p = pay({ amount: 500000, remaining: 500000, proof_note: null })
    const linked = deriveBankMarks([p], [{ payment_id: 'P1', line_id: 'L1', amount: 300000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' }], [
      credit({ deposit: 300000, linkedAmount: 300000, bank_ref: null }),
      credit({ id: 'L2', deposit: 200000, bank_ref: null }),
    ], COVER).get('P1')!
    assert.equal(linked.kind, 'linked')
    assert.equal(bankMarkSummary(linked).text, '₹2,00,000.00 still needs a credit')
    assert.deepEqual(markCandidates(linked).map(c => c.lineId), ['L2'])
  })

  test('a link in the other HDFC account covers nothing, as in the database, and offers no credit it would refuse', () => {
    const p = pay({ payment_mode: 'hdfc_sec' })
    const m = deriveBankMarks([p], [{ payment_id: 'P1', line_id: 'L1', amount: 375000, line_date: '2026-10-06', narration: 'NEFT', account: 'hdfc' }], [credit({ linkedAmount: 375000 })], COVER).get('P1')!
    assert.equal(m.kind, 'linked')
    assert.ok(m.kind === 'linked' && !m.complete && m.otherAccount)
    assert.equal(bankMarkSummary(m).text, 'Linked in the other account')
    assert.deepEqual(markCandidates(m), [])
    assert.equal(pendingBankView('hdfc_sec', m), 'match_found')
  })

  test('a smaller credit is offered only when it carries the client\'s name', () => {
    const line = { id: 'L', account: 'hdfc' as const, line_date: '2026-10-06', bank_ref: null, remaining: 300000 }
    const big = { ...pay({ amount: 500000, remaining: 500000, proof_note: null }) }
    assert.equal(suggestPaymentsForLine({ ...line, narration: 'NEFT CR-SAMPLE HOTELS LLP-X' }, [big]).length, 1)
    assert.equal(suggestPaymentsForLine({ ...line, narration: 'NEFT CR-DEMO FOODS PVT LTD-X' }, [big]).length, 0)
  })
})

describe('what should stop a person', () => {
  test('nothing, when it all fits', () => {
    assert.deepEqual(candidateDoubts(best(pay(), [credit()]), 'Sample Hotels LLP'), [])
  })

  test('the bank reference outweighs a name and a date, but never the account', () => {
    const c = best(pay({ client_name: 'Another Client', payment_date: '2026-09-20' }), [credit()])
    assert.deepEqual(candidateDoubts(c, 'Another Client'), [])
    const elsewhere = best(pay({ payment_mode: 'hdfc_sec' }), [credit()])
    assert.deepEqual(candidateDoubts(elsewhere, 'Sample Hotels LLP'), ['this credit is in the other HDFC account'])
  })

  test('no reference: a name that does not fit and a far date are said', () => {
    const c = best(pay({ client_name: 'Another Client', proof_note: null, payment_date: '2026-10-01' }), [credit()])
    assert.deepEqual(candidateDoubts(c, 'Another Client'), ['the name does not match', 'the dates are 5 days apart'])
  })

  test('the comparison shows both sides of every fact', () => {
    const rows = compareCandidate(pay(), best(pay(), [credit()]), 375000)
    assert.deepEqual(rows.map(r => r.label), ['Amount', 'Date', 'Account', 'Name', 'UTR'])
    assert.ok(rows.every(r => r.tone === 'same'))
    assert.equal(rows[1].bank, '6 Oct 2026')
  })
})

describe('bank check pending', () => {
  const none: BankMark = { kind: 'none' }
  const uncovered: BankMark = { kind: 'uncovered' }
  const today = '2026-11-01'
  const paid = (days: number) => ({ payment_date: new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10) })

  test('a match found says so', () => {
    assert.deepEqual(bankCheckState(paid(2), mark(pay({ payment_date: '2026-10-06' }), [credit()]), today), { text: 'Match found', tone: 'ok' })
  })

  test('the statement covers the date and nothing is there: red after the limit, quiet before it', () => {
    assert.equal(bankCheckState(paid(BANK_CHECK_LATE_DAYS), none, today).tone, 'quiet')
    assert.deepEqual(bankCheckState(paid(9), none, today), { text: 'No bank credit after 9 days', tone: 'stop' })
  })

  test('an upload that has not happened is not a missing credit', () => {
    assert.deepEqual(bankCheckState(paid(2), uncovered, today), { text: 'Waiting for next upload', tone: 'quiet' })
    assert.deepEqual(bankCheckState(paid(9), uncovered, today), { text: 'Waiting for next upload · 9 days', tone: 'warn' })
  })

  test('its credit on another payment is named as a problem', () => {
    assert.equal(bankCheckState(paid(2), { kind: 'lookalike', lineId: 'L1', lineDate: '2026-10-06', deposit: 1, narration: '', holders: [] }, today).tone, 'warn')
  })
})

describe('words', () => {
  test('how far the statements run', () => {
    assert.equal(statementsRunTo({ hdfc: { first: '2026-09-01', last: '2026-10-28' }, hdfc_sec: { first: '2026-09-01', last: '2026-10-20' } }),
      'Bank statements run: HDFC PRI to 28 Oct 2026 · HDFC SEC to 20 Oct 2026')
    assert.equal(statementsRunTo({}), null)
    assert.equal(statementsRunTo(null), null)
  })

  test('every refusal is a sentence, and nothing else is claimed', () => {
    for (const code of ['PAYMENT_EDIT_NEEDS_BANK_MATCH', 'PAYMENT_NEEDS_BANK_MATCH', 'BANK_PAYMENT_OVER_LINKED', 'BANK_LINE_OVER_LINKED', 'BANK_ACCOUNT_DIFFERS', 'BANK_LINE_CLASSIFIED', 'BANK_CHECK_PENDING_ADMIN_ONLY', 'BANK_REASON_REQUIRED', 'BANK_FORBIDDEN']) {
      assert.ok(bankVerifyRefusal(`${code}: raw text`), code)
      assert.ok(!bankVerifyRefusal(`${code}: raw text`)!.includes(code))
    }
    assert.equal(bankVerifyRefusal('something else'), null)
    assert.equal(bankVerifyRefusal(null), null)
  })

  test('the PI page says the same thing', () => {
    assert.match(describePaymentDecisionError({ code: 'P0001', message: 'PAYMENT_NEEDS_BANK_MATCH: x' }), /has no bank credit covering it/)
  })
})

describe('the rule stays where it is', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
  const NAME = '20270516000000_finance_bank_proof_before_verify.sql'
  const migration = read(`supabase/migrations/${NAME}`)

  test('the file name avoids the word the BOE Credits ledger test reserves, and holds no account number', () => {
    assert.ok(!/credit/i.test(NAME))
    assert.ok(!/\b\d{10,}\b/.test(migration.replace(/\b2027\d{10}\b/g, '')))
  })

  test('it is a trigger on the table, for every door and every person', () => {
    assert.match(migration, /create trigger finance_payment_requests_require_bank_proof\n\s+before update of status, amount, payment_mode on public\.finance_payment_requests/)
    assert.ok(!/auth\.uid\(\)/.test(migration.slice(migration.indexOf('function public.finance_payment_requests_require_bank_proof()'), migration.indexOf('drop trigger if exists finance_payment_requests_require_bank_proof'))))
  })

  test('every door is definer with a fixed search_path and no anon execute; the internals are closed to browsers', () => {
    for (const fn of ['verify_payment_with_bank', 'verify_payment_bank_check_pending', 'finance_bank_check_pending']) {
      const body = migration.slice(migration.indexOf(`create or replace function public.${fn}(`))
      assert.match(body.slice(0, 700), /security definer\s*\nset search_path = public, pg_temp/, fn)
      assert.ok(migration.includes(`revoke all on function public.${fn}(`), fn)
    }
    assert.ok(migration.includes('revoke all on function public.finance_payment_awaits_bank_match(uuid, text, numeric, boolean) from public, anon, authenticated;'))
    assert.ok(migration.includes('revoke all on public.finance_payment_bank_exceptions from public, anon, authenticated;'))
  })

  test('the screen for an HDFC payment offers no plain Verify, and verifies through the bank door', () => {
    const details = read('src/app/finance/paymentRequestsDetails.tsx')
    assert.ok(details.includes("DECISIONS.filter(d => d.key !== 'approve')"))
    const panel = read('src/app/finance/bankMarkUi.tsx')
    assert.ok(panel.includes("rpc('verify_payment_with_bank'"))
    assert.ok(panel.includes("rpc('verify_payment_bank_check_pending'"))
    assert.ok(!panel.includes('approve_finance_payment_request'))
  })

  test('the PI page sends an HDFC payment to Finance instead of approving it', () => {
    assert.ok(read('src/components/orders/PiPaymentCard.tsx').includes('row.verifiedAtBank ?'))
    assert.ok(read('src/lib/finance/piPaymentView.ts').includes("verifiedAtBank: row.payment_mode === 'hdfc' || row.payment_mode === 'hdfc_sec'"))
  })

  test('only an admin is offered Verify, bank check pending', () => {
    assert.ok(read('src/app/finance/page.tsx').includes("canVerifyUrgent={isAdmin && detailRequest.status === 'pending_approval'}"))
  })

  test('the views of Pending are worked out over every pending payment, not one page of them', () => {
    const page = read('src/app/finance/page.tsx')
    assert.ok(page.includes('loadPendingBankPayments(supabase)'))
    assert.ok(page.includes("narrowedTo ? listed.in('id', narrowedTo) : listed"))
    assert.ok(page.includes('bankIdsRef.current = bankIds'))
  })

  test('the open payment reads its own mark, so a payment off this page can still be verified', () => {
    const page = read('src/app/finance/page.tsx')
    assert.ok(page.includes('mark={detailMark?.id === detailRequest.id ? detailMark.mark : undefined}'))
    assert.ok(page.includes("setDetailMark({ id: r.id, mark: undefined, failed: true })"))
  })

  test('a credit opens from its address, in its own month', () => {
    assert.equal(creditHref('L1', '2026-10-06'), '/finance/bank?month=2026-10&credit=L1')
    const view = read('src/app/finance/bank/BankStatementsView.tsx')
    assert.ok(view.includes("useState<string | null>(() => params.get('credit'))"))
    assert.ok(read('src/app/finance/bank/page.tsx').includes('<Suspense'))
  })

  test('the Confirmed Payments edit says the refusal in plain words, not the code', () => {
    assert.ok(read('src/app/finance/received/receivedPaymentsModel.tsx').includes('bankVerifyRefusal(dbError.message)'))
  })

  test('every credit in the window is read, in a fixed order', () => {
    const marks = read('src/lib/finance/bankMarks.ts')
    assert.ok(marks.includes('fetchAllRows<LineRow>'))
    assert.ok(marks.includes(".order('line_date', { ascending: true }).order('id', { ascending: true })"))
    assert.ok(marks.includes('bank_line_payment_links(amount, unlinked_at, payment_id)'))
  })

  test('the address that opens the form from a credit carries only the line', () => {
    assert.ok(read('src/app/finance/page.tsx').includes("searchParams.get('bankLine')"))
  })
})
