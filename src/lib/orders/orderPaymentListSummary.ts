import type { OrderPaymentListRow } from './orderPaymentLists'

// ── The payment list's headline (owner, 2026-10-26) ──────────────────────────
//
// Kept out of orderPaymentLists.ts on purpose: that builder only filters and a
// test holds it to computing nothing. This one adds up what the rows show.

/**
 * WHAT THE DIALOG'S HEADER STATES: how many payments, and the sum of this
 * Order's shares in them. The sum is taken in paise from the same exact strings
 * the rows show, so the header and the rows cannot disagree.
 */
export function paymentListSummary(rows: readonly OrderPaymentListRow[]): { count: number; totalPaise: number } {
  let totalPaise = 0
  for (const row of rows) {
    const n = Number(row.allocated)
    if (Number.isFinite(n)) totalPaise += Math.round(n * 100)
  }
  return { count: rows.length, totalPaise }
}

/**
 * THE ONE PAYER EVERY ROW SHARES, or null when they differ (or none is named).
 * The dialog says it once in its header and repeats a payer on a row only when
 * that row's differs — the ordinary Order has one payer on every payment.
 */
export function commonPayer(rows: readonly OrderPaymentListRow[]): string | null {
  const names = new Set(rows.map(r => (r.client ?? '').trim()).filter(n => n !== ''))
  if (names.size !== 1 || rows.some(r => (r.client ?? '').trim() === '')) return null
  return [...names][0]
}
