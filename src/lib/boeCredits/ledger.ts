// BOE Credits — the pure ledger rules, with no database in sight.
//
// The database is authoritative (the view and the balance functions sum the
// ledger on every read). These functions exist so a screen that already holds
// the rows can present them without restating the arithmetic in JSX, and so
// the arithmetic can be tested without a database. They must agree with the
// SQL, and ledger.test.ts pins that.

import type { CreditTransaction, CreditTransactionType, CreditReviewMonthStatus } from './types'

/**
 * Credits carry at most two decimal places — numeric(12,2) in the database, so
 * 1.5 is one and a half credits. Arithmetic on them is done in HUNDREDTHS, so
 * binary-float noise (0.1 + 0.2) never reaches a total or a label.
 */
export const CREDIT_DECIMAL_PLACES = 2

/** The nearest hundredth of a credit. */
export function roundCredits(n: number): number {
  return Math.round(n * 100) / 100
}

/** True when a finite number has at most two decimal places. */
export function hasCreditPrecision(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
}

/** recorded credits = SUM(signed credits). The whole rule, in one line — summed in hundredths. */
export function sumCredits(rows: readonly Pick<CreditTransaction, 'credits'>[]): number {
  return rows.reduce((total, r) => total + Math.round(r.credits * 100), 0) / 100
}

/** "1.5" / "1" / "12,500" — at most two decimals, never a trailing zero. */
export function formatCreditNumber(n: number): string {
  return roundCredits(n).toLocaleString('en-IN', { maximumFractionDigits: CREDIT_DECIMAL_PLACES })
}

/** "350 credits" / "1 credit" / "1.5 credits" / "−50 credits". Employees never see rupees here. */
export function formatCredits(n: number, opts: { signed?: boolean } = {}): string {
  const value = roundCredits(n)
  const abs = Math.abs(value)
  const unit = abs === 1 ? 'credit' : 'credits'
  const body = `${formatCreditNumber(abs)} ${unit}`
  if (value < 0) return `−${body}`
  if (opts.signed && value > 0) return `+${body}`
  return body
}

/** The short label a row shows for its kind — the fallback when no richer description applies. */
export function creditTransactionLabel(type: CreditTransactionType): string {
  switch (type) {
    case 'review_reward':      return 'Review reward'
    case 'redemption':         return 'Redeemed'
    case 'reversal':           return 'Reversal'
    case 'admin_adjustment':   return 'Adjustment'
    case 'review_month_lapse': return 'Month lapsed'
  }
}

/** Colour by what happened, matching the other BOE activity trails. */
export function creditTransactionTone(row: Pick<CreditTransaction, 'transaction_type' | 'credits'>): {
  dot: string
  fg: string
} {
  switch (row.transaction_type) {
    case 'review_reward':      return { dot: '#059669', fg: '#047857' }
    case 'redemption':         return { dot: '#4F6FD0', fg: '#3B63B8' }
    case 'reversal':           return { dot: '#B45309', fg: '#B45309' }
    case 'review_month_lapse': return { dot: '#DC2626', fg: '#B91C1C' }
    case 'admin_adjustment':
      return row.credits >= 0
        ? { dot: '#059669', fg: '#047857' }
        : { dot: '#DC2626', fg: '#B91C1C' }
  }
}

/** Newest first, ties broken by id so the order is stable across reloads. */
export function sortNewestFirst<T extends Pick<CreditTransaction, 'created_at' | 'id'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

/**
 * The balance after each row, walking newest-first from the recorded total.
 *
 * Exact whatever the page size: the newest row's balance-after IS the total,
 * and each older row's is the next-newer one minus that row's credits — so a
 * capped history still shows the right running figure on every row it holds.
 */
export function withRunningBalance<T extends Pick<CreditTransaction, 'credits'>>(
  rowsNewestFirst: readonly T[],
  recordedTotal: number,
): (T & { balance_after: number })[] {
  // In hundredths, so a decimal history walks back without float drift.
  let running = Math.round(recordedTotal * 100)
  return rowsNewestFirst.map(row => {
    const balance_after = running / 100
    running -= Math.round(row.credits * 100)
    return { ...row, balance_after }
  })
}

// ─── Human descriptions ───────────────────────────────────────────────────────
//
// The ledger row carries a type, a source and a description written at posting
// time. The route joins the Phase 1C/1D record tables and hands each row a
// small `meta`; from that, one function writes the sentence an employee reads.
// No database code or enum name reaches the screen.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "September 2026" from a YYYY-MM-01 review month. */
export function reviewMonthLabel(reviewMonth: string, opts: { year?: boolean } = {}): string {
  const [y, m] = reviewMonth.split('-').map(Number)
  const name = MONTH_NAMES[m - 1] ?? reviewMonth
  return opts.year === false ? name : `${name} ${y}`
}

export type CreditTransactionMeta =
  | { kind: 'review_reward'; card_ref: string | null; review_month: string | null; month_status: CreditReviewMonthStatus | null; reversed: boolean; custom?: boolean }
  | { kind: 'attendance_redemption'; deduction_type: 'half_day' | 'absent'; attendance_date: string; reversed: boolean }
  | { kind: 'payroll_redemption'; payroll_month: number | null; payroll_year: number | null; credit_amount: number | null; reversed: boolean }
  | { kind: 'review_month_lapse'; review_month: string | null }
  | { kind: 'reversal_of'; original: CreditTransactionMeta | null; original_type: CreditTransactionType | null }
  | { kind: 'none' }

/** What a row is, in words, plus the status word a provisional reward carries. */
export type CreditTransactionDescription = {
  title: string
  detail: string | null
  /** For a review reward: whether its credit can be spent yet. */
  status: 'pending' | 'available' | 'lapsed' | 'reversed' | null
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${d} ${MONTH_NAMES[m - 1]?.slice(0, 3) ?? ''} ${y}`
}

function payrollLabel(month: number | null, year: number | null): string | null {
  if (!month || !year) return null
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`
}

export function describeCreditTransaction(
  row: Pick<CreditTransaction, 'transaction_type' | 'credits' | 'description'>,
  meta: CreditTransactionMeta,
): CreditTransactionDescription {
  switch (row.transaction_type) {
    case 'review_reward': {
      if (meta.kind !== 'review_reward') return { title: 'Review verified', detail: row.description, status: null }
      const month = meta.review_month ? reviewMonthLabel(meta.review_month, { year: false }) : null
      const status: CreditTransactionDescription['status'] =
        meta.reversed ? 'reversed'
        : meta.month_status === 'open' ? 'pending'
        : meta.month_status === 'lapsed' ? 'lapsed'
        : 'available'
      // A Custom Review Submission earns the same kind of reward, approved rather than verified.
      const noun = meta.custom ? 'Custom review' : 'Review'
      const verb = meta.custom ? 'approved' : 'verified'
      return {
        title: month ? `${noun} ${verb} · ${month}` : `${noun} ${verb}`,
        detail: meta.card_ref ? `${noun} ${meta.card_ref}` : null,
        status,
      }
    }
    case 'redemption': {
      if (meta.kind === 'attendance_redemption') {
        return {
          title: meta.deduction_type === 'half_day' ? 'Half Day covered' : 'Full Day covered',
          detail: dayLabel(meta.attendance_date),
          status: null,
        }
      }
      if (meta.kind === 'payroll_redemption') {
        const label = payrollLabel(meta.payroll_month, meta.payroll_year)
        return {
          title: label ? `Applied to ${label} payroll` : 'Applied to payroll',
          detail: meta.credit_amount != null ? `Salary addition of ₹${meta.credit_amount.toLocaleString('en-IN')}` : null,
          status: null,
        }
      }
      return { title: 'Credits used', detail: row.description, status: null }
    }
    case 'reversal': {
      const o = meta.kind === 'reversal_of' ? meta : null
      if (o?.original_type === 'review_reward') return { title: 'Review reward reversed', detail: row.description, status: null }
      if (o?.original?.kind === 'attendance_redemption') {
        return {
          title: 'Credits restored',
          detail: `${o.original.deduction_type === 'half_day' ? 'Half Day' : 'Full Day'} · ${dayLabel(o.original.attendance_date)}`,
          status: null,
        }
      }
      if (o?.original?.kind === 'payroll_redemption') {
        const label = payrollLabel(o.original.payroll_month, o.original.payroll_year)
        return { title: 'Payroll credit application reversed', detail: label, status: null }
      }
      return { title: 'Reversal', detail: row.description, status: null }
    }
    case 'review_month_lapse': {
      const month = meta.kind === 'review_month_lapse' && meta.review_month ? reviewMonthLabel(meta.review_month, { year: false }) : null
      return {
        title: month ? `${month} review credits lapsed` : 'Review credits lapsed',
        detail: 'The monthly target was not reached',
        status: null,
      }
    }
    case 'admin_adjustment':
      return { title: row.credits >= 0 ? 'Credits added by admin' : 'Credits removed by admin', detail: row.description, status: null }
  }
}

/** The word beside a provisional reward. */
export const REWARD_STATUS_LABELS: Record<NonNullable<CreditTransactionDescription['status']>, string> = {
  pending:   'Pending monthly target',
  available: 'Available',
  lapsed:    'Lapsed',
  reversed:  'Reversed',
}

/**
 * Validate a credit amount the way the database will: non-zero, at most two
 * decimal places. Returns the message to show, or null when the amount is fine.
 */
export function creditAmountIssue(value: unknown): string | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'Enter a number of credits.'
  if (!hasCreditPrecision(n)) return 'Credits can have at most two decimal places.'
  if (n === 0) return 'A zero-credit entry moves nothing and is not recorded.'
  if (Math.abs(n) > 1_000_000) return 'That is more credits than any adjustment should move.'
  return null
}

/** A reason is mandatory for an adjustment. Trimmed; empty is refused. */
export function creditReasonIssue(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return 'A reason is required.'
  if (s.length > 500) return 'Keep the reason under 500 characters.'
  return null
}
