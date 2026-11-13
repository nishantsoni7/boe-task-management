'use client'

import { colors } from '@/lib/tokens'
import { ORDER_TOTALS_SHOWN, orderTotalsView, type OrderTotalRow } from '@/lib/finance/orderTotals'
import { fmtAmount } from './receivedPaymentsModel'

/**
 * The confirmed total of the order a search names (owner, 2026-11-12), drawn
 * above the list: "Order 0425 · ₹12,50,000.00 confirmed · 3 payments".
 *
 * It is the money ALLOCATED to that order across every page — not the sum of the
 * Amount cells below, which would count a payment split across two orders whole
 * in both — and it ignores the date and status filters, so it is always the
 * order's whole confirmed amount. Nothing is drawn while there is nothing to
 * say: no term, no match, or a read that failed (a missing figure is better
 * than a wrong one; the list itself is unaffected).
 */
export function OrderTotalsBanner({ rows }: { rows: OrderTotalRow[] | null }) {
  const { lines, more } = orderTotalsView(rows)
  if (lines.length === 0) return null

  const note: React.CSSProperties = { fontSize: '12px', color: colors.muted }
  const money: React.CSSProperties = { fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }
  const frame: React.CSSProperties = {
    padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, background: '#FAF8F5',
    display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: colors.secondary,
  }

  if (lines.length === 1 && more === 0) {
    const only = lines[0]
    return (
      <div role="status" data-order-totals="one" style={frame}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: colors.primary }}>{only.label}</span>
          <span aria-hidden="true" style={{ color: colors.muted }}>·</span>
          <span style={money}>{fmtAmount(only.total)}</span>
          <span>confirmed</span>
          <span aria-hidden="true" style={{ color: colors.muted }}>·</span>
          <span>{only.payments}</span>
        </div>
        <span style={note}>
          Everything confirmed and allocated to this order, whatever the filters below.
        </span>
      </div>
    )
  }

  return (
    <div role="status" data-order-totals="several" style={frame}>
      <span style={note}>Several orders match. Type the full number to see one order&apos;s total.</span>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {lines.map(line => (
          <li key={line.key} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: colors.primary }}>{line.label}</span>
            <span aria-hidden="true" style={{ color: colors.muted }}>·</span>
            <span style={money}>{fmtAmount(line.total)}</span>
            <span style={note}>{line.payments}</span>
          </li>
        ))}
      </ul>
      {more > 0 && <span style={note}>…and {more >= 21 ? 'many' : more} more (showing {ORDER_TOTALS_SHOWN}).</span>}
    </div>
  )
}
