// ── The confirmed total of the order a search names ───────────────────────────
//
// When the Confirmed Payments search names an order, the page says how much
// confirmed money that order has — the sum of what was ALLOCATED to it, from
// finance_order_confirmed_totals() (20270701000000). It is not the sum of the
// visible payments' amounts: one payment split across two orders would count
// whole in both. No React, no network.

import { allocationTargetLabel } from './allocatedAgainst'
import { sanitizeSearchTerm } from '@/app/finance/listQuery'

/** The shortest term worth asking about: "04" would name half the orders. */
export const ORDER_TOTALS_MIN_TERM = 3
/** How many matched orders the banner lists before it says "and N more". */
export const ORDER_TOTALS_SHOWN = 5

/** One row of finance_order_confirmed_totals(). */
export type OrderTotalRow = {
  target_type: 'order' | 'pi_draft' | 'legacy_order'
  target_reference: string | null
  reserved_order_number: string | null
  target_client_name: string | null
  payments_count: number
  confirmed_total: string | number | null
}

/**
 * The term to ask about, or null when there is nothing worth asking: the same
 * literal the list searches by (sanitizeSearchTerm), at least 3 characters.
 */
export function orderTotalsTerm(search: string): string | null {
  const term = sanitizeSearchTerm(search)
  return term.length >= ORDER_TOTALS_MIN_TERM ? term : null
}

export type OrderTotalLine = {
  key: string
  /** "Order 0425", "PI Draft · PID-00012 · Reserved 0431", "Old order AB-12 · Client". */
  label: string
  /** "3 payments". */
  payments: string
  /** The exact total, as the database sent it. */
  total: string
}

export const paymentsCountLabel = (n: number) => `${n} ${n === 1 ? 'payment' : 'payments'}`

/**
 * What the banner draws: the first ORDER_TOTALS_SHOWN orders, and how many more
 * matched (the database answers at most 26; 26 is "many").
 */
export function orderTotalsView(rows: readonly OrderTotalRow[] | null): { lines: OrderTotalLine[]; more: number } {
  if (!rows || rows.length === 0) return { lines: [], more: 0 }
  const lines = rows.slice(0, ORDER_TOTALS_SHOWN).map((row, i) => ({
    key: `${row.target_type}:${row.target_reference ?? i}:${i}`,
    label: allocationTargetLabel(row),
    payments: paymentsCountLabel(row.payments_count),
    total: String(row.confirmed_total ?? '0'),
  }))
  return { lines, more: Math.max(0, rows.length - ORDER_TOTALS_SHOWN) }
}
