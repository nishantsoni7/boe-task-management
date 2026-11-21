'use client'

// THE APPROVER'S ORDERS DASHBOARD (owner-approved preview, 2026-11-20; the 2026-11-02 layout it replaces
// had "Needs your decision | Revenue" over "Orders to watch"):
//
//   New PIs to approve · Changes on running orders        on the reader
//   Clarifications from Operations · Waiting on others    on the reader · with Sales or Operations
//
// Drawn for a reader who can approve PIs once the overview has arrived; everybody else keeps the
// dashboards they had. "Orders to watch" (AdminOrdersBoard) is no longer drawn here. Factory Focus keeps its
// own section above. Operations' answers are cards rows now, so the page does not draw them separately here.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DashboardSummary } from '@/lib/orders/orderDashboardSummary'
import type { ChangeResponse } from '@/lib/orders/operationsDashboard'
import { DecisionQueue, type EarlyDecisionRead } from './DecisionQueue'
import styles from './adminDashboard.module.css'

export function AdminDashboardView({ summary, answers, supabase, viewerId, isAdmin, canReviewChanges, viewingAs, early }: {
  summary: DashboardSummary
  /** Operations' answers on revised PIs, from the page's own Operations read; empty when it is not available. */
  answers: readonly ChangeResponse[]
  supabase: SupabaseClient
  viewerId: string | null
  isAdmin: boolean
  /** The acting administrator (role admin, not under View As): the only reader asked to decide change requests. */
  canReviewChanges: boolean
  viewingAs: boolean
  /** The list's read, started by the page beside its own (first batch); null when it did not start one. */
  early?: EarlyDecisionRead | null
}) {
  return (
    <div className={styles.root}>
      <DecisionQueue
        supabase={supabase} viewerId={viewerId} isAdmin={isAdmin} canReviewChanges={canReviewChanges} viewingAs={viewingAs} early={early}
        reloadKey={summary.now} alignment={summary.notAligned} reviewerName={summary.reviewer?.name ?? null} answers={answers}
      />
    </div>
  )
}
