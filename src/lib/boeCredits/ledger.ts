// BOE Credits — the pure ledger rules, with no database in sight.
//
// The database is authoritative (the view and boe_credit_balance() both sum the
// ledger on read). These functions exist so a screen that already holds the
// rows can present them without restating the arithmetic in JSX, and so the
// arithmetic can be tested without a database. They must agree with the SQL,
// and ledger.test.ts pins that.

import type { CreditTransaction, CreditTransactionType } from './types'

/** available credits = SUM(signed credits). The whole rule, in one line. */
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

/** The short label a row shows for its kind. */
export function creditTransactionLabel(type: CreditTransactionType): string {
  switch (type) {
    case 'review_reward':    return 'Review reward'
    case 'redemption':       return 'Redeemed'
    case 'reversal':         return 'Reversal'
    case 'admin_adjustment': return 'Adjustment'
  }
}

/** Colour by what happened, matching the other BOE activity trails. */
export function creditTransactionTone(row: Pick<CreditTransaction, 'transaction_type' | 'credits'>): {
  dot: string
  fg: string
} {
  switch (row.transaction_type) {
    case 'review_reward':    return { dot: '#059669', fg: '#047857' }
    case 'redemption':       return { dot: '#4F6FD0', fg: '#3B63B8' }
    case 'reversal':         return { dot: '#B45309', fg: '#B45309' }
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
