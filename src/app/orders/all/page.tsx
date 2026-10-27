'use client'

import { displayOrderNumber } from '@/lib/orderNumbering'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  FilterChip,
  FinanceEmpty,
  FinancePerson,
  FinanceStatusCards,
  type FinanceTabTone,
} from '@/app/finance/components/FinanceListParts'
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
import { PackageSearch, Percent } from 'lucide-react'
import {
  COMMISSION_ICON_LABEL,
  factoryStatus,
  orderListFlags,
  orderListSubtotal,
} from '@/lib/orders/orderListValue'
import { SAMPLE_TYPE_LABEL, type SampleType } from '@/lib/orders/sampleType'
import {
  PENDENCY_COLUMN_LABEL, buildPendencyOverviews,
  type CurrentApprovalRow, type OpenPendencyRow, type OrderPendencyOverview,
} from '@/lib/orders/pendencyOverview'
import { PendenciesPopup, PendencyCell } from './PendenciesPopup'

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
  /** The Subtotal (products minus discount) — what the Value column shows. See orderListValue.ts. */
  subtotal: number | null
  /** 'aligned' once Operations accepted the PI for production (Factory Status). */
  production_alignment: string | null
  /** The PI went with the "Sample order" reason (an icon by the Project code). */
  sample: SampleType | null
  /** The PI has a middleman commission this reader may see (an icon by the Project code). */
  commission: boolean
  status: string
  created_at: string
  lead_source: string | null
  source_request_number: string | null
}

type StatusFilter = 'all' | 'running' | 'on_hold' | 'ready_for_dispatch' | 'dispatched' | 'cancelled'

type DateFilter = 'all' | '7d' | '30d' | 'this_month' | '3m' | 'this_year'

type SortKey = 'newest' | 'oldest' | 'number_desc' | 'number_asc' | 'value_desc' | 'value_asc'

// ── Constants ─────────────────────────────────────────────────────────────────

// The status colours of the Finance lists (owner, 2026-10): Running blue, On
// Hold amber, Ready for Dispatch green, Dispatched grey (finished), Cancelled
// red — on the status cards below. The table has no Status column since
// 2026-10-19 (owner: every Order in this list reads Running).

// 'requested' is gone (20260702000000): an Order exists only after its Order
// Request was reviewed and converted, so every Confirmed Order starts at
// 'running' and no pre-approval state remains to filter by. The database CHECK
// no longer permits the value, so this list is the complete status domain, not
// a subset of it. The status cards ARE the filter (no tab strip since 2026-10).
const STATUS_CARDS: { key: StatusFilter; label: string; tone: FinanceTabTone }[] = [
  { key: 'all',                label: 'All orders',        tone: 'neutral' },
  { key: 'running',            label: 'Running',           tone: 'partial' },
  { key: 'on_hold',            label: 'On Hold',           tone: 'zero' },
  { key: 'ready_for_dispatch', label: 'Ready to Dispatch', tone: 'full' },
  { key: 'dispatched',         label: 'Dispatched',        tone: 'neutral' },
  { key: 'cancelled',          label: 'Cancelled',         tone: 'over' },
]

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

/** Factory Status: aligned for production by Operations (green), or not yet (amber). */
function FactoryBadge({ alignment }: { alignment: string | null }) {
  const f = factoryStatus(alignment)
  return <span className={`fin-pill fin-pill--${f.aligned ? 'full' : 'zero'}`}>{f.label}</span>
}

/**
 * THE TWO MARKERS BY THE PROJECT CODE — a symbol only, no text (owner,
 * 2026-10-19). The name is in the tooltip and the accessible label, so the
 * meaning never depends on recognising the shape.
 */
function ProjectFlags({ sample, commission }: { sample: SampleType | null; commission: boolean }) {
  if (!sample && !commission) return null
  return (
    <span className="orders-list-flags">
      {sample && (
        <span className={`orders-list-flag orders-list-flag--${sample}`} title={SAMPLE_TYPE_LABEL[sample]} aria-label={SAMPLE_TYPE_LABEL[sample]} role="img">
          <PackageSearch size={14} strokeWidth={2} aria-hidden="true" />
        </span>
      )}
      {commission && (
        <span className="orders-list-flag orders-list-flag--commission" title={COMMISSION_ICON_LABEL} aria-label={COMMISSION_ICON_LABEL} role="img">
          <Percent size={14} strokeWidth={2} aria-hidden="true" />
        </span>
      )}
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
  /**
   * THE PENDENCIES COLUMN (owner, 2026-10-27): the newest Fabric / Finish status
   * per Order and every open pendency, two reads beside the list. Until they
   * land, or if either fails, the column shows a dash — never a status nobody
   * checked.
   */
  const [pendencyReads, setPendencyReads] = useState<{ approvals: CurrentApprovalRow[]; open: OpenPendencyRow[] } | null>(null)
  const [pendencyPopup, setPendencyPopup] = useState<string | null>(null)

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
        confirm_date, due_date, total_value, total_product_value, production_alignment, sample_type, sample_type_set_at, status,
        created_at, lead_source, source_request_number,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name),
        source_pi:order_submissions!source_order_submission_id(subtotal_after_discount, grand_total, advance_exception_reason_code, sample_type, commission:order_submission_middleman_commissions(middleman_commission))
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
      // THE VALUE COLUMN IS THE SUBTOTAL (owner, 2026-10-19): products minus
      // discount, never fabric, packing, transport or GST.
      subtotal: orderListSubtotal(o),
      ...orderListFlags(o),
      source_pi: undefined,
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

  const loadPendencies = async () => {
    const [approvals, open] = await Promise.all([
      supabase.from('order_approval_current').select('order_id, approval_kind, status'),
      supabase.from('order_pendencies').select('order_id, label').is('cleared_at', null).order('created_at', { ascending: true }),
    ])
    if (approvals.error || open.error) { setPendencyReads(null); return }
    setPendencyReads({
      approvals: (approvals.data ?? []) as CurrentApprovalRow[],
      open: (open.data ?? []) as OpenPendencyRow[],
    })
  }

  const pendencyOverviews = useMemo(
    () => pendencyReads
      ? buildPendencyOverviews(orders.map(o => o.id), pendencyReads.approvals, pendencyReads.open)
      : new Map<string, OrderPendencyOverview>(),
    [orders, pendencyReads],
  )

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
        loadPendencies(),
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
        case 'value_desc':  return compareValue(a.subtotal, b.subtotal, -1)
        case 'value_asc':   return compareValue(a.subtotal, b.subtotal, 1)
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
          background: '#E8F2EC', border: '1px solid #BCD8C8',
          fontSize: '13px', color: '#276247',
        }}>
          <span>Request deleted successfully.</span>
          <button
            onClick={() => setDeletedBanner(false)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#276247', padding: 0, lineHeight: 1, fontSize: '13px' }}
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
            background: '#FAF0DA', border: '1px solid #E6D2A0',
            fontSize: '13px', color: '#805B0D',
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

      {/* ── The status cards ARE the filter (Finance lists, 2026-10) ──
          Each card counts what it would show under the view bar's filters, so
          a number never contradicts the list once the card is pressed. */}
      <FinanceStatusCards
        ariaLabel="Order status"
        noun="order"
        active={statusTab}
        onSelect={setStatusTab}
        cards={STATUS_CARDS.map(c => ({ ...c, count: listLoading && orders.length === 0 ? null : tabCounts[c.key] }))}
      />

      <div className="fin-board">
        {/* ── The view bar: search, then one chip per filter ──
            Form controls only. Confirmed Orders is a review surface: no
            creation action belongs here — an Order begins as an uploaded PI and
            is confirmed at approval. */}
        <div className="fin-viewbar">
          <div className="fin-tools fin-tools--wrap" role="search" aria-label="Filter Confirmed Orders">
            <label className="boe-list-search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                aria-label="Search Confirmed Orders"
                placeholder="Order no., client or person…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onBlur={flushSearch}
              />
              {searchInput && (
                <button type="button" onClick={() => setSearchInput('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
              )}
            </label>
            <FilterChip
              icon="person"
              label={assigneeOptions.find(a => a.id === assignee)?.name ?? 'Assignee'}
              isSet={assignee !== 'all'}
            >
              <select
                className="boe-input"
                aria-label="Filter by assignee"
                value={assignee}
                onChange={e => setAssignee(e.target.value)}
              >
                <option value="all">All assignees</option>
                {assigneeOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </FilterChip>
            <FilterChip
              label={dateFilter === 'all' ? 'Order date' : DATE_FILTERS.find(d => d.key === dateFilter)?.label ?? 'Order date'}
              isSet={dateFilter !== 'all'}
            >
              <select
                className="boe-input"
                aria-label="Filter by order date"
                value={dateFilter}
                onChange={e => setDateFilter(e.target.value as DateFilter)}
              >
                {DATE_FILTERS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </FilterChip>
            {sourceOptions.length > 0 && (
              <FilterChip
                icon="tag"
                label={source === 'all' ? 'Source' : LEAD_SOURCE_LABEL[source] ?? source}
                isSet={source !== 'all'}
              >
                <select
                  className="boe-input"
                  aria-label="Filter by lead source"
                  value={source}
                  onChange={e => setSource(e.target.value)}
                >
                  <option value="all">All sources</option>
                  {sourceOptions.map(s => <option key={s} value={s}>{LEAD_SOURCE_LABEL[s] ?? s}</option>)}
                </select>
              </FilterChip>
            )}
            <FilterChip
              icon="sort"
              label={SORT_OPTIONS.find(s => s.key === sortKey)?.label ?? 'Sort'}
              isSet={sortKey !== 'newest'}
            >
              <select
                className="boe-input"
                aria-label="Sort orders"
                value={sortKey}
                onChange={e => setSortKey(e.target.value as SortKey)}
              >
                {SORT_OPTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </FilterChip>
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '12px' }}>
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* A REFRESH KEEPS THE ROWS. The table used to be swapped for
            "Loading…" on every re-read, which threw the reader back to the
            top; the rows stay on screen while a read is in flight. */}
        {loadError && (
          <div role="alert" style={{
            display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
            background: 'rgba(180,35,50,0.08)', color: '#B42332', fontSize: '12px',
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>{loadError}</span>
            <button type="button" onClick={() => { void loadOrders() }} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
              Retry
            </button>
          </div>
        )}
        {listLoading && orders.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : loadError && orders.length === 0 ? (
          // Nothing was read, so nothing is claimed — the banner above says why.
          null
        ) : visible.length === 0 ? (
          /* TWO DIFFERENT EMPTIES: "no Orders" is a statement about the
             business; "nothing matches" is about the filters, and offers the
             way out. */
          filtersActive ? (
            <FinanceEmpty
              icon="search"
              title={search.trim() ? `No results for “${search.trim()}”.` : 'No orders match these filters.'}
              body="Try an order number, a client or a person, or clear the filters."
              action={
                <button type="button" onClick={clearFilters} className="boe-btn boe-btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }}>
                  Clear filters
                </button>
              }
            />
          ) : (
            <FinanceEmpty
              icon="box"
              title="No Confirmed Orders yet."
              body="An Order appears here when its PI is approved and confirmed."
            />
          )
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
              // The stored four-digit number (0526), as every Orders screen shows it.
              const number = displayOrderNumber(o.display_number)
              return (
                <li key={o.id} className={`orders-list-card${updateLabel ? ' has-update' : ''}`}>
                  <div className="orders-list-card-top">
                    <Link href={orderHref(o.id)} prefetch={false} className="orders-list-card-link">
                      {number}
                    </Link>
                    <ProjectFlags sample={o.sample} commission={o.commission} />
                  </div>
                  <div className="orders-list-card-client">{o.client_name}</div>
                  <div className="orders-list-card-meta">
                    <span className="orders-list-card-value">{fmtAmount(o.subtotal)}</span>
                    <FactoryBadge alignment={o.production_alignment} />
                  </div>
                  <div className="orders-list-card-meta">
                    <span>{PENDENCY_COLUMN_LABEL}</span>
                    <PendencyCell overview={pendencyOverviews.get(o.id)} onOpen={() => setPendencyPopup(o.id)} />
                  </div>
                  <div className="orders-list-card-meta">
                    <span style={{ color: overdue ? colors.red : undefined, fontWeight: overdue ? 600 : undefined }}>
                      Due {fmtDate(o.due_date)}{overdue ? ' · overdue' : ''}
                    </span>
                  </div>
                  {(o.assigned_to_name || updateLabel) && (
                    <div className="orders-list-card-meta">
                      <span>{o.assigned_to_name ? `Sales person: ${o.assigned_to_name}` : ''}</span>
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
          <div className="orders-list-table fin-table-wrap">
            <table className="fin-table fin-table--orders">
              <colgroup>
                {/* THE OWNER'S ORDER (2026-10-19): Project code, Client,
                    Product Value, Factory Status — then Sales person and the
                    two dates. "Requested by" and "Status" are gone (every
                    Order here reads Running; the status cards still filter).
                    Every column is LEFT-aligned; only the markers sit at the
                    right edge of the Project code cell. */}
                <col style={{ width: '14%' }} />{/* Project code + update badge | markers */}
                <col style={{ width: '19%' }} />{/* Client, lead source under it */}
                <col style={{ width: '12%' }} />{/* Product Value (the Subtotal) */}
                <col style={{ width: '14%' }} />{/* Factory Status */}
                <col style={{ width: '12%' }} />{/* Pendencies (owner, 2026-10-27) */}
                <col style={{ width: '11%' }} />{/* Sales person */}
                <col style={{ width: '9%' }} />{/* Confirmed */}
                <col style={{ width: '9%' }} />{/* Due, "Overdue" under it */}
              </colgroup>
              <thead>
                <tr>
                  <th>Project code</th>
                  <th>Client</th>
                  <th>Product Value</th>
                  <th>Factory Status</th>
                  <th>Pendencies</th>
                  <th>Sales Person</th>
                  <th>Confirmed</th>
                  <th>Due</th>
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
                      /* A TINT AND A LEFT EDGE, NOT A FLASH. The row has to be
                         hard to miss in a list of forty and impossible to find
                         irritating in a list somebody reads all day, so the
                         animation is on the small dot in the badge and nowhere
                         else. */
                      className={updateLabel ? 'has-update' : undefined}
                      /* HOVER IS THE EARLIEST HONEST SIGNAL that this row is
                         about to be opened, and prefetching the Order detail
                         route on it means the code for that screen is already
                         in hand when the click lands. It fetches the ROUTE, not
                         the Order: no record, no permission and no file is read
                         until the page mounts and asks under the reader's own
                         session, so this can neither leak a row nor show a
                         stale one. Next de-duplicates repeated prefetches, so
                         moving down a list of forty costs forty cache hits. */
                      onMouseEnter={() => router.prefetch(`/orders/${o.id}`)}
                    >
                      <td className="fin-ordno orders-code-cell" style={{ fontWeight: updateLabel ? 800 : undefined }}>
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
                          {displayOrderNumber(o.display_number)}
                        </Link>
                        {updateLabel && (
                          <span className="order-update-badge" title={updateLabel}>
                            <span className="order-update-dot" aria-hidden="true" />
                            {updateLabel}
                          </span>
                        )}
                        <ProjectFlags sample={o.sample} commission={o.commission} />
                      </td>
                      <td title={o.client_name}>
                        <span className="fin-primary-text">{o.client_name}</span>
                        {o.lead_source && (
                          <span className="fin-sub">{LEAD_SOURCE_LABEL[o.lead_source] ?? o.lead_source}</span>
                        )}
                      </td>
                      <td>
                        <span className="fin-amount">{fmtAmount(o.subtotal)}</span>
                      </td>
                      <td>
                        <FactoryBadge alignment={o.production_alignment} />
                      </td>
                      <td>
                        <PendencyCell overview={pendencyOverviews.get(o.id)} onOpen={() => setPendencyPopup(o.id)} />
                      </td>
                      <td><FinancePerson name={o.assigned_to_name} /></td>
                      <td className="fin-muted">{fmtDate(o.confirm_date)}</td>
                      <td>
                        {fmtDate(o.due_date)}
                        {overdue && <span className="fin-sub fin-sub--alert">Overdue</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
        {pendencyPopup && pendencyOverviews.get(pendencyPopup) && (() => {
          const o = orders.find(x => x.id === pendencyPopup)
          const overview = pendencyOverviews.get(pendencyPopup)
          if (!o || !overview) return null
          return (
            <PendenciesPopup
              orderNumber={displayOrderNumber(o.display_number)}
              overview={overview}
              orderHref={`${orderHref(o.id)}#order-pendencies`}
              onClose={() => setPendencyPopup(null)}
            />
          )
        })()}
      </div>
    </OrdersLayout>
  )
}
