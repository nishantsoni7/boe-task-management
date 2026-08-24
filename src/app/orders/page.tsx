'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'
import {
  deriveOrdersCapabilities,
  NO_ORDERS_CAPABILITIES,
  type OrdersCapabilities,
} from '@/lib/permissions/orders'
import {
  NEW_ORDER_ACTION,
  NO_ORDER_DASHBOARD_COUNTS,
  ORDER_DASHBOARD_SUBTITLE,
  orderDashboardCards,
  type OrderDashboardCounts,
} from '@/lib/orders/orderDashboard'
import { PI_DRAFT_LIST_STATUSES } from '@/lib/orders/draftsView'
import { RECEIVED_PAYMENTS_SOURCE } from '@/app/finance/paymentRouting'

// ── Types ─────────────────────────────────────────────────────────────────────

type Order = {
  id: string
  display_number: string
  client_name: string
  assigned_to: string | null
  assigned_to_name?: string
  due_date: string | null
  total_value: number | null
  status: string
}

/**
 * The figures above the list.
 *
 * `runningValue` is the only one that is not a card count — it is the money on
 * the floor right now, and it sits beside the list it describes.
 */
type DashboardStats = OrderDashboardCounts & { runningValue: number }

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  running:            { label: 'Running',             bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  on_hold:            { label: 'On Hold',             bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  dispatched:         { label: 'Dispatched',          bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  cancelled:          { label: 'Cancelled',           bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(n: number | null) {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN')
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function isOverdue(due_date: string | null, status: string): boolean {
  if (!due_date) return false
  if (['dispatched', 'cancelled'].includes(status)) return false
  return new Date(due_date) < new Date()
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// ── Dashboard stat card ───────────────────────────────────────────────────────

/**
 * `value` may be null, which renders as a quiet placeholder rather than a "0".
 *
 * A count that has not landed and a count that is genuinely zero are different
 * statements, and printing "0" for the first is how a dashboard tells somebody
 * there is nothing waiting when it simply has not asked yet.
 */
function StatCard({
  label, value, sub, accent, onClick,
}: {
  label: string
  value: string | number | null
  sub?: string
  accent?: string
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        padding: '16px 20px',
        display: 'flex', flexDirection: 'column', gap: '4px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.15s',
        minWidth: 0,
      }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
    >
      <div style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: value === null ? colors.muted : (accent ?? colors.primary), letterSpacing: '-0.02em', lineHeight: 1.2 }}>
        {value === null ? '—' : value}
      </div>
      {sub && <div style={{ fontSize: '11px', color: colors.muted }}>{sub}</div>}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrdersDashboardPage() {
  const [pageLoading, setPageLoading] = useState(true)
  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  // The three money cards read Finance data, so they are gated on Finance
  // capabilities rather than on the admin role. Starts empty so none can flash.
  const [financeCaps, setFinanceCaps] = useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)
  // Drives the Upload PI entry point and the Review Queue card. Starts empty so
  // neither can flash for somebody who is not allowed them; /orders/import and
  // the review controls each enforce their own grant server-side, because hiding
  // a control is not access control.
  const [ordersCaps, setOrdersCaps] = useState<OrdersCapabilities>(NO_ORDERS_CAPABILITIES)
  const [orders,      setOrders]      = useState<Order[]>([])
  const [stats,       setStats]       = useState<DashboardStats>({
    ...NO_ORDER_DASHBOARD_COUNTS, runningValue: 0,
  })
  const [listLoading, setListLoading] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  /**
   * The list, and every figure above it.
   *
   * ALL OF THEM TOGETHER. The list used to be awaited on its own and the stats
   * issued afterwards, which made the dashboard exactly as slow as its slowest
   * query PLUS its list — for no reason, because not one of them depends on
   * another's answer.
   *
   * AND IT TAKES NO CAPABILITIES, deliberately. Every query below is scoped by
   * RLS, so each count is already exactly what this reader may see, and gating
   * the queries on the permission resolver would put the whole dashboard behind
   * a second round trip to save two `head: true` counts. WHICH CARDS ARE DRAWN
   * is a separate decision, made by orderDashboardCards once the capabilities
   * land — and a card that is not drawn shows nobody a number.
   *
   * EVERY FIGURE IS STILL THE DATABASE'S. It would be tempting to derive
   * `runningValue` from the list, which already carries total_value for exactly
   * the running Orders — but the list and the count answer to the SAME RLS and
   * a derived figure would silently become a client-side aggregate the day one
   * of them gains a limit. The counts stay counts.
   */
  const loadData = async () => {
    setListLoading(true)

    const [
      { data: runningData },
      { count: activeCount },
      { data: runningValueData },
      { count: overdueCount },
      { count: draftCount },
      { count: reviewCount },
      { count: awaitingCount },
      availableRes,
    ] = await Promise.all([
      supabase
        .from('orders')
        .select(`
          id, display_number, client_name, assigned_to, due_date, total_value, status,
          assigned_to_user:users!assigned_to(full_name)
        `)
        .eq('status', 'running')
        .order('due_date', { ascending: true, nullsFirst: false }),

      supabase.from('orders').select('*', { count: 'exact', head: true })
        .in('status', ['running', 'on_hold', 'ready_for_dispatch']),
      supabase.from('orders').select('total_value').eq('status', 'running'),
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .in('status', ['running', 'on_hold'])
        .lt('due_date', new Date().toISOString().slice(0, 10)),

      // PI Drafts, in exactly the statuses /orders/drafts lists — the same
      // constant, so the card and the page it opens can never describe
      // different sets.
      supabase.from('order_submissions').select('*', { count: 'exact', head: true })
        .in('status', PI_DRAFT_LIST_STATUSES as unknown as string[]),

      // The review queue: submitted PIs, the same status splitDraftsForReview
      // puts at the top of that page.
      supabase.from('order_submissions').select('*', { count: 'exact', head: true })
        .eq('status', 'submitted'),

      // Money recorded but not yet verified. A DIFFERENT AXIS from allocation,
      // and deliberately its own card: awaiting money must never be added to
      // verified money just because both are attributed.
      supabase.from('finance_payment_requests').select('*', { count: 'exact', head: true })
        .eq('status', 'pending_approval'),

      // Money with a positive unallocated balance, under the ONE canonical
      // classification (src/lib/finance/paymentClassification.ts). Counted by
      // the DATABASE over the whole set, so the figure survives paging — and
      // read from the same projection the Finance list reads, so this card and
      // the page it opens are one predicate rather than two kept in step by
      // hand.
      supabase.from(RECEIVED_PAYMENTS_SOURCE).select('id', { count: 'exact', head: true })
        .eq('is_available_to_allocate', true),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: Order[] = ((runningData ?? []) as any[]).map(o => ({
      ...o,
      assigned_to_name: o.assigned_to_user?.full_name ?? undefined,
      assigned_to_user: undefined,
    }))
    setOrders(mapped)

    const runningValue = (runningValueData ?? []).reduce(
      (sum: number, o: { total_value: number | null }) => sum + (o.total_value ?? 0), 0
    )

    setStats({
      runningValue,
      activeOrders:         activeCount   ?? 0,
      overdueOrders:        overdueCount  ?? 0,
      piDrafts:             draftCount    ?? 0,
      reviewQueue:          reviewCount   ?? 0,
      awaitingVerification: awaitingCount ?? 0,
      // AVAILABLE FUNDS DEGRADE TO ABSENT, NEVER TO ZERO.
      // `is_available_to_allocate` arrives with 20261008000000; against a
      // database without it PostgREST refuses the filter outright, and a card
      // reading "0" would say there is nothing to allocate when the truth is
      // that nothing was asked. `undefined` renders as a dash.
      availableToAllocate:  availableRes.error ? undefined : (availableRes.count ?? 0),
    })

    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // ── ONE ROUND TRIP, NOT FOUR ──
      //
      // The profile, the two permission resolvers and the dashboard's own data
      // used to run one after the next, so the page waited for the sum of four
      // latencies before it showed anything. NONE OF THEM DEPENDS ON ANOTHER'S
      // ANSWER: each needs only the session's user id, and every row the load
      // returns is scoped by RLS rather than by the role being resolved beside
      // it.
      //
      // NOTHING ABOUT AUTHORITY CHANGED. The capabilities are still resolved by
      // resolve_effective_permissions in the database and are still applied
      // before any control renders — pageLoading is not cleared until all four
      // have landed. What was removed is the waiting, not a check.
      const [{ data: me }, financePerms, ordersPerms] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        loadData(),
      ])

      setProfile(me as UserProfile)
      setFinanceCaps(deriveFinanceCapabilities(me?.role, financePerms))
      setOrdersCaps(deriveOrdersCapabilities(me?.role, ordersPerms))
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (pageLoading) return <LoadingScreen />

  const fmtRunningValue = stats.runningValue >= 100000
    ? '₹' + (stats.runningValue / 100000).toFixed(1) + 'L'
    : fmtAmount(stats.runningValue)

  // ── WHICH CARDS THIS READER IS OFFERED ──
  //
  // One decision, made in one place (src/lib/orders/orderDashboard.ts) so what
  // the dashboard offers is a statement a test can read rather than a set of
  // conditionals spread through the markup. A card that is not in this list is
  // not drawn at all — never drawn showing a dash, which would say "nothing is
  // waiting" to somebody who simply cannot see Finance.
  const cards = orderDashboardCards({ counts: stats, orders: ordersCaps, finance: financeCaps })

  return (
    <OrdersLayout
      profile={profile}
      title="Orders"
      subtitle={ORDER_DASHBOARD_SUBTITLE}
      onSignOut={handleSignOut}
      onRefresh={loadData}
      actions={
        // ── THE ONE WAY A NEW ORDER BEGINS ──
        //
        // "Upload PI", not "New Order": what this control does is upload one
        // document. The Order comes into existence at approval, with a number,
        // and the retired path that used to promise one earlier is gone.
        //
        // /orders/import enforces the same `create` grant in its own right,
        // because hiding a button is not access control.
        ordersCaps.canCreateOrder ? (
          <button
            className="boe-btn boe-btn-primary"
            onClick={() => router.push(NEW_ORDER_ACTION.href)}
            title={NEW_ORDER_ACTION.title}
          >
            <Upload size={13} strokeWidth={2.2} />
            {NEW_ORDER_ACTION.label}
          </button>
        ) : undefined
      }
    >
      {/* ── Quick access ──
          The workflow in order: drafts, the review queue, confirmed Orders,
          then the money. Every card is a link; the value is the database's own
          count under this reader's RLS, and a dash means "not asked" rather
          than "nothing there". */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: '12px',
        marginBottom: '20px',
      }}>
        {cards.map(card => (
          <StatCard
            key={card.key}
            label={card.label}
            value={card.value}
            sub={card.sub}
            accent={card.tone === 'attention' ? colors.amber : card.tone === 'money' ? colors.blue : undefined}
            onClick={() => router.push(card.href)}
          />
        ))}
        <StatCard
          label="Running Value"
          value={fmtRunningValue}
          sub="Orders in production"
          accent={colors.blue}
        />
      </div>

      {/* ── Running Orders list ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '14px 20px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
            Running Orders
          </div>
          <div style={{ fontSize: '12px', color: colors.muted }}>
            {listLoading ? 'Loading…' : `${orders.length} order${orders.length !== 1 ? 's' : ''}`}
          </div>
        </div>

        {listLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            Loading…
          </div>
        ) : orders.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No running orders.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Order #', 'Client', 'Assigned To', 'Due Date', 'Value', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map(o => {
                  const overdue = isOverdue(o.due_date, o.status)
                  return (
                    <tr
                      key={o.id}
                      onClick={() => router.push(`/orders/${o.id}`)}
                      style={{
                        borderBottom: `1px solid ${colors.border}`,
                        cursor: 'pointer',
                        transition: 'background 0.1s',
                      }}
                      /* HOVER IS THE EARLIEST HONEST SIGNAL that this row is
                         about to be opened, and prefetching the Order detail
                         route on it means the code for that screen is already
                         in hand when the click lands. It fetches the ROUTE, not
                         the Order: no record, no permission and no file is read
                         until the page mounts and asks under the reader's own
                         session, so this can neither leak a row nor show a
                         stale one. Next de-duplicates repeated prefetches, so
                         moving down a list of forty costs forty cache hits. */
                      onMouseEnter={e => {
                        router.prefetch(`/orders/${o.id}`)
                        ;(e.currentTarget as HTMLTableRowElement).style.background = colors.raised
                      }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                    >
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                        {o.display_number}
                      </td>
                      <td style={{ padding: '12px 16px', color: colors.primary, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.client_name}
                      </td>
                      <td style={{ padding: '12px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {o.assigned_to_name ?? '—'}
                      </td>
                      <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', color: overdue ? colors.red : colors.secondary, fontWeight: overdue ? 600 : 400 }}>
                        {fmtDate(o.due_date)}
                        {overdue && <span style={{ marginLeft: '4px', fontSize: '10px' }}>overdue</span>}
                      </td>
                      <td style={{ padding: '12px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {fmtAmount(o.total_value)}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </OrdersLayout>
  )
}
