'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen, EmptyState, AlertBanner } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { useViewAs } from '@/hooks/useViewAs'
import { RECEIVED_PAYMENTS_SOURCE } from '@/app/finance/paymentRouting'
import { paymentViewClauses } from '@/lib/finance/paymentClassification'

// ── Types ─────────────────────────────────────────────────────────────────────

type QueueCategory =
  | 'finance_pending_approval'
  | 'finance_needs_clarification'
  | 'finance_suspense'
  | 'order_pi_review'
  | 'order_change_request'

type ActionQueueItem = {
  id: string
  category: QueueCategory
  actionLabel: string
  clientName: string
  ownerName: string | null
  module: 'Finance' | 'Orders'
  amount: number | null
  pendingSince: string // ISO timestamp — the sort key
  href: string
}

const CATEGORY_META: Record<QueueCategory, { label: string; actionLabel: string }> = {
  finance_pending_approval:    { label: 'Payment approval',    actionLabel: 'Approve payment' },
  finance_needs_clarification: { label: 'Needs clarification', actionLabel: 'Review clarification' },
  finance_suspense:            { label: 'Suspense payment',    actionLabel: 'Allocate suspense payment' },
  order_pi_review:             { label: 'PI review',           actionLabel: 'Review submitted PI' },
  order_change_request:        { label: 'Order change',        actionLabel: 'Review change request' },
}

// Deep-links into the destination page's existing tab/record/modal query-param
// handling (added alongside this queue) — never a new route or page.
//
// THE ORDER REQUEST CONVERSION ROW IS GONE. It used to sit here, linking to
// /orders/requests/[id]?action=convert — an action the database now refuses
// (20261007000000). What replaced it in the business is the PI review queue, so
// that is what this queue lists: a submitted PI Draft, linking to the PI's own
// detail page, which owns the review decision and re-derives the authority for
// itself.
function buildHref(category: QueueCategory, id: string): string {
  switch (category) {
    case 'finance_pending_approval':    return `/finance?tab=pending&request=${id}`
    case 'finance_needs_clarification': return `/finance?tab=clarification&request=${id}`
    // Suspense money is attached by ALLOCATION now — linking a payment to a
    // single Order was retired, so this sends the reader to Allocate Funds.
    case 'finance_suspense':            return `/finance/received?payment=${id}&action=allocate`
    case 'order_pi_review':             return `/orders/drafts/${id}`
    // The Order detail page owns the Review dialog, and its Change Requests
    // card is where the pending row already lives — so this links to the Order,
    // not to the request. `id` here is therefore the ORDER's id, which is why
    // the row below reads order_id rather than the request's own.
    case 'order_change_request':        return `/orders/${id}`
  }
}

// ── Pending-age label ─────────────────────────────────────────────────────────
// No existing utility formats "Today / 1 day / N days" (src/lib/ui.ts's
// timeAgo/timeSince produce "Xh ago"/"Xd ago"). This mirrors the same
// day-math the rest of the app uses, just with the copy this page needs.
function pendingAgeLabel(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return '1 day'
  return `${days} days`
}

// ── Row-level query types (only the fields this page needs) ──────────────────

type FinanceRow = {
  id: string
  request_number: string
  client_name: string
  amount: number
  status: string
  created_at: string
  updated_at: string
  clarification_requested_at: string | null
  approved_at: string | null
  /** Embedded by the two request-stage queries, which read the base table. */
  submitted_by_user: { full_name: string } | null
  /** Already flattened by the suspense query's projection — see below. */
  submitted_by_name?: string | null
}

type PiReviewRow = {
  id: string
  client_name: string | null
  grand_total: number | null
  created_at: string
  submitted_at: string | null
  submitted_by_user: { full_name: string } | null
}

type OrderChangeRequestRow = {
  id: string
  order_id: string
  order_number_snapshot: string
  request_type: 'edit' | 'cancel'
  proposed_total_value: number | null
  created_at: string
  order: { client_name: string } | null
  requested_by_user: { full_name: string } | null
}

export default function ActionQueuePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ActionQueueItem[]>([])
  const [error, setError] = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, exitViewMode } = useViewAs()

  const loadQueue = async () => {
    setError('')

    const [
      pendingApprovalRes, needsClarificationRes, suspenseRes, piReviewRes, changeRequestsRes,
    ] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        .select('id, request_number, client_name, amount, status, created_at, updated_at, clarification_requested_at, approved_at, submitted_by_user:users!submitted_by(full_name)')
        .eq('status', 'pending_approval'),
      supabase
        .from('finance_payment_requests')
        .select('id, request_number, client_name, amount, status, created_at, updated_at, clarification_requested_at, approved_at, submitted_by_user:users!submitted_by(full_name)')
        .eq('status', 'needs_clarification'),
      // SUSPENSE — money that still needs somebody, which is the only payment
      // state that needs an administrator. Read through RECEIVED_PAYMENTS_SOURCE
      // and scoped by the SAME canonical classification the payments list and
      // its counters use, so this queue cannot disagree with the page it links
      // into.
      //
      // `available` AND NOT "unlinked". Reading the parent columns alone would
      // list money that final PI approval has already moved onto a numbered
      // Order: the allocation moves, the payment record deliberately does not
      // (20260921000000 §7), so order_id stays null. The row would offer "Link
      // suspense payment" for money that is already attached, and the obvious
      // click would attach it twice.
      //
      // It also catches what the old predicate MISSED: a partly allocated
      // payment with a balance left over, and money parked on a retired Order
      // Request that nothing will ever come to collect. Both need an
      // administrator, and neither was in this queue before.
      paymentViewClauses('available').reduce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (query: any, clause) => clause.kind === 'eq' ? query.eq(clause.column, clause.value) : query,
        supabase
          .from(RECEIVED_PAYMENTS_SOURCE)
          .select('id, request_number, client_name, amount, status, created_at, approved_at, submitted_by_name')
          .eq('status', 'approved_unlinked'),
      ),

      // SUBMITTED PI DRAFTS — the pre-approval queue that replaced Order Request
      // conversion. order_submissions_select already scopes this to the people
      // who may see each PI, and this page is admin-only besides.
      supabase
        .from('order_submissions')
        .select('id, client_name, grand_total, created_at, submitted_at, submitted_by_user:users!submitted_by(full_name)')
        .eq('status', 'submitted'),
      // Pending amendments and cancellations raised against Confirmed Orders
      // (20260816000000). order_change_requests_select already scopes this to
      // admins (and to a requester's own rows), so no role filter is needed
      // here — but this page is admin-only anyway.
      supabase
        .from('order_change_requests')
        .select(`
          id, order_id, order_number_snapshot, request_type, proposed_total_value, created_at,
          order:orders!order_id(client_name),
          requested_by_user:users!requested_by(full_name)
        `)
        .eq('status', 'pending'),
    ])

    // Handle partial failure honestly rather than silently rendering an empty queue.
    const failures = [pendingApprovalRes, needsClarificationRes, suspenseRes, piReviewRes, changeRequestsRes]
      .filter(r => r.error)
      .map(r => r.error?.message)
    if (failures.length > 0) {
      setError(`Could not load the full queue: ${failures.join('; ')}`)
    }

    const combined: ActionQueueItem[] = []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toFinance = (rows: any[] | null) => (rows ?? []) as unknown as FinanceRow[]

    for (const r of toFinance(pendingApprovalRes.data)) {
      combined.push({
        id: `finance_pending_approval:${r.id}`,
        category: 'finance_pending_approval',
        actionLabel: CATEGORY_META.finance_pending_approval.actionLabel,
        // NEVER BLANK. client_name is nullable since 20261013000000 §1: a
        // Suspense payment names no customer, and the row still belongs in the
        // queue because somebody is still waiting on it either way.
        clientName: customerDisplayName(r.client_name),
        ownerName: r.submitted_by_user?.full_name ?? null,
        module: 'Finance',
        amount: r.amount,
        pendingSince: r.created_at,
        href: buildHref('finance_pending_approval', r.id),
      })
    }

    for (const r of toFinance(needsClarificationRes.data)) {
      combined.push({
        id: `finance_needs_clarification:${r.id}`,
        category: 'finance_needs_clarification',
        actionLabel: CATEGORY_META.finance_needs_clarification.actionLabel,
        clientName: customerDisplayName(r.client_name),
        ownerName: r.submitted_by_user?.full_name ?? null,
        module: 'Finance',
        amount: r.amount,
        pendingSince: r.clarification_requested_at ?? r.updated_at,
        href: buildHref('finance_needs_clarification', r.id),
      })
    }

    for (const r of toFinance(suspenseRes.data)) {
      combined.push({
        id: `finance_suspense:${r.id}`,
        category: 'finance_suspense',
        actionLabel: CATEGORY_META.finance_suspense.actionLabel,
        clientName: customerDisplayName(r.client_name),
        // Flat on the projection rather than embedded; same value, same null.
        ownerName: r.submitted_by_name ?? null,
        module: 'Finance',
        amount: r.amount,
        pendingSince: r.approved_at ?? r.created_at,
        href: buildHref('finance_suspense', r.id),
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of ((piReviewRes.data ?? []) as any[]) as PiReviewRow[]) {
      combined.push({
        id: `order_pi_review:${r.id}`,
        category: 'order_pi_review',
        actionLabel: CATEGORY_META.order_pi_review.actionLabel,
        // A PI read out of a workbook may carry no client name. The row still
        // belongs in the queue — it is waiting on somebody either way — so it
        // is labelled rather than dropped.
        clientName: r.client_name ?? 'Unnamed client',
        ownerName: r.submitted_by_user?.full_name ?? null,
        module: 'Orders',
        amount: r.grand_total,
        // When it reached review, falling back to when it was created for a row
        // written before submitted_at existed — an unknown must not read as
        // "waiting since today".
        pendingSince: r.submitted_at ?? r.created_at,
        href: buildHref('order_pi_review', r.id),
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of ((changeRequestsRes.data ?? []) as any[]) as OrderChangeRequestRow[]) {
      combined.push({
        id: `order_change_request:${r.id}`,
        category: 'order_change_request',
        actionLabel: r.request_type === 'cancel'
          ? 'Review cancellation request'
          : CATEGORY_META.order_change_request.actionLabel,
        // The Order's live client name, not a snapshot: an amendment may itself
        // be proposing a new one, and the queue should show what the Order says
        // today. The order number rides in the client column's place only when
        // the join is unavailable.
        clientName: r.order?.client_name ?? r.order_number_snapshot,
        ownerName: r.requested_by_user?.full_name ?? null,
        module: 'Orders',
        // Null for a cancellation, and for an edit that proposes no new value —
        // the queue shows a dash rather than implying ₹0 was requested.
        amount: r.proposed_total_value,
        pendingSince: r.created_at,
        href: buildHref('order_change_request', r.order_id),
      })
    }

    combined.sort((a, b) => new Date(a.pendingSince).getTime() - new Date(b.pendingSince).getTime())
    setItems(combined)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: p } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (!p || p.role !== 'admin') { router.push('/dashboard'); return }
      if (viewAsUserId) { exitViewMode(); router.push('/dashboard'); return }

      setProfile(p as UserProfile)
      await loadQueue()
      setLoading(false)
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) return <LoadingScreen />

  return (
    <ControlCenterLayout
      profile={profile}
      title="Action Queue"
      subtitle="Finance and Orders work currently waiting on an admin action"
      onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
    >
      {error && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="red">{error}</AlertBanner>
        </div>
      )}

      {items.length === 0 && !error ? (
        <EmptyState message="No pending Finance or Order actions." />
      ) : (
        <ActionQueueTable items={items} />
      )}
    </ControlCenterLayout>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: 700,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

function ActionQueueTable({ items }: { items: ActionQueueItem[] }) {
  const router = useRouter()
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div className="boe-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '860px' }}>
          <thead>
            <tr>
              <th style={TH_STYLE}>Pending since</th>
              <th style={TH_STYLE}>Action needed</th>
              <th style={TH_STYLE}>Client</th>
              <th style={TH_STYLE}>Owner / submitted by</th>
              <th style={TH_STYLE}>Module</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Direct action</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr
                key={item.id}
                onClick={() => router.push(item.href)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {pendingAgeLabel(item.pendingSince)}
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {item.actionLabel}
                </td>
                <td style={{ ...TD, fontSize: '13px', color: colors.primary }}>
                  {item.clientName}
                  {item.amount != null && (
                    <span style={{ marginLeft: '8px', fontSize: '11px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {formatINR(item.amount)}
                    </span>
                  )}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {item.ownerName ?? '—'}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {item.module}
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <button
                    className="boe-btn boe-btn-ghost"
                    onClick={e => { e.stopPropagation(); router.push(item.href) }}
                    style={{ padding: '5px 12px', fontSize: '12px' }}
                  >
                    {CATEGORY_META[item.category].label} →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
