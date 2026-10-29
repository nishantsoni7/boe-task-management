// ── Founders' payouts: the book, the year, the sums ──────────────────────────
//
// /finance/founders records money BOE pays into the partners' and their
// families' bank accounts (20270501000000). One PAYOUT is one occasion ("Nitish
// needed ₹1.5 lakh; ₹75,000 each into two accounts"); each LINE says which
// account got how much and what kind of money it was. This file turns the
// database's one read (founder_payouts_read) into what the page draws: the
// financial years, the totals per account and per kind, the two sides compared,
// the months, and the equal split of a new payout.
//
// Money is summed in PAISE (integers) so that ₹80,000.50 + ₹0.50 is exactly
// ₹80,001, and shown in rupees.

import { PAYMENT_MODES } from './paymentEntry'
import type { TaxRole } from './founderPayoutTax'

export type FounderPayoutKind = 'partner_remuneration' | 'incentive' | 'interest_on_capital' | 'salary' | 'drawings'

export const FOUNDER_PAYOUT_KINDS: readonly { value: FounderPayoutKind; label: string; short: string }[] = [
  { value: 'partner_remuneration', label: 'Partner remuneration', short: 'Remuneration' },
  { value: 'incentive', label: 'Incentive (orders converted)', short: 'Incentive' },
  { value: 'interest_on_capital', label: 'Interest on capital', short: 'Interest' },
  { value: 'salary', label: 'Salary', short: 'Salary' },
  { value: 'drawings', label: 'Drawings / other', short: 'Drawings' },
]

export const FOUNDER_TAX_ROLES: readonly { value: TaxRole; label: string; hint: string }[] = [
  { value: 'working_partner', label: 'Working partner', hint: 'Named in the partnership deed and works in BOE. Remuneration, incentive and interest are their income.' },
  { value: 'employee', label: 'Employee on salary', hint: 'On the payroll for real work. Salary is their income, with the ₹75,000 standard deduction.' },
  { value: 'family', label: 'Family, not working in BOE', hint: 'Money paid to them is not their income: it counts as the partner’s own drawing given to them.' },
  { value: 'unset', label: 'Role not set yet', hint: 'Choose a role to see how much can be paid tax-free.' },
]

/** The company account a payout left from: the five BOE accounts, cash, other. */
export const FOUNDER_PAID_FROM: readonly { value: string; label: string }[] = [
  ...PAYMENT_MODES.map(m => ({ value: m.value as string, label: m.label as string })),
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

export function kindLabel(kind: string): string {
  return FOUNDER_PAYOUT_KINDS.find(k => k.value === kind)?.label ?? kind
}
export function kindShort(kind: string): string {
  return FOUNDER_PAYOUT_KINDS.find(k => k.value === kind)?.short ?? kind
}
export function roleLabel(role: string): string {
  return FOUNDER_TAX_ROLES.find(r => r.value === role)?.label ?? role
}
export function paidFromLabel(value: string): string {
  return FOUNDER_PAID_FROM.find(p => p.value === value)?.label ?? value
}

/** The kinds a person in this role is normally paid, first one the default. */
export function kindsForRole(role: TaxRole): FounderPayoutKind[] {
  if (role === 'working_partner') return ['partner_remuneration', 'incentive', 'interest_on_capital', 'drawings']
  if (role === 'employee') return ['salary', 'incentive', 'drawings']
  return ['drawings', 'partner_remuneration', 'incentive', 'salary', 'interest_on_capital']
}

// ── The book, as read ────────────────────────────────────────────────────────

export type FounderAccount = {
  id: string
  displayName: string
  side: string
  taxRole: TaxRole
  bankLabel: string | null
  isActive: boolean
}

export type FounderPayoutLine = { id: string; accountId: string; kind: FounderPayoutKind; paise: number }

export type FounderPayout = {
  id: string
  paidOn: string
  paidFrom: string
  note: string | null
  bankReference: string | null
  lines: FounderPayoutLine[]
}

export type FounderBook = {
  accounts: FounderAccount[]
  payouts: FounderPayout[]
  /** `${taxYear}:${accountId}` → other income, paise */
  otherIncome: Map<string, number>
  /** taxYear → expected book profit, paise (null = not typed) */
  bookProfit: Map<number, number | null>
}

export const EMPTY_FOUNDER_BOOK: FounderBook = { accounts: [], payouts: [], otherIncome: new Map(), bookProfit: new Map() }

const ROLES = new Set<string>(['working_partner', 'employee', 'family', 'unset'])
const KINDS = new Set<string>(FOUNDER_PAYOUT_KINDS.map(k => k.value))

export function toPaise(rupees: unknown): number {
  const n = typeof rupees === 'number' ? rupees : Number(rupees)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

type Raw = Record<string, unknown>
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v.filter(x => x && typeof x === 'object') as Raw[]) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** founder_payouts_read() → the book. Unknown values are dropped, never guessed. */
export function parseFounderBook(raw: unknown): FounderBook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw
  const accounts: FounderAccount[] = arr(r.accounts).map(a => ({
    id: str(a.id),
    displayName: str(a.display_name),
    side: str(a.side),
    taxRole: (ROLES.has(str(a.tax_role)) ? str(a.tax_role) : 'unset') as TaxRole,
    bankLabel: strOrNull(a.bank_label),
    isActive: a.is_active !== false,
  })).filter(a => a.id)
  const payouts: FounderPayout[] = arr(r.payouts).map(p => ({
    id: str(p.id),
    paidOn: str(p.paid_on).slice(0, 10),
    paidFrom: str(p.paid_from),
    note: strOrNull(p.note),
    bankReference: strOrNull(p.bank_reference),
    lines: arr(p.lines)
      .filter(l => KINDS.has(str(l.kind)) && str(l.account_id))
      .map(l => ({ id: str(l.id), accountId: str(l.account_id), kind: str(l.kind) as FounderPayoutKind, paise: toPaise(l.amount) })),
  })).filter(p => p.id && /^\d{4}-\d{2}-\d{2}$/.test(p.paidOn))
  const otherIncome = new Map<string, number>()
  for (const y of arr(r.account_years)) otherIncome.set(`${Number(y.tax_year)}:${str(y.account_id)}`, toPaise(y.other_income))
  const bookProfit = new Map<number, number | null>()
  for (const f of arr(r.firm_years)) {
    bookProfit.set(Number(f.tax_year), f.expected_book_profit === null || f.expected_book_profit === undefined ? null : toPaise(f.expected_book_profit))
  }
  return { accounts, payouts, otherIncome, bookProfit }
}

// ── Financial years ──────────────────────────────────────────────────────────

/** The tax year a date belongs to: April onwards is that year, January–March the year before. */
export function taxYearOf(dateIso: string): number {
  const year = Number(dateIso.slice(0, 4))
  const month = Number(dateIso.slice(5, 7))
  return month >= 4 ? year : year - 1
}

export function taxYearLabel(taxYear: number): string {
  return `${taxYear}-${String((taxYear + 1) % 100).padStart(2, '0')}`
}

/** The twelve months of a tax year, April first, as YYYY-MM. */
export function taxYearMonths(taxYear: number): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = ((3 + i) % 12) + 1
    return `${month >= 4 ? taxYear : taxYear + 1}-${String(month).padStart(2, '0')}`
  })
}

/**
 * Whole months still to come in the tax year after the current one: on 29
 * October 2026 that is November to March, 5. A year not started yet has 12; a
 * year that has ended has 0.
 */
export function monthsLeftInTaxYear(todayIso: string, taxYear: number): number {
  const nowIndex = Number(todayIso.slice(0, 4)) * 12 + Number(todayIso.slice(5, 7))
  const marchIndex = (taxYear + 1) * 12 + 3
  const aprilIndex = taxYear * 12 + 4
  if (nowIndex < aprilIndex) return 12
  return Math.max(0, marchIndex - nowIndex)
}

/** Every tax year with a payout, plus the current one, newest first. */
export function availableTaxYears(book: FounderBook, todayIso: string): number[] {
  const years = new Set<number>([taxYearOf(todayIso)])
  for (const p of book.payouts) years.add(taxYearOf(p.paidOn))
  return [...years].sort((a, b) => b - a)
}

// ── The year's sums ──────────────────────────────────────────────────────────

export type FlatLine = FounderPayoutLine & { payout: FounderPayout; account: FounderAccount | undefined }

export type AccountYear = {
  account: FounderAccount
  totalPaise: number
  byKind: Map<FounderPayoutKind, number>
  /** What counts as the person's own income: everything but drawings, for a partner or employee. */
  incomePaise: number
  otherIncomePaise: number
}

export type SideYear = {
  side: string
  totalPaise: number
  incentivePaise: number
  /** The common payments the two sides are kept equal on: everything but incentive. */
  equalSharePaise: number
  accountCount: number
}

export type FounderYear = {
  taxYear: number
  payoutCount: number
  totalPaise: number
  lines: FlatLine[]
  accounts: AccountYear[]
  sides: SideYear[]
  /** month YYYY-MM → side → paise */
  months: Map<string, Map<string, number>>
  /** Remuneration, incentive and salary paid to working partners: what the firm's ceiling is measured against. */
  partnerRemunerationPaise: number
  bookProfitPaise: number | null
}

export function yearLines(book: FounderBook, taxYear: number): FlatLine[] {
  const byId = new Map(book.accounts.map(a => [a.id, a]))
  const out: FlatLine[] = []
  for (const payout of book.payouts) {
    if (taxYearOf(payout.paidOn) !== taxYear) continue
    for (const line of payout.lines) out.push({ ...line, payout, account: byId.get(line.accountId) })
  }
  return out
}

export function summariseYear(book: FounderBook, taxYear: number): FounderYear {
  const lines = yearLines(book, taxYear)
  const accounts: AccountYear[] = book.accounts.map(account => {
    const own = lines.filter(l => l.accountId === account.id)
    const byKind = new Map<FounderPayoutKind, number>()
    for (const l of own) byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + l.paise)
    const incomePaise = account.taxRole === 'working_partner' || account.taxRole === 'employee'
      ? own.filter(l => l.kind !== 'drawings').reduce((s, l) => s + l.paise, 0)
      : 0
    return {
      account,
      totalPaise: own.reduce((s, l) => s + l.paise, 0),
      byKind,
      incomePaise,
      otherIncomePaise: book.otherIncome.get(`${taxYear}:${account.id}`) ?? 0,
    }
  })

  const sideNames = [...new Set(book.accounts.map(a => a.side))].sort((a, b) => a.localeCompare(b))
  const sides: SideYear[] = sideNames.map(side => {
    const own = lines.filter(l => l.account?.side === side)
    const incentivePaise = own.filter(l => l.kind === 'incentive').reduce((s, l) => s + l.paise, 0)
    const totalPaise = own.reduce((s, l) => s + l.paise, 0)
    return {
      side,
      totalPaise,
      incentivePaise,
      equalSharePaise: totalPaise - incentivePaise,
      accountCount: new Set(own.map(l => l.accountId)).size,
    }
  })

  const months = new Map<string, Map<string, number>>()
  for (const m of taxYearMonths(taxYear)) months.set(m, new Map())
  for (const l of lines) {
    const bucket = months.get(l.payout.paidOn.slice(0, 7))
    const side = l.account?.side ?? '—'
    if (bucket) bucket.set(side, (bucket.get(side) ?? 0) + l.paise)
  }

  const payoutIds = new Set(lines.map(l => l.payout.id))
  return {
    taxYear,
    payoutCount: payoutIds.size,
    totalPaise: lines.reduce((s, l) => s + l.paise, 0),
    lines,
    accounts,
    sides,
    months,
    partnerRemunerationPaise: lines
      .filter(l => l.account?.taxRole === 'working_partner' && (l.kind === 'partner_remuneration' || l.kind === 'incentive' || l.kind === 'salary'))
      .reduce((s, l) => s + l.paise, 0),
    bookProfitPaise: book.bookProfit.get(taxYear) ?? null,
  }
}

/** With exactly two sides, how far the first is ahead of the second on the equal share (negative = behind). */
export function equalShareGap(sides: readonly SideYear[]): { ahead: string; behind: string; paise: number } | null {
  if (sides.length !== 2) return null
  const [a, b] = sides
  const diff = a.equalSharePaise - b.equalSharePaise
  if (diff === 0) return { ahead: a.side, behind: b.side, paise: 0 }
  return diff > 0 ? { ahead: a.side, behind: b.side, paise: diff } : { ahead: b.side, behind: a.side, paise: -diff }
}

// ── A new payout ─────────────────────────────────────────────────────────────

/**
 * A total split equally into `count` whole-rupee parts; what does not divide
 * goes to the first: ₹1,00,000 into three is ₹33,334 + ₹33,333 + ₹33,333.
 */
export function splitEqually(totalPaise: number, count: number): number[] {
  if (count <= 0 || totalPaise <= 0) return Array.from({ length: Math.max(0, count) }, () => 0)
  const rupees = Math.floor(totalPaise / 100)
  const each = Math.floor(rupees / count)
  const parts = Array.from({ length: count }, () => each * 100)
  parts[0] += totalPaise - each * 100 * count
  return parts
}

export type DraftLine = { accountId: string; kind: FounderPayoutKind; paise: number }

/** What stops a draft from being saved, in the words the form shows. Empty = ready. */
export function draftProblems(draft: { paidOn: string; paidFrom: string; totalPaise: number; lines: readonly DraftLine[] }, todayIso: string): string[] {
  const problems: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paidOn)) problems.push('Choose the date it was paid.')
  else if (draft.paidOn > todayIso) problems.push('The date must be today or earlier.')
  if (!FOUNDER_PAID_FROM.some(p => p.value === draft.paidFrom)) problems.push('Choose the company account it left from.')
  if (draft.lines.length === 0) problems.push('Pick at least one account.')
  if (draft.lines.some(l => !(l.paise > 0))) problems.push('Every account needs an amount.')
  const seen = new Set<string>()
  for (const l of draft.lines) {
    const key = `${l.accountId}:${l.kind}`
    if (seen.has(key)) { problems.push('The same account appears twice with the same kind; add the amounts together.'); break }
    seen.add(key)
  }
  const sum = draft.lines.reduce((s, l) => s + l.paise, 0)
  if (draft.totalPaise > 0 && sum !== draft.totalPaise) problems.push('The accounts do not add up to the total.')
  return problems
}

// ── Showing money ────────────────────────────────────────────────────────────

/** ₹75,000 — or ₹80,000.50 when there are paise. */
export function formatRupees(paise: number): string {
  const sign = paise < 0 ? '−' : ''
  const abs = Math.abs(paise)
  const whole = abs % 100 === 0
  return `${sign}₹${(abs / 100).toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** ₹6.55 L above a lakh, otherwise ₹75,000. For tiles and meters. */
export function formatLakh(paise: number): string {
  const rupees = Math.abs(paise) / 100
  if (rupees < 100000) return formatRupees(paise)
  const lakh = (rupees / 100000).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
  return `${paise < 0 ? '−' : ''}₹${lakh} L`
}
