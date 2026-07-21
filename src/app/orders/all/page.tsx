'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
  requested_by: string | null
  requested_by_name?: string
  assigned_to: string | null
  assigned_to_name?: string
  confirm_date: string | null
  due_date: string | null
  total_value: number | null
  status: string
}

type StatusFilter = 'all' | 'running' | 'on_hold' | 'ready_for_dispatch' | 'dispatched' | 'cancelled'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  running:            { label: 'Running',             bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  on_hold:            { label: 'On Hold',             bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  dispatched:         { label: 'Dispatched',          bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  cancelled:          { label: 'Cancelled',           bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

// 'requested' is gone (20260702000000): an Order exists only after its Order
// Request was reviewed and converted, so every Confirmed Order starts at
// 'running' and no pre-approval state remains to filter by. The database CHECK
// no longer permits the value, so this list is the complete status domain, not
// a subset of it.
const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all',               label: 'Total Order List' },
  { key: 'running',           label: 'Running' },
  { key: 'on_hold',           label: 'On Hold' },
  { key: 'ready_for_dispatch',label: 'Ready to Dispatch' },
  { key: 'cancelled',         label: 'Cancelled' },
  { key: 'dispatched',        label: 'Dispatched' },
]

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AllOrdersPage() {
  const [pageLoading,  setPageLoading]  = useState(true)
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [orders,       setOrders]       = useState<Order[]>([])
  const [listLoading,  setListLoading]  = useState(false)
  const [search,       setSearch]       = useState('')
  const [statusTab,    setStatusTab]    = useState<StatusFilter>('all')
  const [deletedBanner, setDeletedBanner] = useState(false)

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])

  const loadOrders = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('orders')
      .select(`
        id, display_number, client_name,
        requested_by, assigned_to,
        confirm_date, due_date, total_value, status,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name)
      `)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: Order[] = ((data ?? []) as any[]).map(o => ({
      ...o,
      requested_by_name: o.requested_by_user?.full_name ?? undefined,
      assigned_to_name:  o.assigned_to_user?.full_name  ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
    }))
    setOrders(mapped)
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

      const paramStatus = searchParams.get('status') as StatusFilter | null
      if (paramStatus && STATUS_TABS.some(t => t.key === paramStatus)) {
        setStatusTab(paramStatus)
      }

      if (searchParams.get('deleted') === '1') {
        setDeletedBanner(true)
        router.replace('/orders/all')
      }

      await loadOrders()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const visible = useMemo(() => {
    let list = orders
    if (statusTab !== 'all') list = list.filter(o => o.status === statusTab)
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(o =>
      o.display_number.toLowerCase().includes(q) ||
      o.client_name.toLowerCase().includes(q)
    )
  }, [orders, statusTab, search])

  if (pageLoading) return <LoadingScreen />

  return (
    <OrdersLayout
      profile={profile}
      title="Confirmed Orders"
      subtitle="Complete order list across all statuses."
      onSignOut={handleSignOut}
      onRefresh={loadOrders}
    >
      {deletedBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span>Request deleted successfully.</span>
          <button
            onClick={() => setDeletedBanner(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Search + tabs + new button ── */}
      <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <input
            className="boe-input"
            placeholder="Search by order number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: '320px', flex: 1, minWidth: '180px' }}
          />
          <button
            onClick={() => router.push('/orders/requests')}
            style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            + New Order Request
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatusTab(tab.key)}
              style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                borderColor: statusTab === tab.key ? '#DC1F2E' : colors.border,
                background:   statusTab === tab.key ? 'rgba(220,31,46,0.07)' : 'transparent',
                color:        statusTab === tab.key ? '#DC1F2E' : colors.secondary,
                transition: 'all 0.1s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
          fontSize: '12px', color: colors.muted,
        }}>
          {listLoading ? 'Loading…' : `${visible.length} order${visible.length !== 1 ? 's' : ''}`}
        </div>

        {listLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No orders found.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Order #', 'Client', 'Requested By', 'Assigned To', 'Confirm Date', 'Due Date', 'Value', 'Status'].map(h => (
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
                {visible.map(o => {
                  const overdue = isOverdue(o.due_date, o.status)
                  return (
                    <tr
                      key={o.id}
                      onClick={() => router.push(`/orders/${o.id}`)}
                      style={{
                        borderBottom: `1px solid ${colors.border}`,
                        cursor: 'pointer', transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                    >
                      <td style={{ padding: '11px 16px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                        {o.display_number}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.primary, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.client_name}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {o.requested_by_name ?? '—'}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {o.assigned_to_name ?? '—'}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {fmtDate(o.confirm_date)}
                      </td>
                      <td style={{ padding: '11px 16px', whiteSpace: 'nowrap', color: overdue ? colors.red : colors.secondary, fontWeight: overdue ? 600 : 400 }}>
                        {fmtDate(o.due_date)}
                        {overdue && <span style={{ marginLeft: '4px', fontSize: '10px' }}>overdue</span>}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {fmtAmount(o.total_value)}
                      </td>
                      <td style={{ padding: '11px 16px' }}>
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
