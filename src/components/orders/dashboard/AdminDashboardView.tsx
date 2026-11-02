'use client'

// THE APPROVER'S ORDERS DASHBOARD (owner-approved layout, 2026-11-02):
//
//   Needs your decision | Revenue          what is waiting on me, and how are we doing
//   Orders to watch                        which running orders need chasing
//
// Drawn for a reader who can approve PIs once the overview has arrived; everybody else keeps the
// dashboards they had. Factory Focus and "Operations responses" keep their own sections above it.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DashboardSummary } from '@/lib/orders/orderDashboardSummary'
import { AdminOrdersBoard } from './AdminOrdersBoard'
import { AdminRevenueCard } from './AdminRevenueCard'
import { DecisionQueue } from './DecisionQueue'
import styles from './adminDashboard.module.css'

export function AdminDashboardView({ summary, supabase, viewerId, isAdmin, viewingAs }: {
  summary: DashboardSummary
  supabase: SupabaseClient
  viewerId: string | null
  isAdmin: boolean
  viewingAs: boolean
}) {
  return (
    <div className={styles.root}>
      <div className={summary.revenue ? styles.top : styles.topSolo}>
        <DecisionQueue supabase={supabase} viewerId={viewerId} isAdmin={isAdmin} viewingAs={viewingAs} reloadKey={summary.now} />
        {summary.revenue ? <AdminRevenueCard revenue={summary.revenue} /> : null}
      </div>
      <AdminOrdersBoard summary={summary} />
    </div>
  )
}
