'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { Activity, CircleX, Layers, PackageCheck, PauseCircle, Truck, type LucideIcon } from 'lucide-react'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

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
  created_at: string
  lead_source: string | null
  source_request_number: string | null
}

type StatusFilter = 'all' | 'running' | 'on_hold' | 'ready_for_dispatch' | 'dispatched' | 'cancelled'

type DateFilter = 'all' | '7d' | '30d' | 'this_month' | '3m' | 'this_year'

type SortKey = 'newest' | 'oldest' | 'number_desc' | 'number_asc' | 'value_desc' | 'value_asc'

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
const STATUS_TABS: { key: StatusFilter; label: string; Icon: LucideIcon }[] = [
  { key: 'all',               label: 'Total Order List',  Icon: Layers },
  { key: 'running',           label: 'Running',           Icon: Activity },
  { key: 'on_hold',           label: 'On Hold',           Icon: PauseCircle },
  { key: 'ready_for_dispatch',label: 'Ready to Dispatch', Icon: PackageCheck },
  { key: 'cancelled',         label: 'Cancelled',         Icon: CircleX },
  { key: 'dispatched',        label: 'Dispatched',        Icon: Truck },
]

// Each tab borrows the hue its rows already wear in the Status column, so a
// status reads identically in the navigation strip and in the table. `tint`
// backs the active tab, `badge`/`badgeActive` back the count. Only 'all' has no
// row equivalent; it takes the BOE red brand accent.
type TabAccent = { color: string; tint: string; badge: string; badgeActive: string }

const badgeAccent = (key: string): TabAccent => ({
  color:       STATUS_META[key].color,
  tint:        STATUS_META[key].bg,
  badge:       STATUS_META[key].bg,
  badgeActive: STATUS_META[key].border,
})

const TAB_ACCENT: Record<StatusFilter, TabAccent> = {
  all: {
    color: '#DC1F2E', tint: 'rgba(220,31,46,0.055)',
    badge: 'rgba(220,31,46,0.09)', badgeActive: 'rgba(220,31,46,0.17)',
  },
  running:            badgeAccent('running'),
  on_hold:            badgeAccent('on_hold'),
  ready_for_dispatch: badgeAccent('ready_for_dispatch'),
  cancelled:          badgeAccent('cancelled'),
  dispatched:         badgeAccent('dispatched'),
}

// Mirrors the lead_source CHECK on public.orders (20260655) and the label map on
// the Order detail page. Kept page-local like every other label map in Orders.
const LEAD_SOURCE_LABEL: Record<string, string> = {
  reference:       'Reference',
  repeat_customer: 'Repeat Customer',
  whatsapp:        'WhatsApp',
  instagram:       'Instagram',
  website:         'Website',
}

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all',        label: 'Any date' },
  { key: '7d',         label: 'Last 7 days' },
  { key: '30d',        label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: '3m',         label: 'Last 3 months' },
  { key: 'this_year',  label: 'This year' },
]

// Compact listing control. `.boe-input` is width:100% and 8px/13px for form use;
// the toolbar overrides it to size-to-content at a shorter height so search plus
// every dropdown fits on one desktop row.
const COMPACT_CONTROL: React.CSSProperties = {
  width: 'auto', minWidth: '104px', maxWidth: '150px',
  padding: '6px 8px', fontSize: '12px', flexShrink: 0, cursor: 'pointer',
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'newest',      label: 'Newest first' },
  { key: 'oldest',      label: 'Oldest first' },
  { key: 'number_desc', label: 'Order no. high–low' },
  { key: 'number_asc',  label: 'Order no. low–high' },
  { key: 'value_desc',  label: 'Value high–low' },
  { key: 'value_asc',   label: 'Value low–high' },
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

// The business-facing order date is confirm_date, but it is nullable. Falling
// back to created_at means a date filter narrows the list without ever silently
// dropping an order that simply has no confirmation date recorded.
function orderDate(o: Order): string {
  return o.confirm_date ?? o.created_at
}

function dateFilterStart(key: DateFilter): Date | null {
  const now = new Date()
  switch (key) {
    case '7d':         return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
    case '30d':        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
    case 'this_month': return new Date(now.getFullYear(), now.getMonth(), 1)
    case '3m':         return new Date(now.getFullYear(), now.getMonth() - 2, 1)
    case 'this_year':  return new Date(now.getFullYear(), 0, 1)
    default:           return null
  }
}

// display_number is four numeric digits (20260704), but sort defensively so a
// legacy or unexpected value orders predictably instead of collapsing to NaN.
function compareNumber(a: string, b: string): number {
  const na = Number(a), nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b)
}

// Orders with no value recorded sort last in both directions rather than
// masquerading as the cheapest order.
function compareValue(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return (a - b) * dir
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
  const [assignee,     setAssignee]     = useState('all')
  const [source,       setSource]       = useState('all')
  const [dateFilter,   setDateFilter]   = useState<DateFilter>('all')
  const [sortKey,      setSortKey]      = useState<SortKey>('newest')
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
        created_at, lead_source, source_request_number,
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

      // ── The profile and the list, together ──
      //
      // The list is scoped by RLS, not by the role being read beside it, so
      // waiting for one before starting the other bought nothing but a second
      // round trip. Neither query changed.
      const [{ data: me }] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        loadOrders(),
      ])

      setProfile(me as UserProfile)

      const paramStatus = searchParams.get('status') as StatusFilter | null
      if (paramStatus && STATUS_TABS.some(t => t.key === paramStatus)) {
        setStatusTab(paramStatus)
      }

      if (searchParams.get('deleted') === '1') {
        setDeletedBanner(true)
        router.replace('/orders/all')
      }

      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Filter option lists come from the rows already loaded, so every option is
  // guaranteed to match at least one order the current user can see.
  const assigneeOptions = useMemo(() => {
    const map = new Map<string, string>()
    orders.forEach(o => {
      if (o.assigned_to && o.assigned_to_name) map.set(o.assigned_to, o.assigned_to_name)
    })
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [orders])

  const sourceOptions = useMemo(
    () => [...new Set(orders.map(o => o.lead_source).filter((s): s is string => !!s))]
      .sort((a, b) => (LEAD_SOURCE_LABEL[a] ?? a).localeCompare(LEAD_SOURCE_LABEL[b] ?? b)),
    [orders],
  )

  const filtersActive =
    statusTab !== 'all' || assignee !== 'all' ||
    source !== 'all' || dateFilter !== 'all' || search.trim() !== ''

  const clearFilters = () => {
    setStatusTab('all')
    setAssignee('all')
    setSource('all')
    setDateFilter('all')
    setSearch('')
  }

  // Everything except the status tab. Splitting it out lets each tab show the
  // count it would actually produce under the toolbar filters currently applied,
  // instead of a total that contradicts the list once the tab is clicked.
  const baseFiltered = useMemo(() => {
    let list = orders
    if (assignee !== 'all') list = list.filter(o => o.assigned_to === assignee)
    if (source   !== 'all') list = list.filter(o => o.lead_source === source)

    const start = dateFilterStart(dateFilter)
    if (start) list = list.filter(o => new Date(orderDate(o)) >= start)

    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(o =>
        o.display_number.toLowerCase().includes(q) ||
        o.client_name.toLowerCase().includes(q) ||
        (o.source_request_number ?? '').toLowerCase().includes(q) ||
        (o.requested_by_name ?? '').toLowerCase().includes(q) ||
        (o.assigned_to_name  ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [orders, assignee, source, dateFilter, search])

  const tabCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      all: baseFiltered.length, running: 0, on_hold: 0,
      ready_for_dispatch: 0, dispatched: 0, cancelled: 0,
    }
    baseFiltered.forEach(o => {
      if (o.status in counts) counts[o.status as StatusFilter] += 1
    })
    return counts
  }, [baseFiltered])

  const visible = useMemo(() => {
    const list = statusTab === 'all'
      ? baseFiltered
      : baseFiltered.filter(o => o.status === statusTab)

    // Copy before sorting: `baseFiltered` may have been returned by reference.
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'oldest':      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case 'number_desc': return compareNumber(b.display_number, a.display_number)
        case 'number_asc':  return compareNumber(a.display_number, b.display_number)
        case 'value_desc':  return compareValue(a.total_value, b.total_value, -1)
        case 'value_asc':   return compareValue(a.total_value, b.total_value, 1)
        default:            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
    })
  }, [baseFiltered, statusTab, sortKey])

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

      {/* ── Toolbar: search + filters + sort ──
          Form controls only. Status navigation lives on the table card below so
          the two never read as the same kind of control. Confirmed Orders is a
          review surface: no creation action belongs here — Order Requests are
          raised from /orders/requests. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        marginBottom: '10px',
      }}>
        <input
          className="boe-input"
          placeholder="Search order no., request no., client or person…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: '180px', maxWidth: '320px', padding: '6px 10px', fontSize: '12px' }}
        />
        <select
          className="boe-input"
          aria-label="Filter by assignee"
          value={assignee}
          onChange={e => setAssignee(e.target.value)}
          style={COMPACT_CONTROL}
        >
          <option value="all">All assignees</option>
          {assigneeOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select
          className="boe-input"
          aria-label="Filter by order date"
          value={dateFilter}
          onChange={e => setDateFilter(e.target.value as DateFilter)}
          style={COMPACT_CONTROL}
        >
          {DATE_FILTERS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        {sourceOptions.length > 0 && (
          <select
            className="boe-input"
            aria-label="Filter by lead source"
            value={source}
            onChange={e => setSource(e.target.value)}
            style={COMPACT_CONTROL}
          >
            <option value="all">All sources</option>
            {sourceOptions.map(s => <option key={s} value={s}>{LEAD_SOURCE_LABEL[s] ?? s}</option>)}
          </select>
        )}
        <select
          className="boe-input"
          aria-label="Sort orders"
          value={sortKey}
          onChange={e => setSortKey(e.target.value as SortKey)}
          style={COMPACT_CONTROL}
        >
          {SORT_OPTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {filtersActive && (
          <button
            onClick={clearFilters}
            style={{
              padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              cursor: 'pointer', border: `1px solid ${colors.border}`,
              background: 'transparent', color: colors.muted,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Table, with the status strip as its own header ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        {/* Status navigation. Icon + status hue + count badge make each state
            scannable without reading the label, while the flat background and
            underline keep it visually distinct from the boxed toolbar controls.
            The gap scales with the viewport: generous on desktop, tight enough
            on mobile that the strip still scrolls as one line. */}
        <div style={{
          display: 'flex', alignItems: 'stretch', gap: '12px',
          borderBottom: `1px solid ${colors.border}`, padding: '0 14px 0 6px',
        }}>
          <div style={{
            display: 'flex', alignItems: 'stretch', gap: 'clamp(10px, 1.9vw, 24px)',
            flex: 1, minWidth: 0, overflowX: 'auto',
          }}>
            {STATUS_TABS.map(({ key, label, Icon }) => {
              const active = statusTab === key
              const accent = TAB_ACCENT[key]
              return (
                <button
                  key={key}
                  onClick={() => setStatusTab(key)}
                  aria-pressed={active}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    padding: '8px 8px 7px', border: 'none',
                    background: active ? accent.tint : 'transparent',
                    borderRadius: '6px 6px 0 0',
                    borderBottom: `2px solid ${active ? accent.color : 'transparent'}`,
                    fontSize: '12px', fontWeight: active ? 700 : 500,
                    color: active ? accent.color : colors.primary,
                    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                    transition: 'background 0.12s, color 0.12s',
                  }}
                >
                  <Icon
                    size={14}
                    style={{ color: accent.color, opacity: active ? 1 : 0.55, flexShrink: 0 }}
                    aria-hidden
                  />
                  {label}
                  <span style={{
                    minWidth: '18px', padding: '1px 5px', borderRadius: '999px',
                    background: active ? accent.badgeActive : accent.badge,
                    color: accent.color, fontSize: '10px', fontWeight: 700,
                    lineHeight: '15px', textAlign: 'center',
                  }}>
                    {tabCounts[key]}
                  </span>
                </button>
              )
            })}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', flexShrink: 0,
            fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap',
          }}>
            {listLoading
              ? 'Loading…'
              : filtersActive
                ? `${visible.length} of ${orders.length} visible`
                : `${visible.length} order${visible.length !== 1 ? 's' : ''}`}
          </div>
        </div>

        {listLoading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            {filtersActive ? (
              <>
                No orders match the current filters.
                <button
                  onClick={clearFilters}
                  style={{
                    display: 'block', margin: '10px auto 0', padding: '5px 12px',
                    borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${colors.border}`, background: 'transparent', color: colors.secondary,
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : 'No orders found.'}
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
