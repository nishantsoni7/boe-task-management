'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { BookOpen, ChevronDown, ChevronRight, Layers, MessageSquareHeart, ShieldCheck, Sparkles } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type StatusTab } from '@/components/ui/StatusTabs'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { InternalTestWarning, ReviewBadge } from '@/components/customerReviews/ReviewPieces'
import { GenerateDrafts } from '@/components/customerReviews/GenerateDrafts'
import { PendingBatches } from '@/components/customerReviews/PendingBatches'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import { ReviewFullView, ReviewFullViewActions } from '@/components/customerReviews/ReviewFullView'
import {
  DeleteAllReviewsBar,
  DeleteAllReviewsSheet,
  DeleteReviewButton,
  DeleteReviewsSheet,
} from '@/components/customerReviews/DeleteReviews'
import {
  ReadinessBadge,
  ReviewTypeBadge,
  ReviewTypeSections,
} from '@/components/customerReviews/AssignedReviews'
import { AssignBatchPanel, assignmentNotice } from '@/components/customerReviews/AssignBatch'
import { ImageLibrary } from '@/components/customerReviews/ImageLibrary'
import { EmployeeProgress } from '@/components/customerReviews/EmployeeProgress'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumParam, textParam } from '@/lib/listState'
import { fetchAllRows } from '@/lib/supabasePaging'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { canBookCard, canDeleteCard, type ApprovalMode } from '@/lib/customerReviews/status'
import { nextStepFor, type NextStepViewer } from '@/lib/customerReviews/nextStep'
import {
  DRAFT_BATCH_COLUMNS,
  TEST_CARD_AVAILABLE_COLUMNS,
  TEST_CARD_COLUMNS,
  TEST_CARD_PENDING_COLUMNS,
  TEST_CARD_STATUS_META,
  testCategoryLabel,
  type ApprovalResult,
  type DeletionCounts,
  type DeletionSummary,
  type DraftBatch,
  type ReviewType,
  type TestCard,
  type TestCardStatus,
} from '@/lib/customerReviews/types'
import { AWAITING_IMAGES_LABEL } from '@/lib/customerReviews/reviewTypes'

// The review list.
//
// FIVE TABS, and each answers a different person's question about work that is
// still live:
//
//   Pending approval  what is waiting for ME to release it? Verifier only, and
//                     the only tab that reads unapproved drafts — which no
//                     candidate can read at all, by RLS rather than by query.
//   Available         what can I pick up? Approved, unbooked reviews ASSIGNED
//                     TO ME. There is no company-wide pool any more: the SELECT
//                     policy offers an available review to the person it was
//                     assigned to and to a verifier, and to nobody else, so this
//                     tab is scoped by the database rather than by a filter.
//   My reviews        what am I holding, and what have I handed over?
//   Booked            who is working on what right now? Verifier only.
//   To verify         what is waiting for me to check it? Verifier only.
//
// THE TWO CANDIDATE TABS ARE SPLIT INTO TEXT AND IMAGE SECTIONS, with the four
// operational counts above them — see SECTIONED_TABS. The two verifier queues
// are not: there the type is a badge, because the question is "what is waiting"
// rather than "how far through am I".
//
// A VERIFIED CARD IS IN NO TAB AT ALL. It is the last status in the workflow
// and the product owner's rule is that a finished card leaves the frontend
// entirely — not into a History tab, not into a filter somebody could clear.
//
// THAT IS ENFORCED BY THE ABSENCE OF A QUERY, NOT BY HIDING ROWS. 'verified'
// appears in no tab's status list, so no query this screen can issue asks for
// one; there is no tab key that could reach it, and nothing to un-hide.
//
// BOOKING IS NOT ON A CARD. A tile shows a truncated preview, so booking from a
// tile meant taking a review on the strength of its first line and a half.
// `View` opens the complete review — title, body, the exact outgoing WhatsApp
// message — and `Book` exists only inside it. That is a UI path rather than a
// guarantee, and it is not asked to be one: the database claims the row with a
// conditional UPDATE and would refuse a stale, double or unauthorised booking
// whatever this screen sent. Nothing here reports "the candidate read it",
// because a browser flag saying so would not be evidence.
//
// IT IS STILL NOT A DASHBOARD. There are counts now — a candidate's assigned,
// posted, remaining and available, and a verifier's per-employee table — because
// people doing twelve reviews a batch need to know where they are. There are no
// charts, no percentages, no trends and no ranking, and nothing compares one
// employee with another. They are operational counts, and that is the whole of
// what they are.
//
// THE VERIFIER'S SUMMARY COUNTS VERIFIED REVIEWS WITHOUT LISTING THEM, which is
// the one place that distinction is load-bearing. TAB_STATUSES still names no
// tab that asks for a verified row, so there is still no list on this screen
// that can reach one; EmployeeProgress reads statuses and types with no review
// text at all, so there is nothing in its query that could be rendered as a
// card even by mistake.

const TABS = ['pending', 'available', 'mine', 'booked', 'to_verify'] as const
type TabKey = typeof TABS[number]

/** The tabs only a `verify` holder may open. */
const VERIFIER_TABS: ReadonlySet<TabKey> = new Set<TabKey>(['pending', 'booked', 'to_verify'])

// Module scope: useListUrlState needs a stable codec-map identity across
// renders. Filters live in the URL so Back from a card returns to the list
// exactly as it was — the same contract the task and meeting lists have.
const LIST_PARAMS = {
  tab: enumParam(TABS, 'available'),
  q:   textParam(),
}

/**
 * THE TABS SPLIT INTO TEXT AND IMAGE SECTIONS, and the two that do are the two
 * about ONE PERSON'S OWN WORK.
 *
 * Available and My reviews are a candidate asking "what am I doing and how far
 * through am I", which is a question with two different answers depending on
 * the kind of review. Booked and To verify are a verifier asking "what is
 * waiting", where the type is a badge rather than a heading.
 */
const SECTIONED_TABS: ReadonlySet<TabKey> = new Set<TabKey>(['available', 'mine'])

/**
 * What an empty TEXT or IMAGE section says.
 *
 * Separate sentences because the reasons a section is empty differ: a candidate
 * with no image reviews left has finished them, whereas a candidate whose image
 * reviews are all waiting for photographs has not started them and cannot.
 */
function emptySectionText(type: ReviewType): string {
  return type === 'image'
    ? `No image reviews here. An image review appears once it is assigned to you; until an administrator attaches its project photographs it reads “${AWAITING_IMAGES_LABEL}” and cannot be booked.`
    : 'No text reviews here.'
}

// NO ENTRY CONTAINS 'verified', AND THAT IS THE WHOLE MECHANISM. Every read
// this screen makes is `.in('status', TAB_STATUSES[tab])`, so a verified card
// is outside every query it is capable of issuing.
const TAB_STATUSES: Record<TabKey, readonly TestCardStatus[]> = {
  pending:   ['pending_approval'],
  available: ['available'],
  mine:      ['booked', 'submitted'],
  booked:    ['booked'],
  to_verify: ['submitted'],
}

/**
 * The one line the list says about a verification that just happened. The
 * detail screen sends the verifier back here with `verified=<credits>`, the
 * amount the transition RPC returned from the SAME transaction that verified
 * the review (20261102000000). Like ?saved=1 on an order draft, the flag
 * decides what this line SAYS and nothing about what the list shows: every
 * row still comes from the queries below, and a verified card is outside all
 * of them. Credits, never rupees; no amount is computed here.
 */
export function verifiedNoticeFrom(flag: string | null): string | null {
  if (flag === null) return null
  const credits = /^\d+$/.test(flag) ? Number(flag) : 0
  return credits > 0
    ? `Review verified · ${formatCredits(credits, { signed: true })} awarded to the tester.`
    : 'Review verified.'
}

/**
 * The second sentence (Phase 1D): which month the credit counts for and how
 * that month stands against its target — `reviews`, `target` and `month`
 * (open | qualified) as the RPC reported them. Nothing is computed here
 * beyond the difference the database's own two numbers make; a flag that is
 * missing or malformed says nothing.
 */
export function verifiedMonthNoteFrom(params: { get(name: string): string | null }): string | null {
  const reviews = params.get('reviews')
  const target  = params.get('target')
  const month   = params.get('month')
  if (reviews === null || target === null || !/^\d+$/.test(reviews) || !/^\d+$/.test(target)) return null
  const done = Number(reviews)
  const need = Number(target)
  if (month === 'qualified') {
    return `That makes ${done} of ${need} this month — the month’s credits are available to spend.`
  }
  const left = Math.max(need - done, 0)
  return `That makes ${done} of ${need} this month — ${left} more and the month’s credits become spendable.`
}

export function TestCardListScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()
  const searchParams = useSearchParams()
  const verifiedNotice = verifiedNoticeFrom(searchParams.get('verified'))
  const verifiedMonthNote = verifiedNotice ? verifiedMonthNoteFrom(searchParams) : null

  const [cards, setCards] = useState<TestCard[]>([])
  const [batches, setBatches] = useState<Map<string, DraftBatch>>(new Map())
  const [actorNames, setActorNames] = useState<Map<string, string>>(new Map())
  const [pendingTotal, setPendingTotal] = useState<number | null>(null)
  /** How many reviews a Replace would displace. Verifier-only, like the tab. */
  const [availableTotal, setAvailableTotal] = useState<number | null>(null)
  /**
   * WHICH TAB THE ROWS IN STATE BELONG TO, or null before the first load.
   *
   * "Loading" is derived from this rather than tracked separately, and that is
   * what keeps the fetching effect free of a synchronous setState: a flag would
   * have to be raised before the await, inside the effect, which is the
   * cascading-render pattern react-hooks/set-state-in-effect exists to catch.
   * Here the answer falls out of what is already known.
   *
   * It is also what keeps a REFRESH from blanking the screen. Reloading the tab
   * that is already loaded leaves loadedTab === tab throughout, so the rows on
   * screen stay on screen until the new ones replace them.
   */
  const [loadedTab, setLoadedTab] = useState<TabKey | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)
  const [reading, setReading] = useState<TestCard | null>(null)
  const [approving, setApproving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [approved, setApproved] = useState<string | null>(null)
  /** What the delete confirmation is about, or null when it is closed. */
  const [deleting, setDeleting] = useState<
    null | { cards: TestCard[]; source: 'single' | 'selected' }
  >(null)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  /** The two verifier panels above the tabs. Closed until somebody asks for them. */
  const [assignOpen, setAssignOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [deleteSummary, setDeleteSummary] = useState<DeletionSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const booking = useRef(false)
  const acting = useRef(false)
  /**
   * WHICH FETCH THE ROWS ON SCREEN CAME FROM.
   *
   * Every load takes a ticket and checks it before writing state, so a slow
   * response from a tab somebody has already left cannot overwrite the rows of
   * the tab they are now looking at. Without it, switching tabs twice quickly
   * can leave the first tab's rows under the third tab's heading.
   */
  const loadTicket = useRef(0)

  const { state, setState, resetState } = useListUrlState(LIST_PARAMS)
  const tab = state.tab as TabKey
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(
    state.q, next => setState({ q: next }),
  )

  // A tab a non-verifier cannot use is not a tab they can land on, even by
  // typing the URL. The list they would get is empty anyway — RLS sees to that
  // — but bouncing them is honest rather than showing an empty screen with a
  // promising name.
  useEffect(() => {
    if (authLoading) return
    if (VERIFIER_TABS.has(tab) && !caps.canVerify) {
      setState({ tab: 'available' })
    }
  }, [authLoading, tab, caps.canVerify, setState])

  const load = useCallback(async () => {
    if (!profile) return
    const ticket = ++loadTicket.current

    // NOTHING IS SET BEFORE THE AWAIT. Every setState below runs after the
    // fetch resolves, so the effect that calls this does no synchronous state
    // update of its own.

    // EACH TAB READS ONLY THE COLUMNS IT DISPLAYS. An unbooked or pending card
    // has no holder, no evidence and no timestamps, so selecting those columns
    // would be selecting nulls — and it would be one edit away from selecting
    // them for rows that are neither.
    const columns =
      tab === 'available' ? TEST_CARD_AVAILABLE_COLUMNS
      : tab === 'pending' ? TEST_CARD_PENDING_COLUMNS
      : TEST_CARD_COLUMNS

    // fetchAllRows, not a bare select: PostgREST silently caps a read at 1000
    // rows, and a capped list is a list that quietly stops showing things.
    const result = await fetchAllRows<TestCard>(
      (from, to) => {
        let query = supabase
          .from('customer_review_test_cards')
          .select(columns)
          .in('status', TAB_STATUSES[tab])
          // EVERY OPERATIONAL LIST IS LIVE ROWS ONLY, and this filter is in the
          // query for the verifier's sake rather than the candidate's. RLS
          // already makes a tombstone unreadable to a candidate; it
          // deliberately does NOT hide one from a verifier, because they are
          // the people the audit record exists for. So the SCREEN is what keeps
          // deleted reviews out of the working lists, and it says so here once
          // rather than filtering in five places downstream.
          .is('deleted_at', null)

        // MY REVIEWS IS SCOPED IN THE QUERY AS WELL AS BY RLS. The policy
        // already narrows a `use` holder to their own cards, but a VERIFIER sees
        // everybody's — so without this filter their "My reviews" tab would show
        // the whole company's work under a possessive heading.
        if (tab === 'mine') query = query.eq('booked_by', profile.id)

        return query.order('card_ref', { ascending: true }).range(from, to)
      },
    )

    // A response that arrived after the reader moved on is discarded rather
    // than rendered under the wrong heading.
    if (ticket !== loadTicket.current) return

    if (!result.ok) {
      setLoadError('Those reviews could not be loaded. Refresh to try again.')
      setCards([])
      setLoadedTab(tab)
      return
    }

    setLoadError(null)
    setCards(result.rows)

    // ── The batches behind the pending drafts ──────────────────────────────
    //
    // TWO MORE REQUESTS, NOT ONE PER CARD. The batch ids are collected from the
    // rows already in hand and asked for with a single `in`, and the people who
    // generated them with a second — so twelve drafts from one batch cost the
    // same two requests as twelve drafts from twelve batches would.
    if (tab === 'pending' && result.rows.length > 0) {
      const batchIds = Array.from(new Set(
        result.rows.map(r => r.batch_id).filter((id): id is string => !!id),
      ))
      if (batchIds.length > 0) {
        const { data: batchRows } = await supabase
          .from('customer_review_draft_batches')
          .select(DRAFT_BATCH_COLUMNS)
          .in('id', batchIds)
        if (ticket !== loadTicket.current) return

        const rows = (batchRows ?? []) as unknown as DraftBatch[]
        setBatches(new Map(rows.map(b => [b.id, b])))

        const actorIds = Array.from(new Set(rows.map(b => b.generated_by)))
        if (actorIds.length > 0) {
          // Named columns, never `*` — a `select('*')` against public.users is
          // a permission error in this project (src/lib/users/safeColumns.ts).
          const { data: people } = await supabase
            .from('users')
            .select('id, full_name')
            .in('id', actorIds)
          if (ticket !== loadTicket.current) return
          const named = (people ?? []) as unknown as { id: string; full_name: string | null }[]
          setActorNames(new Map(named.map(p => [p.id, p.full_name ?? 'a verifier'])))
        }
      } else {
        setBatches(new Map())
      }
    }

    setLoadedTab(tab)
  }, [supabase, profile, tab])

  /**
   * HOW MANY DRAFTS ARE WAITING FOR A VERIFIER, whatever tab is open.
   *
   * The one count worth a separate request: it is the "waiting for me" number,
   * and a verifier needs to see it from the Available tab as much as from the
   * Pending one. `head: true` fetches no rows. Nobody else asks for it — a
   * candidate's query would return zero through RLS anyway, and a request whose
   * answer is always zero is a request not worth making.
   */
  const loadPendingCount = useCallback(async () => {
    if (!caps.canVerify) { setPendingTotal(null); setAvailableTotal(null); return }
    const [pending, available] = await Promise.all([
      supabase
        .from('customer_review_test_cards')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_approval')
        .is('deleted_at', null),
      // HOW MANY REVIEWS A REPLACE WOULD DISPLACE.
      //
      // Counted here rather than inside the approval sheet because the sheet
      // opens from the Pending tab, whose rows are pending drafts — it has no
      // way to see the available pool it is being asked about. `head: true`
      // fetches no rows.
      //
      // UNASSIGNED ONLY, matching what customer_review_replace_available()
      // actually does. Replace clears the reviews that belong to NOBODY; a
      // review somebody has been given is that employee's outstanding work and
      // is never displaced by an approval. Counting assigned rows here would
      // put a number in front of a verifier that is larger than the
      // consequence, which is the wrong direction for a confirmation to be
      // wrong in either.
      //
      // IT IS A DISPLAY NUMBER, NOT A DECISION. Between this and the write
      // somebody can book a review; the database chooses and locks the set
      // inside the transaction and returns what it actually replaced.
      supabase
        .from('customer_review_test_cards')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'available')
        .is('assigned_to', null)
        .is('deleted_at', null),
    ])
    setPendingTotal(pending.count ?? 0)
    setAvailableTotal(available.count ?? 0)
  }, [supabase, caps.canVerify])

  // True until the rows in state are the ones this tab asked for.
  const listLoading = loadedTab !== tab

  // A FETCH IS STARTED HERE; NO STATE IS SET HERE.
  //
  // Every setState inside `load` runs after its first await, so this effect
  // performs no synchronous state update and there is no cascading render to
  // prevent. react-hooks/set-state-in-effect is static and cannot see through
  // the await, so the call is made through a named local that says what the
  // effect is for — the same shape the rest of this codebase uses for a
  // fetch-on-mount.
  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  useEffect(() => {
    const startFetch = () => { void loadPendingCount() }
    startFetch()
  }, [loadPendingCount])

  const book = useCallback(async (cardId: string) => {
    // State is too slow to stop a double click, and two clicks racing is
    // exactly the case booking is built to survive. The ref stops the second
    // request; the database's conditional UPDATE stops the second BOOKING, and
    // it is the one that actually decides.
    if (booking.current) return
    booking.current = true
    setBookingId(cardId)
    setBookError(null)
    try {
      const { error } = await supabase.rpc('book_customer_review_test_card', {
        p_card_id: cardId,
      })
      if (error) {
        // THE READER STAYS WHERE THEY ARE. A booking that failed because
        // somebody else got there first is a thing to read and act on, not a
        // reason to close the review and go back to the list. The database's
        // own sentence, stripped of its machine prefix; none of them names who
        // took the card.
        setBookError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That review could not be booked.')
        await load()
        return
      }
      setReading(null)
      router.push(`/customer-reviews/${cardId}`)
    } catch {
      setBookError('That review could not be booked. Check your connection and try again.')
    } finally {
      booking.current = false
      setBookingId(null)
    }
  }, [supabase, load, router])

  const runApproval = useCallback(async (
    rpc: 'approve_customer_review_drafts' | 'approve_customer_review_draft_batch',
    args: Record<string, unknown>,
  ) => {
    if (acting.current) return
    acting.current = true
    setApproving(true)
    setActionError(null)
    setApproved(null)
    try {
      const { data, error } = await supabase.rpc(rpc, args)
      if (error) {
        setActionError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That could not be approved.')
        // A refusal is usually staleness — somebody approved it first — so the
        // list is reloaded to show what is actually there.
        await load()
        await loadPendingCount()
        return
      }
      // THE COUNTS ARE THE DATABASE'S, NOT THE BROWSER'S. Both functions choose
      // and lock their sets inside the transaction, so what comes back is what
      // actually happened — which is the only honest thing to report after a
      // Replace, where the pool can move between the confirmation and the write.
      const result = (data ?? {}) as Partial<ApprovalResult>
      const n = result.approved ?? 0
      const replaced = result.replaced ?? 0
      setApproved(
        replaced > 0
          ? `${n} review${n === 1 ? '' : 's'} approved, replacing ${replaced} that ${replaced === 1 ? 'was' : 'were'} available.`
          : `${n} review${n === 1 ? '' : 's'} approved and available to candidates.`,
      )
      await load()
      await loadPendingCount()
    } catch {
      setActionError('That could not be approved. Check your connection and try again.')
    } finally {
      acting.current = false
      setApproving(false)
    }
  }, [supabase, load, loadPendingCount])

  // `p_replace` HAS NO DEFAULT ON EITHER FUNCTION, so every call states the
  // choice. Two PostgREST overloads differing only by a defaulted argument is
  // PGRST203 — it cannot pick one — which is why the old single-argument
  // signatures were dropped rather than kept alongside.
  const approve = useCallback(
    (ids: string[], mode: ApprovalMode) => runApproval('approve_customer_review_drafts', {
      p_card_ids: ids, p_replace: mode === 'replace',
    }),
    [runApproval],
  )
  const approveBatch = useCallback(
    (batchId: string, mode: ApprovalMode) => runApproval('approve_customer_review_draft_batch', {
      p_batch_id: batchId, p_replace: mode === 'replace',
    }),
    [runApproval],
  )

  // ── Deletion ──────────────────────────────────────────────────────────────
  //
  // THE SCREEN OWNS THE RPC AND THE COMPONENTS OWN THE WORDS, which is the
  // arrangement the approval flow already uses: PendingBatches and the tiles
  // raise an intent, the confirmation sheets render it, and exactly one place
  // here talks to the database.

  const openDelete = useCallback((targets: TestCard[], source: 'single' | 'selected') => {
    if (targets.length === 0) return
    setDeleteError(null)
    setDeleting({ cards: targets, source })
  }, [])

  const runDelete = useCallback(async () => {
    if (!deleting || acting.current) return
    acting.current = true
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const { data, error } = await supabase.rpc('delete_customer_review_test_cards', {
        p_card_ids: deleting.cards.map(c => c.id),
        p_source: deleting.source,
      })
      if (error) {
        // THE SHEET STAYS OPEN ON A REFUSAL. Almost every refusal here is
        // staleness — somebody deleted one of them first — and closing the
        // sheet would hide the sentence explaining why nothing happened.
        setDeleteError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'Those reviews could not be deleted.')
        await load()
        await loadPendingCount()
        return
      }
      const counts = (data ?? {}) as Partial<DeletionCounts>
      const n = counts.deleted ?? 0
      setDeleting(null)
      setApproved(`${n} review${n === 1 ? '' : 's'} deleted.`)
      await load()
      await loadPendingCount()
    } catch {
      setDeleteError('Those reviews could not be deleted. Check your connection and try again.')
    } finally {
      acting.current = false
      setDeleteBusy(false)
    }
  }, [supabase, deleting, load, loadPendingCount])

  /**
   * Opening Delete all RE-READS THE POPULATION rather than counting the tab.
   *
   * No tab on this screen reads `verified` rows — that is deliberate, and it
   * means a total assembled in the browser would leave part of "everything"
   * out. The summary function counts every live review by stage, so the
   * confirmation states the real consequence.
   */
  const openDeleteAll = useCallback(async () => {
    setDeleteError(null)
    setDeleteSummary(null)
    setDeleteAllOpen(true)
    setSummaryLoading(true)
    try {
      const { data, error } = await supabase.rpc('customer_review_deletion_summary')
      if (error) {
        setDeleteError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That count could not be read.')
        return
      }
      setDeleteSummary((data ?? null) as DeletionSummary | null)
    } catch {
      setDeleteError('That count could not be read. Check your connection and try again.')
    } finally {
      setSummaryLoading(false)
    }
  }, [supabase])

  const runDeleteAll = useCallback(async () => {
    if (acting.current) return
    acting.current = true
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const { data, error } = await supabase.rpc('delete_all_customer_review_test_cards')
      if (error) {
        setDeleteError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'The reviews could not be deleted.')
        await load()
        await loadPendingCount()
        return
      }
      const counts = (data ?? {}) as Partial<DeletionCounts>
      const n = counts.deleted ?? 0
      setDeleteAllOpen(false)
      setDeleteSummary(null)
      setApproved(`${n} review${n === 1 ? '' : 's'} deleted. The module is empty.`)
      await load()
      await loadPendingCount()
    } catch {
      setDeleteError('The reviews could not be deleted. Check your connection and try again.')
    } finally {
      acting.current = false
      setDeleteBusy(false)
    }
  }, [supabase, load, loadPendingCount])

  const filtered = useMemo(() => {
    const needle = state.q.trim().toLowerCase()
    if (!needle) return cards
    return cards.filter(card =>
      card.card_ref.toLowerCase().includes(needle)
      || card.test_title.toLowerCase().includes(needle)
      || testCategoryLabel(card.test_category).toLowerCase().includes(needle),
    )
  }, [cards, state.q])

  const tabs: StatusTab<TabKey>[] = useMemo(() => {
    // COUNTS ARE null FOR THE TABS THAT ARE NOT OPEN, and that is the honest
    // answer rather than a missing one. Only the active tab's rows have been
    // fetched, so a number on the others would be a guess — and StatusTab
    // renders null as a dash, which reads as "not known" rather than "none".
    //
    // PENDING IS THE ONE EXCEPTION, because it is counted by its own head
    // request: it is the "waiting for me" number, and a verifier needs it from
    // whichever tab they are standing on.
    const base: StatusTab<TabKey>[] = []
    if (caps.canVerify) {
      base.push({
        key: 'pending', label: 'Pending approval', Icon: Sparkles,
        count: tab === 'pending' ? filtered.length : pendingTotal,
        accent: accentFromBadge(TEST_CARD_STATUS_META.pending_approval),
      })
    }
    base.push(
      { key: 'available', label: 'Available',   Icon: Layers,             count: tab === 'available' ? filtered.length : null, accent: BRAND_TAB_ACCENT },
      { key: 'mine',      label: 'My reviews',  Icon: MessageSquareHeart, count: tab === 'mine'      ? filtered.length : null, accent: accentFromBadge(TEST_CARD_STATUS_META.booked) },
    )
    if (caps.canVerify) {
      base.push(
        { key: 'booked',    label: 'Booked',    Icon: BookOpen,   count: tab === 'booked'    ? filtered.length : null, accent: accentFromBadge(TEST_CARD_STATUS_META.booked) },
        { key: 'to_verify', label: 'To verify', Icon: ShieldCheck, count: tab === 'to_verify' ? filtered.length : null, accent: accentFromBadge(TEST_CARD_STATUS_META.submitted) },
      )
    }
    return base
  }, [tab, filtered.length, caps.canVerify, pendingTotal])

  /**
   * ONE TILE, DRAWN THE SAME WAY WHEREVER IT APPEARS.
   *
   * Extracted so the sectioned view and the flat view render the identical
   * control set: two copies of this call is how a tab quietly loses its Delete
   * button, or keeps one it should not have.
   */
  const renderTile = (card: TestCard) => (
    <TestCardTile
      key={card.id}
      card={card}
      showView={tab === 'available'}
      /*
        DELETION IS A VERIFIER'S CONTROL AND CANDIDATES NEVER SEE ONE.
        `caps.canVerify` is the resolved permission, never a role, and
        it is the weakest of the three checks — the RPC resolves it
        again and the database function resolves it a third time.
      */
      canDelete={canDeleteCard({ userId: profile?.id ?? null, canVerify: caps.canVerify })}
      viewer={{ userId: profile?.id ?? null, canUse: caps.canUse, canVerify: caps.canVerify }}
      onDelete={() => openDelete([card], 'single')}
      onView={() => { setBookError(null); setReading(card) }}
      onOpen={() => router.push(`/customer-reviews/${card.id}`)}
    />
  )

  if (authLoading) return <LoadingScreen />

  // EVERY EMPTY STATE NAMES THE NEXT VALID ACTION FOR THIS PERSON. "Nothing
  // here" tells somebody the screen loaded; it does not tell them what to do,
  // and what to do depends on what they are allowed to do.
  const emptyMessage =
    tab === 'pending'
      ? 'Nothing is waiting for approval. Generate a batch of drafts to review.'
    : tab === 'available'
      ? (caps.canVerify
          ? 'No approved review is waiting to be picked up. Approve a batch of twelve and assign it to an employee.'
          // THE HONEST SENTENCE NOW NAMES ASSIGNMENT. A candidate with an empty
          // list used to be waiting for somebody to approve a draft; they are
          // now waiting for somebody to give a batch to THEM, and telling them
          // the old thing would send them to ask the wrong question.
          : 'Nothing is assigned to you right now. Reviews reach you a batch at a time — an administrator assigns one, and it appears here.')
    : tab === 'mine'
      ? (caps.canUse
          ? 'You are not holding any reviews. Open one from Available — the reviews assigned to you — and book it there.'
          : 'You do not have permission to book reviews, so nothing appears here.')
    : tab === 'booked'
      ? 'Nobody is holding a review right now.'
      : 'Nothing is waiting for verification.'

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Review Workflow"
      subtitle="Draft reviews for customers — you choose who each one goes to"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/*
          GENERATION IS VERIFIER-ONLY, and `caps.canVerify` is the RESOLVED
          permission — never a role. This is the weakest of the three checks
          (a screen can be lied to); the route resolves it again before spending
          a credential, and the database function resolves it a third time and
          is what actually decides.
        */}
        {caps.canVerify && (
          <GenerateDrafts onGenerated={() => {
            setState({ tab: 'pending' })
            void load()
            void loadPendingCount()
          }} />
        )}

        {/*
          TWO MANAGEMENT PANELS, COLLAPSED, AND NOT TWO NEW TABS.

          Both are verifier-only and both are consulted occasionally rather than
          worked in, so they sit above the tab strip folded away instead of
          competing with the five tabs a person uses every day. Adding tabs for
          them would also have put a "which tab am I on" decision in front of a
          candidate who can open neither.

          Each mounts only when opened. That is not a micro-optimisation: the
          library signs a URL per image and the summary reads every assigned
          review, and doing both on every visit to a list of twelve reviews
          would be work nobody asked for.
        */}
        {caps.canVerify && (
          <>
            <Foldaway
              title="Assign a batch"
              hint="Give one approved batch of twelve to one employee. Only they will see it."
              open={assignOpen}
              onToggle={() => setAssignOpen(v => !v)}
            >
              <AssignBatchPanel
                supabase={supabase}
                onAssigned={outcome => {
                  setApproved(assignmentNotice(outcome))
                  void load()
                  void loadPendingCount()
                }}
              />
            </Foldaway>

            <Foldaway
              title="Project image library"
              hint="Create a project group and add its photographs. An image review is given a whole group."
              open={libraryOpen}
              onToggle={() => setLibraryOpen(v => !v)}
            >
              <ImageLibrary supabase={supabase} />
            </Foldaway>

            <Foldaway
              title="Employee progress"
              hint="Assigned, posted, verified and remaining, per employee."
              open={progressOpen}
              onToggle={() => setProgressOpen(v => !v)}
            >
              <EmployeeProgress supabase={supabase} />
            </Foldaway>
          </>
        )}

        {/*
          WHAT THIS SAYS IS WHAT BOE CAN VOUCH FOR, and no more.
          It does not promise who receives a message — the candidate chooses the
          recipient — and it does not describe a draft as anybody's words. What
          is true and enforced: the text is a draft a person approved, nothing is
          posted anywhere, and BOE never sends.
        */}
        <p style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.6, margin: 0 }}>
          Every review here is a draft written by AI and approved by a verifier, for a
          customer to use, adapt or discard. Nothing is published anywhere, and BOE never
          sends a message for you — you choose the number and press send yourself in
          WhatsApp.
        </p>

        {/*
          size="touch" — 44px tabs, not the shared 35px default.
          This strip IS the navigation on a phone, and this module is used
          mainly from one. The prop was added rather than the default changed so
          Finance and Orders render exactly what they rendered before; see
          StatusTabSize. The strip still scrolls horizontally inside its own
          box, which is what keeps the PAGE from scrolling with five tabs at
          360px — measured, not assumed.
        */}
        <StatusTabs
          tabs={tabs}
          active={tab}
          size="touch"
          onSelect={key => { flushSearch(); setState({ tab: key }) }}
        />

        <input
          type="search"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search by reference, title or category"
          aria-label="Search reviews"
          className="boe-input"
          style={{ maxWidth: '340px', minHeight: '44px' }}
        />

        {bookError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{bookError}</p>
        )}
        {actionError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{actionError}</p>
        )}
        {approved && (
          <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>
            {approved}
          </p>
        )}
        {verifiedNotice && (
          <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>
            {verifiedNotice}
            {verifiedMonthNote && <span style={{ fontWeight: 400, color: '#3D4455' }}> {verifiedMonthNote}</span>}
          </p>
        )}
        {loadError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{loadError}</p>
        )}

        {listLoading ? (
          <CardSkeletons />
        ) : filtered.length === 0 ? (
          <div style={{
            padding: '28px 20px', borderRadius: '10px', textAlign: 'center',
            border: `1px dashed ${colors.border}`, color: colors.muted, fontSize: '13px',
            lineHeight: 1.6,
          }}>
            {state.q.trim()
              ? (
                <>
                  Nothing matches that search.{' '}
                  <button
                    type="button"
                    onClick={() => { setSearchInput(''); resetState() }}
                    style={{
                      background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                      color: colors.blue, fontSize: '13px', textDecoration: 'underline',
                    }}
                  >
                    Clear filters
                  </button>
                </>
              )
              : emptyMessage}
          </div>
        ) : tab === 'pending' ? (
          <PendingBatches
            supabase={supabase}
            cards={filtered}
            batches={batches}
            actorNames={actorNames}
            availableCount={availableTotal}
            busy={approving}
            onApprove={approve}
            onApproveBatch={approveBatch}
            onDelete={openDelete}
            onRevised={() => { void load(); void loadPendingCount() }}
            onCardChanged={() => { void load(); void loadPendingCount() }}
          />
        ) : SECTIONED_TABS.has(tab) ? (
          /*
            THE CANDIDATE'S TWO TABS ARE SPLIT BY REVIEW TYPE, with the counts
            above them. A text review and an image review are different work —
            one is words, the other is words plus photographs somebody has to
            have prepared — and mixing them in one list means a candidate learns
            the difference by opening a review and finding a disabled button.

            THE VERIFIER'S TABS ARE NOT SPLIT. Booked and To verify are queues
            of other people's work in progress; the question there is "what is
            waiting", not "how far through am I", and two headings over a
            handful of rows would be scaffolding around nothing.
          */
          <ReviewTypeSections
            cards={filtered}
            emptyText={emptySectionText}
            renderCards={rows => <TileGrid>{rows.map(renderTile)}</TileGrid>}
          />
        ) : (
          <TileGrid>{filtered.map(renderTile)}</TileGrid>
        )}

        {/*
          DELETE ALL SITS BELOW THE LIST, BEHIND ITS OWN RULE, and nowhere near
          Generate or the approval controls at the top. It is the last thing on
          the page rather than a neighbour of anything used routinely.
        */}
        {caps.canVerify && !listLoading && (
          <DeleteAllReviewsBar onOpen={() => { void openDeleteAll() }} disabled={deleteBusy} />
        )}
      </div>

      {/*
        THE COMPLETE REVIEW, AND THE ONLY PLACE `Book` EXISTS.
        A sheet on a phone, a centred dialog on a desktop, with the action
        pinned to the bottom so it is reachable without scrolling past the body.
      */}
      {reading && (
        <ReviewSheet
          title={reading.test_title}
          subtitle={`${reading.card_ref} · ${testCategoryLabel(reading.test_category)}`}
          maxWidth="560px"
          onClose={() => { setReading(null); setBookError(null) }}
          footer={
            <ReviewFullViewActions
              canBook={canBookCard(reading, { userId: profile?.id ?? null, canUse: caps.canUse })}
              booking={bookingId === reading.id}
              onBook={() => book(reading.id)}
              onClose={() => { setReading(null); setBookError(null) }}
            />
          }
        >
          <ReviewFullView
            card={reading}
            canBook={canBookCard(reading, { userId: profile?.id ?? null, canUse: caps.canUse })}
            bookError={bookError}
          />
        </ReviewSheet>
      )}

      {deleting && (
        <DeleteReviewsSheet
          cards={deleting.cards}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => { void runDelete() }}
          onCancel={() => { setDeleting(null); setDeleteError(null) }}
        />
      )}

      {deleteAllOpen && (
        <DeleteAllReviewsSheet
          summary={deleteSummary}
          loadingSummary={summaryLoading}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => { void runDeleteAll() }}
          onCancel={() => {
            setDeleteAllOpen(false)
            setDeleteSummary(null)
            setDeleteError(null)
          }}
        />
      )}
    </CustomerReviewsLayout>
  )
}

/**
 * One card.
 *
 * The provenance note is the first thing in it and is rendered by a component
 * that accepts no text, so no tile can show a softened version of it. Below
 * that: the category, the reference, the title and a short preview.
 *
 * THE PREVIEW IS SHORT ON PURPOSE. A tile that showed the whole body would make
 * `View` pointless, and `View` is the step the workflow requires. It is
 * truncated HERE rather than in SQL — truncating in the query would make the
 * full text unreachable to the view that legitimately needs it, and would put a
 * display decision somewhere no reader of this screen would think to look.
 */
/**
 * A titled section that starts folded and mounts its child only when opened.
 *
 * THE MOUNTING IS THE POINT, not the animation — there is no animation. A
 * closed panel renders no child at all, so the library signs no URLs and the
 * summary issues no query until somebody actually asks for one.
 */
function Foldaway({
  title, hint, open, onToggle, children,
}: {
  title: string
  hint: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ border: `1px solid ${colors.borderSoft}`, borderRadius: '10px', background: colors.base }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '11px 14px', minHeight: '44px', textAlign: 'left',
          background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        {open ? <ChevronDown size={15} style={{ flexShrink: 0, color: colors.secondary }} />
              : <ChevronRight size={15} style={{ flexShrink: 0, color: colors.secondary }} />}
        <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{title}</span>
        <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>{hint}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${colors.borderSoft}`, padding: '12px 14px' }}>
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * The tile grid, in one place because two views draw it.
 *
 * AT MOST TWO PER ROW, and one where there is not room for two. The previous
 * layout was `minmax(280px, 1fr)` with auto-fill, which put four narrow columns
 * on a wide screen and made every review body a column of two-word lines.
 * `min(100%, 340px)` is what keeps the single-column case from overflowing a
 * 360px phone: the track can never be wider than the container.
 */
function TileGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
        maxWidth: '860px',
        gap: '12px',
        // Cards in a row share a top edge without being forced to share a
        // height, so a short review does not grow to match a long one.
        alignItems: 'start',
      }}
    >
      {children}
    </div>
  )
}

function TestCardTile({
  card,
  showView,
  canDelete,
  viewer,
  onDelete,
  onView,
  onOpen,
}: {
  card: TestCard
  /** Available reviews open the full view; everything else opens its own page. */
  showView: boolean
  /** Verifier only. A candidate is never passed true. */
  canDelete: boolean
  /** Who is looking — decides the next-step sentence, and nothing else. */
  viewer: NextStepViewer
  onDelete: () => void
  onView: () => void
  onOpen: () => void
}) {
  const preview = card.test_body.length > 130
    ? `${card.test_body.slice(0, 130).trimEnd()}…`
    : card.test_body

  // THE NEXT STEP, SAID ON THE TILE. A booked or submitted review carries the
  // one sentence that follows from its state for this viewer; an available
  // one does not need it — View is the step. The sentence decides nothing:
  // the detail page and the database still decide what can happen.
  const step = card.status === 'booked' || card.status === 'submitted' ? nextStepFor(card, viewer) : null
  const returned = card.status === 'booked' && !!card.returned_at && !!card.sent_confirmed_at

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: '9px',
        padding: '12px', borderRadius: '10px',
        border: `1px solid ${colors.border}`, background: colors.raised,
        // min-width: 0 lets a long unbroken title shrink instead of forcing the
        // grid column wider than the viewport, which is what produces a
        // horizontally scrolling page on a phone.
        minWidth: 0,
      }}
    >
      <InternalTestWarning compact />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: colors.tertiary }}>
          {card.card_ref}
        </span>
        <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          {/*
            THE TYPE AND THE READINESS, BEFORE THE STATUS. Both are facts about
            what this review IS and what it needs; the status is where it has
            got to. Readiness renders for image reviews only — a "Ready" badge
            on a text review would answer a question nobody asked.
          */}
          <ReviewTypeBadge type={card.review_type} />
          <ReadinessBadge card={card} />
          {returned && (
            <span style={{
              display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
              background: '#FFF7ED', color: '#9A3412', border: '1px solid #FED7AA',
              fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
            }}>
              Returned
            </span>
          )}
          <ReviewBadge meta={TEST_CARD_STATUS_META[card.status]} />
        </span>
      </div>

      <div>
        <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '2px' }}>
          {testCategoryLabel(card.test_category)}
        </div>
        <div style={{
          fontSize: '13px', fontWeight: 600, color: colors.primary,
          lineHeight: 1.4, overflowWrap: 'anywhere',
        }}>
          {card.test_title}
        </div>
      </div>

      <p style={{
        margin: 0, fontSize: '12px', color: colors.secondary,
        lineHeight: 1.55, overflowWrap: 'anywhere',
      }}>
        {preview}
      </p>

      {step && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'baseline',
          fontSize: '12px', lineHeight: 1.45,
          color: step.tone === 'attention' ? '#9A3412' : step.tone === 'act' ? '#1E40AF' : colors.tertiary,
        }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{step.tone === 'wait' ? 'Status:' : 'Next:'}</span>
          <span style={{ fontWeight: 600 }}>{step.headline}</span>
        </div>
      )}

      <div style={{
        display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '4px',
        alignItems: 'center', flexWrap: 'wrap',
      }}>
        <button
          type="button"
          onClick={showView ? onView : onOpen}
          className={`boe-btn ${showView ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
          style={{ fontSize: '12px', padding: '11px 16px', minHeight: '44px' }}
        >
          {showView ? 'View' : 'Open'}
        </button>
        {/*
          PUSHED TO THE FAR EDGE, away from the action a person came to the
          tile for. On a phone the two controls end up at opposite ends of the
          row, which is the most separation a 360px card can offer.
        */}
        {canDelete && (
          <span style={{ marginLeft: 'auto' }}>
            <DeleteReviewButton compact onClick={onDelete} />
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The first load of a tab, and only that.
 *
 * A refresh in place never reaches here — loadedTab still equals tab while the
 * rows are replaced, so what is on screen stays on screen. This is for the case
 * where there is genuinely nothing yet to keep.
 */
function CardSkeletons() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading reviews"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
        maxWidth: '860px', gap: '12px',
      }}
    >
      {[0, 1, 2, 3].map(i => (
        <div key={i} style={{
          height: '168px', borderRadius: '10px',
          border: `1px solid ${colors.border}`, background: colors.raised,
          opacity: 0.6,
        }} />
      ))}
    </div>
  )
}
