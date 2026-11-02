// REVENUE on the admin's dashboard: the same three periods and the same method as RevenueSection,
// drawn compactly beside "Needs your decision". The current month is a plain figure, not red: on the
// second of the month a zero is a date, not a failure. The monthly average gives the other two context.
// Drawn only when the read returned revenue, which the database does only for a reader who sees every order.

import { Info } from 'lucide-react'
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
import { monthlyAverageNote } from '@/lib/orders/adminDashboard'
import styles from './adminDashboard.module.css'

export function AdminRevenueCard({ revenue }: { revenue: DashboardRevenue }) {
  const notes = revenueGapNotes(revenue)
  const noteFor = (key: string, orders: number, amount: number) =>
    key === 'month' ? (orders === 0 ? 'Nothing confirmed yet this month' : null)
    : key === 'six' ? monthlyAverageNote(amount)
    : null
  return (
    <section className={styles.card} aria-labelledby="adm-rev-h">
      <header className={styles.cardHead}>
        <h2 id="adm-rev-h" className={styles.cardTitle}>{REVENUE_TITLE}</h2>
        <span className={styles.tip} title={REVENUE_METHOD_NOTE}><Info size={16} strokeWidth={2} aria-label={REVENUE_METHOD_NOTE} role="img" /></span>
        <span className={styles.tag}>{REVENUE_BASIS}</span>
      </header>
      <div className={styles.revBody}>
        {revenueTiles(revenue).map(t => {
          const note = noteFor(t.key, t.period.orders, t.period.amount)
          return (
            <div key={t.key} className={`${styles.revRow} ${t.key === 'month' ? styles.revHero : ''} ${t.key === 'month' && t.period.orders === 0 ? styles.revZero : ''}`}>
              <div className={styles.revTop}>
                <span className={styles.revLabel}>{t.label}</span>
                <span className={styles.revRange}>{formatRange(t.period.from, t.period.to)}</span>
              </div>
              <div className={styles.revLine}>
                <span className={styles.revAmt}>{formatRupees(t.period.amount)}</span>
                <span className={styles.revMeta}>
                  <span className={styles.pill}>{plural(t.period.orders, 'order')}</span>
                  {note ? <span>{note}</span> : null}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {notes.length > 0 ? (
        <ul className={styles.revGaps}>{notes.map(n => <li key={n}>{n}</li>)}</ul>
      ) : null}
    </section>
  )
}
