'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { parseListState } from '@/lib/listState'
import { useMirrorToUrl } from '@/hooks/useMirrorToUrl'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { mergeSearchParams } from '@/lib/navigation/urlMirror'
import { pathWithSearch } from '@/lib/tasks/taskReturnPath'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import { createClient } from '@/lib/supabase/client'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { PAYMENT_MODE_LABEL } from '@/lib/finance/paymentEntry'
import { RECEIVED_PAYMENTS_SOURCE } from '@/app/finance/paymentRouting'
import { canDeletePayment, describePaymentAllocations } from '@/lib/finance/paymentDeletion'
import { DeletePaymentModal } from '@/components/finance/DeletePaymentModal'
import {
  RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS,
  dateRange,
  isNarrowed,
  confirmedListEmptyKind,
  confirmedListUrlPatch,
  SHOW_ALL_PAYMENTS_STATE,
  type ConfirmedListEmptyKind,
  pageCount,
  pageRange,
  resultSummary,
  receivedPaymentsSearchFilter,
  type PaymentView,
} from '@/app/finance/receivedPaymentsQuery'
import {
  paymentRowFigures,
  type ClassifiablePayment,
} from '@/lib/finance/paymentClassification'
import {
  directOrderOf,
  linkCounts,
  paymentLinks,
} from '@/lib/finance/paymentLinks'
import { PENDING_ALLOCATION_SUMMARY, summarizePaymentAllocations, type PaymentAllocationRow, type PaymentAllocationSummary } from '@/lib/finance/paymentAllocations'
import { ALLOCATION_TARGETS_MAX_IDS, allocationTargetNames, nameSummaryTargets, piDraftSafeName, PI_DRAFT_NAME_COLUMNS, buildAllocatedAgainst, completeAllocatedTotal, completeAllocationSummary, type AllocatedAgainstView, type AllocationTargetRow } from '@/lib/finance/allocatedAgainst'
import {
  canOpenOrderRecord,
  orderDetailHref,
  piSubmissionHref,
} from '@/lib/finance/crossModuleLinks'
import {
  RECORD_PAYMENT_ACTION_LABEL,
  RecordSplitPaymentModal,
} from './RecordSplitPaymentModal'
import { AllocateFundsModal } from './AllocateFundsModal'
import { CorrectAllocationModal } from './CorrectAllocationModal'
import { deriveOrdersCapabilities, NO_ORDERS_CAPABILITIES } from '@/lib/permissions/orders'
import { useQueryClient } from '@tanstack/react-query'
import { RECEIVED_PAYMENTS_COUNTS_KEY } from '@/hooks/queries/useReceivedPaymentsCounts'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { CONFIRMED_ALLOCATION_FILTERS, CONFIRMED_ALLOCATION_FILTER_LABEL, DEFAULT_CONFIRMED_ALLOCATION_FILTER, PAYMENTS_TABLE_BREAKPOINT, PAYMENT_SURFACE_STATUSES, type ConfirmedAllocationFilter, type PaymentSurface } from '@/lib/finance/paymentSurfaces'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'

import { PaymentRequest, LegacyCustodyFields, NO_LEGACY_CUSTODY, fetchLegacyCustodyFields, SEARCH_DEBOUNCE_MS, TO_VERIFY_META, VIEW_META, RECEIVED_LIST_PARAMS, fmtDate, fmtAmount } from './receivedPaymentsModel'

import { ConfirmedListEmptyState } from './receivedPaymentsAtoms'
// Re-exported: the render tests import it from here.
export { ConfirmedListEmptyState } from './receivedPaymentsAtoms'
// @split: src/app/finance/received/receivedPaymentsModel.tsx private=PaymentRequest,LEGACY_CUSTODY_COLUMNS,LegacyCustodyFields,NO_LEGACY_CUSTODY,fetchLegacyCustodyFields,SEARCH_DEBOUNCE_MS,RECEIVED_IN_LABEL,receivedInLabel,STATUS_META,TO_VERIFY_META,VIEW_META,RECEIVED_LIST_PARAMS,RECEIVED_IN_OPTIONS,STATUS_CORRECTION_OPTIONS,fmtDateTime,fmtDate,fmtAmount,friendlyDbErrorMessage,Field,ErrorBanner
// @split: src/app/finance/received/receivedPaymentsAtoms.tsx private=SectionHeader,DetailRow,DIVIDED_SECTION,StatusBadge,VerificationBadge

export { AllocationPanel } from './receivedPaymentsPanel'
// @split: src/app/finance/received/receivedPaymentsPanel.tsx

import { DetailsModal } from './receivedPaymentsDetails'
export { DetailsModal } from './receivedPaymentsDetails'
// @split: src/app/finance/received/receivedPaymentsDetails.tsx

import { EditPaymentModal } from './receivedPaymentsEdit'
// @split: src/app/finance/received/receivedPaymentsEdit.tsx private=EditPaymentModal

import { canOfferAllocateFunds } from './receivedPaymentsTable'
export { ReceivedPaymentsTable, AllocatedAgainstCell } from './receivedPaymentsTable'
// @split: src/app/finance/received/receivedPaymentsTable.tsx private=TH_STYLE,canOfferAllocateFunds,CONFIRMED_ALLOCATION_TONE_STYLE,ConfirmedAllocationBadge

import { PaymentsToVerifyTable, PaymentsToVerifyCards, ConfirmedPaymentsList } from './receivedPaymentsLists'
export { ConfirmedPaymentsList, ReceivedPaymentsCards } from './receivedPaymentsLists'
// @split: src/app/finance/received/receivedPaymentsLists.tsx private=PaymentsToVerifyTable,PaymentsToVerifyCards,ConfirmedListProps

function rowView(
  r: PaymentRequest,
  allocations: Map<string, PaymentAllocationSummary>,
  labels: ReadonlyMap<string, string>,
  canOpenOrders: boolean,
) {
  const figures = paymentRowFigures(r as unknown as ClassifiablePayment)
  const summary = allocations.get(r.id) ?? PENDING_ALLOCATION_SUMMARY(r.id)
  const links = paymentLinks({
    summary,
    directOrder: directOrderOf(r),
    labels,
    canOpenOrders,
  })
  return {
    figures,
    summary,
    links,
    counts: linkCounts(links),
    // A BALANCE THAT WAS WITHHELD IS NOT A BALANCE TO SPEND. `available` is null
    // when this reader cannot see every allocation of this payment, and the
    // control is not offered — the RPC would compute the true balance under a
    // lock and could refuse, but offering a control on a figure nobody can
    // vouch for invites exactly the double-spend the withholding prevents.
    canAllocate: figures.available !== null
      && Number(figures.available) > 0
      && r.status !== 'rejected',
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────
// One component, two routes: /finance/received/linked and
// /finance/received/unlinked each render it with their own `mode`. The table,
// the detail modal and every row action are shared verbatim — only the
// query predicate, the copy and the filter row differ.

export function ReceivedPaymentsView(
  { view, surface = 'confirmed' }: { view: PaymentView; surface?: PaymentSurface },
) {
  return (
    <Suspense fallback={<FinanceRouteFallback />}>
      <ReceivedPaymentsViewInner view={view} surface={surface} />
    </Suspense>
  )
}

function ReceivedPaymentsViewInner(
  { view, surface }: { view: PaymentView; surface: PaymentSurface },
) {
  const [pageLoading,    setPageLoading]    = useState(true)
  // Finance authority for the SIGNED-IN user. Starts empty and is only
  // widened once the resolver answers, so no correction control can flash
  // before it is authorized. Admins short-circuit inside the helper.
  const [caps,           setCaps]           = useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [requests,       setRequests]       = useState<PaymentRequest[]>([])
  const [listLoading,    setListLoading]    = useState(false)
  // A FAILED READ IS NOT AN EMPTY LIST. The sidebar's Confirmed Payments count
  // is a single narrow `id`-only query; this list asks for every classification
  // and allocation column besides. That asymmetry means the two can fail
  // independently, and a swallowed error here used to fall through to
  // `data ?? []` — rendering the same "No payments received yet" a genuinely
  // empty ledger would show, with the sidebar badge (unaffected by whatever
  // failed) still reading the true count beside it. Kept separate from
  // `narrowed`'s "no matches" copy: this is not a filter finding nothing, it is
  // the read itself not having happened.
  const [listError,      setListError]      = useState<string | null>(null)
  const [detailRequest,  setDetailRequest]  = useState<PaymentRequest | null>(null)
  const [editRequest,    setEditRequest]    = useState<PaymentRequest | null>(null)
  const [deleteTarget,   setDeleteTarget]   = useState<PaymentRequest | null>(null)
  // ── The list's working context, seeded from the URL ──
  // Tab, search, date bounds and page arrive in the query string and are
  // mirrored back to it (useMirrorToUrl, below), so opening a payment's Order
  // and pressing Back returns to exactly this view. Read ONCE, at mount; after
  // that React state is the source of truth, exactly as it always was.
  const initialSearchParams = useSearchParams()
  const [initialList] = useState(() => parseListState(RECEIVED_LIST_PARAMS, initialSearchParams))
  const [search,         setSearch]         = useState(initialList.q)
  const [dateFrom,       setDateFrom]       = useState(initialList.from)
  const [dateTo,         setDateTo]         = useState(initialList.to)
  // ── The allocation narrowing ──
  // REMOVED, AND NOT REPLACED — it was already here twice. A `<select>` offered
  // Any allocation / Unallocated / Partly / Fully / Over-allocated, and the tab
  // strip below offers the identical five states over the same
  // `confirmed_allocation_status` column in the same query. Two controls for one
  // narrowing meant they could be set to contradict each other, and the reader
  // had to know which one won.
  //
  // The tabs are what survives. They are the more discoverable of the two, they
  // are already the page's primary navigation, and they need no feature-probe:
  // the dropdown's `allocationReady` check cost a round trip on every page load
  // purely to decide whether to draw itself, and that query is gone with it.
  // ── The Confirmed Payments allocation-status filter (Requirement 1) ──
  // Replaces the old `?view=all|orders|pi_drafts|available` tab strip for the
  // 'confirmed' surface only. A real PostgREST predicate over
  // confirmed_allocation_status, never a client-side filter over the page in
  // hand — this list is paged. Meaningless for 'to_verify', which has not been
  // allocated to anything yet.
  const [confirmedFilter, setConfirmedFilter] = useState<ConfirmedAllocationFilter>(initialList.status)
  const [highlightId,    setHighlightId]    = useState<string | null>(null)
  // ── Paging ──
  // The list was UNBOUNDED, and PostgREST truncates silently at 1000 rows: no
  // error, no warning, a plausible-looking array. Ordered created_at DESC, the
  // 1001st approved payment would have started pushing the OLDEST ones out of
  // Finance with the count beside them reading a confident "1000". `total` is
  // the database's exact count, so the line under the toolbar describes the
  // whole set rather than the length of what happened to load.
  // ── The page, and which view it belongs to ──
  //
  // HELD TOGETHER, deliberately. Changing the view is a different set entirely,
  // so page four of the old one means nothing in the new one — but the view
  // arrives as a PROP from the route, not from a control this component owns,
  // so there is no click to hang a reset on. Resetting it in an effect would set
  // state during a render it also caused, which is the cascading-render pattern
  // react-hooks/set-state-in-effect exists to catch. Deriving it instead costs
  // nothing and cannot render twice.
  const [pageState, setPageState] = useState<{ view: PaymentView; page: number }>({ view, page: initialList.page })
  const page = pageState.view === view ? pageState.page : 1
  const setPage = (next: number | ((current: number) => number)) =>
    setPageState({ view, page: typeof next === 'function' ? next(page) : next })
  const [total,          setTotal]          = useState<number | null>(null)
  // How much of each payment on THIS PAGE has been given a home. A second
  // bounded read keyed on the ids already on screen — one query for the page,
  // never one per row. Absent until it lands, and absent is `unknown`, never
  // "Unallocated": see paymentAllocations.ts on why those must not collapse.
  const [allocations,    setAllocations]    = useState<Map<string, PaymentAllocationSummary>>(new Map())
  // Orders authority, resolved beside the Finance one in the same parallel
  // group. It decides ONE thing: whether a linked row offers a door into the
  // Order or PI it names. It grants nothing — the destination re-reads its own
  // record under this reader's RLS and refuses anything they may not open.
  const [ordersCaps,     setOrdersCaps]     = useState(NO_ORDERS_CAPABILITIES)
  // Display numbers for the Orders and PI Drafts this page's allocations name,
  // read under the reader's OWN RLS. A target whose row did not come back is
  // named by its kind alone and offers no door — see paymentLinks.ts.
  const [targetLabels,   setTargetLabels]   = useState<Map<string, string>>(new Map())
  // ALLOCATED AGAINST: the COMPLETE active targets of this page's payments, from
  // received_payment_allocation_targets() — one call per page, never per row.
  // `rows` null = not answered yet; `failed` = the cell says "Allocation details
  // unavailable" rather than "Not allocated"; `ids` = which payments the answer
  // covers, because silence means "no allocation" only for an id that was asked.
  const [allocationTargets, setAllocationTargets] = useState<{
    rows: AllocationTargetRow[] | null
    failed: boolean
    ids: ReadonlySet<string>
  }>({ rows: null, failed: false, ids: new Set() })
  // The new multi-target allocation flow (Requirement 3) — replaces the old
  // single-target "Allocate" row action on Confirmed Payments with one that
  // can divide a payment across several targets in one atomic RPC call.
  const [allocateFundsTarget, setAllocateFundsTarget] = useState<PaymentRequest | null>(null)
  // Correct Allocation (finance.allocate_correct). One Finance modal at a time:
  // opening it closes the payment detail it was opened from.
  const [correctAllocationTarget, setCorrectAllocationTarget] = useState<PaymentRequest | null>(null)
  // Recording a payment and dividing it in one flow. Held here rather than in
  // the modal so the list can refresh itself and say what landed.
  const [recording, setRecording] = useState(false)
  const [recordNotice, setRecordNotice] = useState<string | null>(null)
  // Below this the eleven-column table becomes cards. Same data, same decisions.
  const [isMobile,       setIsMobile]       = useState(false)

  // THE HEADER IS THE SURFACE'S, then the view's. Payments to Verify has one
  // list and no classification views, so it names itself rather than borrowing
  // "Received Payments" — a page whose title says one thing and whose rows are
  // another is the confusion this split exists to end.
  const meta         = surface === 'to_verify' ? TO_VERIFY_META : VIEW_META.all
  const router       = useRouter()
  const pathname     = usePathname()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()
  const queryClient  = useQueryClient()

  // Guards the one-time ?payment= deep-link resolution below (see effect near
  // the bottom of init) so it can never re-fire and reopen a closed modal.
  const deepLinkHandled = useRef(false)

  /**
   * The search term the last re-read was delayed for.
   *
   * Lets the re-read effect tell a KEYSTROKE — which needs coalescing — from a
   * filter chip or a page step, which is one deliberate click and should start
   * its request immediately. `undefined` until the first change, which no real
   * filter value equals.
   */
  const debouncedSearch = useRef<string | null | undefined>(undefined)

  // ── Wide table, or cards ──
  //
  // Measured rather than guessed at from a user-agent string, and re-measured on
  // resize so rotating a tablet lands on the right shape. Starts false, which is
  // the desktop table: the first paint on a phone swaps to cards within a frame,
  // and starting with cards would flash them on every desktop load instead.
  useEffect(() => {
    const measure = () => setIsMobile(window.innerWidth < PAYMENTS_TABLE_BREAKPOINT)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // The narrowing, as the DATABASE will be asked it. Held in a ref as well as
  // in state so the loader always reads the CURRENT filters rather than the ones
  // its closure was created with — a search typed quickly would otherwise
  // re-issue an older query and paint a stale page over a newer one.
  /**
   * Whether the allocation control is offered at all.
   *
   * BOTH GATES. The column has to exist (the migration is applied) AND this
   * reader has to be able to see every allocation, so that the security_invoker
   * sum behind the state IS the true sum for them. A reader holding
   * finance.view without finance.view_all would otherwise be shown a filter
   * that calls fully-allocated money "Unallocated" — the exact confusion
   * paymentAllocations.ts refuses to make on the per-payment panel.
   */

  const filters = useMemo(() => {
    const dates = dateRange(dateFrom, dateTo)
    return {
      search: receivedPaymentsSearchFilter(search),
      // The VIEW is not a filter the reader applied; it is where they are. It is
      // in this object because the loader has to send it, and out of isNarrowed
      // for the same reason — see receivedPaymentsQuery.ts.
      view,
      dateFrom: dates.from,
      dateTo: dates.to,
      // Never sent unless the column is there AND this reader may trust it.
      // Meaningless outside Confirmed Payments — Payments to Verify never
      // applies it, whatever a stray click set it to.
      confirmedFilter: surface === 'confirmed' ? confirmedFilter : DEFAULT_CONFIRMED_ALLOCATION_FILTER,
    }
  }, [search, view, dateFrom, dateTo, surface, confirmedFilter])

  // Every narrowing a reader applied, in the address bar — see
  // RECEIVED_LIST_PARAMS. Held back until the first load so a deep link's own
  // parameters are read before anything rewrites the query.
  useMirrorToUrl(
    confirmedListUrlPatch({ confirmedFilter, search, dateFrom, dateTo, page }, surface),
    !pageLoading,
  )
  // Back from an Order or a PI lands where the reader was, not at the top.
  useListScrollRestore()

  // Guards against an out-of-order response. Each load claims a number; only the
  // newest one is allowed to write to state. Without this, a slow query for
  // "REQ" can land after a fast one for "REQ-2026" and repaint the wider result
  // under a narrower search box.
  const loadToken = useRef(0)

  /**
   * Whether an EMPTY allocation list is conclusive for this reader — resolved
   * once, held as a PROMISE so the allocation read can await it instead of
   * racing it. Defaults to a resolved `false`, which is the safe answer: a
   * payment is only ever called "Unallocated" on evidence, never on a gap.
   */
  const canViewAllRef = useRef<Promise<boolean>>(Promise.resolve(false))

  const loadRequests = async () => {
    const token = ++loadToken.current
    setListLoading(true)
    // Same approved-only scope as before the split; the linkage predicate is
    // what makes the two pages disjoint. Filtered in the database rather than
    // in the browser so neither page ever holds the other's rows.
    //
    // RECEIVED_PAYMENTS_SOURCE, not the base table: it is the same payments, one
    // row each, plus the ACTIVE-allocation columns this page needs to classify
    // money that PI approval moved onto a Confirmed Order without touching the
    // payment record. It is security_invoker, so RLS still decides what loads.
    // EVERY MUTATION ON THIS PAGE STILL WRITES TO finance_payment_requests by
    // the row's own id, which the projection carries through unchanged.
    //
    // `count: 'exact'` so the toolbar states the size of the WHOLE narrowed set
    // rather than the length of the page in hand.
    const base = supabase
      .from(RECEIVED_PAYMENTS_SOURCE)
      .select(`
        id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
        received_in,
        proof_note, order_number, order_id,
        order_request_id, order_request_number, sales_note,
        status, payment_against, submitted_by, admin_note, created_at,
        submitted_by_name, approved_by_name,
        allocated_order_id, allocated_order_number, is_order_allocated,
        confirmed_allocation_status,${surface === 'confirmed' ? ' complete_allocation_status,' : ''}
        ${RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS.join(', ')}
      `, { count: 'exact' })
      // ── THE SURFACE'S OWN STATUSES, AND NOTHING ELSE ──
      //
      // This used to be CLASSIFIED_PAYMENT_STATUSES — everything except
      // rejected — which put money that had arrived and money nobody had looked
      // at yet in one list, and computed every count, every search result and
      // every page number over the mixture. So "142 payments" answered neither
      // question, and a verifier scanned past confirmed rows to find work.
      //
      // Now each page asks for exactly its half, from the one list in
      // paymentSurfaces.ts that mirrors the database's own
      // finance_payment_status_is_verified(). The two are disjoint and
      // exhaustive, so a payment is on exactly one page and no status is
      // homeless.
      .in('status', PAYMENT_SURFACE_STATUSES[surface] as unknown as string[])

    let scoped = base

    // ── THE NARROWING, IN THE DATABASE ──
    //
    // Search and the classification both used to run in the BROWSER, over
    // whatever the unbounded query happened to return. Both had to move here the
    // moment the list became paged: filtering a page after the fact narrows only
    // the fifty rows in hand and silently hides every match on page two.
    //
    // Every clause narrows a set RLS has ALREADY decided this caller may see —
    // RECEIVED_PAYMENTS_SOURCE is security_invoker — so no filter here can widen
    // anything. The search term is sanitized into a literal before it reaches a
    // filter group (see sanitizeSearchTerm): a comma or a bracket in a term
    // would otherwise be parsed as MORE FILTER rather than as text to match.
    if (filters.search) scoped = scoped.or(filters.search)

    // ── THE CONFIRMED ALLOCATION FILTER (Requirement 1) ──
    //
    // Zero / Partially / Fully Allocated, read off complete_allocation_status
    // (20261216000000 §4) — the pure allocation-ledger classification over
    // the COMPLETE active ledger, as a real database predicate so it
    // composes correctly with search, dates and paging. "All" applies no
    // predicate. CONFIRMED PAYMENTS ONLY: a payment nobody has verified has
    // not been allocated to anything.
    if (surface === 'confirmed' && filters.confirmedFilter !== 'all') {
      // THE COMPLETE STATUS, filtered, paged and counted by the database. The
      // projection's own confirmed_allocation_status is summed under the
      // reader's RLS and can misclassify for a reader without view_all.
      scoped = scoped.eq('complete_allocation_status', filters.confirmedFilter)
    }

    if (filters.dateFrom) scoped = scoped.gte('payment_date', filters.dateFrom)
    if (filters.dateTo)   scoped = scoped.lte('payment_date', filters.dateTo)

    // ORDERED BY created_at AND THEN BY id. range() maps to LIMIT/OFFSET, which
    // makes no promise about row order unless the ordering is deterministic —
    // two payments recorded in the same instant could otherwise swap between
    // pages, showing one twice and hiding the other.
    const range = pageRange(page)
    const { data, count, error } = await scoped
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(range.from, range.to)

    // A newer load has already been issued; this answer is stale and must not
    // repaint the screen underneath it.
    if (token !== loadToken.current) return

    // THE FAILURE IS SHOWN, NEVER READ AS ZERO. `total` stays null rather than
    // 0 so resultSummary says "0 payments" is unknown, not confirmed — see
    // resultSummary's own null handling in listQuery.ts — and the empty state
    // below renders the error instead of "No payments received yet".
    if (error) {
      setListError(error.message || 'Could not load payments.')
      setRequests([])
      setTotal(null)
      setListLoading(false)
      return
    }
    setListError(null)

    // The two submitter/approver names arrive already flattened — the projection
    // joins users itself, so what used to be two embedded resources to unwrap is
    // now two plain columns. Same values, same nulls: approved_by_name is set by
    // approve_finance_payment_request (20260688/20260690) and is null only on a
    // row approved before that column existed. `?? undefined` keeps the optional
    // fields optional so every consumer below reads exactly as before.
    //
    // The five legacy custody columns are NOT on this row — see
    // fetchLegacyCustodyFields — so they are read separately, by the same ids,
    // before the page paints. Bounded exactly as the list is: at most 50 ids.
    const rows = (data ?? []) as unknown as Omit<PaymentRequest, keyof LegacyCustodyFields>[]
    const custody = await fetchLegacyCustodyFields(supabase, rows.map(r => r.id))
    if (token !== loadToken.current) return
    const mapped: PaymentRequest[] = rows.map(r => ({
      ...r,
      ...(custody.get(r.id) ?? NO_LEGACY_CUSTODY),
      submitted_by_name: r.submitted_by_name ?? undefined,
      approved_by_name:  r.approved_by_name  ?? undefined,
    }))
    setRequests(mapped)
    setTotal(count ?? null)
    setListLoading(false)

    // ── HOW MUCH OF EACH PAYMENT HAS A HOME ──
    //
    // Started AFTER the list, because it is keyed on the ids the list just
    // returned — and deliberately NOT awaited before the table paints. The rows
    // are already correct without it; this only fills one column and one panel
    // in the details modal, and blocking the whole list on it would trade a
    // visible table for a spinner.
    //
    // ONE QUERY FOR THE PAGE, never one per row, and bounded twice over: the
    // page is at most 50 ids, and the read is anchored to exactly those.
    loadAllocations(mapped, token)
    if (surface === 'confirmed') void loadAllocationTargets(mapped, token)
  }

  /**
   * The Allocated Against column's data: every ACTIVE allocation of the
   * payments on this page, complete, in ONE call.
   *
   * NOT the direct allocation read above. That one runs under the reader's RLS,
   * which for a participant without finance.view_all returns only the
   * allocations whose target they can open — so a split payment would show one
   * destination of three. received_payment_allocation_targets (20261216000000)
   * returns the complete set for every payment this reader may already see,
   * with safe references only, and nothing for any other id.
   *
   * A FAILURE IS SHOWN AS A FAILURE. `failed` makes every cell read
   * "Allocation details unavailable" — never "Not allocated", zero, or a
   * partial list.
   */
  const loadAllocationTargets = async (rows: readonly PaymentRequest[], token: number) => {
    const ids = rows.map(r => r.id).slice(0, ALLOCATION_TARGETS_MAX_IDS)
    if (ids.length === 0) {
      setAllocationTargets({ rows: [], failed: false, ids: new Set() })
      return
    }
    setAllocationTargets({ rows: null, failed: false, ids: new Set() })
    const { data, error } = await supabase.rpc('received_payment_allocation_targets', {
      p_payment_request_ids: ids,
    })
    if (token !== loadToken.current) return
    setAllocationTargets(error
      ? { rows: null, failed: true, ids: new Set() }
      : { rows: (data ?? []) as AllocationTargetRow[], failed: false, ids: new Set(ids) })
  }

  /** Re-read one payment's targets and splice them into the page's answer. */
  const refreshAllocationTargetsFor = async (id: string) => {
    const { data, error } = await supabase.rpc('received_payment_allocation_targets', {
      p_payment_request_ids: [id],
    })
    setAllocationTargets(prev => {
      const others = (prev.rows ?? []).filter(row => row.payment_request_id !== id)
      const ids = new Set(prev.ids)
      if (error) {
        // This one payment is now unknown; the rest of the page is unaffected.
        ids.delete(id)
        return { rows: prev.rows === null ? null : others, failed: prev.failed, ids }
      }
      ids.add(id)
      return { rows: [...others, ...((data ?? []) as AllocationTargetRow[])], failed: prev.failed, ids }
    })
  }

  /** The Allocated Against cell for one row, decided once for table and cards. */
  const allocatedAgainstFor = (r: PaymentRequest): AllocatedAgainstView =>
    buildAllocatedAgainst(r, allocationTargets.rows, {
      readFailed: allocationTargets.failed,
      covered: allocationTargets.rows === null ? undefined : allocationTargets.ids.has(r.id),
    })

  /**
   * A destination's page, ONLY when this reader may already open it: Orders
   * module entry AND the record came back from their own RLS read
   * (loadTargetLabels). Otherwise null, and the name is drawn as plain text.
   */
  const allocationTargetHref = (targetType: 'order' | 'pi_draft', targetId: string): string | null => {
    if (!canOpenOrderRecord(ordersCaps.canAccessOrdersModule)) return null
    if (!targetLabels.has(targetId)) return null
    // Carries this list's own address, so the record's Back control returns to
    // the same tab, filters and page.
    return withReturnTo(
      targetType === 'order' ? orderDetailHref(targetId) : piSubmissionHref(targetId),
      pathWithSearch(pathname, searchParams.toString()),
    )
  }

  /**
   * The allocations behind one page of payments.
   *
   * finance_payment_allocations under its own RLS — admin, finance.view_all, the
   * payment's own submitter, a PI participant or an Order participant. It is not
   * read through finance_received_payments, which exposes no allocated amount
   * and no split by design; and being able to SEE an allocation grants no
   * authority over one, because that table carries no INSERT, UPDATE or DELETE
   * policy for any role.
   *
   * A REFUSAL IS NOT AN ANSWER ABOUT THE MONEY. When the read fails, or when
   * this reader cannot see every allocation, each payment reports `unknown`
   * rather than `unallocated` — see paymentAllocations.ts. Telling a Finance
   * user that verified money is sitting in suspense when it is merely invisible
   * to them would be the worse failure by far.
   */
  const loadAllocations = async (rows: readonly PaymentRequest[], token: number) => {
    if (rows.length === 0) {
      if (token === loadToken.current) setAllocations(new Map())
      return
    }

    const [{ data, error }, emptyIsConclusive] = await Promise.all([
      supabase
        .from('finance_payment_allocations')
        .select('id, payment_request_id, allocated_amount, status, order_id, order_submission_id, created_at')
        .in('payment_request_id', rows.map(r => r.id))
        .eq('status', 'active'),
      canViewAllRef.current,
    ])

    if (token !== loadToken.current) return

    const allocationRows = (data ?? []) as PaymentAllocationRow[]

    // ── WHICH DESTINATIONS THIS READER MAY OPEN ──
    //
    // Two bounded reads over the ids this page's allocations name, under the
    // reader's OWN RLS. A record that comes back has a name and a door; one that
    // does not has neither, and paymentLinks names it by its kind alone.
    //
    // ASKING THE DATABASE IS THE POINT. A capability check here would be a
    // second, coarser answer than RLS's per-record one, and would offer a door
    // into a record RLS refuses. Bounded twice over: the page is at most fifty
    // payments, and these are keyed to exactly the targets they name.
    void loadTargetLabels(allocationRows, rows, token)

    setAllocations(summarizePaymentAllocations(
      // ID AND AMOUNT ONLY. The payment's own order_id is not an input: a row
      // with no active allocation is Zero Allocated whatever it points at.
      rows.map(r => ({ id: r.id, amount: r.amount })),
      allocationRows, {
      readable: !error,
      // Only a reader who can see EVERY allocation may be told "unallocated" on
      // the strength of an empty list. This is the protected finance.view_all
      // action, with admins short-circuiting inside deriveFinanceCapabilities —
      // exactly the two cases whose RLS returns the complete set.
      emptyIsConclusive,
      // The Confirmed Order number the projection already resolved, so naming an
      // allocation's target costs no additional read. A PI submission has no
      // number on this row and is named by its target only when the reader can
      // open it, which the PI page decides for itself.
      labels: new Map(
        rows
          .filter(r => r.allocated_order_id && r.allocated_order_number)
          .map(r => [r.allocated_order_id as string, r.allocated_order_number as string]),
      ),
    }))
  }

  /**
   * The display numbers for every Order and PI Draft this page's payments point
   * at, for the records this reader may actually read.
   *
   * A MISS IS THE ANSWER, NOT A FAILURE. An id that comes back with no row is a
   * record RLS refused, and paymentLinks turns that into an unnamed destination
   * with no door — the reader learns that their payment is split without
   * learning whose business the other share is.
   *
   * A PI HAS NO ALLOCATED NUMBER, so it is named by what its workbook carries.
   * An approved PI's money belongs to the Order, so a PI naming money here is by
   * definition still a draft and still has no number of its own.
   */
  const loadTargetLabels = async (
    allocationRows: readonly PaymentAllocationRow[],
    rows: readonly PaymentRequest[],
    token: number,
  ) => {
    const orderIds = new Set<string>()
    const submissionIds = new Set<string>()
    for (const row of allocationRows) {
      if (row.status !== 'active') continue
      if (row.order_id) orderIds.add(row.order_id)
      if (row.order_submission_id) submissionIds.add(row.order_submission_id)
    }
    // The direct-link fallback's Order is a destination too, and its number is
    // often already on the projection row — but not always, so it is asked for
    // here rather than assumed.
    for (const row of rows) {
      if (row.order_id) orderIds.add(row.order_id)
    }

    if (orderIds.size === 0 && submissionIds.size === 0) {
      if (token === loadToken.current) setTargetLabels(new Map())
      return
    }

    const [ordersRes, submissionsRes] = await Promise.all([
      orderIds.size > 0
        ? supabase.rpc('finance_order_lookup', { p_ids: [...orderIds] })   // pinned to the pre-scope rule (20270221000000)
        : Promise.resolve({ data: [] }),
      submissionIds.size > 0
        ? supabase.from('order_submissions')
            .select(PI_DRAFT_NAME_COLUMNS)
            .in('id', [...submissionIds])
        : Promise.resolve({ data: [] }),
    ])

    if (token !== loadToken.current) return

    const labels = new Map<string, string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of ((ordersRes.data ?? []) as any[])) {
      if (row.display_number) labels.set(row.id, row.display_number)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of ((submissionsRes.data ?? []) as any[])) {
      // The reserved Order number or the workbook's name — never the
      // workbook's own B20 (source_order_number), which is normally the number
      // of an older PI the file was copied from.
      labels.set(row.id, piDraftSafeName(row))
    }
    setTargetLabels(labels)
  }

  /**
   * Refresh ONLY one payment's own row data — the narrow refresh Requirement 3
   * asks for after a successful multi-target allocation. It re-reads that one
   * row from the projection and splices it back into `requests`, and
   * re-derives just its own entry in `allocations` / `targetLabels` (merged
   * into the existing maps rather than replacing them). Filters, pagination,
   * search, scroll position and every other open modal are left exactly as
   * they were — nothing here calls loadRequests() or router.refresh().
   */
  const refreshOneRow = async (id: string): Promise<PaymentRequest | null> => {
    const { data } = await supabase
      .from(RECEIVED_PAYMENTS_SOURCE)
      .select(`
        id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
        received_in,
        proof_note, order_number, order_id,
        order_request_id, order_request_number, sales_note,
        status, payment_against, submitted_by, admin_note, created_at,
        submitted_by_name, approved_by_name,
        allocated_order_id, allocated_order_number, is_order_allocated,
        confirmed_allocation_status,${surface === 'confirmed' ? ' complete_allocation_status,' : ''}
        ${RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS.join(', ')}
      `)
      .eq('id', id)
      .maybeSingle()
    if (!data) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = data as any
    const custody = (await fetchLegacyCustodyFields(supabase, [id])).get(id) ?? NO_LEGACY_CUSTODY
    const mapped: PaymentRequest = {
      ...row,
      ...custody,
      submitted_by_name: row.submitted_by_name ?? undefined,
      approved_by_name:  row.approved_by_name  ?? undefined,
    }
    setRequests(prev => prev.map(r => (r.id === id ? mapped : r)))

    const [{ data: allocRows, error: allocErr }, emptyIsConclusive] = await Promise.all([
      supabase
        .from('finance_payment_allocations')
        .select('id, payment_request_id, allocated_amount, status, order_id, order_submission_id, created_at')
        .eq('payment_request_id', id)
        .eq('status', 'active'),
      canViewAllRef.current,
    ])
    const allocationRows = (allocRows ?? []) as PaymentAllocationRow[]
    const summaryMap = summarizePaymentAllocations(
      [{ id: mapped.id, amount: mapped.amount }],
      allocationRows, {
        readable: !allocErr,
        emptyIsConclusive,
        labels: mapped.allocated_order_id && mapped.allocated_order_number
          ? new Map([[mapped.allocated_order_id, mapped.allocated_order_number]])
          : new Map(),
      },
    )
    const newSummary = summaryMap.get(id)
    if (newSummary) setAllocations(prev => new Map(prev).set(id, newSummary))
    if (surface === 'confirmed') void refreshAllocationTargetsFor(id)

    const orderIds = new Set<string>()
    const submissionIds = new Set<string>()
    for (const a of allocationRows) {
      if (a.order_id) orderIds.add(a.order_id)
      if (a.order_submission_id) submissionIds.add(a.order_submission_id)
    }
    if (mapped.order_id) orderIds.add(mapped.order_id)
    if (orderIds.size > 0 || submissionIds.size > 0) {
      const [ordersRes, submissionsRes] = await Promise.all([
        orderIds.size > 0
          ? supabase.rpc('finance_order_lookup', { p_ids: [...orderIds] })   // pinned to the pre-scope rule (20270221000000)
          : Promise.resolve({ data: [] }),
        submissionIds.size > 0
          ? supabase.from('order_submissions')
              .select(PI_DRAFT_NAME_COLUMNS)
              .in('id', [...submissionIds])
          : Promise.resolve({ data: [] }),
      ])
      setTargetLabels(prev => {
        const next = new Map(prev)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const o of ((ordersRes.data ?? []) as any[])) if (o.display_number) next.set(o.id, o.display_number)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const s of ((submissionsRes.data ?? []) as any[])) next.set(s.id, piDraftSafeName(s))
        return next
      })
    }

    // The counts beside the sidebar nav and the filter chips describe the WHOLE
    // set, not the page in hand — allocating this one payment can move it
    // between allocation-status buckets, so those numbers are invalidated too.
    queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
    return mapped
  }

  // Every mutation on this page — allocate, edit, status correction — can
  // move a row between the two Received Payments pages or in or out of them
  // entirely, so each re-reads the list AND invalidates the sidebar counts. The
  // initial load deliberately does not: the counts query is mounting alongside
  // it and would only be told to fetch twice.
  const refreshAfterMutation = () => {
    loadRequests()
    queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
  }

  /**
   * Whether this reader may delete this payment, asked once for the table, the
   * cards and the modal so all three cannot disagree.
   *
   * `profile` is the signed-in user's own row, so role and id are this reader's
   * — not a claim the browser was handed. A null profile (still loading, or a
   * session that went away) answers false, which is the safe direction: the
   * control simply is not there.
   */
  const canDeleteRow = (r: PaymentRequest) =>
    canDeletePayment(r, { isAdmin: profile?.role === 'admin' })

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // ── THE PROFILE, BOTH PERMISSION SETS AND THE LIST, TOGETHER ──
      //
      // This ran one after the next — session, then profile, then permissions,
      // then the list — so the page waited for four latencies end to end before
      // it drew anything, and none of the last three needs another's answer.
      // Every row the list reads is scoped by RLS, not by the capabilities being
      // resolved beside it.
      //
      // NOTHING ABOUT AUTHORITY CHANGED. `caps` still starts empty and is still
      // widened only once resolve_effective_permissions answers, so no
      // correction control can flash before it is authorized: pageLoading is not
      // cleared until every one of these has landed. A failed resolve still
      // falls back to NO capabilities rather than to the role.
      const profilePromise = supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()
      const financePromise = getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => [])
      const ordersPromise = getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => [])

      // ── IS THE ALLOCATION COLUMN THERE? ──
      //
      // One row, two columns, asked once. The projection gains allocation_state
      // only when 20261004000000 is applied; until then this errors and the
      // control is never drawn, so an un-migrated database behaves exactly as it
      // did before and no query is ever built against a column that does not
      // exist. A filter that silently matched nothing, or a request PostgREST
      // refused outright, would both be worse than an absent control.
      //

      // THE ALLOCATION READ'S SAFETY FLAG, PUBLISHED BEFORE IT IS NEEDED.
      // loadAllocations must know whether an EMPTY allocation list is conclusive
      // for this reader, and that answer depends on both calls above. Handing it
      // the PROMISE rather than the value is what lets the list start now: the
      // allocation read already runs after the list, so by the time it awaits
      // this, the answer is in flight or already there, and it never has to
      // guess.
      canViewAllRef.current = Promise.all([profilePromise, financePromise])
        .then(([{ data: who }, perms]) =>
          deriveFinanceCapabilities((who as UserProfile | null)?.role, perms).canViewAllFinance)
        .catch(() => false)

      const [{ data: me }, financePerms, ordersPerms] =
        await Promise.all([
          profilePromise,
          financePromise,
          ordersPromise,
          loadRequests(),
        ])

      setProfile(me as UserProfile)
      setCaps(deriveFinanceCapabilities(me?.role, financePerms))
      setOrdersCaps(deriveOrdersCapabilities(me?.role, ordersPerms))

      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Re-read when the narrowing or the page changes ───────────────────────────
  //
  // Search and the filters are answered by the DATABASE now, so a change to any
  // of them is a new query rather than a re-filter of rows already in hand. The
  // search box is DEBOUNCED — `filters.search` is derived from the raw term, so
  // without this every keystroke would be a round trip — and the other controls
  // are not, because each is a single deliberate click.
  //
  // Skipped entirely until the first load has finished, so the mount does not
  // issue the same query twice.
  useEffect(() => {
    if (pageLoading) return
    // ONLY THE SEARCH IS DEBOUNCED, which is what the paragraph above always
    // said and what the delay did not do: every dependency here shared the
    // 250ms timer, so paging and each of the five filter chips — all of them a
    // single deliberate click, with no keystroke to coalesce — waited a quarter
    // of a second before their request even started.
    //
    // Compared by VALUE rather than assumed from which dependency fired,
    // because a filter chip also clears the term; the same technique, and the
    // same reason, as countedSearch on the Payment Requests page.
    const searchChanged = debouncedSearch.current !== filters.search
    debouncedSearch.current = filters.search
    const timer = setTimeout(() => { loadRequests() }, searchChanged ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, filters.view, filters.dateFrom, filters.dateTo, filters.confirmedFilter, page])

  // A narrowing change moves the reader back to page one — staying on page four
  // of a result set that now has one page would show an empty table over a
  // filter that matches plenty.
  //
  // Done in the EVENT HANDLER rather than in an effect watching the filters.
  // An effect would set state during a render it also caused, which is the
  // cascading-render pattern react-hooks/set-state-in-effect exists to catch;
  // here the page reset is simply part of what changing a filter means.
  const narrowBy = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(1) }
  const applySearch   = narrowBy(setSearch)
  const applyDateFrom = narrowBy(setDateFrom)
  const applyDateTo   = narrowBy(setDateTo)
  const applyConfirmedFilter = narrowBy(setConfirmedFilter)

  // ── Deep-link resolution (?payment=&action=allocate|edit) ───────────────────
  // Runs exactly once, once `requests` is loaded. Sources: the Admin Action
  // Queue (action=allocate) and Finance notifications. Each modal auto-opens
  // only when the loaded payment still satisfies the same rule the manual
  // button uses — a stale, fully allocated, or not-permitted payment is simply
  // highlighted, never a fatal error.
  useEffect(() => {
    const resolveDeepLink = async () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      const paymentId = searchParams.get('payment')
      const action     = searchParams.get('action')
      if (!paymentId) return

      // ── THE ROW MAY NOT BE ON THIS PAGE ──
      //
      // Before the list was paged it held every approved payment, so a deep
      // link's target was always among the loaded rows. Now it is one page of
      // fifty, and a link into a payment recorded months ago would silently do
      // nothing — no modal, no highlight, and no explanation.
      //
      // So a miss is followed by ONE read for that ONE payment, by its id. It is
      // the same security_invoker projection the list reads, so RLS decides
      // exactly as it does for the list: a payment this reader may not see comes
      // back empty and the page simply shows its first page, which is what a
      // stale or unauthorized link has always done here. Nothing is highlighted
      // in that case, because the row is genuinely not on screen — but the
      // record the link was for does open.
      let match = requests.find(r => r.id === paymentId) ?? null
      const onThisPage = match !== null

      if (!match) {
        const { data } = await supabase
          .from(RECEIVED_PAYMENTS_SOURCE)
          .select(`
            id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
            received_in,
            proof_note, order_number, order_id,
            order_request_id, order_request_number, sales_note,
            status, payment_against, submitted_by, admin_note, created_at,
            submitted_by_name, approved_by_name,
            allocated_order_id, allocated_order_number, is_order_allocated,
            confirmed_allocation_status${surface === 'confirmed' ? ', complete_allocation_status' : ''}
          `)
          .eq('id', paymentId)
          .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = data as any
        const custody = row
          ? (await fetchLegacyCustodyFields(supabase, [row.id])).get(row.id) ?? NO_LEGACY_CUSTODY
          : NO_LEGACY_CUSTODY
        match = row
          ? { ...row,
              ...custody,
              submitted_by_name: row.submitted_by_name ?? undefined,
              approved_by_name:  row.approved_by_name  ?? undefined } as PaymentRequest
          : null
      }

      if (match) {
        if (onThisPage) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`payment-row-${match.id}`)?.scrollIntoView({ block: 'center' })
        }
        // `?action=allocate` IS THE ONLY ATTACHMENT DEEP LINK. `link` is not an
        // alias for it and is not accepted: reinterpreting one action as
        // another would open a modal the URL did not ask for. An old `link` URL
        // is simply not an action this page knows, so it falls through to the
        // ordinary list — highlighted if the row is here, opened read-only if
        // it is not.
        if (action === 'allocate' && caps.canAllocatePayment && canOfferAllocateFunds(match)) {
          setAllocateFundsTarget(match)
        } else if (caps.canManageFinance && action === 'edit') {
          // Editing a received payment is admin-only here, exactly as the
          // table's own Edit button is.
          setEditRequest(match)
        } else if (action === 'edit' || action === 'allocate') {
          // Not permitted (or nothing left to allocate): fall back to the
          // read-only view rather than silently doing nothing.
          setDetailRequest(match)
        } else if (!onThisPage) {
          // A bare ?payment= link used to be answered by highlighting the row.
          // When the row is on another page there is nothing to highlight, so
          // the record itself is opened instead of nothing happening at all.
          setDetailRequest(match)
        }
      }

      // Drop the deep-link params so a refresh or back-navigation can't
      // reopen the modal. ONLY those two: a filter the reader arrived with
      // stays in the address.
      //
      // THIS PAGE'S OWN PATH. It used to replace with /finance/received?view=…
      // whatever the surface, which also took a reader who followed a deep link
      // into Payments to Verify over to Confirmed Payments.
      router.replace(pathWithSearch(pathname, mergeSearchParams(searchParams.toString(), { payment: null, action: null })), { scroll: false })
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // THE ROWS ARE THE ANSWER, not a starting point to filter.
  //
  // This used to hold a client-side search and linkage filter over whatever the
  // unbounded query returned. Both were wrong in their own way — the search
  // could not find a payment by the request number the table leads with, and the
  // linkage filter tested `order_id` alone, so a payment attached to an Order by
  // ALLOCATION matched neither narrowing while displaying that Order in its own
  // row. Both now run in the database, where they also survive paging: filtering
  // a page after the fact would narrow fifty rows and silently hide every match
  // on page two.
  const visible = requests
  // Search and dates — what the toolbar's "Clear filters" undoes. The status
  // tab is navigation, so it is not in here (see isNarrowed)…
  const narrowed = isNarrowed({ search, dateFrom: filters.dateFrom, dateTo: filters.dateTo })
  // …but it IS a constraint on what the list can hold, so the count's wording
  // and the empty state take it into account.
  const statusNarrowed = surface === 'confirmed' && confirmedFilter !== DEFAULT_CONFIRMED_ALLOCATION_FILTER
  const constrained = narrowed || statusNarrowed
  const pages = pageCount(total)

  const clearFilters = () => {
    setSearch('')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  // The one way out of a filtered EMPTY list: every constraint at once —
  // search, dates, the status tab — and page one. The URL mirror then drops
  // their parameters. See SHOW_ALL_PAYMENTS_STATE.
  const showAllPayments = () => {
    setSearch(SHOW_ALL_PAYMENTS_STATE.search)
    setDateFrom(SHOW_ALL_PAYMENTS_STATE.dateFrom)
    setDateTo(SHOW_ALL_PAYMENTS_STATE.dateTo)
    setConfirmedFilter(SHOW_ALL_PAYMENTS_STATE.confirmedFilter as ConfirmedAllocationFilter)
    setPage(SHOW_ALL_PAYMENTS_STATE.page)
  }

  const emptyKind: ConfirmedListEmptyKind = confirmedListEmptyKind({
    loading: listLoading,
    error: listError !== null,
    searchOrDateNarrowed: narrowed,
    statusNarrowed,
  })

  if (pageLoading) return <FinanceRouteFallback />

  return (
    <FinanceLayout
      profile={profile}
      title={meta.title}
      subtitle={meta.subtitle}
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
      // ── Record Payment: THE PAGE'S ONE CREATING ACTION, IN THE HEADER ──
      // Where every Orders and Finance page puts its primary action (Upload PI,
      // + New), instead of at the far end of the filter row, where it read as
      // one more filter.
      //
      // ONE real payment, entered once and divided across every Order and PI
      // Draft it actually paid for. Offered to a holder of finance.allocate,
      // which is what record_payment_with_allocations() requires alongside
      // Finance module entry; the RPC re-derives both, so this is a drawing
      // rule only.
      actions={caps.canAllocatePayment && (
        <button
          onClick={() => { setRecordNotice(null); setRecording(true) }}
          className="boe-btn boe-btn-primary"
        >
          {RECORD_PAYMENT_ACTION_LABEL}
        </button>
      )}
    >
      {/* ── Toolbar: everything that NARROWS the list, and nothing else ──
          One row, in the order a reader reaches for it: search, then when the
          money arrived, then the way out of a narrowed view. The status tabs
          and the result count head the list they describe (below), and the one
          creating action is in the page header — the same arrangement as
          Confirmed Orders, so both "confirmed" lists read the same way. It
          wraps rather than overlapping when there is no room, and at 320px each
          date keeps its own label on its own line. */}
      <div className="boe-list-toolbar" role="search" aria-label="Filter payments">
        <label className="boe-list-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            aria-label="Search payments"
            placeholder={meta.searchPlaceholder}
            value={search}
            onChange={e => applySearch(e.target.value)}
          />
          {search && (
            <button type="button" onClick={() => applySearch('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
          )}
        </label>

        {/* ── When the money arrived ──
            Bounds the list by payment_date, which is the date Finance
            reconciles against — not created_at, which is when somebody typed it
            in. Either bound alone is a valid open-ended range, and a pair typed
            the wrong way round is read as the range between them rather than
            answered with an empty table. */}
        <div className="boe-list-daterange" role="group" aria-label="Payment date">
          <label className="boe-list-date">
            <span>Paid from</span>
            <input
              id="payment-date-from"
              type="date"
              className="boe-input"
              aria-label="Payments on or after"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={e => applyDateFrom(e.target.value)}
            />
          </label>
          <label className="boe-list-date">
            <span>to</span>
            <input
              id="payment-date-to"
              type="date"
              className="boe-input"
              aria-label="Payments on or before"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={e => applyDateTo(e.target.value)}
            />
          </label>
        </div>

        {narrowed && (
          <button type="button" onClick={clearFilters} className="boe-btn boe-btn-ghost boe-list-clear">
            Clear filters
          </button>
        )}

        {/* Payments to Verify has no status tabs, so its count closes this row;
            Confirmed Payments carries it on the tab bar below instead. */}
        {surface !== 'confirmed' && (
          <div aria-live="polite" className="boe-list-count" style={{ marginLeft: 'auto' }}>
            {resultSummary({ loading: listLoading, shown: visible.length, total, narrowed: constrained, page, pages })}
          </div>
        )}
      </div>
      {recordNotice && (
        <div
          role="status"
          style={{
            marginBottom: '10px', padding: '9px 12px', borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised,
            fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
            display: 'flex', alignItems: 'center', gap: '10px',
          }}
        >
          <span style={{ minWidth: 0 }}>{recordNotice}</span>
          <button
            onClick={() => setRecordNotice(null)}
            className="boe-btn boe-btn-ghost"
            style={{ marginLeft: 'auto', padding: '3px 9px', fontSize: '12px', flexShrink: 0 }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="boe-card" style={{ overflow: 'hidden' }}>
        {/* ── The allocation-status tabs, heading the list they narrow ──
            All (default), Zero, Partially, Fully and Over-allocated — read off
            complete_allocation_status as a real database predicate, never a
            client-side filter over the page in hand. The size of the WHOLE
            narrowed set sits at the right of the same bar, from the database's
            exact count rather than the length of the page in hand. */}
        {surface === 'confirmed' && (
          <div className="boe-list-tabbar">
            <div role="tablist" aria-label="Allocation status" className="boe-list-tabs">
              {CONFIRMED_ALLOCATION_FILTERS.map(f => {
                const active = f === confirmedFilter
                return (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="boe-list-tab"
                    onClick={() => applyConfirmedFilter(f)}
                  >
                    {CONFIRMED_ALLOCATION_FILTER_LABEL[f]}
                  </button>
                )
              })}
            </div>
            <div aria-live="polite" className="boe-list-count">
              {resultSummary({ loading: listLoading, shown: visible.length, total, narrowed: constrained, page, pages })}
            </div>
          </div>
        )}
        {/* Table. A RE-READ KEEPS THE ROWS: the list used to be swapped for
            "Loading…" on every refresh and after every edit, which threw the
            reader back to the top of a page they were working down. The count
            above says a read is in flight. */}
        {visible.length === 0 ? (
          /* FOUR DIFFERENT EMPTIES, said differently — see
             confirmedListEmptyKind. A read in flight or a failed read is not
             a business fact and must never be spoken as one; "No payments
             received yet" is a statement about the business and is made only
             when NOTHING — no search, no date, no status tab — constrained the
             list; anything else is a statement about the constraints, and
             offers the one way out of all of them at once. */
          <ConfirmedListEmptyState
            kind={emptyKind}
            noneText={meta.empty}
            errorMessage={listError}
            statusLabel={statusNarrowed ? CONFIRMED_ALLOCATION_FILTER_LABEL[confirmedFilter] : null}
            searchOrDateNarrowed={narrowed}
            onRetry={() => loadRequests()}
            onShowAll={showAllPayments}
          />
        ) : (
          isMobile && surface === 'to_verify' ? (
            <PaymentsToVerifyCards
              rows={visible}
              canManage={caps.canManageFinance}
              highlightId={highlightId}
              onView={r => setDetailRequest(r)}
              onEdit={r => setEditRequest(r)}
            />
          ) : surface === 'to_verify' ? (
            <PaymentsToVerifyTable
              rows={visible}
              canManage={caps.canManageFinance}
              highlightId={highlightId}
              onView={r => setDetailRequest(r)}
              onEdit={r => setEditRequest(r)}
            />
          ) : (
            // Table or cards by the width of the card itself — see
            // ConfirmedPaymentsList. isMobile (viewport) is Payments to Verify's.
            <ConfirmedPaymentsList
              rows={visible}
              canManage={caps.canManageFinance}
              canAllocate={caps.canAllocatePayment}
              highlightId={highlightId}
              onView={r  => setDetailRequest(r)}
              onEdit={r  => setEditRequest(r)}
              onAllocateFunds={r => setAllocateFundsTarget(r)}
              canDeleteRow={canDeleteRow}
              onDelete={r => setDeleteTarget(r)}
              allocatedAgainst={allocatedAgainstFor}
              targetHref={allocationTargetHref}
              onOpenTarget={href => router.push(href)}
            />
          )
        )}

        {/* ── Paging ──
            Rendered only when there is more than one page, so a short list
            looks exactly as it always has. Deep-linkable navigation is
            unchanged: ?payment= still resolves to whichever page holds the row
            through the parent /finance/received route. */}
        {!listLoading && pages > 1 && (
          <nav
            aria-label="Payment pages"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
              padding: '10px 12px', borderTop: `1px solid ${colors.border}`,
            }}
          >
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '5px 12px', fontSize: '12px', opacity: page <= 1 ? 0.5 : 1, cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
            >
              Previous
            </button>
            <span style={{ fontSize: '12px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
              Page {page} of {pages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '5px 12px', fontSize: '12px', opacity: page >= pages ? 0.5 : 1, cursor: page >= pages ? 'not-allowed' : 'pointer' }}
            >
              Next
            </button>
          </nav>
        )}
      </div>

      {/* ── Modals ── */}

      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          mayCorrectPayments={caps.canCorrectOrReversePayment}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); refreshAfterMutation() }}
          // Named from the complete targets read, so a destination the
          // reader's own RLS could not name still reads "PI Draft · Reserved
          // Order 0526" rather than "A PI Draft".
          //
          // THE FIGURES ARE THE COMPLETE READ'S for a reader without
          // finance.view_all (launch audit 2026-09-19): their own RLS returns
          // only the allocations whose target they may open, and the panel
          // used to print that part as "Allocated / Remaining". Admins and
          // view_all readers see every row directly, and keep that path.
          allocation={nameSummaryTargets(
            (!caps.canViewAllFinance && completeAllocationSummary(detailRequest, allocationTargets.rows, {
              covered: allocationTargets.ids.has(detailRequest.id),
              readFailed: allocationTargets.failed,
            }))
              || (allocations.get(detailRequest.id) ?? PENDING_ALLOCATION_SUMMARY(detailRequest.id)),
            allocationTargetNames(allocationTargets.rows))}
          canOpenLinkedRecord={canOpenOrderRecord(ordersCaps.canAccessOrdersModule)}
          onOpenLinked={href => router.push(href)}
          onCorrectAllocation={caps.canCorrectPaymentAllocation
            ? () => { setCorrectAllocationTarget(detailRequest); setDetailRequest(null) }
            : undefined}
        />
      )}

      {/* ── Correct Allocation ──
          Reverses one wrong allocation through reverse_payment_allocation(),
          then offers Allocate Funds — the existing workflow — for the released
          money. Each change refreshes only this payment's own row. */}
      {correctAllocationTarget && (
        <CorrectAllocationModal
          payment={{
            id: correctAllocationTarget.id,
            human_payment_id: correctAllocationTarget.human_payment_id,
            amount: correctAllocationTarget.amount,
          }}
          supabase={supabase}
          canAllocate={caps.canAllocatePayment}
          onClose={() => setCorrectAllocationTarget(null)}
          onChanged={() => { void refreshOneRow(correctAllocationTarget.id) }}
          onAllocateFunds={async () => {
            const id = correctAllocationTarget.id
            const fresh = await refreshOneRow(id)
            setCorrectAllocationTarget(null)
            // The same rule the row action uses. A payment with nothing left to
            // give (or an over-allocated one) opens its record instead.
            if (fresh && canOfferAllocateFunds(fresh)) setAllocateFundsTarget(fresh)
            else if (fresh) setDetailRequest(fresh)
          }}
        />
      )}

      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); refreshAfterMutation() }}
        />
      )}



      {/* ── Record Payment ──
          The whole entry, allocations included, in one transaction. Every gate
          is record_payment_with_allocations()'s. */}
      {recording && (
        <RecordSplitPaymentModal
          supabase={supabase}
          userId={profile?.id ?? null}
          onClose={() => setRecording(false)}
          onRecorded={summary => {
            setRecording(false)
            setRecordNotice(
              summary.allocationCount === 0
                ? `Payment ${summary.requestNumber} ${summary.verified ? 'recorded and verified' : 'recorded'}. None of it is allocated yet — it is available to allocate.`
                : summary.verified
                  ? `Payment ${summary.requestNumber} recorded, verified and divided across ${summary.allocationCount} record${summary.allocationCount === 1 ? '' : 's'}. The other Admins have been told, for information.`
                  : `Payment ${summary.requestNumber} recorded and divided across ${summary.allocationCount} record${summary.allocationCount === 1 ? '' : 's'}. Finance verification is still pending.`)
            refreshAfterMutation()
          }}
        />
      )}

      {/* ── Allocate Funds (Requirement 3) ──
          Divides this payment across up to 20 Orders / PI Drafts in one
          atomic call. Offered only for a 'zero' or 'partial' payment (see
          canOfferAllocateFunds) — the row action already checks that before
          this ever opens. A SUCCESSFUL allocation refreshes ONLY this
          payment's own row (refreshOneRow), never the whole list — filters,
          paging, search and scroll all survive it. */}
      {allocateFundsTarget && (
        <AllocateFundsModal
          payment={{
            id: allocateFundsTarget.id,
            human_payment_id: allocateFundsTarget.human_payment_id,
            client_name: allocateFundsTarget.client_name,
            amount: allocateFundsTarget.amount,
            // The EXISTING total from the complete read when it covers this
            // payment: the projection's allocated_total is security_invoker,
            // so for a reader without view_all it counted only the allocations
            // they may open — and "Remaining" / "Allocate Full Remaining"
            // offered money the server then refused as already spent.
            allocated_total: completeAllocatedTotal(allocateFundsTarget.id, allocationTargets.rows, {
              covered: allocationTargets.ids.has(allocateFundsTarget.id),
              readFailed: allocationTargets.failed,
            }) ?? allocateFundsTarget.allocated_total,
          }}
          supabase={supabase}
          onClose={() => setAllocateFundsTarget(null)}
          onAllocated={() => {
            const id = allocateFundsTarget.id
            setAllocateFundsTarget(null)
            refreshOneRow(id)
          }}
        />
      )}

      {/* DELETE PAYMENT — the shared action, mounted here and on Payments to
          Verify, so both surfaces run one sequence and show one set of words.
          The allocation sentence is built from the SAME links the row drew, so
          the dialog cannot name a destination the reader was not already shown
          — and says nothing at all when this reader's allocation read was
          incomplete, because `links` is empty then. */}
      {deleteTarget && (
        <DeletePaymentModal
          payment={deleteTarget}
          allocationSummary={describePaymentAllocations(
            rowView(deleteTarget, allocations, targetLabels,
              canOpenOrderRecord(ordersCaps.canAccessOrdersModule)).links)}
          formatAmount={fmtAmount}
          formatDate={fmtDate}
          modeLabel={mode => PAYMENT_MODE_LABEL[mode] ?? mode}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); refreshAfterMutation() }}
        />
      )}

    </FinanceLayout>
  )
}
