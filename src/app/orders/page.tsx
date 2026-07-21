'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'

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

type DashboardStats = {
  activeOrders: number
  runningValue: number
  readyToDispatch: number
  unlinkedPayments: number
  overdueOrders: number
}

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

function StatCard({
  label, value, sub, accent, onClick,
}: {
  label: string
  value: string | number
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
      <div style={{ fontSize: '22px', fontWeight: 700, color: accent ?? colors.primary, letterSpacing: '-0.02em', lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: '11px', color: colors.muted }}>{sub}</div>}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrdersDashboardPage() {
  const [pageLoading, setPageLoading] = useState(true)
  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [orders,      setOrders]      = useState<Order[]>([])
  const [stats,       setStats]       = useState<DashboardStats>({
    activeOrders: 0, runningValue: 0, readyToDispatch: 0, unlinkedPayments: 0, overdueOrders: 0,
  })
  const [listLoading, setListLoading] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const loadData = async () => {
    setListLoading(true)

    // Running orders list
    const { data: runningData } = await supabase
      .from('orders')
      .select(`
        id, display_number, client_name, assigned_to, due_date, total_value, status,
        assigned_to_user:users!assigned_to(full_name)
      `)
      .eq('status', 'running')
      .order('due_date', { ascending: true, nullsFirst: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: Order[] = ((runningData ?? []) as any[]).map(o => ({
      ...o,
      assigned_to_name: o.assigned_to_user?.full_name ?? undefined,
      assigned_to_user: undefined,
    }))
    setOrders(mapped)

    // Stats queries in parallel
    const [
      { count: activeCount },
      { data: runningValueData },
      { count: readyCount },
      { count: unlinkedCount },
      { count: overdueCount },
    ] = await Promise.all([
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .in('status', ['running', 'on_hold', 'ready_for_dispatch']),
      supabase.from('orders').select('total_value').eq('status', 'running'),
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .eq('status', 'ready_for_dispatch'),
      supabase.from('finance_payment_requests').select('*', { count: 'exact', head: true })
        .is('order_id', null)
        // A payment parked on an Order Request (20260698) links itself on
        // conversion — it is no longer an actionable unlinked payment.
        .is('order_request_id', null)
        .in('status', ['approved_unlinked', 'approved_linked']),
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .in('status', ['running', 'on_hold'])
        .lt('due_date', new Date().toISOString().slice(0, 10)),
    ])

    const runningValue = (runningValueData ?? []).reduce(
      (sum: number, o: { total_value: number | null }) => sum + (o.total_value ?? 0), 0
    )

    setStats({
      activeOrders:     activeCount   ?? 0,
      runningValue,
      readyToDispatch:  readyCount    ?? 0,
      unlinkedPayments: unlinkedCount ?? 0,
      overdueOrders:    overdueCount  ?? 0,
    })

    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)
      await loadData()
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

  // finance_payment_requests RLS only returns rows to admins (or the
  // submitter, which isn't meaningful for an org-wide count) — for anyone
  // else the query already silently returns 0. Neutralize the card instead
  // of showing a "0" that reads as "nothing unlinked" when it actually
  // means "you can't see Finance data."
  const canSeeFinance = profile?.role === 'admin'

  return (
    <OrdersLayout
      profile={profile}
      title="Orders"
      subtitle="Running orders and operational overview."
      onSignOut={handleSignOut}
      onRefresh={loadData}
    >
      {/* ── Dashboard cards ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: '12px',
        marginBottom: '28px',
      }}>
        <StatCard
          label="Active Orders"
          value={stats.activeOrders}
          sub="Running + Hold + Ready"
          onClick={() => router.push('/orders/all')}
        />
        <StatCard
          label="Running Value"
          value={fmtRunningValue}
          sub="Orders in production"
          accent={colors.blue}
        />
        <StatCard
          label="Ready to Dispatch"
          value={stats.readyToDispatch}
          accent="#5B21B6"
          onClick={() => router.push('/orders/all?status=ready_for_dispatch')}
        />
        <StatCard
          label="Unlinked Payments"
          value={canSeeFinance ? stats.unlinkedPayments : '—'}
          sub={canSeeFinance ? 'Payments without an order' : 'Finance only'}
          accent={canSeeFinance && stats.unlinkedPayments > 0 ? colors.amber : colors.muted}
          // Counted with the exact predicate Non-Linked Payments uses, so the
          // card lands on the page that holds these rows, not on Linked.
          onClick={canSeeFinance ? () => router.push('/finance/received/unlinked') : undefined}
        />
        <StatCard
          label="Overdue"
          value={stats.overdueOrders}
          sub="Past due date"
          accent={stats.overdueOrders > 0 ? colors.red : colors.muted}
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
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
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
