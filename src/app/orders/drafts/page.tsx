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
import { useRouter } from 'next/navigation'
import { FileText, Inbox, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { PiCard } from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { formatInr } from '@/lib/pi/previewView'
import { fetchAllRows } from '@/lib/supabasePaging'
import {
  PI_DRAFTS_EMPTY_NOTE,
  PI_DRAFTS_EMPTY_TEXT,
  PI_DRAFTS_SUBTITLE,
  PI_DRAFT_LIST_COLUMNS,
  PI_DRAFT_LIST_STATUSES,
  PI_REVIEW_EMPTY_TEXT,
  describeDraftListEntry,
  type PersistedSubmission,
  type PiDraftListEntry,
  type PiDraftStatusTone,
} from '@/lib/orders/draftsView'
import {
  REVIEW_ACTION_LABEL,
  REVIEW_QUEUE_TITLE,
  splitDraftsForReview,
} from '@/lib/orders/submissionWorkflow'

const MOBILE_BREAKPOINT = 768

/** Newest first, and capped: a drafts list is a working set, not an archive. */
const LIST_LIMIT = 200

const TONE_STYLE: Record<PiDraftStatusTone, { bg: string; color: string; border: string }> = {
  neutral: { bg: colors.raised,    color: colors.secondary, border: colors.border },
  blue:    { bg: colors.blueTint,  color: '#2F5BB7',        border: 'rgba(85,133,232,0.3)' },
  amber:   { bg: colors.amberTint, color: '#9A6212',        border: 'rgba(232,160,48,0.3)' },
  red:     { bg: colors.redTint,   color: colors.red,       border: 'rgba(217,79,79,0.3)' },
  green:   { bg: colors.greenTint, color: '#2F7A52',        border: 'rgba(69,168,112,0.25)' },
}

function StatusPill({ label, tone }: { label: string; tone: PiDraftStatusTone }) {
  const style = TONE_STYLE[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: '5px',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
      background: style.bg, color: style.color, border: `1px solid ${style.border}`,
    }}>
      {label}
    </span>
  )
}

export default function PiDraftsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [canCreate, setCanCreate] = useState(false)
  const [canReview, setCanReview] = useState(false)
  const [entries, setEntries] = useState<PiDraftListEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  /**
   * The same answer as `canReview`, in a ref.
   *
   * `load` is a stable callback the header's refresh control also calls, and it
   * runs for the first time in the same tick that resolves the permission — a
   * state read there would still be the initial `false` and the reviewer's very
   * first page load would fetch no submitter names. The ref is written before
   * the first load and read by every one, so both agree.
   */
  const reviewerRef = useRef(false)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /**
   * Load the list.
   *
   * TWO READS, BOTH UNDER THE CALLER'S OWN POLICIES. The submissions, then the
   * product lines belonging to those submissions so each row can say how many
   * products it holds. The second read is paged through fetchAllRows because
   * PostgREST silently caps a response at 1000 rows: two hundred drafts of a
   * dozen lines each is past that, and a silent truncation would print "3
   * products" beside a twelve-product PI — a wrong number, delivered
   * confidently, which is worse than no number at all.
   */
  const load = useCallback(async () => {
    setFailed(false)

    const { data, error } = await supabase
      .from('order_submissions')
      .select(PI_DRAFT_LIST_COLUMNS)
      .in('status', PI_DRAFT_LIST_STATUSES)
      .order('updated_at', { ascending: false })
      .limit(LIST_LIMIT)

    if (error || !data) { setEntries(null); setFailed(true); return }

    const rows = data as unknown as PersistedSubmission[]
    const ids = rows.map(r => r.id)

    const counts = new Map<string, number>()
    if (ids.length > 0) {
      const items = await fetchAllRows<{ submission_id: string }>((from, to) =>
        supabase
          .from('order_submission_items')
          .select('id, submission_id')
          .in('submission_id', ids)
          // A deterministic order on a unique column, which is what makes
          // range-based paging return each row exactly once.
          .order('id', { ascending: true })
          .range(from, to))

      if (!items.ok || items.truncated) { setEntries(null); setFailed(true); return }
      for (const item of items.rows) {
        counts.set(item.submission_id, (counts.get(item.submission_id) ?? 0) + 1)
      }
    }

    // ── Who submitted the ones waiting for review ──
    //
    // Read ONLY for somebody who has a queue to read. An employee's own list
    // names nobody — every record in it is theirs — so the query is skipped
    // rather than made and discarded.
    //
    // One read for every name, not one per row. A failed or partial read leaves
    // the name unresolved and the row renders an honest dash: a queue entry
    // without a name is still a queue entry, and hiding it would be worse.
    const names = new Map<string, string>()
    const submitterIds = reviewerRef.current
      ? [...new Set(rows.filter(r => r.status === 'submitted' && r.submitted_by).map(r => r.submitted_by as string))]
      : []
    if (submitterIds.length > 0) {
      const { data: people } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', submitterIds)
      for (const person of (people ?? []) as { id: string; full_name: string | null }[]) {
        if (person?.id && person.full_name) names.set(person.id, person.full_name)
      }
    }

    setEntries(rows.map(row => describeDraftListEntry(
      row,
      counts.get(row.id) ?? 0,
      formatInr,
      row.submitted_by ? names.get(row.submitted_by) ?? null : null,
    )))
  }, [supabase])

  useEffect(() => {
    let active = true

    const run = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      // Module entry is enforced by the Orders layout above this page, and row
      // visibility by RLS below it. What is resolved here is only whether to
      // offer the "New Order" button — an entry point, not an authority.
      const permissions = await getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => [])
      const caps = deriveOrdersCapabilities((me as UserProfile | null)?.role, permissions)

      if (!active) return
      setProfile((me as UserProfile) ?? null)
      setCanCreate(caps.canCreateOrder)
      // Written before the first load, so that load — which is a stable
      // callback — sees the answer rather than the initial false.
      reviewerRef.current = caps.canApproveOrderSubmission
      setCanReview(caps.canApproveOrderSubmission)
      await load()
    }

    run()
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const openDraft = (entry: PiDraftListEntry) => router.push(entry.href)

  if (entries === null && !failed) return <LoadingScreen />

  const emptyState = (
    <PiCard>
      <div style={{
        padding: '40px 24px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
        textAlign: 'center',
      }}>
        <FileText size={22} strokeWidth={1.8} color={colors.muted} />
        <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
          {PI_DRAFTS_EMPTY_TEXT}
        </div>
        <div style={{ fontSize: '12px', color: colors.secondary, maxWidth: '440px', lineHeight: 1.5 }}>
          {/* This used to end "Nothing is submitted for approval at this stage",
              which stopped being true the day submission shipped. */}
          {PI_DRAFTS_EMPTY_NOTE}
        </div>
      </div>
    </PiCard>
  )

  const failureState = (
    <PiCard style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
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
    </PiCard>
  )

  /**
   * One table of PI records.
   *
   * The review queue and the working list are the SAME rows in the same shape —
   * a client, a file, a count, a total, a state and a way in — so they are one
   * table rendered twice rather than two tables to keep in step. What differs is
   * the third-from-last column (when it was submitted, which only matters to a
   * reviewer) and the wording on the button.
   */
  const listTable = (rows: PiDraftListEntry[], actionLabel: string, showSubmission: boolean) => (
    <PiCard>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              {['Client', 'PI file', 'Products', 'Grand total', 'Status',
                ...(showSubmission ? ['Submitted', 'Submitted by'] : ['Saved']), ''].map((h, i) => (
                <th key={h || 'action'} style={{
                  padding: '8px 14px',
                  textAlign: i === 2 || i === 3 ? 'right' : 'left',
                  fontSize: '10px', fontWeight: 600, color: colors.muted,
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(entry => (
              <tr key={entry.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                <td style={{ padding: '10px 14px', fontWeight: 600, color: colors.primary, minWidth: '160px' }}>
                  {entry.client}
                </td>
                <td style={{
                  padding: '10px 14px', color: colors.secondary,
                  maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={entry.reference}>
                  {entry.reference}
                </td>
                <td style={{ padding: '10px 14px', textAlign: 'right', color: colors.secondary, whiteSpace: 'nowrap' }}>
                  {entry.itemCount}
                </td>
                <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                  {entry.grandTotal}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <StatusPill label={entry.statusLabel} tone={entry.statusTone} />
                </td>
                {showSubmission ? (
                  <>
                    <td style={{ padding: '10px 14px', color: colors.muted, whiteSpace: 'nowrap', fontSize: '12px' }}>
                      {entry.submittedAt}
                    </td>
                    <td style={{ padding: '10px 14px', color: colors.secondary, whiteSpace: 'nowrap', fontSize: '12px' }}>
                      {entry.submitter}
                    </td>
                  </>
                ) : (
                  <td style={{ padding: '10px 14px', color: colors.muted, whiteSpace: 'nowrap', fontSize: '12px' }}>
                    {entry.savedAt}
                  </td>
                )}
                <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                  <button className="boe-btn boe-btn-ghost" onClick={() => openDraft(entry)}>
                    {actionLabel}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PiCard>
  )

  const listCards = (rows: PiDraftListEntry[], actionLabel: string, showSubmission: boolean) => (
    <PiCard>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((entry, i) => (
          <div
            key={entry.id}
            style={{
              padding: '14px 16px',
              borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
                  {entry.client}
                </div>
                <div style={{
                  fontSize: '11px', color: colors.muted, marginTop: '2px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {entry.reference}
                </div>
              </div>
              <StatusPill label={entry.statusLabel} tone={entry.statusTone} />
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
              <span style={{ fontSize: '12px', color: colors.secondary }}>{entry.itemCountLabel}</span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{entry.grandTotal}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
              <span style={{ fontSize: '11px', color: colors.muted }}>
                {showSubmission
                  ? `${entry.submittedAt}${entry.submitter !== '—' ? ` · ${entry.submitter}` : ''}`
                  : entry.savedAt}
              </span>
              <button className="boe-btn boe-btn-ghost" onClick={() => openDraft(entry)}>
                {actionLabel}
              </button>
            </div>
          </div>
        ))}
      </div>
    </PiCard>
  )

  const renderList = (rows: PiDraftListEntry[], actionLabel: string, showSubmission: boolean) =>
    (isMobile ? listCards : listTable)(rows, actionLabel, showSubmission)

  // Which rows go where. RLS already decided what is in `entries` at all; this
  // decides only where each row is printed, and for a viewer without review
  // authority it changes nothing — `review` is empty and `working` is the list
  // exactly as it was.
  const { review, working } = splitDraftsForReview(entries ?? [], canReview)

  const reviewSection = canReview && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 2px' }}>
        <Inbox size={15} strokeWidth={1.9} color="#2F5BB7" />
        <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
          {REVIEW_QUEUE_TITLE}
        </span>
        <span style={{
          fontSize: '11px', fontWeight: 700, color: '#2F5BB7',
          background: colors.blueTint, border: '1px solid rgba(85,133,232,0.3)',
          borderRadius: '999px', padding: '1px 8px',
        }}>
          {review.length}
        </span>
      </div>
      {review.length === 0 ? (
        <PiCard>
          <div style={{ padding: '18px 20px', fontSize: '12px', color: colors.secondary }}>
            {PI_REVIEW_EMPTY_TEXT}
          </div>
        </PiCard>
      ) : renderList(review, REVIEW_ACTION_LABEL, true)}
    </div>
  )

  const workingSection = working.length > 0 && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* The heading appears only when there is a queue above it to tell this
          list apart from. On an employee's page there is one list and it needs
          no label — the page title is already "PI Drafts". */}
      {canReview && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 2px 0' }}>
          <FileText size={15} strokeWidth={1.9} color={colors.tertiary} />
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>PI Drafts</span>
        </div>
      )}
      {renderList(working, 'Open Draft', false)}
    </div>
  )

  return (
    <OrdersLayout
      profile={profile}
      title="PI Drafts"
      subtitle={PI_DRAFTS_SUBTITLE}
      onSignOut={handleSignOut}
      onRefresh={load}
      actions={canCreate ? (
        <button className="boe-btn boe-btn-primary" onClick={() => router.push('/orders/import')}>
          <Plus size={13} strokeWidth={2} />
          New Order
        </button>
      ) : undefined}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '24px' }}>
        {failed ? failureState : (entries && entries.length === 0 ? (
          // A reviewer with an empty queue and no records of their own gets the
          // ordinary empty state, not two empty boxes.
          emptyState
        ) : (
          <>
            {reviewSection}
            {workingSection}
          </>
        ))}
      </div>
    </OrdersLayout>
  )
}
