import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { payeeFromDebitNarration, suggestDebitKind } from './bankStatement'
import { suggestExpensesForDebit, type MatchExpense } from './bankMatching'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const kind = (n: string) => suggestDebitKind(n)?.kind ?? null

describe('what a debit looks like', () => {
  test('the debits seen in the September and October statements', () => {
    assert.equal(kind('NEFT DR-HSBC0560002-WOODTECH CONSULTANTS PVT LTD-NETBANK, MUM-HDFCH01229367579-BB54N17882538011606656646'), 'supplier_payment')
    assert.equal(kind('RTGS DR-RMGB0000657-KAMAL HANDICRAFTS-NETBANK, MUM-HDFCR52026090253733596-BB54R1788322241129336'), 'supplier_payment')
    assert.equal(kind('50200033910868-TPT-HDFC8C8E6CB2F844-S K SHAH AND CO'), 'supplier_payment')
    assert.equal(kind('IMPS-625939486199-SS INTERIOR AND EXHIBITIONS-CNRB-XXXXXXXX9711-SS INTERIOR'), 'supplier_payment')
    assert.equal(kind('CBDT/BANK REFERENCE NO:K2625052966670/CIN NO:26090700526618HDFC/ONLINE'), 'tax')
    assert.equal(kind('GST/BANK REFERENCE NO: R2626275724977/CIN NO: HDFC26090800090921'), 'tax')
    assert.equal(kind('EMI 167512667 CHQ S16751266718 0926167512667'), 'loan_emi')
    assert.equal(kind('IB FUNDS TRANSFER DR-50200102461169-BEST OF EXPORTS'), 'own_transfer')
    assert.equal(kind('INTEREST DEBITED TILL 30-SEP-2026'), 'bank_charges')
    assert.equal(kind('DC INTL POS TXN MARKUP+ST 010926-EPR2724815409079'), 'bank_charges')
  })

  test('card, UPI and gateway payments are left for a person: they may be recorded expenses', () => {
    assert.equal(kind('POS 514834XXXXXX4804 261996 06SEP26 17:26:59 DUBLIN ADOBE'), null)
    assert.equal(kind('UPI-AMAZON INDIA-AMAZON@RAPL-RATN000RAPL-624538139515-LAPTOP BAG MOUSE'), null)
    assert.equal(kind('ME DC SI 514834XXXXXX4804 ANTHROPIC* CLAUDE SUB'), null)
    assert.equal(kind('114901473001/CCAMAKEMYTRIPINDIAPR'), null)
  })

  test('the payee is read from each style of debit', () => {
    assert.equal(payeeFromDebitNarration('NEFT DR-HSBC0560002-WOODTECH CONSULTANTS PVT LTD-NETBANK, MUM-HDFCH01229367579-BB54N1788'), 'WOODTECH CONSULTANTS PVT LTD')
    assert.equal(payeeFromDebitNarration('IMPS-625939486199-SS INTERIOR AND EXHIBITIONS-CNRB-XXXXXXXX9711-SS INTERIOR'), 'SS INTERIOR AND EXHIBITIONS')
    assert.equal(payeeFromDebitNarration('50200033910868-TPT-HDFC8C8E6CB2F844-S K SHAH AND CO'), 'S K SHAH AND CO')
    assert.equal(payeeFromDebitNarration('UPI-BHASKAR ADCOM-Q497593907@YBL-YESB0YBLUPI-625078716650-BHASKAR AD'), 'BHASKAR ADCOM')
    assert.equal(payeeFromDebitNarration('CBDT/BANK REFERENCE NO:K2625052966670'), null)
  })

  test('a supplier suggestion carries the payee so marking it needs no typing', () => {
    assert.equal(suggestDebitKind('NEFT DR-ICIC0006833-ADINATH DEVELOPERS-NETBANK, MUM-HDFCH00902644085')?.payee, 'ADINATH DEVELOPERS')
  })
})

describe('suggestExpensesForDebit', () => {
  const debit = { id: 'D1', line_date: '2026-10-04', remaining: 8127, narration: 'UPI-SALAWAS DURRY UDHYOG-SALAWASDURRY@YBL-UCBA0001301-627727734474-DURRY' }
  const exp = (over: Partial<MatchExpense>): MatchExpense => ({
    id: 'E1', expense_date: '2026-10-04', paid_to: 'Salawas Durry Udhyog', remaining: 8127, payment_mode: 'upi', paid_from: 'company', remark: 'durry', ...over,
  })

  test('same amount, same payee, same day is strong and explains itself', () => {
    const [s] = suggestExpensesForDebit(debit, [exp({})])
    assert.equal(s.confidence, 'strong')
    assert.ok(s.reasons.includes('Exact amount'))
  })

  test('a different amount is never suggested; a smaller one is offered as part of the debit', () => {
    assert.equal(suggestExpensesForDebit(debit, [exp({ remaining: 9000 })]).length, 0)
    assert.equal(suggestExpensesForDebit({ ...debit, remaining: 10000 }, [exp({})])[0].amountExact, false)
  })

  test('a cash or personally-paid expense is still found, with a warning', () => {
    const [s] = suggestExpensesForDebit(debit, [exp({ payment_mode: 'cash', paid_from: 'personal' })])
    assert.ok(s)
    assert.ok(s.warnings.some(w => /personally/.test(w)))
    assert.ok(s.warnings.some(w => /cash/.test(w)))
  })

  test('an expense already fully linked is not offered', () => {
    assert.equal(suggestExpensesForDebit(debit, [exp({ remaining: 0 })]).length, 0)
  })
})

describe('the money-out migration', () => {
  const SQL = read('supabase/migrations/20270330000000_finance_bank_money_out.sql')
  test('depends on the bank migration and holds no account number', () => {
    assert.ok(SQL.includes("to_regprocedure('public.assert_bank_reconcile_door()')"))
    assert.ok(!/\b\d{10,}\b/.test(SQL.replace(/20270330000000|20270329000000/g, '')))
  })
  test('every RPC is definer with a fixed search_path, asks the reconcile door first and is closed to anon', () => {
    for (const fn of ['link_bank_debit_to_expense', 'unlink_bank_debit_expense', 'classify_bank_debits', 'clear_bank_line_classification']) {
      assert.ok(SQL.includes(`revoke all on function public.${fn}(`), fn)
      assert.ok(SQL.includes(`grant execute on function public.${fn}(`), fn)
    }
    assert.equal((SQL.match(/security definer\nset search_path = public, pg_temp/g) ?? []).length, 4)
    assert.equal((SQL.match(/assert_bank_reconcile_door\(\);/g) ?? []).length, 4)
  })
  test('the links table is read-only to clients', () => {
    assert.ok(SQL.includes('revoke all on public.bank_line_expense_links from public, anon, authenticated'))
    assert.ok(SQL.includes('grant select on public.bank_line_expense_links to authenticated'))
  })
})

describe('money-out screens never touch an expense', () => {
  test('no bank file calls an expense write RPC or writes a table', () => {
    for (const f of ['src/app/finance/bank/bankDebitPanel.tsx', 'src/app/finance/bank/BankStatementsView.tsx']) {
      const src = read(f)
      for (const rpc of ['finalize_expense_draft', 'record_expense_reimbursement', 'reverse_expense_reimbursement']) {
        assert.ok(!src.includes(rpc), `${f} must not call ${rpc}`)
      }
      assert.ok(!/\.from\('expenses'\)\s*\.(insert|update|delete|upsert)/.test(src))
    }
  })
})
