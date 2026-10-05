'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import { AdminSubmissionAction, type AdminActionKind } from '@/components/customerReviews/AdminSubmissionAction'
import { CustomSubmissionList } from '@/components/customerReviews/CustomSubmissionList'
import listStyles from '@/components/customerReviews/customSubmissionList.module.css'
import {
  CustomSubmissionFacts,
  CustomSubmissionProof,
  CustomSubmissionTrail,
} from '@/components/customerReviews/CustomSubmissionPieces'
import {
  DuplicatePanel,
  loadDuplicateSummaries,
  type DuplicateSummary,
} from '@/components/customerReviews/DuplicateReview'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { CUSTOM_REVIEW_PENDING_COUNT_KEY } from '@/hooks/queries/useCustomReviewPendingCount'
import { istDateOf } from '@/lib/istDate'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { REVIEW_TYPE_META } from '@/lib/customerReviews/types'
import {
  NO_SUBMISSION_FILTERS,
  SUBMISSION_STATUS_FILTERS,
  SUBMISSION_STATUS_FILTER_LABELS,
  canAdminDelete,
  canAdminRejectApproved,
  recordedOrNot,
  reviewMonthLabel,
  reviewMonthOptions,
  reviewMonthRange,
  statusFilterOf,
  type SubmissionListFilters,
} from '@/lib/customerReviews/submissionList'
import {
  CUSTOM_PROOF_BUCKET,
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_STATUS_META,
  MAX_REJECTION_REASON_LENGTH,
  approvalCreditsIssue,
  customSubmissionErrorMessage,
  formatSubmissionDay,
  rejectionReasonIssue,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'

// ── Custom Submissions: the verifier's queue ─────────────────────────────────
//
// Reviews employees arranged themselves, with the screenshot that proves each
// was published. A separate workspace rather than a fifth tab on Reviews: the
// Reviews queue is the generated-review lifecycle (pending → available →
// booked → to verify), and a custom submission has none of those states.
//
// OPEN PROOF → CHECK → APPROVE + CREDIT, OR REJECT + REASON. A rejected review
// can come back: the employee corrects it and reapplies the SAME review, which
// returns here as Pending Approval with a "Reapplied" marker, their note, and
// the whole history — the first submission, the rejection and why.
//
// THE DATABASE DECIDES EVERYTHING THAT MATTERS. approve_customer_review_custom_
// submission() and reject_…() take their actor from auth.uid(), resolve
// `verify`, refuse the submitter's own row, lock the submission, and post the
// credit exactly once. This screen only shows the amount they will post: the
// configured reward for the review type, which a verifier confirms and only a
// BOE Credits administrator may change (the function enforces that too).
//
// A NOTIFICATION OPENS ONE REVIEW. `?submission=<id>` loads that row, switches
// to its status and opens its sheet.

type Rewards = { text: number; image: number }

/** Reviews read per page. "Show more" asks for another page; nothing is silently cut off. */
const PAGE_SIZE = 100
/** How many rows the filter menus are built from (employees and months that have submissions). */
const FILTER_SOURCE_LIMIT = 5000
/** Signed screenshot links for the thumbnails live this long; opening one re-signs it. */
const THUMB_TTL_SECONDS = 600

export function CustomSubmissionsScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()

  const [filters, setFilters] = useState<SubmissionListFilters>(NO_SUBMISSION_FILTERS)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [rows, setRows] = useState<CustomReviewSubmission[]>([])
  const [total, setTotal] = useState<number | null>(null)
  // The filters the rows on screen were loaded with — a list for filters somebody already left is not shown.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [namesReady, setNamesReady] = useState(false)
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map())
  const [filterSource, setFilterSource] = useState<{ submitted_by: string; submitted_at: string }[]>([])
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [rewards, setRewards] = useState<Rewards | null>(null)
  // Possible-duplicate state for the rows on screen. A failed read leaves it null: no badge, never a "clear".
  const [duplicates, setDuplicates] = useState<Map<string, DuplicateSummary> | null>(null)
  const [opened, setOpened] = useState<CustomReviewSubmission | null>(null)
  const [previewing, setPreviewing] = useState<CustomReviewSubmission | null>(null)
  const [adminAction, setAdminAction] = useState<{ kind: AdminActionKind; row: CustomReviewSubmission } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // A response for filters somebody already left must not overwrite the ones they are on.
  const loadTicket = useRef(0)
  const deepLinked = useRef<string | null>(null)

  const filterKey = `${filters.status}|${filters.month}|${filters.employeeId}|${limit}`
  const isAdmin = profile?.role === 'admin'

  useEffect(() => {
    if (loading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [loading, caps.canVerify, router])

  const rememberNames = useCallback(async (found: { submitted_by: string; approved_by?: string | null; rejected_by?: string | null; deleted_by?: string | null }[]) => {
    const ids = [...new Set(found.flatMap(r => [r.submitted_by, r.approved_by, r.rejected_by, r.deleted_by]).filter((v): v is string => !!v))]
    if (ids.length === 0) return
    // id and full_name only — users has private columns (src/lib/users/safeColumns.ts).
    const { data: people } = await supabase.from('users').select('id, full_name').in('id', ids)
    const named = (people ?? []) as unknown as { id: string; full_name: string | null }[]
    setNames(prev => {
      const next = new Map(prev)
      for (const p of named) next.set(p.id, p.full_name ?? 'Unknown')
      return next
    })
  }, [supabase])

  /** Employees and months that have submissions — the filter menus, and nothing else. */
  const loadFilterSource = useCallback(async () => {
    const { data } = await supabase
      .from('customer_review_custom_submissions')
      .select('submitted_by, submitted_at')
      .order('submitted_at', { ascending: false })
      .limit(FILTER_SOURCE_LIMIT)
    const found = (data ?? []) as unknown as { submitted_by: string; submitted_at: string }[]
    setFilterSource(found)
    await rememberNames(found)
  }, [supabase, rememberNames])

  const load = useCallback(async (f: SubmissionListFilters, rowLimit: number) => {
    const ticket = ++loadTicket.current
    const key = `${f.status}|${f.month}|${f.employeeId}|${rowLimit}`
    // A deleted review is kept for verifiers (RLS) but is in no queue: it has its own filter,
    // and every other view leaves it out — as do the counts.
    let query = supabase
      .from('customer_review_custom_submissions')
      .select(CUSTOM_SUBMISSION_COLUMNS, { count: 'exact' })
    query = f.status === 'deleted' ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)
    if (f.status !== 'all' && f.status !== 'deleted') query = query.eq('status', f.status)
    if (f.employeeId) query = query.eq('submitted_by', f.employeeId)
    const range = reviewMonthRange(f.month)
    if (range) query = query.gte('submitted_at', range.from).lt('submitted_at', range.to)
    // Oldest pending first — that queue is worked in order; everything else, newest first.
    query = f.status === 'pending_verification'
      ? query.order('submitted_at', { ascending: true })
      : f.status === 'deleted'
        ? query.order('deleted_at', { ascending: false })
        : query.order('submitted_at', { ascending: false })

    const [list, pending] = await Promise.all([
      query.limit(rowLimit),
      supabase
        .from('customer_review_custom_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_verification')
        .is('deleted_at', null),
    ])
    if (ticket !== loadTicket.current) return
    if (list.error) {
      setLoadError('Custom submissions could not be loaded. Refresh to try again.')
      setRows([])
      setTotal(null)
      setLoadedKey(key)
      return
    }
    const found = (list.data ?? []) as unknown as CustomReviewSubmission[]
    setLoadError(null)
    setRows(found)
    setTotal(list.count ?? found.length)
    setLoadedKey(key)
    setPendingCount(pending.error ? null : pending.count ?? null)
    setNamesReady(false)
    await rememberNames(found)
    if (ticket !== loadTicket.current) return
    setNamesReady(true)

    // Thumbnails: one batch request for the page. A path that fails simply has no thumbnail and
    // the card says so; the full-size preview asks for the file again.
    const paths = [...new Set(found.map(r => r.proof_storage_path))]
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage.from(CUSTOM_PROOF_BUCKET).createSignedUrls(paths, THUMB_TTL_SECONDS)
      if (ticket !== loadTicket.current) return
      const next = new Map<string, string>()
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) next.set(s.path, s.signedUrl)
      setThumbs(next)
    } else {
      setThumbs(new Map())
    }

    const summaries = await loadDuplicateSummaries(supabase, found.map(r => r.id))
    if (ticket === loadTicket.current) setDuplicates(summaries)
  }, [supabase, rememberNames])

  useEffect(() => {
    if (loading || !caps.canVerify) return
    const startFetch = () => { void load(filters, limit) }
    startFetch()
  }, [loading, caps.canVerify, filters, limit, load])

  useEffect(() => {
    if (loading || !caps.canVerify) return
    const startFetch = () => { void loadFilterSource() }
    startFetch()
  }, [loading, caps.canVerify, loadFilterSource])

  // The review a notification points at, opened once per id.
  const wanted = searchParams.get('submission')
  useEffect(() => {
    if (loading || !caps.canVerify || !wanted || deepLinked.current === wanted) return
    deepLinked.current = wanted
    const startFetch = () => {
      void (async () => {
        const { data } = await supabase
          .from('customer_review_custom_submissions')
          .select(CUSTOM_SUBMISSION_COLUMNS)
          .eq('id', wanted)
          .maybeSingle()
        const row = data as unknown as CustomReviewSubmission | null
        if (!row) { setNotice('That custom review could not be found.'); return }
        await rememberNames([row])
        setLimit(PAGE_SIZE)
        setFilters({ ...NO_SUBMISSION_FILTERS, status: statusFilterOf(row) })
        setOpened(row)
      })()
    }
    startFetch()
  }, [loading, caps.canVerify, wanted, supabase, rememberNames])

  // The configured rewards, read under RLS (every active employee may read the
  // settings). A label for the button — the approval function re-reads them.
  useEffect(() => {
    if (loading || !caps.canVerify) return
    let active = true
    const startFetch = () => {
      void (async () => {
        const { data } = await supabase
          .from('boe_credit_settings')
          .select('review_reward_credits, image_review_reward_credits')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const row = data as { review_reward_credits: unknown; image_review_reward_credits: unknown } | null
        if (active && row) {
          setRewards({ text: Number(row.review_reward_credits), image: Number(row.image_review_reward_credits) })
        }
      })()
    }
    startFetch()
    return () => { active = false }
  }, [loading, caps.canVerify, supabase])

  /** After any decision or admin action: the list, the filter menus and every count that reads reviews. */
  const refreshAfterChange = useCallback(async () => {
    // Pending badge, reports and any other query under 'customer-reviews'; credits screens read the ledger on open.
    void queryClient.invalidateQueries({ queryKey: CUSTOM_REVIEW_PENDING_COUNT_KEY })
    void queryClient.invalidateQueries({ queryKey: ['customer-reviews'] })
    await Promise.all([load(filters, limit), loadFilterSource()])
  }, [queryClient, load, filters, limit, loadFilterSource])

  if (loading) return <LoadingScreen />

  const listLoading = loadedKey !== filterKey
  const monthOptions = reviewMonthOptions(filterSource.map(r => r.submitted_at))
  const employeeOptions = [...new Set(filterSource.map(r => r.submitted_by))]
    .map(id => ({ id, name: names.get(id) ?? '…' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const filtered = filters.status !== 'all' || filters.month !== '' || filters.employeeId !== ''

  const changeFilters = (next: Partial<SubmissionListFilters>) => {
    setFilters(prev => ({ ...prev, ...next }))
    setLimit(PAGE_SIZE)
    setNotice(null)
  }

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Custom Submissions"
      subtitle="Every custom review — pending, approved and rejected"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '1100px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {notice && (
          <p role="status" style={{ fontSize: '12.5px', color: '#166534', fontWeight: 600, margin: 0 }}>{notice}</p>
        )}

        <div role="tablist" aria-label="Submission status" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {SUBMISSION_STATUS_FILTERS.map(s => {
            const active = s === filters.status
            const meta = s === 'deleted'
              ? { label: 'Deleted', bg: '#F3F4F6', color: '#4B5563', border: '#D1D5DB' }
              : s === 'all'
                ? { label: 'All', bg: 'rgba(79,111,208,0.10)', color: '#3B5BC0', border: 'rgba(79,111,208,0.25)' }
                : CUSTOM_SUBMISSION_STATUS_META[s]
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => changeFilters({ status: s })}
                style={{
                  minHeight: '40px', padding: '7px 14px', borderRadius: '999px', fontFamily: 'inherit',
                  fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${active ? meta.border : colors.borderSoft}`,
                  background: active ? meta.bg : colors.base,
                  color: active ? meta.color : colors.secondary,
                }}
              >
                {SUBMISSION_STATUS_FILTER_LABELS[s]}{s === 'pending_verification' && pendingCount != null ? ` · ${pendingCount}` : ''}
              </button>
            )
          })}
        </div>

        <div className={listStyles.filters}>
          <label>
            Review month
            <select
              value={filters.month}
              onChange={e => changeFilters({ month: e.target.value })}
              aria-label="Filter by review month"
            >
              <option value="">All months</option>
              {monthOptions.map(m => <option key={m} value={m}>{reviewMonthLabel(m)}</option>)}
            </select>
          </label>
          <label>
            Submitted by
            <select
              value={filters.employeeId}
              onChange={e => changeFilters({ employeeId: e.target.value })}
              aria-label="Filter by employee"
            >
              <option value="">All employees</option>
              {employeeOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          {filtered && (
            <button
              type="button"
              className="boe-btn boe-btn-ghost"
              onClick={() => changeFilters(NO_SUBMISSION_FILTERS)}
              style={{ padding: '7px 12px', fontSize: '12.5px', minHeight: '40px' }}
            >
              Clear filters
            </button>
          )}
        </div>

        {loadError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{loadError}</p>
        )}

        {listLoading ? (
          <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Loading submissions…</p>
        ) : rows.length === 0 ? (
          <p style={{
            margin: 0, padding: '24px 20px', borderRadius: '10px', textAlign: 'center',
            border: `1px dashed ${colors.border}`, color: colors.muted, fontSize: '13px',
          }}>
            {filtered ? 'No custom review matches these filters.' : 'No custom review has been submitted yet.'}
          </p>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '12px', color: colors.secondary }}>
              Showing {rows.length}{total != null && total > rows.length ? ` of ${total}` : ''} {rows.length === 1 ? 'review' : 'reviews'}
            </p>
            <CustomSubmissionList
              rows={rows}
              names={names}
              namesReady={namesReady}
              thumbs={thumbs}
              duplicates={duplicates}
              viewerId={profile?.id ?? null}
              isAdmin={isAdmin}
              onOpen={row => { setNotice(null); setOpened(row) }}
              onPreview={setPreviewing}
              onAdminReject={row => { setNotice(null); setAdminAction({ kind: 'reject', row }) }}
              onAdminDelete={row => { setNotice(null); setAdminAction({ kind: 'delete', row }) }}
            />
            {total != null && total > rows.length && (
              <button
                type="button"
                className="boe-btn boe-btn-ghost"
                onClick={() => setLimit(l => l + PAGE_SIZE)}
                style={{ alignSelf: 'center', padding: '8px 18px', fontSize: '13px', minHeight: '44px' }}
              >
                Show more
              </button>
            )}
          </>
        )}
      </div>

      {previewing && (
        <ReviewSheet
          title={`Screenshot · ${previewing.submission_ref}`}
          subtitle={`${recordedOrNot(previewing.reviewer_name)} · submitted by ${names.get(previewing.submitted_by) ?? '…'}`}
          maxWidth="900px"
          onClose={() => setPreviewing(null)}
        >
          <CustomSubmissionProof
            key={previewing.id}
            supabase={supabase}
            path={previewing.proof_storage_path}
            alt={`Screenshot of ${previewing.submission_ref}`}
            large
          />
        </ReviewSheet>
      )}

      {opened && (
        <DecisionSheet
          key={opened.id}
          row={opened}
          supabase={supabase}
          viewerId={profile?.id ?? null}
          isAdmin={isAdmin}
          names={names}
          rewards={rewards}
          duplicate={duplicates?.get(opened.id)}
          onDuplicateChanged={() => { void load(filters, limit) }}
          onClose={() => setOpened(null)}
          onAdminAction={(kind, row) => setAdminAction({ kind, row })}
          onDecided={async message => {
            setOpened(null)
            setNotice(message)
            await refreshAfterChange()
          }}
        />
      )}

      {adminAction && (
        <AdminSubmissionAction
          key={`${adminAction.kind}:${adminAction.row.id}`}
          kind={adminAction.kind}
          row={adminAction.row}
          employee={names.get(adminAction.row.submitted_by) ?? 'the employee'}
          supabase={supabase}
          onClose={() => setAdminAction(null)}
          onDone={async message => {
            setAdminAction(null)
            setOpened(null)
            setNotice(message)
            await refreshAfterChange()
          }}
        />
      )}
    </CustomerReviewsLayout>
  )
}

function DecisionSheet({
  row, supabase, viewerId, isAdmin, names, rewards, duplicate, onDuplicateChanged, onClose, onDecided, onAdminAction,
}: {
  row: CustomReviewSubmission
  supabase: SupabaseClient
  viewerId: string | null
  /** A BOE Credits administrator may award a different amount; the function checks can_manage_boe_credits(). */
  isAdmin: boolean
  names: Map<string, string>
  rewards: Rewards | null
  /** The list's possible-duplicate summary for this review, when it could be read. */
  duplicate: DuplicateSummary | undefined
  onDuplicateChanged: () => void
  onClose: () => void
  onDecided: (message: string) => Promise<void>
  /** An administrator's reject-after-approval or delete — confirmed in its own dialog. */
  onAdminAction: (kind: AdminActionKind, row: CustomReviewSubmission) => void
}) {
  const configured = rewards ? (row.review_type === 'image' ? rewards.image : rewards.text) : null
  const [creditsText, setCreditsText] = useState(configured != null ? String(configured) : '')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // State is too slow to stop a double click. The database is what makes an
  // approval pay once; this only stops the second request.
  const acting = useRef(false)

  const buttonStyle: React.CSSProperties = { padding: '8px 16px', fontSize: '13px', minHeight: '44px' }

  const own = row.submitted_by === viewerId
  const pending = row.status === 'pending_verification' && row.deleted_at == null
  const held = row.reward_held
  const employee = names.get(row.submitted_by) ?? 'the employee'
  const typeMeta = REVIEW_TYPE_META[row.review_type]

  // A verifier confirms the configured amount; an administrator may type another.
  const credits = held ? Number(row.credits_awarded ?? 0) : isAdmin ? Number(creditsText.trim()) : configured
  const creditsIssue = held ? null : isAdmin
    ? approvalCreditsIssue(creditsText)
    : configured == null ? 'The configured reward could not be read. Reload the page to try again.' : null

  const approve = async () => {
    if (acting.current) return
    if (creditsIssue || credits == null) { setError(creditsIssue ?? 'Enter the number of credits to award.'); return }
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('approve_customer_review_custom_submission', {
        p_submission_id: row.id,
        p_credits: credits,
      })
      if (rpcError) {
        setError(customSubmissionErrorMessage(rpcError.message, 'That submission could not be approved.'))
        return
      }
      const result = data as { already_decided?: boolean; reaffirmed?: boolean; submission?: { credits_awarded?: unknown } } | null
      const awarded = Number(result?.submission?.credits_awarded ?? credits)
      await onDecided(result?.already_decided
        ? `${row.submission_ref} was already approved. Nothing more was awarded.`
        : result?.reaffirmed
          ? `${row.submission_ref} approved again. Its ${formatCredits(awarded)} stands; nothing more was awarded.`
          : `${row.submission_ref} approved · ${formatCredits(awarded, { signed: true })} awarded to ${employee}.`)
    } catch {
      setError('That submission could not be approved. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  const reject = async () => {
    if (acting.current) return
    const issue = rejectionReasonIssue(reason)
    if (issue) { setError(issue); return }
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('reject_customer_review_custom_submission', {
        p_submission_id: row.id,
        p_reason: reason.trim(),
      })
      if (rpcError) {
        setError(customSubmissionErrorMessage(rpcError.message, 'That submission could not be rejected.'))
        return
      }
      const result = data as { already_decided?: boolean; credit_reversed?: boolean } | null
      await onDecided(result?.already_decided
        ? `${row.submission_ref} was already rejected.`
        : result?.credit_reversed
          ? `${row.submission_ref} rejected. The credit it was holding was withdrawn; ${employee} can submit it again as a new review.`
          : `${row.submission_ref} rejected. No credits were awarded; ${employee} can correct it and reapply.`)
    } catch {
      setError('That submission could not be rejected. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  const adminReject = canAdminRejectApproved(row, viewerId, isAdmin)
  const adminDelete = canAdminDelete(row, isAdmin)
  const adminButtons = (adminReject || adminDelete) && !rejecting ? (
    <>
      {adminDelete && (
        <button
          type="button"
          className="boe-btn boe-btn-ghost"
          onClick={() => onAdminAction('delete', row)}
          disabled={busy}
          style={{ ...buttonStyle, color: '#B91C1C', marginRight: 'auto' }}
        >
          Delete
        </button>
      )}
      {adminReject && (
        <button
          type="button"
          className="boe-btn boe-btn-primary"
          onClick={() => onAdminAction('reject', row)}
          disabled={busy}
          style={{ ...buttonStyle, background: '#B91C1C', borderColor: '#B91C1C' }}
        >
          Reject approval
        </button>
      )}
    </>
  ) : null

  const footer = (pending && !own) || adminButtons ? (
    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {adminButtons}
      {!(pending && !own) ? null : rejecting ? (
        <>
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            onClick={() => { setRejecting(false); setError(null) }}
            disabled={busy}
            style={buttonStyle}
          >
            Back
          </button>
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            onClick={() => { void reject() }}
            disabled={busy || reason.trim() === ''}
            style={{ ...buttonStyle, background: '#B91C1C', borderColor: '#B91C1C' }}
          >
            {busy ? 'Rejecting…' : 'Confirm Reject'}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            onClick={() => { setRejecting(true); setError(null) }}
            disabled={busy}
            style={{ ...buttonStyle, color: '#B91C1C' }}
          >
            Reject
          </button>
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            onClick={() => { void approve() }}
            disabled={busy || creditsIssue != null}
            style={buttonStyle}
          >
            {busy
              ? 'Approving…'
              : held
                ? 'Approve again'
                : creditsIssue == null && credits != null
                  ? `Approve · ${formatCredits(credits, { signed: true })}`
                  : 'Approve'}
          </button>
        </>
      )}
    </div>
  ) : undefined

  return (
    <ReviewSheet
      title={`${employee} · ${CUSTOM_REVIEW_TYPE_LABELS[row.review_type]}`}
      subtitle={`${row.submission_ref} · ${CUSTOM_SUBMISSION_STATUS_META[row.status].label}${row.reapplication_count > 0 ? ' · Reapplied' : ''}`}
      maxWidth="720px"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose() }}
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {error && (
          <p role="alert" style={{ fontSize: '12.5px', color: colors.red, margin: 0 }}>{error}</p>
        )}

        {row.deleted_at && (
          <section style={{
            padding: '10px 12px', borderRadius: '9px', border: '1px solid #D1D5DB', background: '#F3F4F6',
            fontSize: '12.5px', color: colors.primary, lineHeight: 1.55,
          }}>
            <strong>Deleted by {row.deleted_by && row.deleted_by !== row.submitted_by ? (names.get(row.deleted_by) ?? 'an administrator') : (names.get(row.deleted_by ?? '') ?? 'the employee')} on {formatSubmissionDay(istDateOf(row.deleted_at))}.</strong>{' '}
            The record is kept as history and as duplicate-check evidence.
            {row.reward_reversal_transaction_id ? ' Its credit was reversed.' : ''}
          </section>
        )}

        {pending && held && (
          <section style={{
            padding: '10px 12px', borderRadius: '9px', border: '1px solid #FDE68A', background: '#FFFBEB',
            fontSize: '12.5px', color: '#92400E', lineHeight: 1.55,
          }}>
            <strong>Edited after approval.</strong> {employee} changed an approved review.
            {' '}Its {formatCredits(Number(row.credits_awarded ?? 0))} is still in {employee}&rsquo;s balance (the ledger is unchanged) but the review is not counted as eligible or ranked while it is pending.
            Approving again pays nothing more; rejecting it, or the employee deleting it, withdraws that credit once.
          </section>
        )}

        {pending && row.reapplication_count > 0 && (
          <section style={{
            padding: '10px 12px', borderRadius: '9px',
            border: '1px solid rgba(79,111,208,0.25)', background: 'rgba(79,111,208,0.06)',
            fontSize: '12.5px', color: colors.primary, lineHeight: 1.55,
          }}>
            <strong>Reapplied after a rejection</strong> — the same review, corrected. It still uses its one monthly slot.
            {row.candidate_note && (
              <div style={{ marginTop: '4px', color: colors.secondary, overflowWrap: 'anywhere' }}>
                {employee}&rsquo;s note: {row.candidate_note}
              </div>
            )}
          </section>
        )}

        <CustomSubmissionProof
          supabase={supabase}
          path={row.proof_storage_path}
          alt={`Proof for ${row.submission_ref}`}
          large
        />

        <CustomSubmissionFacts row={row} names={names} />

        <DuplicatePanel
          supabase={supabase}
          submission={row}
          viewerId={viewerId}
          names={names}
          onChanged={onDuplicateChanged}
        />

        {pending && !own && duplicate && duplicate.decided_duplicate > 0 && (
          <p role="note" style={{
            margin: 0, padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
            border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C',
          }}>
            A reviewer marked this review a duplicate. Approving it is still your decision; nothing was rejected automatically.
          </p>
        )}

        <CustomSubmissionTrail supabase={supabase} submissionId={row.id} viewerId={viewerId} names={names} />

        {pending && own && (
          <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
            You submitted this review, so another verifier must approve or reject it.
          </p>
        )}

        {pending && !own && !rejecting && !held && (
          <section style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            padding: '11px 13px', borderRadius: '9px', border: `1px solid ${typeMeta.border}`, background: typeMeta.bg,
          }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: typeMeta.color }}>BOE Credits to award</span>
              {isAdmin ? (
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  step="0.01"
                  value={creditsText}
                  disabled={busy}
                  aria-invalid={creditsText.trim() !== '' && creditsIssue != null}
                  onChange={e => { setCreditsText(e.target.value); setError(null) }}
                  style={{
                    width: '140px', padding: '8px 10px', borderRadius: '8px', fontSize: '15px', fontWeight: 700,
                    border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
                    fontFamily: 'inherit', minHeight: '40px', fontVariantNumeric: 'tabular-nums',
                  }}
                />
              ) : (
                <span style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                  {configured != null ? formatCredits(configured) : '—'}
                </span>
              )}
            </label>
            {isAdmin && creditsText.trim() !== '' && creditsIssue && (
              <span style={{ fontSize: '11.5px', color: colors.red }}>{creditsIssue}</span>
            )}
            <p style={{ margin: 0, fontSize: '11.5px', color: typeMeta.color, lineHeight: 1.6 }}>
              {configured != null
                ? `The configured reward for a ${CUSTOM_REVIEW_TYPE_LABELS[row.review_type]} is ${formatCredits(configured)}. `
                : ''}
              {isAdmin
                ? 'As a BOE Credits administrator you can award a different amount, up to two decimal places. '
                : 'Only a BOE Credits administrator can change the amount. '}
              The credits go to {employee}, not to you, and count toward their monthly review target.
              Approving is final and pays once.
            </p>
          </section>
        )}

        {pending && !own && rejecting && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>Reason for rejecting</span>
            <textarea
              value={reason}
              rows={3}
              maxLength={MAX_REJECTION_REASON_LENGTH}
              disabled={busy}
              autoFocus
              placeholder="e.g. The screenshot does not show a published review"
              onChange={e => { setReason(e.target.value); setError(null) }}
              style={{
                width: '100%', padding: '9px 11px', borderRadius: '8px', fontSize: '13.5px', resize: 'vertical',
                border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
                fontFamily: 'inherit', boxSizing: 'border-box', minHeight: '80px',
              }}
            />
            <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
              The employee sees this reason and can correct the review and reapply it. No credits are awarded.
            </span>
          </label>
        )}
      </div>
    </ReviewSheet>
  )
}
