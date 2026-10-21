'use client'

// PI Drafts — the saved PI submissions a person is allowed to see.
//
// THE DEFECT THIS SCREEN EXISTS TO FIX
// ------------------------------------
// Saving a PI already worked: the row, its product lines, its pictures and its
// diagnostics were all written by the server and are all still there. What did
// not exist was anywhere to look at them. A real PI was uploaded in production,
// saved correctly, and then became unreachable — not lost, just unlisted, with
// the only pointer to it living in the memory of the tab that saved it.
//
// So this page invents nothing and repairs nothing. It reads rows that were
// already being written.
//
// AUTHORIZATION IS THE DATABASE'S, NOT THIS PAGE'S. There is no owner filter
// below, and there must not be one. order_submissions_select already answers
// "may this person see this submission" — the owner, the named reviewer, an
// orders.approve_order holder, or an active admin — and the module entry gate
// ANDs on top of it. A `.eq('created_by', me)` here would be a second, weaker
// copy of that rule that would quietly hide a reviewer's queue. What the page
// filters on is STATUS, which is a product decision about what belongs in this
// list, not an access decision.
//
// THE REVIEW QUEUE IS A SECTION OF THIS PAGE, NOT A SEPARATE SCREEN.
//
// A holder of orders.approve_order sees the submissions waiting on them at the
// top, and the ordinary working list below it. That is deliberate: a second
// route would mean a second query, a second empty state and a second place for a
// record to hide, and the reviewer would still have to come here for anything
// not currently submitted. The queue is drawn from the SAME rows this page
// already reads — RLS put them there — and splitDraftsForReview only decides
// where each row is printed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ClipboardCheck, Eye, Trash2, Upload } from 'lucide-react'
import { PiFormatButton } from '@/components/orders/PiFormatLink'
import { createClient } from '@/lib/supabase/client'
import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { PiDeleteConfirmModal } from '@/components/orders/piReviewModals'
import {
  FinanceEmpty,
  FinanceStatusCards,
  type FinanceTabTone,
} from '@/app/finance/components/FinanceListParts'
import { enumParam, textParam } from '@/lib/listState'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { isAdminRole } from '@/lib/permissions/moduleVisibility'
import { formatInr } from '@/lib/pi/previewView'
import {
  PI_DRAFTS_EMPTY_NOTE,
  PI_DRAFTS_EMPTY_TEXT,
  PI_DRAFTS_SUBTITLE,
  PI_DRAFT_LIST_COLUMNS,
  PI_DRAFT_LIST_STATUSES,
  PI_DRAFT_STATUS_LABEL,
  PI_REVIEW_EMPTY_TEXT,
  describeDraftListEntry,
  type PersistedSubmission,
  type PiDraftListEntry,
  type PiDraftStatusTone,
} from '@/lib/orders/draftsView'
import {
  REVIEW_ACTION_LABEL,
  REVIEW_QUEUE_TITLE,
  UPLOAD_PI_BUTTON_LABEL,
  splitDraftsForReview,
} from '@/lib/orders/submissionWorkflow'
import {
  DELETE_PI_ARIA_LABEL,
  DELETE_PI_SUCCESS,
  canDeleteSubmission,
  describeDeletionFailure,
  type DeletionActor,
  type SubmissionDeletionFailure,
} from '@/lib/orders/submissionDeletion'

// THE TABLE NEEDS A DESKTOP. Measured 2026-09-18: with the reviewer columns it
// was 87px wider than its card at 1440, 247px at 1280 and 503px at 1024 — a
// sideways scroll inside the card on every screen. The submission columns are
// one stacked cell now and names may wrap, so the table fits a ~976px card
// (1280 viewport); below 1100 — where the 260px sidebar leaves ~800px — the
// cards are drawn instead, which fit any width.
const MOBILE_BREAKPOINT = 1100

/** Newest first, and capped: a drafts list is a working set, not an archive. */
const LIST_LIMIT = 200

/** A draft's tone, drawn in the Finance lists' colours (2026-10). */
const TONE: Record<PiDraftStatusTone, FinanceTabTone> = {
  neutral: 'neutral',
  blue:    'partial',
  amber:   'zero',
  red:     'over',
  green:   'full',
}

function StatusPill({ label, tone }: { label: string; tone: PiDraftStatusTone }) {
  return <span className={`fin-pill fin-pill--${TONE[tone]}`}>{label}</span>
}

type DraftStatusFilter = 'all' | 'draft' | 'submitted' | 'needs_changes' | 'rejected'

/**
 * THE STATUS CARDS ARE THE FILTER (owner, 2026-10), as on the Finance lists.
 * One card per status this list can hold (PI_DRAFT_LIST_STATUSES) plus All.
 */
const STATUS_CARDS: { key: DraftStatusFilter; label: string; tone: FinanceTabTone }[] = [
  { key: 'all',           label: 'All drafts',                             tone: 'neutral' },
  { key: 'draft',         label: PI_DRAFT_STATUS_LABEL.draft,         tone: 'neutral' },
  { key: 'submitted',     label: PI_DRAFT_STATUS_LABEL.submitted,     tone: 'partial' },
  { key: 'needs_changes', label: PI_DRAFT_STATUS_LABEL.needs_changes, tone: 'zero' },
  { key: 'rejected',      label: PI_DRAFT_STATUS_LABEL.rejected,      tone: 'over' },
]

/**
 * The status card and the search live in the URL (src/lib/listState.ts), so
 * Back from a draft returns to the same view. Both narrow the rows ALREADY
 * READ: neither is a query, and neither decides who may see what — RLS did.
 */
const DRAFTS_LIST_PARAMS = {
  status: enumParam<DraftStatusFilter>(['all', 'draft', 'submitted', 'needs_changes', 'rejected'], 'all'),
  q:      textParam(),
}

/** Does this row answer the search? Client, PI reference and the salesperson. */
function matchesSearch(entry: PiDraftListEntry, q: string): boolean {
  if (!q) return true
  return [entry.client, entry.reference, entry.numberLine, entry.authoredBy]
    .some(value => (value ?? '').toLowerCase().includes(q))
}

export default function PiDraftsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [canCreate, setCanCreate] = useState(false)
  const [canReview, setCanReview] = useState(false)
  const [entries, setEntries] = useState<PiDraftListEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  /**
   * Who is looking, for the Delete rule.
   *
   * Both facts come from the profile read below — the signed-in id and the
   * project's established administrator check — and canDeleteSubmission is the
   * only place they are combined with a row's status and owner. The control this
   * draws is a courtesy: delete_order_submission() decides again, under a lock.
   */
  const [actor, setActor] = useState<DeletionActor>({ userId: null, isAdmin: false })

  /** The row whose confirmation dialog is open, or null. */
  const [pendingDelete, setPendingDelete] = useState<PiDraftListEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  /**
   * The route's last answer about this deletion, described.
   *
   * THE WHOLE OBJECT, not the sentence out of it. The dialog needs three of its
   * facts, not one: what to say, whether pressing again is worth doing, and
   * whether the refusal is a protected relationship that a second press cannot
   * move. Keeping only the message here is what left the red button live under a
   * refusal that was never going to change.
   */
  const [deleteFailure, setDeleteFailure] = useState<SubmissionDeletionFailure | null>(null)
  const [deleted, setDeleted] = useState<string | null>(null)

  /**
   * The in-flight guard, in a ref as well as in state.
   *
   * State is what disables the button; the ref is what stops a second call that
   * was already on its way when the first one started. A double click on a
   * destructive action must send exactly one request.
   */
  const deletingRef = useRef(false)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // The status card and the search, both in the URL (see DRAFTS_LIST_PARAMS).
  // The box shows what is being typed and commits after the shared pause.
  const { state: listState, setState: setListState, resetState: resetListState } =
    useListUrlState(DRAFTS_LIST_PARAMS)
  const statusFilter = listState.status
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(listState.q, next => setListState({ q: next }))
  const search = listState.q.trim().toLowerCase()
  const narrowed = statusFilter !== 'all' || search !== ''
  const clearView = () => {
    setSearchInput('')
    resetListState()
  }

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /**
   * The submissions read, named so the first load can START it beside the
   * profile and the permissions rather than after them. It reads no
   * capability: which rows come back is RLS's answer, not a role's.
   *
   * THE PRODUCT-LINE COUNT IS NO LONGER READ. The list used to page every item
   * row of every draft through a paged read purely to print "9" in a column —
   * a second, unbounded read on every page load for a number nobody makes a
   * decision on. The column went; the query went with it.
   */
  const draftsQuery = useCallback(() =>
    supabase
      .from('order_submissions')
      .select(PI_DRAFT_LIST_COLUMNS)
      .in('status', PI_DRAFT_LIST_STATUSES)
      .order('updated_at', { ascending: false })
      .limit(LIST_LIMIT), [supabase])

  /**
   * Load the list.
   *
   * TWO READS, BOTH UNDER THE CALLER'S OWN ACCESS. The submissions, then the
   * advance percentage of every one of them in a single call.
   *
   * `preloaded` is that first read, already in flight before this runs — the
   * first load hands its answer in rather than issuing a second one. Every
   * later refresh passes nothing and reads afresh.
   */
  const load = useCallback(async (
    preloaded?: Awaited<ReturnType<ReturnType<typeof draftsQuery>['then']>> | null,
  ) => {
    setFailed(false)

    const { data, error } = preloaded ?? await draftsQuery()

    if (error || !data) { setEntries(null); setFailed(true); return }

    const rows = data as unknown as PersistedSubmission[]

    // ── Advance % received, for every row in ONE call ──
    //
    // pi_submissions_advance_percent() (20270327000000) applies the same rule
    // as the PI detail page's payment card and answers only for PIs this
    // caller may view. A failed read, or a PI with no usable Total before GST,
    // leaves the row without a figure and it prints an honest dash — a missing
    // percentage is not 0%, and it is not a reason to hide the list.
    const advance = new Map<string, number | string | null>()
    if (rows.length > 0) {
      const { data: percents } = await supabase.rpc('pi_submissions_advance_percent', {
        p_submission_ids: rows.map(r => r.id),
      })
      for (const p of (percents ?? []) as { submission_id: string; attached_percent: number | string | null }[]) {
        if (p?.submission_id) advance.set(p.submission_id, p.attached_percent)
      }
    }

    setEntries(rows.map(row => describeDraftListEntry(row, formatInr, advance.get(row.id) ?? null)))
  }, [draftsQuery, supabase])

  useEffect(() => {
    let active = true

    const run = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      // ── The profile and the permissions, together ──
      //
      // Neither needs the other's answer; both need only the session's user id.
      // Awaiting them in turn made the page wait for the sum of two latencies
      // before it could even start reading the drafts.
      //
      // THE DRAFT LIST TRAVELS WITH THEM. It reads no capability — the rows it
      // gets back are RLS's answer — so waiting for the permissions to resolve
      // bought nothing and cost a whole round trip. The advance percentages
      // depend only on the rows, so that one call follows in load().
      const [{ data: me }, permissions, drafts] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        // Module entry is enforced by the Orders layout above this page, and row
        // visibility by RLS below it. What is resolved here is only whether to
        // offer the "New Order" button — an entry point, not an authority.
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        draftsQuery(),
      ])
      const caps = deriveOrdersCapabilities((me as UserProfile | null)?.role, permissions)

      if (!active) return
      setProfile((me as UserProfile) ?? null)
      setActor({
        userId: session.user.id,
        // The project's established Admin check, read through the module that
        // owns it rather than compared to a literal here — and deliberately not
        // a permission: see submissionDeletion.ts and the migration header.
        isAdmin: isAdminRole((me as UserProfile | null)?.role),
      })
      setCanCreate(caps.canCreateOrder)
      setCanReview(caps.canApproveOrderSubmission)
      await load(drafts)
    }

    run()
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  /**
   * HOVER IS THE EARLIEST HONEST SIGNAL that this draft is about to be opened,
   * so the code for the PI detail route is already in hand when the click
   * lands. The two Order lists have done this since their own performance
   * pass; this list was the one that did not.
   *
   * It fetches the ROUTE, not the draft: no record, no permission and no file
   * is read until that page mounts and asks under the reader's own session, so
   * this can neither leak a row nor show a stale one. Next de-duplicates
   * repeated prefetches, so moving down a list costs one fetch and then cache
   * hits.
   */
  const prefetchDraft = (entry: PiDraftListEntry) => router.prefetch(entry.href)

  /**
   * Erase one PI, files and all.
   *
   * ONE ROUND TRIP TO ONE ROUTE, which removes the storage objects with the
   * service role and only then runs delete_order_submission(). The browser never
   * touches the bucket: two of the three deletable cases — an administrator
   * deleting somebody else's PI, and anybody deleting a rejected one — fall
   * outside the order-files DELETE policy, so a client-side removal would fail
   * for exactly the cases this exists to serve.
   *
   * NO FULL PAGE RELOAD. On success the row is dropped from the list in place;
   * on a failure that means the screen is stale, the list is re-read so the row
   * shows the status the database actually has.
   */
  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete
    if (!entry || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteFailure(null)

    try {
      const response = await fetch('/api/orders/submissions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: entry.id }),
      })
      const body = await response.json().catch(() => null) as {
        ok?: boolean
        code?: unknown
        detail?: { blockers?: unknown } | null
      } | null

      if (!response.ok || body?.ok !== true) {
        const failure = describeDeletionFailure(body?.code, body?.detail?.blockers)
        setDeleteFailure(failure)
        // The row stays visible either way. When the failure means the screen is
        // out of date — the PI entered review, or somebody else already deleted
        // it — the list is re-read so what is on screen is what is true.
        if (failure.refresh) await load()
        return
      }

      // Removed in place. Re-querying would be a second round trip to learn
      // something this call already knows.
      setEntries(current => (current ?? []).filter(row => row.id !== entry.id))
      setPendingDelete(null)
      setDeleted(DELETE_PI_SUCCESS)
    } catch {
      setDeleteFailure(describeDeletionFailure('DELETE_FAILED'))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }, [pendingDelete, load])

  const closeDeleteDialog = useCallback(() => {
    if (deletingRef.current) return
    setPendingDelete(null)
    setDeleteFailure(null)
  }, [])

  /**
   * The compact destructive action, or nothing at all.
   *
   * Hidden for an ineligible status and for an unauthorized viewer, so the list
   * offers no control the database would refuse. Icon-only to keep a working
   * list readable, with a real accessible name rather than a title attribute.
   */
  const deleteAction = (entry: PiDraftListEntry) => {
    if (!canDeleteSubmission(
      { status: entry.status, created_by: entry.createdBy, submitted_by: entry.submittedBy },
      actor,
    )) return null

    return (
      <button
        type="button"
        className="boe-row-icon boe-row-icon--delete"
        onClick={e => { e.stopPropagation(); setDeleteFailure(null); setPendingDelete(entry) }}
        disabled={deleting}
        aria-label={`${DELETE_PI_ARIA_LABEL} — ${entry.client}`}
        title={DELETE_PI_ARIA_LABEL}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    )
  }

  /**
   * The row's icons, in fixed 28px slots as on the Finance lists: Open Draft
   * (or Review PI, in the review blue), then Delete. A missing Delete leaves an
   * empty slot so the open icon never moves between rows.
   */
  const rowActions = (entry: PiDraftListEntry, actionLabel: string) => (
    <div className="boe-row-actions boe-row-actions--slots" style={{ gap: '4px', justifyContent: 'flex-end' }}>
      <Link
        href={entry.href}
        prefetch={false}
        className={`boe-row-icon${actionLabel === REVIEW_ACTION_LABEL ? ' boe-row-icon--review' : ''}`}
        aria-label={`${actionLabel} — ${entry.client}`}
        title={actionLabel}
        onClick={e => e.stopPropagation()}
        onMouseEnter={() => prefetchDraft(entry)}
        onFocus={() => prefetchDraft(entry)}
      >
        {actionLabel === REVIEW_ACTION_LABEL
          ? <ClipboardCheck size={15} aria-hidden="true" />
          : <Eye size={15} aria-hidden="true" />}
      </Link>
      {deleteAction(entry) ?? <span className="boe-row-icon-slot" aria-hidden="true" />}
    </div>
  )
  /** One destination, named once, so the header and the empty state cannot
   *  drift apart or grow a second hand-built path. */
  const goToImport = () => router.push('/orders/import')

  if (entries === null && !failed) return <OrdersRouteFallback />

  const emptyState = (
    <div className="fin-board">
      <FinanceEmpty
        icon="file"
        title={PI_DRAFTS_EMPTY_TEXT}
        /* This used to end "Nothing is submitted for approval at this stage",
           which stopped being true the day submission shipped. */
        body={PI_DRAFTS_EMPTY_NOTE}
        /* The action belongs HERE, in the empty state, because this is the one
           moment the page has nothing else to offer — a person arriving with no
           records should not have to find the header button to begin.

           It is deliberately NOT rendered when the list has rows: the header
           already carries it, and two identical primary buttons stacked on a
           phone is the repetition this avoids. */
        action={canCreate && (
          <button className="boe-btn boe-btn-primary" onClick={goToImport}>
            <Upload size={13} strokeWidth={2} />
            {UPLOAD_PI_BUTTON_LABEL}
          </button>
        )}
      />
    </div>
  )

  const failureState = (
    <div className="fin-board" role="alert" style={{ borderColor: 'rgba(180,35,50,0.3)' }}>
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
          These drafts could not be loaded
        </div>
        <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
          {/* No database message is shown. It can carry column names and row
              content, and there is nothing in it a person could act on. */}
          The list could not be read just now. Try again in a moment.
        </div>
        <div>
          <button className="boe-btn boe-btn-ghost" onClick={() => { setEntries(null); void load() }}>
            Try again
          </button>
        </div>
      </div>
    </div>
  )

  /**
   * One table of PI records.
   *
   * WHAT A ROW ANSWERS, in the order somebody asks it: whose order is this,
   * who wrote the PI, when was it confirmed and when is it due, how much of the
   * advance has come in, what is it worth, and where has it got to. The file
   * name, the product-line count, Uploaded by, Submitted, Grand total and the
   * workbook date under the salesperson are gone (the last four on
   * 2026-10-21) — none decided anything the list is used for.
   *
   * The review queue and the working list are the SAME rows in the same shape,
   * so they are one table rendered twice rather than two tables to keep in step.
   * What differs is only the action icon.
   */
  const listTable = (rows: PiDraftListEntry[], actionLabel: string) => (
    <div className="fin-table-wrap">
      <table className="fin-table fin-table--drafts">
        <colgroup>
          <col style={{ width: '23%' }} />{/* Client, reference under it */}
          <col style={{ width: '13%' }} />{/* Salesperson (the workbook's) */}
          <col style={{ width: '12%' }} />{/* Confirmed date */}
          <col style={{ width: '12%' }} />{/* Due date */}
          <col style={{ width: '10%' }} />{/* Advance % */}
          <col style={{ width: '13%' }} />{/* Product value */}
          <col style={{ width: '17%' }} />{/* Status */}
          <col style={{ width: '76px' }} />{/* Actions: two 28px slots */}
        </colgroup>
        <thead>
          <tr>
            {['Client', 'Salesperson', 'Confirmed date', 'Due date', 'Advance %',
              'Product value', 'Status', 'Actions'].map((h, i, all) => (
              // The advance percentage, the money column and the actions are
              // right-aligned, so the figures line up digit for digit.
              <th key={h} className={i === 4 || i === 5 || i === all.length - 1 ? 'fin-num' : undefined}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(entry => (
            <tr
              key={entry.id}
              onClick={() => router.push(entry.href)}
              onMouseEnter={() => prefetchDraft(entry)}
            >
              <td title={entry.client}>
                <span className="fin-primary-text">{entry.client}</span>
                {/* THE DRAFT'S OWN REFERENCE AND ITS NUMBER (20270114000000): a
                    reserved number only where an older draft genuinely holds one,
                    otherwise the plain statement that none is allotted yet. */}
                <span className="fin-sub">{entry.reference} · {entry.numberLine}</span>
              </td>
              {/* The workbook's own author. The date the document carries
                  was shown under it until 2026-10-21 and was removed: it is
                  a typed-in preparation date, not something this system
                  records, and it was read as an upload or status date. */}
              <td>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.authoredBy}</span>
              </td>
              {/* The two dates Sales confirms in Internal details, and how
                  much of the advance has arrived (verified plus awaiting
                  verification, of Total before GST). A dash is "not entered"
                  or "no figure", never zero. */}
              <td>{entry.confirmedOn}</td>
              <td>{entry.dueOn}</td>
              <td className="fin-num">{entry.advancePercent}</td>
              {/* THE GOODS. The Grand total column was removed from the list
                  on 2026-10-21 (owner: not needed here); the PI detail page
                  still states it, and says so when it could not be read. */}
              <td className="fin-num fin-muted">{entry.productValue}</td>
              <td>
                <StatusPill label={entry.statusLabel} tone={entry.statusTone} />
              </td>
              <td>
                {/* Open sits first and keeps its place; Delete is last, so
                    the destructive control is never the one a hurried click
                    lands on. */}
                {rowActions(entry, actionLabel)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  const listCards = (rows: PiDraftListEntry[], actionLabel: string) => (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((entry, i) => (
        <div
          key={entry.id}
          style={{
            padding: '14px 16px',
            borderTop: i === 0 ? 'none' : '1px solid #ECE7E0',
            display: 'flex', flexDirection: 'column', gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
                {entry.client}
              </div>
              <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                {entry.reference} · {entry.numberLine}
              </div>
            </div>
            <StatusPill label={entry.statusLabel} tone={entry.statusTone} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' }}>
            <span style={{ color: colors.secondary }}>
              <span style={{ color: colors.muted }}>Salesperson </span>{entry.authoredBy}
            </span>
            <span style={{ color: colors.secondary }}>
              <span style={{ color: colors.muted }}>Confirmed </span>{entry.confirmedOn}
              <span style={{ color: colors.muted }}> · Due </span>{entry.dueOn}
            </span>
            <span style={{ color: colors.secondary }}>
              <span style={{ color: colors.muted }}>Advance received </span>{entry.advancePercent}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ fontSize: '12px', color: colors.muted }}>Product value</span>
            <span style={{ fontSize: '12px', color: colors.secondary }}>{entry.productValue}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px' }}>
            {rowActions(entry, actionLabel)}
          </div>
        </div>
      ))}
    </div>
  )

  const renderList = (rows: PiDraftListEntry[], actionLabel: string) =>
    (isMobile ? listCards : listTable)(rows, actionLabel)

  // Which rows go where. RLS already decided what is in `entries` at all; this
  // decides only where each row is printed, and for a viewer without review
  // authority it changes nothing — `review` is empty and `working` is the list
  // exactly as it was. The status card and the search then narrow each part.
  const split = splitDraftsForReview(entries ?? [], canReview)
  const inView = (entry: PiDraftListEntry) =>
    (statusFilter === 'all' || entry.status === statusFilter) && matchesSearch(entry, search)
  const review = split.review.filter(inView)
  const working = split.working.filter(inView)

  // What each card would show under the current search: a number never
  // contradicts the list once its card is pressed.
  const searched = (entries ?? []).filter(entry => matchesSearch(entry, search))
  const cardCounts: Record<DraftStatusFilter, number> = {
    all: searched.length, draft: 0, submitted: 0, needs_changes: 0, rejected: 0,
  }
  for (const entry of searched) {
    if (entry.status in cardCounts) cardCounts[entry.status as DraftStatusFilter] += 1
  }

  // The queue group is drawn whenever the view can hold submitted rows, so a
  // reviewer is told plainly that nothing is waiting rather than shown nothing.
  const showQueue = canReview && (statusFilter === 'all' || statusFilter === 'submitted')
  const nothingInView = review.length === 0 && working.length === 0

  const viewBar = (
    <div className="fin-viewbar">
      <div className="fin-tools" role="search" aria-label="Filter PI drafts">
        <label className="boe-list-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            aria-label="Search PI drafts"
            placeholder="Client, PI reference or person…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onBlur={flushSearch}
          />
          {searchInput && (
            <button type="button" onClick={() => setSearchInput('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
          )}
        </label>
        {narrowed && (
          <button type="button" onClick={clearView} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '12px' }}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  )

  const reviewSection = canReview && (showQueue && (!nothingInView || !narrowed) && (
    <>
      <div className="fin-group">
        {REVIEW_QUEUE_TITLE}
        <span className="fin-group-count">{review.length}</span>
      </div>
      {review.length === 0 ? (
        <div className="fin-group-body" style={{ padding: '16px 14px', fontSize: '12px', color: colors.secondary }}>
          {PI_REVIEW_EMPTY_TEXT}
        </div>
      ) : renderList(review, REVIEW_ACTION_LABEL)}
    </>
  ))

  const workingSection = working.length > 0 && (
    <>
      {/* The group label appears only when there is a queue above it to tell
          this list apart from. On an employee's page there is one list and it
          needs no label — the page title is already "PI Drafts". */}
      {showQueue && (
        <div className="fin-group">
          PI Drafts
          <span className="fin-group-count">{working.length}</span>
        </div>
      )}
      {renderList(working, 'Open Draft')}
    </>
  )

  return (
    <OrdersLayout
      profile={profile}
      title="PI Drafts"
      subtitle={PI_DRAFTS_SUBTITLE}
      onSignOut={handleSignOut}
      onRefresh={load}
      // THE ENTRY POINT TO THE IMPORTER, and the only one on this page for a
      // person who already has records. Shown only to a holder of orders.create
      // — a courtesy, not the control: /orders/import re-resolves the permission
      // for itself, and the storage policies and the server route decide again.
      actions={(
        <>
          {canCreate ? (
            <button className="boe-btn boe-btn-primary" onClick={goToImport}>
              <Upload size={13} strokeWidth={2} />
              {UPLOAD_PI_BUTTON_LABEL}
            </button>
          ) : null}
          {/* The approved PI format, for everyone who can enter Orders (the route's own rule) —
              the same action as the left navigation's entry. */}
          <PiFormatButton />
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: '24px' }}>
        {/* Concise, dismissible, and gone the moment anything else happens. A
            deletion that worked needs one line, not a panel. */}
        {deleted && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
            fontSize: '12px', color: colors.primary, lineHeight: 1.5,
            background: colors.greenTint, border: '1px solid rgba(39,98,71,0.25)',
            borderRadius: '8px', padding: '9px 12px', marginBottom: '16px',
          }} role="status">
            <span>{deleted}</span>
            <button
              className="boe-btn boe-btn-ghost"
              onClick={() => setDeleted(null)}
              aria-label="Dismiss"
              style={{ padding: '2px 8px' }}
            >
              ×
            </button>
          </div>
        )}

        {failed ? failureState : (entries && entries.length === 0 ? (
          // A reviewer with an empty queue and no records of their own gets the
          // ordinary empty state, not two empty boxes.
          emptyState
        ) : (
          <>
            {/* ── The status cards ARE the filter (Finance lists, 2026-10) ── */}
            <FinanceStatusCards
              ariaLabel="PI draft status"
              noun="draft"
              active={statusFilter}
              onSelect={key => setListState({ status: key })}
              cards={STATUS_CARDS.map(c => ({ ...c, count: cardCounts[c.key] }))}
            />
            <div className="fin-board">
              {viewBar}
              {reviewSection}
              {workingSection}
              {nothingInView && narrowed && (
                /* A filter that matches nothing is not "no drafts": it says so
                   and offers the way out. */
                <FinanceEmpty
                  icon="search"
                  title={search ? `No results for “${listState.q.trim()}”.` : 'No PI drafts with this status.'}
                  body="Try a client, a PI reference or a person, or clear the filters."
                  action={
                    <button type="button" onClick={clearView} className="boe-btn boe-btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }}>
                      Clear filters
                    </button>
                  }
                />
              )}
            </div>
          </>
        ))}
      </div>

      {pendingDelete && (
        <PiDeleteConfirmModal
          client={pendingDelete.client}
          status={pendingDelete.status}
          deleting={deleting}
          failure={deleteFailure}
          onCancel={closeDeleteDialog}
          onConfirm={confirmDelete}
        />
      )}
    </OrdersLayout>
  )
}
