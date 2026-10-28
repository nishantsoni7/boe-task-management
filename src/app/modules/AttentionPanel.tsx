'use client'

// ── "Needs your attention" on the Modules launcher ───────────────────────────
//
// The notices that used to stack above the module tiles (open cash handovers,
// attendance requests waiting for a decision) plus the unread counts of the
// modules they belong to, gathered in one column to the right of the tiles and
// split by category: Finance, Orders, Attendance.
//
// A PLACEMENT AND NOTHING ELSE. Every group reads what it read before — the
// handover query, the shared unread-count hooks, the attendance queue — and
// every gate is decided by the page and passed in, so a person who may not open
// Finance or Orders gets no row for them, exactly as they get no tile. A group
// with nothing to show is not drawn; with every group empty the whole column is
// not drawn and the tiles take the full width.

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useOpenHandovers } from '@/hooks/queries/useHandovers'
import { HandoverBanner } from '@/components/finance/HandoverBanner'
import { PendingApprovals } from './PendingApprovals'
import styles from './modules.module.css'

type CountRow = { href: string; label: string; count: number | null | undefined }

/** One link row: what is waiting, the number, and a chevron. */
function AttentionRow({ href, label, count }: { href: string; label: string; count: number }) {
  return (
    <Link href={href} className={styles.attentionRow}>
      <span className={styles.attentionRowLabel}>{label}</span>
      <span className={styles.approvalsCount}>{count > 99 ? '99+' : count}</span>
      <ChevronRight className={styles.approvalChevron} aria-hidden="true" focusable="false" />
    </Link>
  )
}

const hasCount = (row: CountRow | null): row is CountRow & { count: number } =>
  !!row && (row.count ?? 0) > 0

export function AttentionPanel({
  userId,
  financeUnread,
  ordersUnread,
  showAttendance,
}: {
  userId: string | null
  /** null = the signed-in person may not open Finance: no Finance row. */
  financeUnread: number | null | undefined
  /** null = the signed-in person may not open Orders: no Orders row. */
  ordersUnread: number | null | undefined
  showAttendance: boolean
}) {
  // The same query HandoverBanner reads; TanStack dedupes it to one request.
  // Read here only to know whether the Finance group has anything to say.
  const { mine, others, isError } = useOpenHandovers()
  const hasHandovers = isError || mine.length > 0 || others.length > 0

  const finance: CountRow = { href: '/finance', label: 'Unread finance notifications', count: financeUnread }
  const orders: CountRow = { href: '/orders', label: 'Unread order notifications', count: ordersUnread }
  const showFinanceRow = hasCount(finance)
  const showOrdersRow = hasCount(orders)

  const showFinance = hasHandovers || showFinanceRow
  const showAttendanceGroup = showAttendance && !!userId

  // Nothing at all: the column is not drawn. (The attendance group draws
  // itself only when it has requests, so it is always mounted when allowed and
  // an empty parent is hidden by `:empty`-style CSS on the column.)
  if (!showFinance && !showOrdersRow && !showAttendanceGroup) return null

  return (
    <aside className={styles.attention} aria-label="Needs your attention">
      {showFinance && (
        <section className={styles.attentionGroup} aria-labelledby="attention-finance-heading">
          <h2 id="attention-finance-heading" className={styles.attentionTitle}>Finance</h2>
          {showFinanceRow && <AttentionRow {...finance} count={finance.count as number} />}
          {hasHandovers && (
            <div className={styles.attentionHandovers}>
              <HandoverBanner />
            </div>
          )}
        </section>
      )}

      {showOrdersRow && (
        <section className={styles.attentionGroup} aria-labelledby="attention-orders-heading">
          <h2 id="attention-orders-heading" className={styles.attentionTitle}>Orders</h2>
          <AttentionRow {...orders} count={orders.count as number} />
        </section>
      )}

      {showAttendanceGroup && <PendingApprovals userId={userId!} inPanel />}
    </aside>
  )
}
