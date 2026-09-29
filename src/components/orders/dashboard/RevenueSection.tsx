// REVENUE — three figures, together, below the urgent work.
//
// Product value, excluding GST and other charges; each order once, at its current
// approved value; by the date the order was confirmed. The range and the words
// "product value" sit beside every figure so none of them is read as something
// else, and anything left out of a figure is said underneath rather than hidden.
// Drawn only when the read returned revenue — which the database does only for a
// reader who sees every order.

import {
  REVENUE_BASIS,
  REVENUE_METHOD_NOTE,
  REVENUE_TITLE,
  formatRange,
  formatRupees,
  plural,
  revenueGapNotes,
  revenueTiles,
  type DashboardRevenue,
} from '@/lib/orders/orderDashboardSummary'

export function RevenueSection({ revenue }: { revenue: DashboardRevenue | null }) {
  if (!revenue) return null
  const notes = revenueGapNotes(revenue)
  return (
    <section className="od-revenue" aria-labelledby="od-revenue-h">
      <h2 id="od-revenue-h" className="od-revenue-title">{REVENUE_TITLE}</h2>
      <p className="od-revenue-basis">{REVENUE_BASIS}</p>
      <dl className="od-revenue-grid">
        {revenueTiles(revenue).map(t => (
          <div key={t.key} className="od-revenue-tile">
            <dt>{t.label}</dt>
            <dd className="od-revenue-amount">{formatRupees(t.period.amount)}</dd>
            <dd className="od-revenue-range">
              {formatRange(t.period.from, t.period.to)} · {plural(t.period.orders, 'order')}
            </dd>
          </div>
        ))}
      </dl>
      <p className="od-revenue-note">{REVENUE_METHOD_NOTE}</p>
      {notes.length > 0 ? (
        <ul className="od-revenue-gaps">
          {notes.map(n => <li key={n}>{n}</li>)}
        </ul>
      ) : null}
    </section>
  )
}
