'use client'

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { pageParam } from '@/lib/listState'
import { useMirrorToUrl } from '@/hooks/useMirrorToUrl'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { pathWithSearch } from '@/lib/tasks/taskReturnPath'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import { destinationRecordHref } from '@/lib/finance/crossModuleLinks'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { createClient } from '@/lib/supabase/client'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { canDeletePayment } from '@/lib/finance/paymentDeletion'
import { deleteOwnPaymentRequest } from '@/lib/finance/ownPaymentRequestDeletion'
import { DeleteOwnPaymentRequestModal } from '@/components/finance/DeleteOwnPaymentRequestModal'
import { isSalespersonPaymentView } from '@/lib/finance/paymentRequestsSalesView'
import { loadPaymentTotals } from '@/lib/finance/paymentCommercialTotals'
import { loadCancelledLinks, needsHistoricalLink, withCancelledLinks } from '@/lib/finance/paymentCancelledLinks'
import { DeletePaymentModal } from '@/components/finance/DeletePaymentModal'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'
import { StatusTabs } from '@/components/ui/StatusTabs'
import { REQUEST_STAGE_STATUSES, isOwnPaymentDecision } from './paymentRouting'
import {
  COUNTED_TABS,
  archiveCutoffIso,
  clampPage,
  pageCount,
  pageRange,
  parseFilterTab,
  paymentRequestsSearchFilter,
  resultSummary,
  tabClauses,
  tabCounts,
  tabMatches,
  type FilterTab,
} from './paymentRequestsQuery'
import { paymentDestinationLabel } from './paymentDestinations'
import { loadPaymentDestinations, type PaymentDestination } from '@/lib/finance/paymentDestination'
import { useQueryClient } from '@tanstack/react-query'
import { RECEIVED_PAYMENTS_COUNTS_KEY } from '@/hooks/queries/useReceivedPaymentsCounts'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

import { FILTER_TABS, EMPTY_MESSAGES, fmtDate, fmtAmount, SEARCH_DEBOUNCE_MS, type PaymentRequest } from './paymentRequestsModel'
// Re-exported: other modules import the type from the page.
export type { PaymentRequest } from './paymentRequestsModel'
// @split: src/app/finance/paymentRequestsModel.tsx private=AdminAction,STATUS_META,ARCHIVE_TAB_ACCENT,FILTER_TABS,EMPTY_MESSAGES,fmtDate,fmtDateTime,fmtAmount,orderNoCell,friendlyDbErrorMessage,SEARCH_DEBOUNCE_MS,isApproved,APPROVED_RACE_MESSAGE,APPROVED_LOCK_NOTE,canManageRequest,isStaleClarification

// @split: src/app/finance/paymentRequestsAtoms.tsx private=Field,ErrorBanner,SectionHeader,MetaItem,PaymentDestinationLine,StatusBadge,StaleBadge,STATUS_CORRECTION_OPTIONS

import { DetailsModal } from './paymentRequestsDetails'
// @split: src/app/finance/paymentRequestsDetails.tsx private=DetailsModal

import { NewPaymentConfirmationModal } from './paymentRequestsNew'
// @split: src/app/finance/paymentRequestsNew.tsx private=EMPTY_FORM,NewPaymentModalProps,NewPaymentConfirmationModal

import { EditPaymentModal } from './paymentRequestsEdit'
// @split: src/app/finance/paymentRequestsEdit.tsx private=EditPaymentModalProps,EditPaymentModal

import { AdminReviewModal } from './paymentRequestsAdminReview'
// @split: src/app/finance/paymentRequestsAdminReview.tsx private=FigureBand,FigureCell,REVIEW_DECISIONS,DecisionRow,AdminReviewModalProps,AdminReviewModal

import { PaymentsTable } from './paymentRequestsTable'
export { PaymentsTable } from './paymentRequestsTable'
// @split: src/app/finance/paymentRequestsTable.tsx private=TH_STYLE

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  return (
    <Suspense fallback={<FinanceRouteFallback />}>
      <FinancePageInner />
    </Suspense>
  )
}

function FinancePageInner() {
  const [pageLoading, setPageLoading]   = useState(true)
  const [userId, setUserId]             = useState<string>('')
  const [isAdmin, setIsAdmin]           = useState(false)
  // Finance authority for the SIGNED-IN user, resolved from the permission
  // engine. Starts at "nothing" and is only ever widened once the resolver has
  // answered, so an administrative control cannot flash before it is
  // authorized. Admins short-circuit inside deriveFinanceCapabilities, so
  // their behaviour is unchanged.
  const [caps, setCaps]                 = useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)
  const [profile, setProfile]           = useState<UserProfile | null>(null)
  const [requests, setRequests]         = useState<PaymentRequest[]>([])
  // WHAT EACH ROW IS FOR, by payment id. `null` means "not read back yet", which
  // the table shows as such rather than as "attached to nothing".
  const [destinations, setDestinations]  = useState<Map<string, PaymentDestination> | null>(null)
  const [listLoading, setListLoading]   = useState(false)
  const [showForm, setShowForm]           = useState(false)
  // Prefill carried in from another module's "Add Payment" action (currently
  // the Order Requests details modal). Cleared with the form, so the plain
  // "+ New" button always opens an empty one.
  const [formPrefill, setFormPrefill]     = useState<{ clientName: string; salesNote: string; contextLabel: string } | null>(null)
  const [reviewRequest, setReviewRequest] = useState<PaymentRequest | null>(null)
  const [detailRequest, setDetailRequest] = useState<PaymentRequest | null>(null)
  const [editRequest,   setEditRequest]   = useState<PaymentRequest | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<PaymentRequest | null>(null)
  // The submitter's own soft delete — a different dialog from the admin's.
  const [deleteOwnRequest, setDeleteOwnRequest] = useState<PaymentRequest | null>(null)
  // Total Before GST per payment on the loaded page; see the effect below.
  const [totalsState, setTotalsState] = useState<{
    forDestinations: Map<string, PaymentDestination>
    totals: Map<string, number | null>
  } | null>(null)
  // What rejected requests were linked to before the rejection cancelled it,
  // tagged with the destinations it was read for (see paymentCancelledLinks.ts).
  const [cancelledState, setCancelledState] = useState<{
    forDestinations: Map<string, PaymentDestination>
    links: Map<string, PaymentDestination>
  } | null>(null)
  // Seeded from the address — ?q= and ?page= — and mirrored back to it below
  // (useMirrorToUrl), so Back from an Order or PI returns to the same tab,
  // search and page. ?tab= already arrived this way.
  const initialSearchParams = useSearchParams()
  const [search, setSearch]             = useState(() => initialSearchParams.get('q') ?? '')
  const [highlightId, setHighlightId]   = useState<string | null>(null)
  // ── Paging ──
  // The list carried no range and no limit, and PostgREST truncates at 1000 rows
  // SILENTLY — no error, no warning, a plausible-looking array. This page looks
  // like a small queue because it is scoped to the three request-stage statuses,
  // but `rejected` accumulates forever: the Archive tab exists precisely because
  // it does, and Archive — the tab whose whole purpose is the OLDEST rejected
  // requests — is the first one that would empty while its badge kept counting.
  const [page,        setPage]        = useState(() => pageParam().parse(initialSearchParams.get('page')))
  const [total,       setTotal]       = useState<number | null>(null)
  // The four counted tabs. 'all' is derived from three of them — see tabCounts.
  const [counts,      setCounts]      = useState<Record<string, number | null>>({})
  const [loadError,   setLoadError]   = useState<string | null>(null)

  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()
  const queryClient  = useQueryClient()

  // ?tab= from the Admin Action Queue selects the initial tab; manual tab
  // clicks below still just call setActiveTab and are otherwise untouched.
  const [activeTab, setActiveTab] = useState<FilterTab>(() => parseFilterTab(searchParams.get('tab')))

  // Orders module entry — decides ONE thing: whether the Against cell offers a
  // door into the Order or PI Draft it names. It grants nothing; the destination
  // re-reads its own record under this reader's RLS. Starts closed.
  const [canOpenOrders, setCanOpenOrders] = useState(false)

  // The working context in the address bar (see the note on `search` above).
  useMirrorToUrl({
    tab:  activeTab === parseFilterTab(null) ? null : activeTab,
    q:    search.trim() || null,
    page: page > 1 ? String(page) : null,
  }, !pageLoading)
  // Back from a record lands where the reader was, not at the top.
  useListScrollRestore()
  const returnPath = pathWithSearch(usePathname(), searchParams.toString())
  // The rule is destinationRecordHref's (crossModuleLinks.ts): Orders module
  // entry, ONE named record, and a reference the reader's own RLS returned.
  const againstHref = (destination: PaymentDestination | null | undefined): string | null => {
    const href = destinationRecordHref(destination, canOpenOrders)
    return href ? withReturnTo(href, returnPath) : null
  }

  // Guards the one-time ?request= deep-link resolution below so it can never
  // re-fire (StrictMode double-invoke, unrelated rerenders) and reopen a
  // modal the admin already closed.
  const deepLinkHandled = useRef(false)

  /**
   * The search the four badges were last counted against.
   *
   * THE BADGES DO NOT DEPEND ON THE ACTIVE TAB. loadCounts walks COUNTED_TABS —
   * a fixed list — and never reads activeTab, so every tab's badge is already
   * correct whichever tab is open. Re-running it on a tab click cost four head
   * requests to arrive at the four numbers already on screen.
   *
   * It DOES depend on the search, because the badges describe the searched set.
   * Selecting a tab also clears the search, so the two genuinely do move
   * together when a search was active — which is why this compares the value
   * rather than assuming a tab click never affects the counts.
   *
   * `undefined` until the first count, which no real filter value can equal, so
   * the first change after mount always counts.
   */
  const countedSearch = useRef<string | null | undefined>(undefined)

  // The narrowing, as the DATABASE will be asked it. One instant decides the
  // archive cutoff for the list AND for all four counts, so a record on the
  // boundary cannot be in one answer and out of the other.
  const filters = useMemo(() => ({
    tab: activeTab,
    search: paymentRequestsSearchFilter(search),
  }), [activeTab, search])

  /**
   * The archive cutoff the LOADED rows were selected against.
   *
   * Read from the clock inside the loader, never during render: a render is
   * required to be pure, and a cutoff that moved every time the component
   * re-drew could put a record on the boundary in one answer and out of the
   * next. Storing what the QUERY used also guarantees the in-memory gate below
   * tests rows against the same instant the database did.
   *
   * 0 until the first load, which archives nothing — the safe direction: a
   * record is shown in the active tab rather than hidden in Archive.
   */
  const [cutoffMs, setCutoffMs] = useState(0)

  // Guards against an out-of-order response. Each load claims a number; only the
  // newest may write to state. Without it a slow query for "REQ" can land after
  // a fast one for "REQ-2026" and repaint the wider result under a narrower box.
  const loadToken = useRef(0)

  /** The status scope and the narrowing, applied to any query over this table. */
  const scopedQuery = <T extends {
    in(column: string, values: string[]): T
    or(filters: string): T
    eq(column: string, value: string): T
    is(column: string, value: null): T
    not(column: string, op: string, value: null): T
  }>(query: T): T => {
    // Request-stage records ONLY. This replaces a .neq('approved_linked'),
    // which let approved_unlinked through and put confirmed money on the
    // Payment Requests page. Filtering positively means a status added later
    // has to be named here to appear, rather than appearing by default.
    let scoped = query.in('status', REQUEST_STAGE_STATUSES as unknown as string[])
    if (filters.search) scoped = scoped.or(filters.search)
    return scoped
  }

  /** The tab's own clauses, applied on top of the shared scope. */
  const applyTab = <T extends {
    or(filters: string): T
    eq(column: string, value: string): T
    is(column: string, value: null): T
    not(column: string, op: string, value: null): T
  }>(query: T, tab: FilterTab, cutoffIso: string): T => {
    let scoped = query
    for (const clause of tabClauses(tab, cutoffIso)) {
      if (clause.kind === 'or') scoped = scoped.or(clause.filters)
      else if (clause.kind === 'eq') scoped = scoped.eq(clause.column, clause.value)
      else if (clause.kind === 'isNull') scoped = scoped.is(clause.column, null)
      else if (clause.kind === 'notNull') scoped = scoped.not(clause.column, 'is', null)
    }
    return scoped
  }

  // ── Fetch — one page, narrowed in the database ───────────────────────────────
  //
  // EVERY TAB AND THE SEARCH MOVED SERVER-SIDE, and not for speed: a tab applied
  // in the browser over ONE PAGE narrows fifty rows and silently hides every
  // match on page two. Paging without moving them would have replaced a
  // truncation defect with a filtering one.
  //
  // The predicates are the SAME ONES tabMatches applies — see
  // paymentRequestsQuery.ts, where a test evaluates both forms against the same
  // rows and requires them to agree on every one. The in-memory gate is kept
  // below as a second, independent check.
  const loadRequests = async (cutoffIso: string) => {
    const token = ++loadToken.current
    setListLoading(true)

    const range = pageRange(page)
    const { data, count, error } = await applyTab(
      scopedQuery(
        supabase
          .from('finance_payment_requests')
          .select(`
            id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
            received_in, collected_by_user_id, collected_from_text,
            handed_over_to_user_id, handed_over_at, collection_handover_note,
            proof_note, order_number, order_id,
            order_request_id, order_request_number, sales_note,
            payment_against, payment_target_type, status, submitted_by, admin_note, created_at,
            updated_at, rejected_at, clarification_requested_at,
            submitted_by_user:users!submitted_by(full_name),
            collected_by_user:users!collected_by_user_id(full_name),
            handed_over_to_user:users!handed_over_to_user_id(full_name)
          `, { count: 'exact' }),
      ),
      activeTab,
      cutoffIso,
    )
      // ORDERED BY created_at AND THEN BY id. range() maps to LIMIT/OFFSET,
      // which promises nothing about row order unless the ordering is unique —
      // two requests created in the same instant could otherwise swap between
      // pages, showing one twice and hiding the other.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(range.from, range.to)

    // A newer load has been issued; this answer is stale and must not repaint
    // the screen underneath it.
    if (token !== loadToken.current) return

    if (error) {
      // The list keeps whatever it had rather than blanking: a failed refresh is
      // not evidence that the records are gone. The banner says which it is.
      setLoadError('Could not load payment requests. Check your connection and try again.')
      setListLoading(false)
      return
    }
    setLoadError(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PaymentRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      submitted_by_name:   r.submitted_by_user?.full_name   ?? undefined,
      collected_by_name:   r.collected_by_user?.full_name   ?? undefined,
      handed_over_to_name: r.handed_over_to_user?.full_name ?? undefined,
      submitted_by_user:   undefined,
      collected_by_user:   undefined,
      handed_over_to_user: undefined,
    }))
    setRequests(mapped)
    setTotal(count ?? null)
    setListLoading(false)

    // ── WHAT EACH OF THESE PAYMENTS IS FOR ──
    //
    // ONE request for the whole page, by id, after the rows are on screen. The
    // list draws immediately and the Against column fills in — a per-row read
    // would be fifty round trips for one table.
    //
    // NOT AWAITED. The first load used to wait for this read before the page
    // was allowed to draw at all, so every visit paid a third round trip for a
    // column that already says "Reading…" while it fills. It still runs at
    // once, and the cells fill when it lands.
    //
    // The map is CLEARED FIRST so a stale page's destinations cannot be shown
    // beside a new page's rows, and the same token guard that protects the rows
    // protects this: a slow answer for page one never repaints page two.
    setDestinations(null)
    void loadPaymentDestinations(supabase, mapped.map(m => m.id)).then(found => {
      if (token !== loadToken.current) return
      setDestinations(found)
    })

    // A PAGE BEYOND THE END, corrected here rather than in an effect watching
    // the total. Switching to a tab with fewer records would otherwise leave the
    // reader on page four of a one-page result, staring at an empty table over a
    // filter that matches plenty. Setting it from this async callback — not from
    // a render or an effect the render caused — is what keeps the component
    // pure; the change re-runs the page effect once and settles.
    if (count !== null && count !== undefined) {
      const corrected = clampPage(page, count)
      if (corrected !== page) setPage(corrected)
    }
  }

  /**
   * The four tab badges, counted by the database.
   *
   * HEAD REQUESTS: `count: 'exact', head: true` transfers no rows at all, so
   * four of them cost four counts and no payload. They run TOGETHER, so the
   * badges cost one wait rather than four.
   *
   * FOUR AND NOT FIVE — 'all' is exactly pending + clarification + rejected and
   * is derived, which saves a round trip and cannot disagree with the tabs it is
   * the sum of. A count that fails leaves its badge unknown rather than zero: a
   * confident 0 on a tab holding records is worse than no number.
   */
  const loadCounts = async (cutoffIso: string) => {
    const token = loadToken.current
    const results = await Promise.all(COUNTED_TABS.map(async tab => {
      const { count, error } = await applyTab(
        scopedQuery(
          supabase
            .from('finance_payment_requests')
            .select('id', { count: 'exact', head: true }),
        ),
        tab,
        cutoffIso,
      )
      return [tab, error ? null : (count ?? null)] as const
    }))

    if (token !== loadToken.current) return
    setCounts(Object.fromEntries(results))
    // What the badges now describe. Recorded by the function that computes
    // them, so the two can never disagree about which narrowing they are for.
    // A discarded round (token moved) deliberately leaves it alone: the counts
    // on screen are still the previous search's, and the next change must
    // recount. Erring toward recounting is the safe direction.
    countedSearch.current = filters.search
  }

  /**
   * One round of reads: the page of rows and the four badges, against ONE
   * cutoff.
   *
   * The cutoff is read from the clock HERE — in an async function, never during
   * render — and handed to both. Two loaders each calling Date.now() could, for
   * a record sitting exactly on the 30-day boundary, put it in the list and out
   * of the count in the same breath.
   */
  const reload = async () => {
    const cutoffIso = archiveCutoffIso(Date.now())
    setCutoffMs(Date.parse(cutoffIso))
    await Promise.all([loadRequests(cutoffIso), loadCounts(cutoffIso)])
  }

  /**
   * After a mutation: the page of rows AND the badges.
   *
   * A review, a correction, a delete or a reapply can move a record between
   * tabs, so refreshing the list alone would leave a badge counting a record
   * that is no longer there. The two run together — the counts are head-only
   * requests and carry no payload.
   */
  const refreshAfterMutation = () => { reload() }

  // ── Auth + profile ───────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id
      setUserId(uid)

      // ── THE PROFILE, THE PERMISSIONS AND THE LIST, TOGETHER ──
      //
      // These ran one after the next, so the page waited for four latencies end
      // to end before it drew anything — and none of the last three needs
      // another's answer. Every row loadRequests reads is scoped by RLS, not by
      // the capabilities being resolved beside it. The same shape the Received
      // Payments pages and the Order detail now use.
      //
      // NOTHING ABOUT AUTHORITY CHANGED. `caps` still starts empty and is still
      // resolved by resolve_effective_permissions before anything can be
      // clicked: pageLoading is not cleared until all three have landed, and a
      // failed resolve still falls back to NO capabilities rather than to the
      // role.
      const [{ data: me }, financePerms, ordersPerms] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', uid)
          .single(),
        getEffectivePermissions(supabase, uid, 'finance').catch(() => []),
        // Orders module entry, for the Against cell's link only. In the same
        // group, so it costs no additional wait; a failed read offers no link.
        getEffectivePermissions(supabase, uid, 'orders').catch(() => []),
        // The rows AND the four badge counts, in the same group. The counts are
        // head-only — `count: 'exact', head: true` transfers no rows — so they
        // cost four counts and no payload, and being in this group they cost no
        // additional wait.
        reload(),
      ])

      setProfile(me as UserProfile)
      setIsAdmin(me?.role === 'admin')
      setCaps(deriveFinanceCapabilities(me?.role, financePerms))
      setCanOpenOrders(deriveOrdersCapabilities(me?.role, ordersPerms).canAccessOrdersModule)

      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Re-read when the narrowing or the page changes ───────────────────────────
  //
  // The tab and the search are answered by the DATABASE now, so a change to
  // either is a new query rather than a re-filter of rows already in hand. The
  // search box is DEBOUNCED — without it every keystroke would be a round trip
  // and four count queries — while a tab click is a single deliberate action and
  // is not delayed.
  //
  // Skipped until the first load has finished, so the mount does not issue the
  // same query twice.
  useEffect(() => {
    if (pageLoading) return
    const delay = filters.search === null ? 0 : SEARCH_DEBOUNCE_MS
    const timer = setTimeout(() => {
      // The badges describe the SEARCHED set, so they move with the narrowing —
      // and with NOTHING else. A tab click that leaves the search where it was
      // re-reads the rows for the newly selected tab and keeps the four counts
      // already on screen, which are still exactly right (see countedSearch).
      // That turns a tab click from five round trips into one.
      if (countedSearch.current === filters.search) {
        loadRequests(new Date(cutoffMs).toISOString())
      } else {
        reload()
      }
    }, delay)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, activeTab])

  // A page change is one more page of the SAME narrowing, so the badges are
  // already right and only the rows are re-read — against the cutoff the badges
  // were counted with, so the page and its tab totals describe one instant.
  //
  // Deferred by a timer rather than fetched in the effect body: the loader sets
  // state on its first line, and doing that synchronously inside an effect is
  // the cascading-render pattern react-hooks/set-state-in-effect exists to
  // catch. The zero delay only moves it past the commit.
  useEffect(() => {
    if (pageLoading) return
    const timer = setTimeout(() => { loadRequests(new Date(cutoffMs).toISOString()) }, 0)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // ── Deep-link resolution (Admin Action Queue → ?tab=&request=) ───────────────
  // Runs exactly once, once `requests` is loaded. A missing, invalid, or
  // no-longer-pending id is a silent no-op — the normal tab still renders,
  // no fatal error, no claim that the action is still available.
  useEffect(() => {
    const resolveDeepLink = async () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      // ?new=1[&client=&note=] — another module asked for a new payment request
      // against a client it already knows. Opens THIS page's own submission
      // form prefilled; nothing is created until the user submits it here.
      if (searchParams.get('new') === '1') {
        const client = searchParams.get('client')?.trim() ?? ''
        const note   = searchParams.get('note')?.trim() ?? ''
        setFormPrefill({ clientName: client, salesNote: note, contextLabel: note })
        setShowForm(true)
        router.replace('/finance')
        return
      }

      const requestId = searchParams.get('request')
      if (!requestId) return

      // ── THE RECORD MAY NOT BE ON THIS PAGE ──
      //
      // Before the list was paged it held every request-stage record, so a deep
      // link's target was always among the loaded rows. Now it is one page of
      // fifty, and a link into an older request — exactly what the Admin Action
      // Queue sends for an ageing item — would silently do nothing: no modal, no
      // highlight, no explanation.
      //
      // So a miss is followed by ONE read for that ONE record, by its id, from
      // the same RLS-protected table the list reads. A record this caller may
      // not see comes back empty and the page simply renders its tab, which is
      // what a stale or unauthorized link has always done here. Nothing is
      // highlighted in that case, because the row is genuinely not on screen —
      // but the record the link was for does open.
      let match = requests.find(r => r.id === requestId) ?? null
      const onThisPage = match !== null

      if (!match) {
        const { data } = await supabase
          .from('finance_payment_requests')
          .select(`
            id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
            received_in, collected_by_user_id, collected_from_text,
            handed_over_to_user_id, handed_over_at, collection_handover_note,
            proof_note, order_number, order_id,
            order_request_id, order_request_number, sales_note,
            payment_against, payment_target_type, status, submitted_by, admin_note, created_at,
            updated_at, rejected_at, clarification_requested_at,
            submitted_by_user:users!submitted_by(full_name),
            collected_by_user:users!collected_by_user_id(full_name),
            handed_over_to_user:users!handed_over_to_user_id(full_name)
          `)
          .eq('id', requestId)
          // Request-stage only, exactly as the list is. A confirmed payment
          // reached through a stale link belongs to Received Payments and must
          // not open here.
          .in('status', REQUEST_STAGE_STATUSES as unknown as string[])
          .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = data as any
        match = row
          ? { ...row,
              submitted_by_name:   row.submitted_by_user?.full_name   ?? undefined,
              collected_by_name:   row.collected_by_user?.full_name   ?? undefined,
              handed_over_to_name: row.handed_over_to_user?.full_name ?? undefined,
              submitted_by_user:   undefined,
              collected_by_user:   undefined,
              handed_over_to_user: undefined } as PaymentRequest
          : null
      }

      if (match) {
        if (onThisPage) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`payment-row-${match.id}`)?.scrollIntoView({ block: 'center' })
        }
        if (caps.canApprovePayment && match.status === 'pending_approval' && !isOwnPaymentDecision(match.submitted_by, userId, caps.canDecideOwnPayment)) {
          setReviewRequest(match)
        } else {
          setDetailRequest(match)
        }
      }
      // Drop the record param so a refresh or back-navigation can't reopen
      // the modal; keep the tab so the deep link still lands correctly.
      router.replace(`/finance?tab=${activeTab}`)
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // ── The page's rows ──────────────────────────────────────────────────────────
  //
  // THE ROWS ARE THE ANSWER, not a starting point to filter. The tab and the
  // search are database predicates now; re-applying them here would narrow the
  // fifty rows in hand and silently hide every match on the next page.
  //
  // tabMatches IS STILL APPLIED, and deliberately: it is the SAME predicate the
  // query was built from, used as a second and independent gate over whatever is
  // in memory. A row approved by somebody else since this page loaded must not
  // linger in a tab the query would no longer return it for. It removes rows; it
  // can never add one, so it cannot disagree with the count beside it in the
  // direction that matters.
  const visible = useMemo(
    () => requests.filter(r => tabMatches(r, activeTab, cutoffMs)),
    [requests, activeTab, cutoffMs])

  // THE SALESPERSON'S LIST — see paymentRequestsSalesView.ts for why only a
  // person who can decide a payment keeps the review columns.
  const salesView = isSalespersonPaymentView(isAdmin, caps)

  // ── Total Before GST ─────────────────────────────────────────────────────────
  // Two batched reads for the whole page (never per row), started when this
  // page's destinations land and only for the list that shows the column. The
  // result is tagged with the destinations it was read for, so a slow answer for
  // page one can never paint beside page two's rows.
  //
  // A rejected request has no live destination (its intent was cancelled), so
  // its original PI/Order is read back from that cancelled intent FIRST and the
  // total follows the same record the Against cell names.
  useEffect(() => {
    if (!destinations) return
    let current = true
    const missing = requests.filter(r => r.status === 'rejected' && needsHistoricalLink(destinations.get(r.id))).map(r => r.id)
    void (missing.length > 0 ? loadCancelledLinks(supabase, missing) : Promise.resolve(new Map<string, PaymentDestination>()))
      .then(links => { if (current) setCancelledState({ forDestinations: destinations, links }) })
    return () => { current = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinations, supabase])
  const shownDestinations = useMemo(() => {
    if (!destinations || !cancelledState || cancelledState.forDestinations !== destinations) return destinations
    return withCancelledLinks(destinations, cancelledState.links)
  }, [destinations, cancelledState])
  const historySettled = !!destinations && cancelledState?.forDestinations === destinations

  useEffect(() => {
    if (!salesView || !shownDestinations || !historySettled) return
    let current = true
    void loadPaymentTotals(supabase, shownDestinations).then(found => {
      if (current) setTotalsState({ forDestinations: shownDestinations, totals: found })
    })
    return () => { current = false }
  }, [salesView, shownDestinations, historySettled, supabase])
  const totals = totalsState && totalsState.forDestinations === shownDestinations ? totalsState.totals : null

  // Which delete dialog a row opens: the admin's hard delete if they are allowed
  // it, otherwise the submitter's own.
  const openDelete = (r: PaymentRequest) => {
    if (canDeletePayment(r, { isAdmin })) setDeleteRequest(r)
    else setDeleteOwnRequest(r)
  }

  // ── The tab badges ───────────────────────────────────────────────────────────
  // Counted by the DATABASE across the whole narrowed set — the old counts were
  // taken over the rows that happened to be loaded, which was every row only
  // while the query was unbounded. 'all' is derived from three of the four; a
  // count that failed leaves its badge unknown rather than a confident zero.
  const tabCount = useMemo(() => tabCounts(counts), [counts])
  const pages = pageCount(total)

  // ── Row click handler ────────────────────────────────────────────────────────
  const handleRowClick = (r: PaymentRequest) => {
    if (caps.canApprovePayment && r.status === 'pending_approval' && !isOwnPaymentDecision(r.submitted_by, userId, caps.canDecideOwnPayment)) {
      setReviewRequest(r)
    } else {
      setDetailRequest(r)
    }
  }

  if (pageLoading) return <FinanceRouteFallback />

  return (
    <FinanceLayout
      profile={profile}
      title="Payment Requests"
      subtitle="Sales can submit customer payment details here for admin approval."
      onSignOut={handleSignOut}
      onRefresh={reload}
      actions={
        <button onClick={() => { setFormPrefill(null); setShowForm(true) }} className="boe-btn boe-btn-primary"
          style={{ padding: '6px 14px', fontSize: '12px' }}>
          + New
        </button>
      }
    >
      {/* ── Search toolbar ── sits above the card so the form control and the
          status navigation below never read as the same kind of control. */}
      <div className="boe-list-toolbar" role="search" aria-label="Filter payment requests">
        <label className="boe-list-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            aria-label="Search payment requests"
            placeholder="Payment ID, client or order…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
          />
          {search && (
            <button type="button" onClick={() => { setSearch(''); setPage(1) }} aria-label="Clear search" className="boe-list-search-clear">✕</button>
          )}
        </label>
      </div>

      <div className="boe-card" style={{ overflow: 'hidden' }}>

        {/* ── Status navigation ── */}
        <StatusTabs
          tabs={FILTER_TABS.map(t => ({ ...t, count: tabCount[t.key] }))}
          active={activeTab}
          onSelect={key => { setActiveTab(key); setSearch(''); setPage(1) }}
          summary={
            // The size of the WHOLE narrowed set, from the database's exact
            // count — not the length of the page in hand, which understates it
            // the moment there is more than one page.
            resultSummary({
              loading: listLoading,
              shown: visible.length,
              total,
              narrowed: search.trim() !== '',
              page,
              pages,
              noun: 'request',
            })
          }
        />

        {/* A FAILED REFRESH IS NOT EVIDENCE THE RECORDS ARE GONE. The rows
            already on screen stay, and this says which it is and offers the way
            back — rather than an empty table that reads as "no requests". */}
        {loadError && (
          <div
            role="alert"
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
              background: 'rgba(180,35,50,0.08)', color: '#B42332', fontSize: '12px',
            }}
          >
            <span style={{ flex: 1, minWidth: '200px' }}>{loadError}</span>
            <button onClick={refreshAfterMutation} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
              Retry
            </button>
          </div>
        )}

        {/* ── Table ──
            A RE-READ KEEPS THE ROWS. The table used to be swapped for
            "Loading…" after every edit, approval and page step, which threw the
            reader back to the top; now it only shows before there is anything. */}
        {listLoading && visible.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          /* TWO DIFFERENT EMPTIES. "No pending payment requests" is a statement
             about the business; "no results for X" is a statement about the
             search, and it offers the way out. Confusing the two sends somebody
             hunting for a record that is merely filtered. */
          <div style={{ padding: '40px 20px', textAlign: 'center', color: colors.muted, fontSize: '13px', lineHeight: 1.6 }}>
            {search.trim() ? (
              <>
                No results for &ldquo;{search.trim()}&rdquo;.
                <div style={{ marginTop: '10px' }}>
                  <button onClick={() => { setSearch(''); setPage(1) }} className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }}>
                    Clear search
                  </button>
                </div>
              </>
            ) : EMPTY_MESSAGES[activeTab]}
          </div>
        ) : (
          <PaymentsTable
            destinations={shownDestinations}
            rows={visible}
            isAdmin={isAdmin}
            userId={userId}
            cutoff={cutoffMs}
            highlightId={highlightId}
            onRowClick={handleRowClick}
            onView={r => setDetailRequest(r)}
            onEdit={r => setEditRequest(r)}
            againstHref={againstHref}
            salesView={salesView}
            totals={totals}
            onDelete={openDelete}
          />
        )}

        {/* ── Paging ──
            Rendered only when there is more than one page, so a short queue
            looks exactly as it always has. ?tab= and ?request= deep links are
            unaffected: the tab is a filter, and a request that is not on the
            loaded page is fetched by its own id. */}
        {!listLoading && pages > 1 && (
          <nav
            aria-label="Payment request pages"
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
      {showForm && (
        <NewPaymentConfirmationModal
          userId={userId}
          supabase={supabase}
          initialClientName={formPrefill?.clientName}
          initialSalesNote={formPrefill?.salesNote}
          contextLabel={formPrefill?.contextLabel}
          onClose={() => { setShowForm(false); setFormPrefill(null) }}
          onSaved={() => { setShowForm(false); setFormPrefill(null); refreshAfterMutation() }}
        />
      )}
      {reviewRequest && (
        <AdminReviewModal
          request={reviewRequest}
          supabase={supabase}
          onClose={() => setReviewRequest(null)}
          // Approval is the ONE action on this page that creates a received
          // payment — a new_order approval lands in suspense with no linkage, so
          // the sidebar's Non-Linked count changes the moment it commits.
          // Clarify and Reject keep the record at request stage and move no
          // count, but they share this callback and re-checking is free.
          onActioned={() => {
            setReviewRequest(null)
            refreshAfterMutation()
            queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
          }}
        />
      )}
      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          isAdmin={isAdmin}
          mayCorrectPayments={caps.canCorrectOrReversePayment}
          mayApprovePayments={caps.canApprovePayment}
          mayDecideOwnPayments={caps.canDecideOwnPayment}
          userId={userId}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); refreshAfterMutation() }}
          // Details hands off to the same two modals the table uses; only one
          // Finance modal is open at a time, so it closes as they open.
          onEdit={r => { setDetailRequest(null); setEditRequest(r) }}
          onDelete={r => { setDetailRequest(null); openDelete(r) }}
        />
      )}
      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          isAdmin={isAdmin}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); refreshAfterMutation() }}
        />
      )}
      {/* DELETE PAYMENT REQUEST — the shared modal (Requirement 4), admin-only
          for any status. This page tracks no allocation-links data of its own
          (that read lives on Received Payments), so allocationSummary is
          withheld rather than guessed. */}
      {deleteOwnRequest && (
        <DeleteOwnPaymentRequestModal
          payment={deleteOwnRequest}
          formatAmount={fmtAmount}
          onDelete={id => deleteOwnPaymentRequest(supabase, id)}
          onClose={() => setDeleteOwnRequest(null)}
          onDeleted={id => {
            // Gone from this screen at once; the re-read below confirms it and
            // brings every tab count into line.
            setRequests(prev => prev.filter(x => x.id !== id))
            setDeleteOwnRequest(null)
            refreshAfterMutation()
            queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
          }}
        />
      )}
      {deleteRequest && (
        <DeletePaymentModal
          payment={deleteRequest}
          allocationSummary={null}
          formatAmount={fmtAmount}
          formatDate={fmtDate}
          modeLabel={mode => paymentDestinationLabel(mode, deleteRequest.received_in)}
          onClose={() => setDeleteRequest(null)}
          onDeleted={() => { setDeleteRequest(null); refreshAfterMutation() }}
        />
      )}

    </FinanceLayout>
  )
}
