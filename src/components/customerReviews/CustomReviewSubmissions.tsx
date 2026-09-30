'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FileText, Image as ImageIcon, ImagePlus, Pencil, RotateCcw, Trash2, Upload } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'
import { colors } from '@/lib/tokens'
import { istDateOf, istToday } from '@/lib/istDate'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { DEFAULT_BOE_CREDIT_SETTINGS, parseBoeCreditSettingsRow } from '@/lib/boeCredits/settings'
import type { BoeCreditSettings, CreditReviewMonth } from '@/lib/boeCredits/types'
import {
  TEST_SCREENSHOT_ACCEPT,
  TEST_SCREENSHOT_TYPES_LABEL,
  validateTestScreenshot,
} from '@/lib/customerReviews/photos'
import {
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_STATUS_META,
  APPROVED_EDIT_NOTICE,
  MAX_CANDIDATE_NOTE_LENGTH,
  MAX_CUSTOM_REMARK_LENGTH,
  MAX_REVIEWER_NAME_LENGTH,
  MAX_REVIEW_TEXT_LENGTH,
  canDeleteSubmission,
  canEditSubmission,
  canReapplySubmission,
  deleteConfirmationText,
  editSendsBackForApproval,
  formatSubmissionDay,
  parseCustomReapplicationInput,
  parseCustomSubmissionInput,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'
import {
  istMonthBoundsUtc,
  istMonthOf,
  monthRulesFromSettings,
  previousMonth,
  reapplicationIssue,
  submissionAllowance,
  summarizeCustomReviewMonth,
  usageForMonth,
  type SubmissionAllowance,
} from '@/lib/customerReviews/customMonthlyRules'
import { REVIEW_TYPE_META, type ReviewType } from '@/lib/customerReviews/types'
import {
  DUPLICATE_REASON_LABELS,
  DUPLICATE_UNAVAILABLE_TITLE,
  DUPLICATE_WARNING_TITLE,
  type EmployeeDuplicateView,
} from '@/lib/customerReviews/duplicateDetection'
import { REVIEW_LEADERBOARD_KEY, REVIEW_LEADER_CARD_KEY } from '@/lib/customerReviews/reviewReport'
import { CUSTOM_REVIEW_PENDING_COUNT_KEY } from '@/hooks/queries/useCustomReviewPendingCount'
import { usePublishSubmitControl } from './CustomReviewSubmitControl'
import { submitAvailability } from '@/lib/customerReviews/submitAvailability'
import { ReviewBadge } from './ReviewPieces'
import { ReviewSheet } from './ReviewSheet'
import {
  CustomSubmissionFacts,
  CustomSubmissionProof,
  CustomSubmissionTrail,
  formatSubmissionMoment,
} from './CustomSubmissionPieces'
import { CurrentMonthPanel, LastMonthPanel, ReviewRewardRules } from './CustomReviewPerformance'

// ── Custom Reviews, on the employee's own screen ─────────────────────────────
//
// A review the employee arranged THEMSELVES, handed over as proof. During the
// Custom Review phase this is the whole of a candidate's Review Workflow.
//
// ONE PRIMARY ACTION — Submit Custom Review — with the reward rules beside it,
// then where the employee stands this month and last month, then their own
// submissions. A rejected review shows why and offers Edit & Reapply, which
// sends the SAME review back for approval.
//
// THE BROWSER DECIDES NOTHING THAT MATTERS. It explains the monthly rules
// before an upload (customMonthlyRules.ts); the route and the database apply
// them again, under a lock, and are what decide. No credit is awarded here.
// Every read is this employee's own RLS.

type MonthRow = Pick<CreditReviewMonth, 'review_month' | 'minimum_reviews_snapshot' | 'qualifying_review_count' | 'earned_review_credits' | 'status' | 'finalized_at'>

const MONTH_COLUMNS = 'review_month, minimum_reviews_snapshot, qualifying_review_count, earned_review_credits, status, finalized_at'

type FormState = { mode: 'new' } | { mode: 'reapply'; row: CustomReviewSubmission } | { mode: 'edit'; row: CustomReviewSubmission }

export function CustomReviewSubmissions({
  supabase, profileId, canSubmit,
}: {
  supabase: SupabaseClient
  profileId: string
  /** customer_review_requests.use — the route and the database ask again. */
  canSubmit: boolean
}) {
  const queryClient = useQueryClient()
  const [history, setHistory] = useState<CustomReviewSubmission[]>([])
  const [recent, setRecent] = useState<CustomReviewSubmission[]>([])
  const [months, setMonths] = useState<MonthRow[]>([])
  const [settings, setSettings] = useState<BoeCreditSettings>(DEFAULT_BOE_CREDIT_SETTINGS)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [viewing, setViewing] = useState<CustomReviewSubmission | null>(null)
  const [deleting, setDeleting] = useState<CustomReviewSubmission | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const thisMonth = istMonthOf(new Date())
  const lastMonth = previousMonth(thisMonth)

  const load = useCallback(async () => {
    const current = istMonthOf(new Date())
    const previous = previousMonth(current)
    const [historyRes, recentRes, monthsRes, settingsRes] = await Promise.all([
      supabase
        .from('customer_review_custom_submissions')
        .select(CUSTOM_SUBMISSION_COLUMNS)
        .eq('submitted_by', profileId)
        .is('deleted_at', null)
        .order('submitted_at', { ascending: false })
        .limit(50),
      // Every row of this month and last — the counts must not be cut off by the
      // list's limit. The monthly cap keeps this small.
      supabase
        .from('customer_review_custom_submissions')
        .select(CUSTOM_SUBMISSION_COLUMNS)
        .eq('submitted_by', profileId)
        .is('deleted_at', null)
        .gte('submitted_at', istMonthBoundsUtc(previous).from),
      supabase
        .from('boe_credit_review_months')
        .select(MONTH_COLUMNS)
        .eq('employee_id', profileId)
        .in('review_month', [current, previous]),
      supabase
        .from('boe_credit_settings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (historyRes.error || recentRes.error) {
      setLoadError('Your custom reviews could not be loaded. Refresh to try again.')
      setLoaded(true)
      return
    }
    setLoadError(null)
    const found = (historyRes.data ?? []) as unknown as CustomReviewSubmission[]
    setHistory(found)
    setRecent((recentRes.data ?? []) as unknown as CustomReviewSubmission[])
    if (!monthsRes.error) setMonths((monthsRes.data ?? []) as unknown as MonthRow[])
    if (!settingsRes.error && settingsRes.data) {
      const parsed = parseBoeCreditSettingsRow(settingsRes.data as Record<string, unknown>)
      if (parsed.ok) setSettings(parsed.settings)
    }
    setLoaded(true)

    // Who rejected, where a name can be read. A name that cannot be read is
    // simply not shown.
    const ids = [...new Set(found.map(r => r.rejected_by).filter((v): v is string => !!v))]
    if (ids.length > 0) {
      const { data: people } = await supabase.from('users').select('id, full_name').in('id', ids)
      const named = (people ?? []) as unknown as { id: string; full_name: string | null }[]
      setNames(new Map(named.filter(p => p.full_name).map(p => [p.id, p.full_name as string])))
    }
  }, [supabase, profileId])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const rules = useMemo(() => monthRulesFromSettings(settings), [settings])
  const currentSummary = useMemo(() => summarizeCustomReviewMonth({
    month: thisMonth, rows: recent, rules, monthRow: months.find(m => m.review_month === thisMonth) ?? null,
  }), [thisMonth, recent, rules, months])
  const lastSummary = useMemo(() => summarizeCustomReviewMonth({
    month: lastMonth, rows: recent, rules, monthRow: months.find(m => m.review_month === lastMonth) ?? null,
  }), [lastMonth, recent, rules, months])
  const allowance = useMemo(
    () => submissionAllowance({ submitted: currentSummary.submitted, imageReviews: currentSummary.imageReviews }, rules),
    [currentSummary, rules],
  )

  const reapplyTypeIssue = useCallback((row: CustomReviewSubmission, nextType: ReviewType): string | null => {
    // Rows from the review's own month; the database counts again, whatever month it is.
    const pool = [...new Map([...recent, ...history].map(r => [r.id, r])).values()]
    const usage = usageForMonth(pool, istMonthOf(row.submitted_at), row.id)
    return reapplicationIssue(usage, row.review_type, nextType, rules)
  }, [recent, history, rules])

  const rejected = history.filter(r => r.status === 'rejected')

  // ONE availability for both entry points (this section's button and the page header's).
  const availability = useMemo(() => submitAvailability({
    loaded, loadError, canSubmitAny: allowance.canSubmitAny, limitMessage: allowance.limitMessage,
  }), [loaded, loadError, allowance.canSubmitAny, allowance.limitMessage])
  const openNew = useCallback(() => { setNotice(null); setForm({ mode: 'new' }) }, [])
  usePublishSubmitControl(availability, openNew)

  const afterChange = async (message: string) => {
    setForm(null)
    setNotice(message)
    // A submission or a reapplication adds to the reviewers' pending queue.
    void queryClient.invalidateQueries({ queryKey: CUSTOM_REVIEW_PENDING_COUNT_KEY })
    // Every change here can move an eligible count (an edit of an approved review
    // holds it, a delete withdraws it), so the mounted leaderboards refetch now:
    // the landing panel and the past-months page (prefix match) and the dashboard card.
    void queryClient.invalidateQueries({ queryKey: REVIEW_LEADERBOARD_KEY })
    void queryClient.invalidateQueries({ queryKey: REVIEW_LEADER_CARD_KEY })
    await load()
  }

  return (
    <section aria-labelledby="custom-reviews-heading" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 id="custom-reviews-heading" style={{
            margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: colors.primary,
          }}>
            Custom Reviews
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
            A review you arranged yourself. BOE Credits are awarded once it is approved.
          </p>
        </div>
        {canSubmit && (
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            disabled={availability.status !== 'ready'}
            onClick={openNew}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '13px', minHeight: '44px' }}
          >
            <Upload size={14} strokeWidth={2.2} />
            Submit Custom Review
          </button>
        )}
      </header>

      <ReviewRewardRules settings={settings} />

      {canSubmit && loaded && allowance.limitMessage && (
        <p role="note" style={{ margin: 0, fontSize: '12.5px', color: '#92400E', fontWeight: 600 }}>{allowance.limitMessage}</p>
      )}
      {notice && (
        <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>{notice}</p>
      )}
      {loadError && (
        <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{loadError}</p>
      )}

      {loaded && !loadError && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          <CurrentMonthPanel summary={currentSummary} allowance={allowance} settings={settings} />
          <LastMonthPanel summary={lastSummary} />
        </div>
      )}

      {rejected.length > 0 && (
        <p role="note" style={{
          margin: 0, padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
          border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C',
        }}>
          {rejected.length === 1 ? '1 rejected review needs' : `${rejected.length} rejected reviews need`} your correction.
          Open Edit &amp; Reapply to fix it and send the same review back for approval.
        </p>
      )}

      <h3 style={{ margin: '4px 0 0', fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: colors.secondary }}>
        Your submissions
      </h3>

      {!loaded ? (
        <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Loading your custom reviews…</p>
      ) : history.length === 0 ? (
        <p style={{
          margin: 0, padding: '14px 16px', borderRadius: '8px', fontSize: '12px',
          border: `1px dashed ${colors.border}`, color: colors.muted,
        }}>
          No custom reviews submitted yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {history.map(row => (
            <SubmissionRow
              key={row.id}
              row={row}
              rejectedBy={row.rejected_by ? names.get(row.rejected_by) ?? null : null}
              canReapply={canSubmit && canReapplySubmission(row, profileId)}
              canEdit={canSubmit && canEditSubmission(row, profileId)}
              canDelete={canSubmit && canDeleteSubmission(row, profileId)}
              onView={() => setViewing(row)}
              onReapply={() => { setNotice(null); setForm({ mode: 'reapply', row }) }}
              onEdit={() => { setNotice(null); setForm({ mode: 'edit', row }) }}
              onDelete={() => { setNotice(null); setDeleting(row) }}
            />
          ))}
        </ul>
      )}

      {form && (
        <CustomReviewFormSheet
          form={form}
          supabase={supabase}
          allowance={allowance}
          reapplyTypeIssue={reapplyTypeIssue}
          onClose={() => setForm(null)}
          onDone={afterChange}
        />
      )}

      {deleting && (
        <DeleteConfirmSheet
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={async message => { setDeleting(null); await afterChange(message) }}
        />
      )}

      {viewing && (
        <ReviewSheet
          title={CUSTOM_REVIEW_TYPE_LABELS[viewing.review_type]}
          subtitle={`${viewing.submission_ref} · ${CUSTOM_SUBMISSION_STATUS_META[viewing.status].label}`}
          maxWidth="640px"
          onClose={() => setViewing(null)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <CustomSubmissionProof
              key={viewing.proof_storage_path}
              supabase={supabase}
              path={viewing.proof_storage_path}
              alt={`Proof for ${viewing.submission_ref}`}
            />
            <CustomSubmissionFacts row={viewing} names={undefined} />
            <CustomSubmissionTrail supabase={supabase} submissionId={viewing.id} viewerId={profileId} names={names} />
          </div>
        </ReviewSheet>
      )}
    </section>
  )
}

function SubmissionRow({
  row, rejectedBy, canReapply, canEdit, canDelete, onView, onReapply, onEdit, onDelete,
}: {
  row: CustomReviewSubmission
  rejectedBy: string | null
  canReapply: boolean
  canEdit: boolean
  canDelete: boolean
  onView: () => void
  onReapply: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const Icon = row.review_type === 'image' ? ImageIcon : FileText
  return (
    <li style={{
      padding: '12px 14px', borderRadius: '10px', background: colors.base,
      border: `1px solid ${row.status === 'rejected' ? '#FECACA' : colors.borderSoft}`,
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px',
    }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Icon size={14} strokeWidth={2.2} style={{ color: REVIEW_TYPE_META[row.review_type].color, flexShrink: 0 }} />
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
            {CUSTOM_REVIEW_TYPE_LABELS[row.review_type]}
          </span>
          <ReviewBadge meta={CUSTOM_SUBMISSION_STATUS_META[row.status]} />
          {row.reapplication_count > 0 && row.status === 'pending_verification' && (
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#3B5BC0' }}>Reapplied</span>
          )}
          {row.edit_count > 0 && (
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#3B5BC0' }}>
              {row.reward_held ? 'Edited · Pending Approval again · credit on hold' : 'Edited'}
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
          {row.submission_ref} · Published {formatSubmissionDay(row.published_on)} · Submitted {formatSubmissionDay(istDateOf(row.submitted_at))}
        </div>
        {row.status === 'rejected' && (
          <div style={{ fontSize: '12px', color: '#B91C1C', marginTop: '4px', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
            Rejected {formatSubmissionMoment(row.rejected_at)}{rejectedBy ? ` by ${rejectedBy}` : ''}
            {row.rejection_reason ? <> — {row.rejection_reason}</> : null}
          </div>
        )}
      </div>
      {row.status === 'approved' && row.credits_awarded != null && (
        <span style={{ fontSize: '14px', fontWeight: 700, color: '#047857', fontVariantNumeric: 'tabular-nums' }}>
          {formatCredits(Number(row.credits_awarded), { signed: true })}
        </span>
      )}
      {row.reward_held && row.credits_awarded != null && (
        <span
          title="Still in your BOE Credits balance. It does not count towards the leaderboard while the review is pending."
          style={{ fontSize: '12px', fontWeight: 600, color: '#92400E', maxWidth: '190px', lineHeight: 1.4 }}
        >
          {formatCredits(Number(row.credits_awarded))} on hold — still in your balance until it is decided
        </span>
      )}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="boe-btn boe-btn-ghost"
          onClick={onView}
          style={{ padding: '7px 12px', fontSize: '12px', minHeight: '44px' }}
        >
          View Proof
        </button>
        {canReapply && (
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            onClick={onReapply}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '7px 12px', fontSize: '12px', minHeight: '44px' }}
          >
            <RotateCcw size={13} strokeWidth={2.2} />
            Edit &amp; Reapply
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            onClick={onEdit}
            aria-label={`Edit ${row.submission_ref}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '7px 12px', fontSize: '12px', minHeight: '44px' }}
          >
            <Pencil size={13} strokeWidth={2.2} />
            Edit
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            onClick={onDelete}
            aria-label={`Delete ${row.submission_ref}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '7px 12px', fontSize: '12px', minHeight: '44px', color: '#B91C1C' }}
          >
            <Trash2 size={13} strokeWidth={2.2} />
            Delete
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * The short confirmation before a delete. The ref stops a double click; the
 * database makes a repeat harmless (already_deleted, one reversal).
 */
function DeleteConfirmSheet({
  row, onClose, onDone,
}: {
  row: CustomReviewSubmission
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const acting = useRef(false)

  const confirm = async () => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/customer-reviews/custom-submissions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: row.id }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'That review could not be deleted. Try again.')
        return
      }
      const reversed = Number(payload?.credits_reversed ?? 0)
      await onDone(reversed > 0
        ? `${row.submission_ref} deleted. ${formatCredits(reversed)} was taken back.`
        : `${row.submission_ref} deleted.`)
    } catch {
      setError('That review could not be deleted. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  return (
    <ReviewSheet
      title="Delete review"
      subtitle={row.submission_ref}
      maxWidth="440px"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose() }}
      footer={
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={busy}
            style={{ padding: '8px 14px', fontSize: '13px', minHeight: '44px' }}>
            Cancel
          </button>
          <button type="button" className="boe-btn boe-btn-primary" onClick={() => { void confirm() }} disabled={busy}
            style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px', background: '#B91C1C', borderColor: '#B91C1C' }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {error && <p role="alert" style={{ fontSize: '12.5px', color: colors.red, margin: 0 }}>{error}</p>}
        <p style={{ margin: 0, fontSize: '13px', color: colors.primary, lineHeight: 1.6 }}>
          {deleteConfirmationText(row)}
        </p>
      </div>
    </ReviewSheet>
  )
}

/**
 * The inline duplicate warning: an amber icon, the plain reason, and who it
 * concerns. It names REASON CATEGORIES only. For another employee's review it
 * says nothing about which review, who wrote it, or when; for the employee's own
 * earlier review it gives its reference. Nothing is sent as a notification.
 */
function DuplicateWarning({ view }: { view: EmployeeDuplicateView }) {
  const unavailable = view.status === 'unavailable'
  return (
    <section
      role="alert"
      aria-labelledby="duplicate-warning-title"
      style={{
        display: 'flex', gap: '10px', alignItems: 'flex-start',
        padding: '11px 13px', borderRadius: '10px',
        border: '1px solid #FDE68A', background: '#FFFBEB', color: '#92400E',
      }}
    >
      <AlertTriangle size={18} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px', color: '#D97706' }} />
      <div style={{ minWidth: 0, fontSize: '12.5px', lineHeight: 1.55 }}>
        <div id="duplicate-warning-title" style={{ fontWeight: 700 }}>
          {unavailable ? DUPLICATE_UNAVAILABLE_TITLE : DUPLICATE_WARNING_TITLE}
        </div>
        {unavailable ? (
          <p style={{ margin: '3px 0 0' }}>
            We could not check this review against earlier ones, so it is not confirmed as unique.
            You can edit it, cancel, or submit anyway; a reviewer will see that the check did not run.
          </p>
        ) : (
          <>
            <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
              {view.reasons.map(reason => <li key={reason}>{DUPLICATE_REASON_LABELS[reason]}</li>)}
            </ul>
            {view.items.some(i => i.scope === 'yours') && (
              <p style={{ margin: '4px 0 0' }}>
                Matches your own earlier {view.items.filter(i => i.scope === 'yours').length === 1 ? 'review' : 'reviews'}
                {view.items.filter(i => i.scope === 'yours' && i.ref).length > 0
                  ? ` (${view.items.filter(i => i.scope === 'yours' && i.ref).map(i => i.ref).join(', ')})`
                  : ''}.
              </p>
            )}
            {view.items.some(i => i.scope === 'another_employee') && (
              <p style={{ margin: '4px 0 0' }}>Matches a review already in the system.</p>
            )}
            <p style={{ margin: '4px 0 0' }}>
              Edit it, cancel, or submit anyway. A reviewer decides; nothing is rejected automatically.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

const labelStyle: React.CSSProperties = { fontSize: '12.5px', fontWeight: 600, color: colors.primary }
const hintStyle: React.CSSProperties = { fontSize: '11px', color: colors.muted, lineHeight: 1.5 }
const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px' }
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', borderRadius: '8px', fontSize: '13.5px', minHeight: '44px',
  border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
  fontFamily: 'inherit', boxSizing: 'border-box',
}

/**
 * Submit Custom Review, or Reapply for Approval — one form, because they ask
 * for the same things. A reapplication starts from the rejected review's own
 * values, keeps its screenshot unless a new one is chosen, and may carry a note.
 */
function CustomReviewFormSheet({
  form, supabase, allowance, reapplyTypeIssue, onClose, onDone,
}: {
  form: FormState
  supabase: SupabaseClient
  allowance: SubmissionAllowance
  reapplyTypeIssue: (row: CustomReviewSubmission, nextType: ReviewType) => string | null
  onClose: () => void
  onDone: (message: string) => Promise<void>
}) {
  const today = istToday()
  const original = form.mode === 'reapply' ? form.row : null
  const editing = form.mode === 'edit' ? form.row : null
  const source = original ?? editing
  const lockedType = editing != null && editSendsBackForApproval(editing)
  const [reviewType, setReviewType] = useState<ReviewType | null>(source?.review_type ?? null)
  const [publishedOn, setPublishedOn] = useState(source?.published_on ?? '')
  const [remark, setRemark] = useState(source?.remark ?? '')
  const [reviewerName, setReviewerName] = useState(source?.reviewer_name ?? '')
  const [reviewText, setReviewText] = useState(source?.review_text ?? '')
  // The inline duplicate warning: what the server found, and the token "Submit anyway" must echo.
  const [warning, setWarning] = useState<{ view: EmployeeDuplicateView; token: string } | null>(null)
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // State is too slow to stop a double click; the ref stops the second request,
  // and the database refuses the same screenshot twice whatever raced.
  const submitting = useRef(false)
  const previewUrl = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // The preview is a local object URL of the chosen file — nothing is uploaded
  // until the form is sent. Released when the sheet closes.
  useEffect(() => () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
  }, [])

  /** Why this type cannot be chosen, or null. */
  const typeIssue = (type: ReviewType): string | null => {
    if (lockedType && editing) {
      return type === editing.review_type ? null : 'The type of an approved review cannot change. Delete it and submit a new review instead.'
    }
    if (original) return reapplyTypeIssue(original, type)
    if (editing) return type === editing.review_type ? null : reapplyTypeIssue(editing, type)
    if (type === 'text') return allowance.canSubmitText ? null : allowance.textBlockedMessage
    return allowance.canSubmitImage ? null : allowance.limitMessage
  }
  const blockedMessage = typeIssue('text') ?? typeIssue('image')

  const choose = (files: FileList | null) => {
    const next = files?.[0] ?? null
    setError(null)
    if (!next) return
    // A courtesy check, not the boundary: the route decodes the bytes.
    const invalid = validateTestScreenshot(next)
    if (invalid) {
      setError(invalid)
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    const url = URL.createObjectURL(next)
    previewUrl.current = url
    setFile(next)
    setPreview(url)
    setWarning(null)
  }

  const submit = async (acknowledge?: string) => {
    if (submitting.current) return
    if (reviewType && typeIssue(reviewType)) { setError(typeIssue(reviewType)); return }

    const body = new FormData()
    if (editing) {
      const parsed = parseCustomSubmissionInput({ reviewType, publishedOn, remark, hasProof: true }, today)
      if (!parsed.ok) { setError(parsed.issues[0].message); return }
      body.append('submissionId', editing.id)
      body.append('expectedEditCount', String(editing.edit_count))
      body.append('reviewType', parsed.value.reviewType)
      body.append('publishedOn', parsed.value.publishedOn)
      if (parsed.value.remark) body.append('remark', parsed.value.remark)
      if (file) body.append('file', file)
    } else if (original) {
      const parsed = parseCustomReapplicationInput({ reviewType, publishedOn, remark, note }, today)
      if (!parsed.ok) { setError(parsed.issues[0].message); return }
      body.append('submissionId', original.id)
      body.append('reviewType', parsed.value.reviewType)
      body.append('publishedOn', parsed.value.publishedOn)
      if (parsed.value.remark) body.append('remark', parsed.value.remark)
      if (parsed.value.note) body.append('note', parsed.value.note)
      if (file) body.append('file', file)
    } else {
      const parsed = parseCustomSubmissionInput({ reviewType, publishedOn, remark, hasProof: file !== null }, today)
      if (!parsed.ok || !file) {
        setError(parsed.ok ? 'Upload a screenshot of the published review.' : parsed.issues[0].message)
        return
      }
      body.append('reviewType', parsed.value.reviewType)
      body.append('publishedOn', parsed.value.publishedOn)
      if (parsed.value.remark) body.append('remark', parsed.value.remark)
      body.append('file', file)
    }

    body.append('reviewerName', reviewerName.trim())
    body.append('reviewText', reviewText.trim())
    if (acknowledge) body.append('acknowledgeDuplicate', acknowledge)

    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const response = editing
        ? await fetch('/api/customer-reviews/custom-submissions', { method: 'PUT', body })
        : original
          ? await fetch('/api/customer-reviews/custom-submissions', { method: 'PATCH', body })
          : await fetch('/api/customer-reviews/custom-submissions', { method: 'POST', body })
      const payload = await response.json().catch(() => null)
      if (response.status === 409 && payload?.code === 'possible_duplicate' && payload?.duplicate) {
        // Nothing was saved. The employee edits, cancels, or chooses Submit anyway.
        setWarning({ view: payload.duplicate as EmployeeDuplicateView, token: String(payload.token ?? '') })
        return
      }
      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'That submission could not be saved. Try again.')
        return
      }
      if (editing) {
        await onDone(payload?.unchanged
          ? `${editing.submission_ref} was not changed.`
          : payload?.sent_back_for_approval
            ? `${editing.submission_ref} saved. It is Pending Approval again; your credits stay as they are meanwhile.`
            : `${editing.submission_ref} saved. Its submission date and monthly slot did not change.`)
        return
      }
      await onDone(original
        ? (payload?.already_pending
            ? `${original.submission_ref} is already waiting for approval.`
            : `${original.submission_ref} reapplied. It is Pending Approval again, and still uses one monthly slot.`)
        : 'Submitted for approval. It is listed below as Pending Approval.')
    } catch {
      setError('That submission could not be saved. Check your connection and try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <ReviewSheet
      title={editing ? 'Edit Custom Review' : original ? 'Reapply for Approval' : 'Submit Custom Review'}
      subtitle={editing
        ? `${editing.submission_ref} · submitted ${formatSubmissionDay(istDateOf(editing.submitted_at))}`
        : original ? `${original.submission_ref} · correct it and send the same review back` : 'Proof that a review you arranged was published'}
      maxWidth="560px"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose() }}
      footer={
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="boe-btn boe-btn-ghost"
            onClick={onClose}
            disabled={busy}
            style={{ padding: '8px 14px', fontSize: '13px', minHeight: '44px' }}
          >
            Cancel
          </button>
          {warning ? (
            <>
              <button
                type="button"
                className="boe-btn boe-btn-ghost"
                onClick={() => setWarning(null)}
                disabled={busy}
                style={{ padding: '8px 14px', fontSize: '13px', minHeight: '44px' }}
              >
                Edit review
              </button>
              <button
                type="button"
                className="boe-btn boe-btn-primary"
                onClick={() => { void submit(warning.token) }}
                disabled={busy}
                style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px' }}
              >
                {busy ? 'Sending…' : 'Submit anyway'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="boe-btn boe-btn-primary"
              onClick={() => { void submit() }}
              disabled={busy}
              style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px' }}
            >
              {busy ? (editing ? 'Saving…' : 'Sending…') : editing ? 'Save Changes' : original ? 'Reapply for Approval' : 'Submit for Approval'}
            </button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {original && (
          <section style={{
            padding: '10px 12px', borderRadius: '9px', border: '1px solid #FECACA', background: '#FEF2F2',
            fontSize: '12.5px', color: '#B91C1C', lineHeight: 1.55, overflowWrap: 'anywhere',
          }}>
            <strong>Rejected {formatSubmissionMoment(original.rejected_at)}</strong>
            {original.rejection_reason ? <div>{original.rejection_reason}</div> : null}
          </section>
        )}

        {editing && lockedType && (
          <p role="note" style={{
            margin: 0, padding: '10px 12px', borderRadius: '9px', border: '1px solid #FDE68A', background: '#FFFBEB',
            fontSize: '12.5px', color: '#92400E', lineHeight: 1.55,
          }}>
            {APPROVED_EDIT_NOTICE}
          </p>
        )}

        {warning && <DuplicateWarning view={warning.view} />}

        {error && (
          <p role="alert" style={{ fontSize: '12.5px', color: colors.red, margin: 0 }}>{error}</p>
        )}

        <div style={fieldStyle}>
          <span id="custom-review-type-label" style={labelStyle}>Review Type</span>
          <div
            role="radiogroup"
            aria-labelledby="custom-review-type-label"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px' }}
          >
            {(['text', 'image'] as const).map(type => {
              const selected = reviewType === type
              const meta = REVIEW_TYPE_META[type]
              const Icon = type === 'image' ? ImageIcon : FileText
              const unavailable = typeIssue(type) != null
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={unavailable}
                  disabled={busy || unavailable}
                  onClick={() => { setReviewType(type); setError(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                    minHeight: '44px', padding: '8px 10px', borderRadius: '9px',
                    fontSize: '13px', fontWeight: 600, fontFamily: 'inherit',
                    cursor: busy || unavailable ? 'not-allowed' : 'pointer',
                    opacity: unavailable ? 0.5 : 1,
                    border: `1px solid ${selected ? meta.color : colors.borderSoft}`,
                    background: selected ? meta.bg : colors.base,
                    color: selected ? meta.color : colors.secondary,
                  }}
                >
                  <Icon size={14} strokeWidth={2.2} />
                  {CUSTOM_REVIEW_TYPE_LABELS[type]}
                </button>
              )
            })}
          </div>
          {blockedMessage && (
            <span style={{ fontSize: '12px', color: '#92400E', lineHeight: 1.5 }}>{blockedMessage}</span>
          )}
        </div>

        <label style={fieldStyle}>
          <span style={labelStyle}>Review Published On</span>
          <input
            type="date"
            value={publishedOn}
            max={today}
            disabled={busy}
            onChange={e => { setPublishedOn(e.target.value); setError(null) }}
            style={inputStyle}
          />
        </label>

        <label style={fieldStyle}>
          <span style={labelStyle}>Reviewer name <span style={{ fontWeight: 400, color: colors.muted }}>(optional)</span></span>
          <input
            type="text"
            value={reviewerName}
            maxLength={MAX_REVIEWER_NAME_LENGTH}
            disabled={busy}
            autoComplete="off"
            placeholder="The customer's name as shown on the review"
            onChange={e => { setReviewerName(e.target.value); setWarning(null); setError(null) }}
            style={inputStyle}
          />
        </label>

        <label style={fieldStyle}>
          <span style={labelStyle}>Review text <span style={{ fontWeight: 400, color: colors.muted }}>(optional)</span></span>
          <textarea
            value={reviewText}
            rows={4}
            maxLength={MAX_REVIEW_TEXT_LENGTH}
            disabled={busy}
            placeholder="Paste the review as it was published"
            onChange={e => { setReviewText(e.target.value); setWarning(null); setError(null) }}
            style={{ ...inputStyle, minHeight: '96px', resize: 'vertical' }}
          />
          <span style={hintStyle}>
            Helps us notice when the same review is submitted twice. It is checked against earlier reviews; you never see anyone else&rsquo;s.
          </span>
        </label>

        <div style={fieldStyle}>
          <span style={labelStyle}>
            Screenshot / Proof{source && <span style={{ fontWeight: 400, color: colors.muted }}> (optional — the current one is kept)</span>}
          </span>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Screenshot preview"
              style={{
                width: '100%', maxHeight: '260px', objectFit: 'contain', borderRadius: '9px',
                border: `1px solid ${colors.border}`, background: colors.float,
              }}
            />
          ) : source ? (
            <CustomSubmissionProof
              key={source.proof_storage_path}
              supabase={supabase}
              path={source.proof_storage_path}
              alt={`Current proof for ${source.submission_ref}`}
            />
          ) : null}
          <input
            ref={inputRef}
            id="custom-review-proof-input"
            type="file"
            accept={TEST_SCREENSHOT_ACCEPT}
            disabled={busy}
            onChange={e => choose(e.target.files)}
            style={{ display: 'none' }}
          />
          <label
            htmlFor="custom-review-proof-input"
            className="boe-btn boe-btn-ghost"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px', alignSelf: 'flex-start',
              padding: '7px 14px', fontSize: '12px', minHeight: '44px',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            <ImagePlus size={14} strokeWidth={2} />
            {file || source ? 'Replace screenshot' : 'Upload screenshot'}
          </label>
          <span style={hintStyle}>
            {TEST_SCREENSHOT_TYPES_LABEL}, up to 5 MB. Only you and a reviewer can see it.
          </span>
        </div>

        <label style={fieldStyle}>
          <span style={labelStyle}>Remark <span style={{ fontWeight: 400, color: colors.muted }}>(optional)</span></span>
          <input
            type="text"
            value={remark}
            maxLength={MAX_CUSTOM_REMARK_LENGTH}
            disabled={busy}
            placeholder="Short context, e.g. where it was posted"
            onChange={e => { setRemark(e.target.value); setError(null) }}
            style={inputStyle}
          />
        </label>

        {original && (
          <label style={fieldStyle}>
            <span style={labelStyle}>What did you change? <span style={{ fontWeight: 400, color: colors.muted }}>(optional)</span></span>
            <textarea
              value={note}
              rows={3}
              maxLength={MAX_CANDIDATE_NOTE_LENGTH}
              disabled={busy}
              placeholder="e.g. Uploaded the full screenshot showing the published review"
              onChange={e => { setNote(e.target.value); setError(null) }}
              style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
            />
            <span style={hintStyle}>The reviewer sees this note with your review.</span>
          </label>
        )}
      </div>
    </ReviewSheet>
  )
}
