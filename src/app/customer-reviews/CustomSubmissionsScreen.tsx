'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import { ReviewBadge } from '@/components/customerReviews/ReviewPieces'
import { CustomSubmissionFacts, CustomSubmissionProof } from '@/components/customerReviews/CustomSubmissionPieces'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { istDateOf } from '@/lib/istDate'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { REVIEW_TYPE_META } from '@/lib/customerReviews/types'
import {
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_STATUSES,
  CUSTOM_SUBMISSION_STATUS_META,
  MAX_REJECTION_REASON_LENGTH,
  approvalCreditsIssue,
  customSubmissionErrorMessage,
  formatSubmissionDay,
  rejectionReasonIssue,
  type CustomReviewSubmission,
  type CustomSubmissionStatus,
} from '@/lib/customerReviews/customSubmissions'

// ── Custom Submissions: the verifier's queue ─────────────────────────────────
//
// Reviews employees arranged themselves, with the screenshot that proves each
// was published. A separate workspace rather than a fifth tab on Reviews: the
// Reviews queue is the generated-review lifecycle (pending → available →
// booked → to verify), and a custom submission has none of those states.
//
// OPEN PROOF → VERIFY → APPROVE + CREDIT, OR REJECT + REASON.
//
// THE DATABASE DECIDES EVERYTHING THAT MATTERS. approve_customer_review_custom_
// submission() and reject_…() take their actor from auth.uid(), resolve
// `verify`, refuse the submitter's own row, lock the submission, and post the
// credit exactly once. This screen only shows the amount they will post: the
// configured reward for the review type, which a verifier confirms and only a
// BOE Credits administrator may change (the function enforces that too).

type Rewards = { text: number; image: number }

export function CustomSubmissionsScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()

  const [status, setStatus] = useState<CustomSubmissionStatus>('pending_verification')
  const [rows, setRows] = useState<CustomReviewSubmission[]>([])
  const [loadedStatus, setLoadedStatus] = useState<CustomSubmissionStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [rewards, setRewards] = useState<Rewards | null>(null)
  const [opened, setOpened] = useState<CustomReviewSubmission | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // A response for a tab somebody already left must not overwrite the one they are on.
  const loadTicket = useRef(0)

  useEffect(() => {
    if (loading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [loading, caps.canVerify, router])

  const load = useCallback(async (which: CustomSubmissionStatus) => {
    const ticket = ++loadTicket.current
    const [list, pending] = await Promise.all([
      supabase
        .from('customer_review_custom_submissions')
        .select(CUSTOM_SUBMISSION_COLUMNS)
        .eq('status', which)
        // Oldest pending first — the queue is worked in order; decided ones newest first.
        .order('submitted_at', { ascending: which === 'pending_verification' })
        .limit(200),
      supabase
        .from('customer_review_custom_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_verification'),
    ])
    if (ticket !== loadTicket.current) return
    if (list.error) {
      setLoadError('Custom submissions could not be loaded. Refresh to try again.')
      setRows([])
      setLoadedStatus(which)
      return
    }
    const found = (list.data ?? []) as unknown as CustomReviewSubmission[]
    setLoadError(null)
    setRows(found)
    setLoadedStatus(which)
    setPendingCount(pending.error ? null : pending.count ?? null)

    const ids = [...new Set(found.flatMap(r => [r.submitted_by, r.approved_by, r.rejected_by]).filter((v): v is string => !!v))]
    if (ids.length === 0) return
    // id and full_name only — users has private columns (src/lib/users/safeColumns.ts).
    const { data: people } = await supabase.from('users').select('id, full_name').in('id', ids)
    if (ticket !== loadTicket.current) return
    const named = (people ?? []) as unknown as { id: string; full_name: string | null }[]
    setNames(new Map(named.map(p => [p.id, p.full_name ?? 'Unknown'])))
  }, [supabase])

  useEffect(() => {
    if (loading || !caps.canVerify) return
    const startFetch = () => { void load(status) }
    startFetch()
  }, [loading, caps.canVerify, status, load])

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

  if (loading) return <LoadingScreen />

  const listLoading = loadedStatus !== status

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Custom Submissions"
      subtitle="Reviews employees arranged themselves"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '960px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {notice && (
          <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>{notice}</p>
        )}

        <div role="tablist" aria-label="Submission status" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {CUSTOM_SUBMISSION_STATUSES.map(s => {
            const active = s === status
            const meta = CUSTOM_SUBMISSION_STATUS_META[s]
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => { setStatus(s); setNotice(null) }}
                style={{
                  minHeight: '40px', padding: '7px 14px', borderRadius: '999px', fontFamily: 'inherit',
                  fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${active ? meta.border : colors.borderSoft}`,
                  background: active ? meta.bg : colors.base,
                  color: active ? meta.color : colors.secondary,
                }}
              >
                {meta.label}{s === 'pending_verification' && pendingCount != null ? ` · ${pendingCount}` : ''}
              </button>
            )
          })}
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
            {status === 'pending_verification'
              ? 'Nothing is waiting for verification.'
              : status === 'approved' ? 'No custom review has been approved yet.' : 'No custom review has been rejected.'}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {rows.map(row => (
              <li
                key={row.id}
                style={{
                  padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.borderSoft}`,
                  background: colors.base, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px',
                }}
              >
                <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13.5px', fontWeight: 700, color: colors.primary }}>
                      {names.get(row.submitted_by) ?? '…'}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: REVIEW_TYPE_META[row.review_type].color }}>
                      {CUSTOM_REVIEW_TYPE_LABELS[row.review_type]}
                    </span>
                    <ReviewBadge meta={CUSTOM_SUBMISSION_STATUS_META[row.status]} />
                  </div>
                  <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
                    {row.submission_ref} · Published {formatSubmissionDay(row.published_on)} · Submitted {formatSubmissionDay(istDateOf(row.submitted_at))}
                  </div>
                  {row.remark && (
                    <div style={{
                      fontSize: '12px', color: colors.tertiary, marginTop: '3px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {row.remark}
                    </div>
                  )}
                </div>
                {row.status === 'approved' && row.credits_awarded != null && (
                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#047857', fontVariantNumeric: 'tabular-nums' }}>
                    {formatCredits(Number(row.credits_awarded), { signed: true })}
                  </span>
                )}
                <button
                  type="button"
                  className={row.status === 'pending_verification' ? 'boe-btn boe-btn-primary' : 'boe-btn boe-btn-ghost'}
                  onClick={() => { setNotice(null); setOpened(row) }}
                  style={{ padding: '7px 14px', fontSize: '12.5px', minHeight: '44px' }}
                >
                  {row.status === 'pending_verification' ? 'Open & Verify' : 'Open'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {opened && (
        <DecisionSheet
          key={opened.id}
          row={opened}
          supabase={supabase}
          viewerId={profile?.id ?? null}
          isAdmin={profile?.role === 'admin'}
          names={names}
          rewards={rewards}
          onClose={() => setOpened(null)}
          onDecided={async message => {
            setOpened(null)
            setNotice(message)
            await load(status)
          }}
        />
      )}
    </CustomerReviewsLayout>
  )
}

function DecisionSheet({
  row, supabase, viewerId, isAdmin, names, rewards, onClose, onDecided,
}: {
  row: CustomReviewSubmission
  supabase: SupabaseClient
  viewerId: string | null
  /** A BOE Credits administrator may award a different amount; the function checks can_manage_boe_credits(). */
  isAdmin: boolean
  names: Map<string, string>
  rewards: Rewards | null
  onClose: () => void
  onDecided: (message: string) => Promise<void>
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

  const own = row.submitted_by === viewerId
  const pending = row.status === 'pending_verification'
  const employee = names.get(row.submitted_by) ?? 'the employee'
  const typeMeta = REVIEW_TYPE_META[row.review_type]

  // A verifier confirms the configured amount; an administrator may type another.
  const credits = isAdmin ? Number(creditsText.trim()) : configured
  const creditsIssue = isAdmin
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
      const result = data as { already_decided?: boolean; submission?: { credits_awarded?: unknown } } | null
      const awarded = Number(result?.submission?.credits_awarded ?? credits)
      await onDecided(result?.already_decided
        ? `${row.submission_ref} was already approved. Nothing more was awarded.`
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
      const result = data as { already_decided?: boolean } | null
      await onDecided(result?.already_decided
        ? `${row.submission_ref} was already rejected.`
        : `${row.submission_ref} rejected. No credits were awarded.`)
    } catch {
      setError('That submission could not be rejected. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  const buttonStyle: React.CSSProperties = { padding: '8px 16px', fontSize: '13px', minHeight: '44px' }

  const footer = pending && !own ? (
    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {rejecting ? (
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
      subtitle={`${row.submission_ref} · ${CUSTOM_SUBMISSION_STATUS_META[row.status].label}`}
      maxWidth="720px"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose() }}
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {error && (
          <p role="alert" style={{ fontSize: '12.5px', color: colors.red, margin: 0 }}>{error}</p>
        )}

        <CustomSubmissionProof
          supabase={supabase}
          path={row.proof_storage_path}
          alt={`Proof for ${row.submission_ref}`}
          large
        />

        <CustomSubmissionFacts row={row} names={names} />

        {pending && own && (
          <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
            You submitted this review, so another verifier must approve or reject it.
          </p>
        )}

        {pending && !own && !rejecting && (
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
                ? `The configured reward for a ${CUSTOM_REVIEW_TYPE_LABELS[row.review_type].toLowerCase()} is ${formatCredits(configured)}. `
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
              The employee sees this reason. No credits are awarded, and the submission is kept.
            </span>
          </label>
        )}
      </div>
    </ReviewSheet>
  )
}
