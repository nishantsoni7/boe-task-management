// ── HDFC statement parsing and non-customer suggestions ─────────────────────
//
// Pure functions. The upload route reads the .xls with the xlsx library and
// hands the rows here; nothing in this file touches the network or the database.
//
// THE STATEMENT'S SHAPE (HDFC NetBanking "Statement of accounts" .xls):
//   rows 0-18   address block; "Account No :<number>", "Statement From : dd/mm/yyyy To : dd/mm/yyyy"
//   a header    Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
//   the lines   dd/mm/yy dates, amounts as numbers (or strings with commas)
//   a summary   "STATEMENT SUMMARY" then Opening Balance | Debits | Credits | Closing Bal
//
// EVERY LINE IS CHECKED against the running balance by the parser and again by
// the database (import_bank_statement): a statement that does not add up to the
// paisa is a damaged download and is refused, never repaired.

import { toPaise } from './bankMoney'

export type BankAccountKey = 'hdfc' | 'hdfc_sec'

export const BANK_ACCOUNT_LABEL: Record<BankAccountKey, string> = {
  hdfc: 'HDFC PRI',
  hdfc_sec: 'HDFC SEC',
}

export type ParsedBankLine = {
  seq: number
  line_date: string // ISO yyyy-mm-dd
  value_date: string | null
  narration: string
  bank_ref: string | null
  withdrawal: number
  deposit: number
  balance: number
}

export type ParsedBankStatement = {
  accountNumber: string
  periodFrom: string
  periodTo: string
  openingBalance: number
  closingBalance: number
  declaredDebits: number | null
  declaredCredits: number | null
  lines: ParsedBankLine[]
}

export class BankStatementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BankStatementError'
  }
}

const DATE_SHORT = /^(\d{2})\/(\d{2})\/(\d{2})$/
const DATE_LONG = /^(\d{2})\/(\d{2})\/(\d{4})$/

export function isoFromBankDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  let m = DATE_SHORT.exec(s)
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`
  m = DATE_LONG.exec(s)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  return null
}

/** A cell as a number of rupees: number, or a string with commas; '' is 0; anything else is an error. */
export function cellAmount(raw: unknown): number {
  if (raw === '' || raw === null || raw === undefined) return 0
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new BankStatementError('A statement amount is not a number.')
    return raw
  }
  const s = String(raw).replace(/[,\s]/g, '')
  if (s === '') return 0
  const n = Number(s)
  if (!Number.isFinite(n)) throw new BankStatementError(`"${String(raw)}" is not an amount.`)
  return n
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function parseHdfcStatement(rows: unknown[][]): ParsedBankStatement {
  const flat = rows.map(r => r.map(c => String(c ?? '')).join(' '))

  let accountNumber = ''
  let periodFrom = ''
  let periodTo = ''
  for (const text of flat.slice(0, 40)) {
    const a = /Account No\s*:\s*(\d{6,24})/i.exec(text)
    if (a && !accountNumber) accountNumber = a[1]
    const p = /Statement From\s*:\s*(\d{2}\/\d{2}\/\d{4})\s+To\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)
    if (p && !periodFrom) {
      periodFrom = isoFromBankDate(p[1]) ?? ''
      periodTo = isoFromBankDate(p[2]) ?? ''
    }
  }
  if (!accountNumber) throw new BankStatementError('This does not look like an HDFC statement: no account number found.')
  if (!periodFrom || !periodTo) throw new BankStatementError('The statement period could not be read.')

  const headerIdx = flat.findIndex(t => /Narration/i.test(t) && /Withdrawal/i.test(t) && /Deposit/i.test(t))
  if (headerIdx < 0) throw new BankStatementError('The column headings (Narration, Withdrawal, Deposit) were not found.')

  const summaryIdx = flat.findIndex((t, i) => i > headerIdx && /STATEMENT SUMMARY/i.test(t))
  const end = summaryIdx < 0 ? rows.length : summaryIdx

  const lines: ParsedBankLine[] = []
  for (let i = headerIdx + 1; i < end; i++) {
    const r = rows[i]
    const date = isoFromBankDate(r[0])
    if (!date) {
      // A wrapped narration continues on the next row with no date.
      const extra = String(r[1] ?? '').trim()
      if (extra && !/^\*+$/.test(extra) && lines.length > 0 && String(r[0] ?? '').trim() === '') {
        lines[lines.length - 1].narration += ' ' + extra
      }
      continue
    }
    const withdrawal = round2(cellAmount(r[4]))
    const deposit = round2(cellAmount(r[5]))
    if ((withdrawal === 0) === (deposit === 0) || withdrawal < 0 || deposit < 0) {
      throw new BankStatementError(`Line ${lines.length + 1} (${date}) must have exactly one of withdrawal or deposit.`)
    }
    const ref = String(r[2] ?? '').trim()
    lines.push({
      seq: lines.length + 1,
      line_date: date,
      value_date: isoFromBankDate(r[3]),
      narration: String(r[1] ?? '').trim(),
      bank_ref: ref === '' || /^0+$/.test(ref) ? null : ref,
      withdrawal,
      deposit,
      balance: round2(cellAmount(r[6])),
    })
  }
  if (lines.length === 0) throw new BankStatementError('The statement has no transactions.')

  let openingBalance = NaN
  let closingBalance = NaN
  let declaredDebits: number | null = null
  let declaredCredits: number | null = null
  if (summaryIdx >= 0) {
    const labelRow = flat.findIndex((t, i) => i > summaryIdx && /Opening Balance/i.test(t))
    if (labelRow >= 0) {
      const nums = rows[labelRow + 1].filter(c => c !== '' && c !== null && c !== undefined).map(cellAmount)
      if (nums.length >= 4) {
        openingBalance = round2(nums[0])
        declaredDebits = round2(nums[1])
        declaredCredits = round2(nums[2])
        closingBalance = round2(nums[3])
      }
    }
  }
  if (!Number.isFinite(openingBalance)) {
    // No summary: derive the opening balance from the first line.
    const first = lines[0]
    openingBalance = round2(first.balance - first.deposit + first.withdrawal)
    closingBalance = lines[lines.length - 1].balance
  }

  // The chain: every balance follows from the one before it, to the paisa.
  let prev = toPaise(openingBalance)
  for (const l of lines) {
    const next = prev + toPaise(l.deposit) - toPaise(l.withdrawal)
    if (next !== toPaise(l.balance)) {
      throw new BankStatementError(
        `The balances do not add up at line ${l.seq} (${l.line_date}). The file may be incomplete or edited; download it again from NetBanking.`,
      )
    }
    prev = next
  }
  if (prev !== toPaise(closingBalance)) {
    throw new BankStatementError('The last balance does not equal the closing balance in the statement summary.')
  }
  if (declaredDebits !== null && declaredCredits !== null) {
    const d = lines.reduce((a, l) => a + toPaise(l.withdrawal), 0)
    const c = lines.reduce((a, l) => a + toPaise(l.deposit), 0)
    if (d !== toPaise(declaredDebits) || c !== toPaise(declaredCredits)) {
      throw new BankStatementError('The statement summary totals do not match its lines.')
    }
  }

  return { accountNumber, periodFrom, periodTo, openingBalance, closingBalance, declaredDebits, declaredCredits, lines }
}

// ── What a credit is, from its narration ────────────────────────────────────

export type NonCustomerKind = 'own_transfer' | 'fd_redemption' | 'refund' | 'interest' | 'bank_test' | 'other'

export const NON_CUSTOMER_KIND_LABEL: Record<NonCustomerKind, string> = {
  own_transfer: 'Own account transfer',
  fd_redemption: 'FD redemption',
  refund: 'Refund / reversal',
  interest: 'Interest',
  bank_test: 'Bank test credit',
  other: 'Other, not a customer',
}

/**
 * A suggestion that a credit is NOT customer money. A suggestion only: the credit
 * stays Not matched until a person confirms it with one click, or says it is a
 * customer's and records it.
 */
export function suggestNonCustomerKind(narration: string): { kind: NonCustomerKind; reason: string } | null {
  const n = narration.toUpperCase()
  if (/ACCOUNTVALIDATION/.test(n)) return { kind: 'bank_test', reason: 'Bank account-validation credit' }
  if (/AUTO[_ ]?REDEMPTION/.test(n)) return { kind: 'fd_redemption', reason: 'Fixed deposit auto-redemption' }
  if (/^IB FUNDS TRANSFER CR/.test(n)) return { kind: 'own_transfer', reason: 'Transfer from another HDFC account of the company' }
  if (/^(NEFT|RTGS) CR-[A-Z0-9]+-BEST ?OF ?EXPORTS?\b/.test(n)) return { kind: 'own_transfer', reason: 'Paid by BEST OF EXPORTS itself' }
  if (/^REF-|REFUND|^CRV POS|REVERSAL/.test(n)) return { kind: 'refund', reason: 'Refund or reversal' }
  if (/INTEREST (PAID|CREDIT)|\bINT\.? ?PD\b|CREDIT INTEREST/.test(n)) return { kind: 'interest', reason: 'Interest credit' }
  return null
}
// ── What a debit is, from its narration ─────────────────────────────────────
//
// Most debits on the statements are NOT expenses recorded in the app: supplier
// NEFT/RTGS payments, tax and GST, loan EMIs, transfers to the company's own
// other account, bank charges. A suggestion only — the owner confirms (one at a
// time, or all the shown suggestions at once after seeing them).

export type DebitKind = 'supplier_payment' | 'salary' | 'tax' | 'loan_emi' | 'own_transfer' | 'bank_charges' | 'other'

export const DEBIT_KIND_LABEL: Record<DebitKind, string> = {
  supplier_payment: 'Supplier payment',
  salary: 'Salary',
  tax: 'Tax / GST',
  loan_emi: 'Loan EMI',
  own_transfer: 'Own account transfer',
  bank_charges: 'Bank charges / interest',
  other: 'Other, not an expense',
}

/** Who the money went to, as far as the narration says. Display only. */
export function payeeFromDebitNarration(narration: string): string | null {
  const n = narration.trim()
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
  let m = /^(?:NEFT|RTGS) DR-[A-Z0-9]+-(.+?)-NETBANK/i.exec(n) ?? /^(?:NEFT|RTGS) DR-[A-Z0-9]+-([^-]+)/i.exec(n)
  if (m) return tidy(m[1])
  m = /^IMPS-\d+-(.+?)-[A-Z]{3,5}-X/i.exec(n)
  if (m) return tidy(m[1])
  m = /^IB FUNDS TRANSFER DR-\d+-(.+)$/i.exec(n)
  if (m) return tidy(m[1])
  m = /^UPI-(.+?)-[^-]*@/i.exec(n)
  if (m) return tidy(m[1])
  m = /^\d+-TPT-.*?-([^-]+)$/i.exec(n)
  if (m) return tidy(m[1])
  return null
}

export function suggestDebitKind(narration: string): { kind: DebitKind; reason: string; payee: string | null } | null {
  const n = narration.toUpperCase().trim()
  if (/^IB FUNDS TRANSFER DR/.test(n)) return { kind: 'own_transfer', reason: 'Transfer to another HDFC account', payee: payeeFromDebitNarration(narration) }
  if (/^CBDT\/|^GST\/BANK|\b(CGST|SGST|IGST)\b/.test(n)) return { kind: 'tax', reason: 'Tax or GST payment', payee: null }
  if (/^EMI\b/.test(n)) return { kind: 'loan_emi', reason: 'Loan EMI', payee: null }
  if (/^INTEREST DEBITED|^DC INTL POS TXN|CHARGES|^ANNUAL FEE|MIN(IMUM)? BAL/.test(n)) return { kind: 'bank_charges', reason: 'Bank charge or interest', payee: null }
  if (/^(NEFT|RTGS) DR-|^IMPS-\d+-|^\d+-TPT-/.test(n)) {
    const payee = payeeFromDebitNarration(narration)
    return { kind: 'supplier_payment', reason: payee ? `Bank transfer to ${payee}` : 'Bank transfer', payee }
  }
  return null
}
