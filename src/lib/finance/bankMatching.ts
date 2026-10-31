// ── Suggesting which recorded payment a bank credit is ──────────────────────
//
// Pure scoring. NOTHING here links, verifies or approves: the page shows the
// ranked candidates with the reasons, and a person presses Link.
//
// SIGNALS, strongest first:
//   reference   the bank's reference (UTR) appears in the payment's reference
//   amount      equal to the paisa (or part of a larger credit, or within a few rupees)
//   name        the payer in the narration against the client of the payment
//   date        the bank date against the recorded payment date
//   account     the payment says it arrived in this account
//
// A bank date and a recorded date differ all the time (recorded later, value
// date, a weekend), so the date is evidence, never a requirement.

import { samePaise, toPaise } from './bankMoney'
import { BANK_ACCOUNT_LABEL, type BankAccountKey } from './bankStatement'

export type MatchLine = {
  id: string
  account: BankAccountKey
  line_date: string
  narration: string
  bank_ref: string | null
  /** Rupees of the credit not yet linked to a payment. */
  remaining: number
}

export type MatchPayment = {
  id: string
  human_payment_id: string | null
  client_name: string | null
  amount: number
  /** Rupees of the payment not yet linked to a bank line. */
  remaining: number
  payment_date: string
  payment_mode: string
  proof_note: string | null
  status: string
}

export type MatchConfidence = 'strong' | 'likely' | 'possible'

export type PaymentSuggestion = {
  paymentId: string
  score: number
  confidence: MatchConfidence
  amountExact: boolean
  reasons: string[]
  warnings: string[]
}

const STOP = new Set([
  'PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'AND', 'OF', 'THE', 'CO', 'COMPANY',
  'INDIA', 'PROP', 'M', 'S', 'MS', 'MR', 'MRS', 'SHRI', 'SMT', 'NEFT', 'RTGS', 'IMPS', 'UPI',
])

export function nameTokens(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
}

/** Share of the client's significant words that the narration contains (a truncated word counts if it is a 4+ letter prefix). */
export function nameOverlap(clientName: string | null, narration: string): number {
  if (!clientName) return 0
  const want = nameTokens(clientName)
  if (want.length === 0) return 0
  const have = nameTokens(narration)
  let hit = 0
  for (const w of want) {
    if (have.some(h => h === w || (Math.min(h.length, w.length) >= 4 && (h.startsWith(w) || w.startsWith(h))))) hit++
  }
  return hit / want.length
}

const dayNumber = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000)
export const daysBetween = (a: string, b: string) => dayNumber(a) - dayNumber(b)

/** Equal, or within ₹500 and 1%: what bank charges or a rounded transfer leave. */
export function amountsClose(a: number, b: number): boolean {
  const diff = Math.abs(toPaise(a) - toPaise(b))
  return diff === 0 || (diff <= 100 * 500 && diff <= Math.max(toPaise(a), toPaise(b)) * 0.01)
}

/** Reference-like tokens of a narration: 10+ characters mixing digits (UTRs, NEFT/RTGS/IMPS numbers). */
export function referenceTokens(line: Pick<MatchLine, 'narration' | 'bank_ref'>): string[] {
  const out = new Set<string>()
  if (line.bank_ref && line.bank_ref.length >= 8) out.add(line.bank_ref.toUpperCase())
  for (const t of line.narration.toUpperCase().split(/[^A-Z0-9]+/)) {
    // An IFSC (KKBK0000958) names a branch, not a payment.
    if (t.length >= 10 && /\d/.test(t) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(t)) out.add(t)
  }
  return [...out]
}

export function suggestPaymentsForLine(line: MatchLine, payments: MatchPayment[], max = 5): PaymentSuggestion[] {
  const refs = referenceTokens(line)
  const out: PaymentSuggestion[] = []

  for (const p of payments) {
    if (p.remaining <= 0 || p.status === 'rejected') continue
    const reasons: string[] = []
    const warnings: string[] = []
    let score = 0

    // reference
    const note = (p.proof_note ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const refHit = note.length >= 8 && refs.some(r => note.includes(r))
    if (refHit) { score += 45; reasons.push('Reference matches the bank reference') }

    // amount
    const amountExact = samePaise(p.remaining, line.remaining)
    const diffPaise = Math.abs(toPaise(p.remaining) - toPaise(line.remaining))
    if (amountExact) {
      score += 50
      reasons.push('Exact amount')
    } else if (p.remaining < line.remaining) {
      score += 8
      reasons.push('Could be part of this credit')
    } else if (diffPaise <= 100 * 500 && diffPaise <= toPaise(line.remaining) * 0.01) {
      score += 18
      reasons.push('Within ₹' + (diffPaise / 100).toFixed(2) + ' of the credit (bank charges?)')
    } else if (!refHit) {
      continue
    }

    // name
    const overlap = nameOverlap(p.client_name, line.narration)
    if (overlap >= 0.99) { score += 25; reasons.push('Name matches ' + p.client_name) }
    else if (overlap >= 0.5) { score += 12; reasons.push('Name partly matches ' + p.client_name) }

    // date
    const d = daysBetween(line.line_date, p.payment_date)
    const ad = Math.abs(d)
    if (ad === 0) { score += 15; reasons.push('Same day') }
    else if (ad <= 3) { score += 12; reasons.push(`${ad} day${ad === 1 ? '' : 's'} ${d > 0 ? 'after' : 'before'} the recorded date`) }
    else if (ad <= 7) { score += 7; reasons.push(`${ad} days ${d > 0 ? 'after' : 'before'} the recorded date`) }
    else if (ad <= 21) { score += 2; warnings.push(`Recorded ${ad} days ${d > 0 ? 'before' : 'after'} the bank date`) }
    else { score -= 10; warnings.push(`Dates are ${ad} days apart`) }

    // account
    if (p.payment_mode === line.account) score += 8
    else if (p.payment_mode === 'hdfc' || p.payment_mode === 'hdfc_sec') {
      score -= 5
      warnings.push(`Recorded as ${BANK_ACCOUNT_LABEL[p.payment_mode as BankAccountKey]}, but this credit is in ${BANK_ACCOUNT_LABEL[line.account]}`)
    }

    if (score < 40) continue

    const strong = amountExact && (refHit || overlap >= 0.99)
    const likely = amountExact && (ad <= 7 || overlap >= 0.5) || score >= 75
    out.push({
      paymentId: p.id,
      score,
      confidence: strong ? 'strong' : likely ? 'likely' : 'possible',
      amountExact,
      reasons,
      warnings,
    })
  }

  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}

/** The payer's name, as far as the narration states one. Display only. */
export function payerFromNarration(narration: string): string | null {
  const n = narration.trim()
  let m = /^(?:NEFT|RTGS) CR-[A-Z0-9]+-(.+?)-(?:BEST ?OF ?EXPORTS?|BESTOFEXPORTS?|[A-Z0-9]{8,})/i.exec(n)
  if (m) return tidy(m[1])
  m = /^IMPS-\d+-(.+?)-[A-Z]{3,5}-X/i.exec(n)
  if (m) return tidy(m[1])
  m = /^UPI-(.+?)-[^-]*@/i.exec(n)
  if (m) return tidy(m[1])
  m = /^FT - CR - \d+ - (.+)$/i.exec(n)
  if (m) return tidy(m[1])
  m = /-TPT-.*-([^-]+)$/i.exec(n)
  if (m) return tidy(m[1])
  return null
}

function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
// ── Money out: which recorded expense is this debit? ────────────────────────

export type MatchDebit = {
  id: string
  line_date: string
  narration: string
  /** Rupees of the debit not yet linked to an expense. */
  remaining: number
}

export type MatchExpense = {
  id: string
  expense_date: string
  paid_to: string
  /** Rupees of the expense not yet linked to a bank debit. */
  remaining: number
  payment_mode: string
  paid_from: 'company' | 'personal' | null
  remark: string | null
}

export type ExpenseSuggestion = {
  expenseId: string
  score: number
  confidence: MatchConfidence
  amountExact: boolean
  reasons: string[]
  warnings: string[]
}

const COMPANY_BANK_MODES = new Set(['bank_transfer', 'upi', 'cheque', 'debit_card', 'credit_card'])

/**
 * Ranked expenses for a bank debit. A suggestion only; a person presses Link.
 * An amount that is not equal (or part of a larger debit) is never suggested:
 * a debit is money that left, and it is the same paisa or it is another thing.
 */
export function suggestExpensesForDebit(debit: MatchDebit, expenses: MatchExpense[], max = 5): ExpenseSuggestion[] {
  const out: ExpenseSuggestion[] = []
  for (const e of expenses) {
    if (e.remaining <= 0) continue
    const reasons: string[] = []
    const warnings: string[] = []
    let score = 0

    const amountExact = samePaise(e.remaining, debit.remaining)
    if (amountExact) { score += 50; reasons.push('Exact amount') }
    else if (e.remaining < debit.remaining) { score += 8; reasons.push('Could be part of this debit') }
    else continue

    const overlap = nameOverlap(e.paid_to, debit.narration)
    if (overlap >= 0.99) { score += 25; reasons.push('Name matches ' + e.paid_to) }
    else if (overlap >= 0.5) { score += 12; reasons.push('Name partly matches ' + e.paid_to) }

    const d = daysBetween(debit.line_date, e.expense_date)
    const ad = Math.abs(d)
    if (ad === 0) { score += 15; reasons.push('Same day') }
    else if (ad <= 3) { score += 12; reasons.push(`${ad} day${ad === 1 ? '' : 's'} ${d > 0 ? 'after' : 'before'} the expense date`) }
    else if (ad <= 7) { score += 7; reasons.push(`${ad} days ${d > 0 ? 'after' : 'before'} the expense date`) }
    else if (ad <= 21) { score += 2; warnings.push(`Recorded ${ad} days ${d > 0 ? 'before' : 'after'} the bank date`) }
    else { score -= 10; warnings.push(`Dates are ${ad} days apart`) }

    if (COMPANY_BANK_MODES.has(e.payment_mode)) score += 5
    else warnings.push(`Recorded as paid by ${e.payment_mode.replace('_', ' ')}`)
    if (e.paid_from === 'personal') { score -= 15; warnings.push('Recorded as paid personally, not from the company') }

    if (score < 40) continue
    const strong = amountExact && overlap >= 0.99
    const likely = amountExact && (ad <= 7 || overlap >= 0.5) || score >= 75
    out.push({ expenseId: e.id, score, confidence: strong ? 'strong' : likely ? 'likely' : 'possible', amountExact, reasons, warnings })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}
// ── The other direction: which bank credit is this payment? ─────────────────

export type LineSuggestion = PaymentSuggestion & {
  lineId: string
}

/**
 * Ranked bank credits for ONE payment. The same scoring as the page that goes
 * the other way (suggestPaymentsForLine), asked once per credit, so the two
 * screens can never disagree about what counts as a match.
 */
export function suggestLinesForPayment(payment: MatchPayment, lines: MatchLine[], max = 3): LineSuggestion[] {
  const out: LineSuggestion[] = []
  for (const line of lines) {
    if (line.remaining <= 0) continue
    const [s] = suggestPaymentsForLine(line, [payment], 1)
    if (s) out.push({ ...s, lineId: line.id })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}
