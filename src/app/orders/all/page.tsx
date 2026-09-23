'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { Activity, CircleX, Layers, PackageCheck, PauseCircle, Truck, type LucideIcon } from 'lucide-react'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatOrderOperationalNumber } from '@/lib/orders/orderProductCodes'
import {
  ORDER_UNREAD_TYPES,
  unreadUpdateCounts,
  unreadUpdateLabel,
  type UnreadUpdateRow,
} from '@/lib/orders/orderUnreadUpdates'
import { enumParam, idParam, optionParam, textParam } from '@/lib/listState'
import { OPERATIONS_REVIEW_QUEUE_BANNER } from '@/lib/orders/operationsHandoff'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { listReturnPathWithSearch, withReturnTo } from '@/lib/navigation/recordReturn'

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

// ── The list's working context lives in the URL ──
//
// Status tab, search, assignee, source, date window and sort are all query
// parameters (the shared codecs in src/lib/listState.ts, the same ones the Task
// lists use). Opening an Order and pressing Back — the browser's or the
// record's own — therefore returns to exactly this view, and a filtered list can
// be bookmarked or shared. A value the page does not recognise reads as the
// default rather than breaking the page; a default is never written, so the
// unfiltered list is a clean /orders/all.
const ORDERS_LIST_PARAMS = {
  status:   enumParam<StatusFilter>(['all', 'running', 'on_hold', 'ready_for_dispatch', 'dispatched', 'cancelled'], 'all'),
  q:        textParam(),
  assignee: idParam(),
  source:   optionParam(Object.keys(LEAD_SOURCE_LABEL)),
  date:     enumParam<DateFilter>(['all', '7d', '30d', 'this_month', '3m', 'this_year'], 'all'),
  sort:     enumParam<SortKey>(['newest', 'oldest', 'number_desc', 'number_asc', 'value_desc', 'value_asc'], 'newest'),
  // The operations queue (20261229000000): only the Orders whose PI version in
  // force is awaiting operations review — assigned to this reader, or to
  // nobody. Reached from the dashboard card and from nowhere else on this
  // page; a banner names it and offers the way out.
  ops:      enumParam<'all' | 'awaiting'>(['all', 'awaiting'], 'all'),
}

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
  /**
   * A FAILED READ IS NOT AN EMPTY LIST (launch audit, 2026-09-19). The loader
   * ignored the query's error, so a failed read became zero rows and the page
   * said "No orders found." — a statement about the business that nobody read.
   * On failure the rows already on screen stay, and the page says it could not
   * load and offers Retry.
   */
  const [loadError,    setLoadError]    = useState<string | null>(null)
  // Every control reads and writes the URL (see ORDERS_LIST_PARAMS). The
  // names below are the ones the rest of this page always used, so the
  // filtering and sorting logic is untouched.
  const { state: listState, setState: setListState, resetState: resetListState } =
    useListUrlState(ORDERS_LIST_PARAMS)
  const statusTab  = listState.status
  const assignee   = listState.assignee || 'all'
  const source     = listState.source || 'all'
  const dateFilter = listState.date
  const sortKey    = listState.sort
  // The URL holds the committed search; the box shows what is being typed and
  // commits after a short pause, so each keystroke is not a history entry.
  // flushSearch commits a pending term at once — wired to the box's blur, as
  // on the Task lists, so leaving the box never drops what was typed.
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(listState.q, next => setListState({ q: next }))
  const search = listState.q
  const setStatusTab  = (next: StatusFilter) => setListState({ status: next })
  const setAssignee   = (next: string) => setListState({ assignee: next === 'all' ? '' : next })
  const setSource     = (next: string) => setListState({ source: next === 'all' ? '' : next })
  const setDateFilter = (next: DateFilter) => setListState({ date: next })
  const setSortKey    = (next: SortKey) => setListState({ sort: next })
  // Back from an Order lands where the reader was, not at the top.
  useListScrollRestore()
  // Handed to each Order so its Back control returns to this exact view.
  // Built from the search AS TYPED (see listReturnPathWithSearch): typing and
  // clicking a row at once must not lose the term the reader just entered.
  const pathname = usePathname()
  const returnPath = listReturnPathWithSearch(pathname, useSearchParams().toString(), searchInput)
  const orderHref = (id: string) => withReturnTo(`/orders/${id}`, returnPath)
  const [deletedBanner, setDeletedBanner] = useState(false)
  /**
   * HOW MANY UNREAD UPDATES THIS READER HAS, PER ORDER.
   *
   * Read from `notifications` under RLS, so it is scoped to the signed-in
   * person by the database and cannot be anybody else's. Empty until the read
   * lands, which is right: an absent badge is honest, a wrong one is not.
   */
  const [unread, setUnread] = useState<Map<string, number>>(new Map())
  /**
   * WHICH ORDERS' CURRENT PI VERSION IS AWAITING OPERATIONS (20261229000000):
   * the live, undecided handoffs this reader can see, keyed by Order, with who
   * they are addressed to. Read only when the ?ops=awaiting queue is open, and
   * scoped by the Order's own RLS. The dashboard card links here.
   */
  const [awaitingOps, setAwaitingOps] = useState<Map<string, string | null>>(new Map())
  const opsFilter = listState.ops

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])

  const loadAwaitingOps = async () => {
    const { data, error } = await supabase
      .from('order_operations_handoffs')
      .select('order_id, assigned_to')
      // Awaiting AND flagged: a flagged version is still unresolved work.
      .in('status', ['awaiting', 'clarification_needed'])
      .is('superseded_at', null)
    if (error) { setAwaitingOps(new Map()); return }
    setAwaitingOps(new Map(((data ?? []) as { order_id: string; assigned_to: string | null }[])
      .map(r => [r.order_id, r.assigned_to])))
  }

  const loadOrders = async () => {
    setListLoading(true)
    const { data, error } = await supabase
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

    if (error) {
      setLoadError('Could not load Confirmed Orders. Check your connection and try again.')
      setListLoading(false)
      return
    }
    setLoadError(null)

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

  /**
   * WHICH ORDERS HAVE UPDATES THIS READER HAS NOT SEEN.
   *
   * ONE QUERY, AND IT IS THE NOTIFICATION SYSTEM'S OWN ROWS. `user_id` is not
   * filtered here because it does not need to be: the notifications RLS policy
   * already limits a reader to their own rows, so this cannot return anybody
   * else's unread state even if it asked for it. `is_read = false` and the four
   * Order-update types are the whole filter, and both are served by the partial
   * index 20261202000000 adds.
   *
   * DELIBERATELY SEPARATE FROM loadOrders. The badge is an enhancement over a
   * list that must render without it: a failed or slow notification read leaves
   * the Orders exactly as they were, with no badges, rather than delaying or
   * breaking the table.
   */
  const loadUnread = async () => {
    const { data, error } = await supabase
      .from('notifications')
      .select('entity_id')
      .eq('is_read', false)
      .in('type', ORDER_UNREAD_TYPES)
    if (error) return
    setUnread(unreadUpdateCounts((data ?? []) as UnreadUpdateRow[]))
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
        // Alongside, never after: the badge depends on neither of the other
        // two, and a third round trip in series would delay the whole table
        // for a decoration.
        loadUnread(),
        // The operations queue, only when it was asked for. Beside the
        // others, so the filtered list costs no extra wait.
        opsFilter === 'awaiting' ? loadAwaitingOps() : Promise.resolve(),
      ])

      setProfile(me as UserProfile)

      // ?status= is read by useListUrlState now, together with every other
      // filter, so a deep link and the page's own tabs are one mechanism.

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
    setSearchInput('')
    resetListState()
  }

  // Everything except the status tab. Splitting it out lets each tab show the
  // count it would actually produce under the toolbar filters currently applied,
  // instead of a total that contradicts the list once the tab is clicked.
  const baseFiltered = useMemo(() => {
    let list = orders
    // The operations queue: Orders whose version in force awaits THIS reader
    // (assigned to them) or NOBODY (unassigned, an administrator's problem).
    // A handoff addressed to somebody else is not this reader's queue.
    if (opsFilter === 'awaiting') {
      list = list.filter(o => {
        if (!awaitingOps.has(o.id)) return false
        const to = awaitingOps.get(o.id) ?? null
        return to === null || to === profile?.id
      })
    }
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
  }, [orders, assignee, source, dateFilter, search, opsFilter, awaitingOps, profile])

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

  if (pageLoading) return <OrdersRouteFallback />

  return (
    <OrdersLayout
      profile={profile}
      title="Confirmed Orders"
      subtitle="Complete order list across all statuses."
      onSignOut={handleSignOut}
      /* Refresh re-reads both: a reader who has just opened an Order in
         another tab expects its badge to be gone when they come back. */
      onRefresh={async () => { await Promise.all([loadOrders(), loadUnread()]) }}
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
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── The operations queue banner (20261229000000) ──
          Named in words, with the one way out. The filter is a URL parameter
          the dashboard card sets; no control on this page sets it, so a reader
          who arrived here must be told why the list is short. */}
      {opsFilter === 'awaiting' && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
            padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
            background: '#FFF7ED', border: '1px solid #FED7AA',
            fontSize: '13px', color: '#9A3412',
          }}
        >
          <span>{OPERATIONS_REVIEW_QUEUE_BANNER}</span>
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 12px', fontSize: '12px' }}
            onClick={() => setListState({ ops: 'all' })}
          >
            Show all Orders
          </button>
        </div>
      )}

      {/* ── Toolbar: search + filters + sort ──
          Form controls only. Status navigation lives on the table card below so
          the two never read as the same kind of control. Confirmed Orders is a
          review surface: no creation action belongs here — an Order begins as
          an uploaded PI and is confirmed at approval. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        marginBottom: '10px',
      }}>
        <input
          className="boe-input"
          type="search"
          aria-label="Search Confirmed Orders"
          placeholder="Search order no., request no., client or person…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onBlur={flushSearch}
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
                  type="button"
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
          <div aria-live="polite" style={{
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

        {/* A REFRESH KEEPS THE ROWS. The table used to be swapped for
            "Loading…" on every re-read, which threw the reader back to the
            top; the count above says a read is in flight. */}
        {loadError && (
          <div role="alert" style={{
            display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            margin: '12px 14px 0', padding: '9px 12px', borderRadius: '8px',
            background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '12px',
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>{loadError}</span>
            <button type="button" onClick={() => { void loadOrders() }} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
              Retry
            </button>
          </div>
        )}
        {listLoading && orders.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : loadError && orders.length === 0 ? (
          // Nothing was read, so nothing is claimed — the banner above says why.
          null
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
          <>
          {/* PHONE: one card per Order instead of an eight-column table that
              scrolled sideways inside its card. The switch is CSS
              (.orders-list-table / .orders-list-cards), so there is no
              measure-then-swap flash. */}
          <ul className="orders-list-cards" aria-label="Confirmed Orders">
            {visible.map(o => {
              const overdue = isOverdue(o.due_date, o.status)
              const updateLabel = unreadUpdateLabel(unread.get(o.id) ?? 0)
              const number = formatOrderOperationalNumber(o.display_number) ?? o.display_number
              return (
                <li key={o.id} className={`orders-list-card${updateLabel ? ' has-update' : ''}`}>
                  <div className="orders-list-card-top">
                    <Link href={orderHref(o.id)} prefetch={false} className="orders-list-card-link">
                      Order {number}
                    </Link>
                    <StatusBadge status={o.status} />
                  </div>
                  <div className="orders-list-card-client">{o.client_name}</div>
                  <div className="orders-list-card-meta">
                    <span style={{ color: overdue ? colors.red : undefined, fontWeight: overdue ? 600 : undefined }}>
                      Due {fmtDate(o.due_date)}{overdue ? ' · overdue' : ''}
                    </span>
                    <span className="orders-list-card-value">{fmtAmount(o.total_value)}</span>
                  </div>
                  {(o.assigned_to_name || updateLabel) && (
                    <div className="orders-list-card-meta">
                      <span>{o.assigned_to_name ? `Assigned to ${o.assigned_to_name}` : ''}</span>
                      {updateLabel && (
                        <span className="order-update-badge">
                          <span className="order-update-dot" aria-hidden="true" />
                          {updateLabel}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="orders-list-table" style={{ overflowX: 'auto' }}>
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
                  // PER READER. This count came from this person's own unread
                  // notification rows, so another recipient opening the Order
                  // leaves this badge exactly where it is.
                  const updates = unread.get(o.id) ?? 0
                  const updateLabel = unreadUpdateLabel(updates)
                  return (
                    <tr
                      key={o.id}
                      onClick={() => router.push(orderHref(o.id))}
                      style={{
                        borderBottom: `1px solid ${colors.border}`,
                        cursor: 'pointer', transition: 'background 0.1s',
                        /* A TINT AND A LEFT EDGE, NOT A FLASH. The row has to
                           be hard to miss in a list of forty and impossible to
                           find irritating in a list somebody reads all day, so
                           the animation is on the small dot in the badge and
                           nowhere else. */
                        ...(updateLabel ? {
                          background: colors.blueTint,
                          boxShadow: `inset 3px 0 0 ${colors.blue}`,
                        } : null),
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
                        ;(e.currentTarget as HTMLTableRowElement).style.background =
                          updateLabel ? colors.blueTint : colors.raised
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLTableRowElement).style.background =
                          updateLabel ? colors.blueTint : 'transparent'
                      }}
                    >
                      <td style={{ padding: '11px 16px', fontWeight: updateLabel ? 800 : 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                        {/* The row is clickable for a pointer; THIS is the
                            real link — reachable by Tab, opens in a new tab,
                            shows its address. prefetch={false}: the row's
                            hover already prefetches the route, and forty
                            visible links must not mean forty prefetches. */}
                        <Link
                          href={orderHref(o.id)}
                          prefetch={false}
                          className="orders-row-link"
                          onClick={e => e.stopPropagation()}
                          onFocus={() => router.prefetch(`/orders/${o.id}`)}
                        >
                          {formatOrderOperationalNumber(o.display_number) ?? o.display_number}
                        </Link>
                        {updateLabel && (
                          <span className="order-update-badge">
                            <span className="order-update-dot" aria-hidden="true" />
                            {updateLabel}
                          </span>
                        )}
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
          </>
        )}
      </div>
    </OrdersLayout>
  )
}
