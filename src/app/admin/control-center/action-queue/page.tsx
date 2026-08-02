'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen, EmptyState, AlertBanner } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import { useViewAs } from '@/hooks/useViewAs'

// ── Types ─────────────────────────────────────────────────────────────────────

type QueueCategory =
  | 'finance_pending_approval'
  | 'finance_needs_clarification'
  | 'finance_suspense'
  | 'order_request_conversion'
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
  finance_suspense:            { label: 'Suspense payment',    actionLabel: 'Link suspense payment' },
  order_request_conversion:    { label: 'Order Request',       actionLabel: 'Convert Order Request' },
  order_change_request:        { label: 'Order change',        actionLabel: 'Review change request' },
}

// Deep-links into the destination page's existing tab/record/modal query-param
// handling (added alongside this queue) — never a new route or page.
//
// The Order Request link points at the request's own detail page, which owns
// the Convert action; `action=convert` is re-checked there against the same
// admin + status='submitted' condition the manual button requires, and `from`
// is the list tab its Back control returns to.
function buildHref(category: QueueCategory, id: string): string {
  switch (category) {
    case 'finance_pending_approval':    return `/finance?tab=pending&request=${id}`
    case 'finance_needs_clarification': return `/finance?tab=clarification&request=${id}`
    case 'finance_suspense':            return `/finance/received?payment=${id}&action=link`
    case 'order_request_conversion':    return `/orders/requests/${id}?from=pending&action=convert`
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
  submitted_by_user: { full_name: string } | null
}

type OrderRequestRow = {
  id: string
  request_number: string
  client_name: string
  total_value: number | null
  created_at: string
  created_by_user: { full_name: string } | null
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
      pendingApprovalRes, needsClarificationRes, suspenseRes, orderRequestsRes, changeRequestsRes,
    ] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        .select('id, request_number, client_name, amount, status, created_at, updated_at, clarification_requested_at, approved_at, submitted_by_user:users!submitted_by(full_name)')
        .eq('status', 'pending_approval'),
      supabase
        .from('finance_payment_requests')
        .select('id, request_number, client_name, amount, status, created_at, updated_at, clarification_requested_at, approved_at, submitted_by_user:users!submitted_by(full_name)')
        .eq('status', 'needs_clarification'),
      supabase
        .from('finance_payment_requests')
        .select('id, request_number, client_name, amount, status, created_at, updated_at, clarification_requested_at, approved_at, submitted_by_user:users!submitted_by(full_name)')
        .eq('status', 'approved_unlinked')
        .is('order_id', null)
        // A payment parked on an Order Request (20260698) is no longer an
        // actionable suspense item — it links itself on conversion.
        .is('order_request_id', null),
      supabase
        .from('order_requests')
        .select('id, request_number, client_name, total_value, created_at, created_by_user:users!created_by(full_name)')
        .eq('status', 'submitted')
        // Only finalized submissions are actionable; upload-stage drafts
        // (finalized_at IS NULL) have no verified Main PI and are not yet real.
        .not('finalized_at', 'is', null),
      // Pending amendments and cancellations raised against Confirmed Orders
      // (20260804000000). order_change_requests_select already scopes this to
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
    const failures = [pendingApprovalRes, needsClarificationRes, suspenseRes, orderRequestsRes, changeRequestsRes]
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
        clientName: r.client_name,
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
        clientName: r.client_name,
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
        clientName: r.client_name,
        ownerName: r.submitted_by_user?.full_name ?? null,
        module: 'Finance',
        amount: r.amount,
        pendingSince: r.approved_at ?? r.created_at,
        href: buildHref('finance_suspense', r.id),
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of ((orderRequestsRes.data ?? []) as any[]) as OrderRequestRow[]) {
      combined.push({
        id: `order_request_conversion:${r.id}`,
        category: 'order_request_conversion',
        actionLabel: CATEGORY_META.order_request_conversion.actionLabel,
        clientName: r.client_name,
        ownerName: r.created_by_user?.full_name ?? null,
        module: 'Orders',
        amount: r.total_value,
        pendingSince: r.created_at,
        href: buildHref('order_request_conversion', r.id),
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
      subtitle="Finance and Order Requests currently waiting on an admin action"
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
