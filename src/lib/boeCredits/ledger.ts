// BOE Credits — the pure ledger rules, with no database in sight.
//
// The database is authoritative (the view and the balance functions sum the
// ledger on every read). These functions exist so a screen that already holds
// the rows can present them without restating the arithmetic in JSX, and so
// the arithmetic can be tested without a database. They must agree with the
// SQL, and ledger.test.ts pins that.

import type { CreditTransaction, CreditTransactionType, CreditReviewMonthStatus } from './types'

/** recorded credits = SUM(signed credits). The whole rule, in one line. */
export function sumCredits(rows: readonly Pick<CreditTransaction, 'credits'>[]): number {
  return rows.reduce((total, r) => total + r.credits, 0)
}

/** "350 credits" / "1 credit" / "−50 credits". Employees never see rupees here. */
export function formatCredits(n: number, opts: { signed?: boolean } = {}): string {
  const abs = Math.abs(n)
  const unit = abs === 1 ? 'credit' : 'credits'
  const body = `${abs.toLocaleString('en-IN')} ${unit}`
  if (n < 0) return `−${body}`
  if (opts.signed && n > 0) return `+${body}`
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
  let running = recordedTotal
  return rowsNewestFirst.map(row => {
    const balance_after = running
    running -= row.credits
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
  | { kind: 'review_reward'; card_ref: string | null; review_month: string | null; month_status: CreditReviewMonthStatus | null; reversed: boolean }
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
      return {
        title: month ? `Review verified · ${month}` : 'Review verified',
        detail: meta.card_ref ? `Review ${meta.card_ref}` : null,
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
 * Validate a whole-credit amount the way the database will. Returns the
 * message to show, or null when the amount is fine.
 */
export function creditAmountIssue(value: unknown): string | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'Enter a number of credits.'
  if (!Number.isInteger(n)) return 'Credits are whole numbers.'
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
