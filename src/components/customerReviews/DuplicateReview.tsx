'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import {
  DUPLICATE_REASON_LABELS,
  DUPLICATE_STRENGTH_LABELS,
  DUPLICATE_UNAVAILABLE_TITLE,
  DUPLICATE_WARNING_TITLE,
  describeEvidence,
  type DuplicateEvidence,
  type DuplicateReason,
  type DuplicateStrength,
} from '@/lib/customerReviews/duplicateDetection'
import {
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_STATUS_META,
  customSubmissionErrorMessage,
  formatSubmissionDay,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'
import { istDateOf } from '@/lib/istDate'
import { ReviewSheet } from './ReviewSheet'
import { CustomSubmissionProof, formatSubmissionMoment } from './CustomSubmissionPieces'

// The verifier's side of duplicate detection: a badge for the list and the
// detail, and a comparison of the two reviews with the evidence and the two
// decisions a verifier may record.
//
// READ UNDER RLS. The checks, the flags and the summary view are readable only by
// a holder of `verify`; the deleted reviews a flag may point at are readable by
// the same people. A decision is a database function (decide_customer_review_
// custom_duplicate), which refuses the review's own submitter and a flag from an
// older run. A decision changes no status and no credit.

export type DuplicateSummary = {
  submission_id: string
  check_status: 'clear' | 'flagged' | 'unavailable' | null
  flags_current: number
  flags_open: number
  decided_duplicate: number
  decided_different: number
}

export const DUPLICATE_SUMMARY_COLUMNS =
  'submission_id, check_status, flags_current, flags_open, decided_duplicate, decided_different'

export type DuplicateFlag = {
  id: string
  submission_id: string
  matched_submission_id: string
  content_fingerprint: string
  reasons: DuplicateReason[]
  strength: DuplicateStrength
  evidence: DuplicateEvidence
  employee_proceeded: boolean
  matched_was_deleted: boolean
  created_at: string
  decision: 'duplicate' | 'different' | null
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
}

const FLAG_COLUMNS =
  'id, submission_id, matched_submission_id, content_fingerprint, reasons, strength, evidence, employee_proceeded, matched_was_deleted, created_at, decision, decided_by, decided_at, decision_note'

/** What the list says about a review, in one pill; null when there is nothing to say. */
export function duplicateBadge(s: DuplicateSummary | undefined): { label: string; tone: 'amber' | 'red' | 'grey' } | null {
  if (!s) return null
  if (s.flags_open > 0) return { label: `${DUPLICATE_WARNING_TITLE} · awaiting decision`, tone: 'amber' }
  if (s.decided_duplicate > 0) return { label: 'Marked duplicate', tone: 'red' }
  if (s.check_status === 'unavailable') return { label: DUPLICATE_UNAVAILABLE_TITLE, tone: 'amber' }
  if (s.decided_different > 0) return { label: 'Checked · different review', tone: 'grey' }
  if (s.flags_current > 0) return { label: 'Weak name match', tone: 'grey' }
  return null
}

const TONES = {
  amber: { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  red:   { bg: '#FEF2F2', color: '#B91C1C', border: '#FECACA' },
  grey:  { bg: '#F3F4F6', color: '#4B5563', border: '#D1D5DB' },
} as const

export function DuplicateBadge({ summary }: { summary: DuplicateSummary | undefined }) {
  const badge = duplicateBadge(summary)
  if (!badge) return null
  const t = TONES[badge.tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
      background: t.bg, color: t.color, border: `1px solid ${t.border}`,
    }}>
      {badge.tone !== 'grey' && <AlertTriangle size={11} strokeWidth={2.4} aria-hidden="true" />}
      {badge.label}
    </span>
  )
}

/** One read of the summary view for the submissions on screen. A failure is "no badge", never "clear". */
export async function loadDuplicateSummaries(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, DuplicateSummary> | null> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from('customer_review_custom_duplicate_summary')
    .select(DUPLICATE_SUMMARY_COLUMNS)
    .in('submission_id', ids)
  if (error) return null
  return new Map(((data ?? []) as unknown as DuplicateSummary[]).map(r => [r.submission_id, r]))
}

// ─── The panel in the review's detail ─────────────────────────────────────────

export function DuplicatePanel({
  supabase, submission, viewerId, names, onChanged,
}: {
  supabase: SupabaseClient
  submission: CustomReviewSubmission
  viewerId: string | null
  names: Map<string, string>
  /** Called after a decision so the list badge and the open count refresh. */
  onChanged: () => void
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'ready'; status: 'clear' | 'flagged' | 'unavailable' | null; fingerprint: string | null; flags: DuplicateFlag[] }
  >({ kind: 'loading' })
  const [comparing, setComparing] = useState<DuplicateFlag | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    const startFetch = () => {
      void (async () => {
        const [checkRes, flagRes] = await Promise.all([
          supabase
            .from('customer_review_custom_duplicate_checks')
            .select('status, content_fingerprint, created_at')
            .eq('submission_id', submission.id)
            .order('seq', { ascending: false })
            .limit(1),
          supabase
            .from('customer_review_custom_duplicate_flags')
            .select(FLAG_COLUMNS)
            .eq('submission_id', submission.id)
            .order('created_at', { ascending: false }),
        ])
        if (!active) return
        if (checkRes.error || flagRes.error) { setState({ kind: 'error' }); return }
        const latest = ((checkRes.data ?? []) as unknown as { status: 'clear' | 'flagged' | 'unavailable'; content_fingerprint: string }[])[0]
        setState({
          kind: 'ready',
          status: latest?.status ?? null,
          fingerprint: latest?.content_fingerprint ?? null,
          flags: (flagRes.data ?? []) as unknown as DuplicateFlag[],
        })
      })()
    }
    startFetch()
    return () => { active = false }
  }, [supabase, submission.id, reload])

  if (state.kind === 'loading') return <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Checking for duplicates…</p>
  if (state.kind === 'error') {
    return (
      <p role="status" style={{ margin: 0, fontSize: '12px', color: '#92400E' }}>
        {DUPLICATE_UNAVAILABLE_TITLE}. The duplicate results could not be loaded.
      </p>
    )
  }

  const current = state.flags.filter(f => f.content_fingerprint === state.fingerprint)
  const earlier = state.flags.filter(f => f.content_fingerprint !== state.fingerprint)

  if (state.status === null) {
    return (
      <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>
        No duplicate check is on record for this review (it was submitted before duplicate checking).
      </p>
    )
  }
  if (state.status === 'clear' && state.flags.length === 0) {
    return <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>No possible duplicate was found when this review was checked.</p>
  }

  return (
    <section aria-label="Possible duplicates" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <h3 style={{ margin: 0, fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.secondary }}>
        Duplicate check
      </h3>

      {state.status === 'unavailable' && (
        <p role="status" style={{
          margin: 0, padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
          border: '1px solid #FDE68A', background: '#FFFBEB', color: '#92400E',
        }}>
          <strong>{DUPLICATE_UNAVAILABLE_TITLE}.</strong> The check did not run when this review was saved, so it is not confirmed as unique.
        </p>
      )}

      {current.map(flag => (
        <FlagRow key={flag.id} flag={flag} names={names} onCompare={() => setComparing(flag)} />
      ))}

      {earlier.length > 0 && (
        <details style={{ fontSize: '12px', color: colors.secondary }}>
          <summary style={{ cursor: 'pointer' }}>
            {earlier.length} earlier {earlier.length === 1 ? 'flag' : 'flags'} on previous versions of this review
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
            {earlier.map(flag => (
              <FlagRow key={flag.id} flag={flag} names={names} onCompare={() => setComparing(flag)} historical />
            ))}
          </div>
        </details>
      )}

      {comparing && (
        <DuplicateCompareSheet
          supabase={supabase}
          submission={submission}
          flag={comparing}
          viewerId={viewerId}
          names={names}
          canDecide={comparing.content_fingerprint === state.fingerprint}
          onClose={() => setComparing(null)}
          onDecided={() => { setComparing(null); setReload(n => n + 1); onChanged() }}
        />
      )}
    </section>
  )
}

function decisionText(flag: DuplicateFlag, names: Map<string, string>): string | null {
  if (!flag.decision) return null
  const who = flag.decided_by ? names.get(flag.decided_by) : null
  return `Marked ${flag.decision === 'duplicate' ? 'Duplicate' : 'Different review'}`
    + (who ? ` by ${who}` : '')
    + (flag.decided_at ? ` · ${formatSubmissionMoment(flag.decided_at)}` : '')
}

function FlagRow({
  flag, names, onCompare, historical = false,
}: {
  flag: DuplicateFlag
  names: Map<string, string>
  onCompare: () => void
  historical?: boolean
}) {
  const decided = decisionText(flag, names)
  const tone = flag.decision === 'duplicate' ? TONES.red : flag.decision === 'different' || flag.strength === 'weak' ? TONES.grey : TONES.amber
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px',
      padding: '9px 12px', borderRadius: '9px', border: `1px solid ${tone.border}`, background: tone.bg,
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: '12.5px', lineHeight: 1.5, color: tone.color }}>
        <div style={{ fontWeight: 700 }}>
          {DUPLICATE_STRENGTH_LABELS[flag.strength]}
          {flag.matched_was_deleted ? ' · matches a deleted review' : ''}
        </div>
        <div>{flag.reasons.map(r => DUPLICATE_REASON_LABELS[r]).join(' · ')}</div>
        <div style={{ color: colors.secondary }}>
          {flag.employee_proceeded ? 'The employee saw the warning and submitted anyway.' : 'Found without a warning.'}
          {historical ? ' · older version' : ''}
        </div>
        {decided && <div style={{ fontWeight: 600 }}>{decided}{flag.decision_note ? ` — ${flag.decision_note}` : ''}</div>}
      </div>
      <button
        type="button"
        className="boe-btn boe-btn-ghost"
        onClick={onCompare}
        style={{ padding: '7px 12px', fontSize: '12px', minHeight: '44px' }}
      >
        {flag.decision || historical ? 'Compare' : 'Compare & decide'}
      </button>
    </div>
  )
}

// ─── The comparison ───────────────────────────────────────────────────────────

function DuplicateCompareSheet({
  supabase, submission, flag, viewerId, names, canDecide, onClose, onDecided,
}: {
  supabase: SupabaseClient
  submission: CustomReviewSubmission
  flag: DuplicateFlag
  viewerId: string | null
  names: Map<string, string>
  /** False for a flag from an older version of the review: it is history. */
  canDecide: boolean
  onClose: () => void
  onDecided: () => void
}) {
  const [matched, setMatched] = useState<CustomReviewSubmission | null | 'missing'>(null)
  const [matchedNames, setMatchedNames] = useState<Map<string, string>>(names)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // "Duplicate" is binding (it rejects the review and reverses its credit), so it asks first.
  const [confirmingDuplicate, setConfirmingDuplicate] = useState(false)
  const rewarded = Number(submission.credits_awarded ?? 0) > 0 && !submission.reward_reversal_transaction_id && submission.status !== 'rejected'
  const acting = useRef(false)

  useEffect(() => {
    let active = true
    const startFetch = () => {
      void (async () => {
        const { data } = await supabase
          .from('customer_review_custom_submissions')
          .select(CUSTOM_SUBMISSION_COLUMNS)
          .eq('id', flag.matched_submission_id)
          .maybeSingle()
        if (!active) return
        const row = data as unknown as CustomReviewSubmission | null
        if (!row) { setMatched('missing'); return }
        setMatched(row)
        if (!names.has(row.submitted_by)) {
          const { data: people } = await supabase.from('users').select('id, full_name').eq('id', row.submitted_by)
          const p = ((people ?? []) as unknown as { id: string; full_name: string | null }[])[0]
          if (active && p?.full_name) setMatchedNames(prev => new Map(prev).set(p.id, p.full_name as string))
        }
      })()
    }
    startFetch()
    return () => { active = false }
  }, [supabase, flag.matched_submission_id, names])

  const own = submission.submitted_by === viewerId
  const rejectedForDuplicate = submission.status === 'rejected' && submission.rejection_reason === 'Confirmed duplicate of an earlier review'

  const decide = useCallback(async (decision: 'duplicate' | 'different') => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('decide_customer_review_custom_duplicate', {
        p_flag_id: flag.id,
        p_decision: decision,
        p_note: note.trim() === '' ? null : note.trim(),
      })
      if (rpcError) {
        setError(customSubmissionErrorMessage(rpcError.message, 'That decision could not be recorded.'))
        return
      }
      onDecided()
    } catch {
      setError('That decision could not be recorded. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, flag.id, note, onDecided])

  const evidence = describeEvidence(flag.reasons, flag.evidence)

  return (
    <ReviewSheet
      title={DUPLICATE_WARNING_TITLE}
      subtitle={`${submission.submission_ref}${matched && matched !== 'missing' ? ` and ${matched.submission_ref}` : ''}`}
      maxWidth="960px"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose() }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {error && <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: colors.red }}>{error}</p>}

        <section aria-label="Evidence" style={{
          padding: '10px 12px', borderRadius: '9px', border: '1px solid #FDE68A', background: '#FFFBEB',
          fontSize: '12.5px', lineHeight: 1.55, color: '#92400E',
        }}>
          <strong>{DUPLICATE_STRENGTH_LABELS[flag.strength]}</strong>
          {flag.matched_was_deleted ? ' — the earlier review was deleted by its employee' : ''}
          <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
            {evidence.map(line => <li key={line}>{line}</li>)}
          </ul>
          <div style={{ marginTop: '4px' }}>
            {flag.employee_proceeded
              ? 'The employee saw this warning and chose Submit anyway.'
              : 'The employee was not shown a warning for this.'}
          </div>
        </section>

        <div style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}>
          <ReviewSide
            heading="This review"
            supabase={supabase}
            row={submission}
            names={names}
          />
          {matched === null ? (
            <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Loading the earlier review…</p>
          ) : matched === 'missing' ? (
            <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>The earlier review could not be read.</p>
          ) : (
            <ReviewSide
              heading={matched.deleted_at ? 'Earlier review (deleted)' : 'Earlier review'}
              supabase={supabase}
              row={matched}
              names={matchedNames}
            />
          )}
        </div>

        {rejectedForDuplicate && flag.decision === 'different' ? (
          <p role="note" style={{ margin: 0, fontSize: '12.5px', color: '#92400E', lineHeight: 1.5 }}>
            This review was rejected when it was first marked a duplicate. Changing the decision to Different review did not restore it or any credit: the employee can Edit &amp; Reapply it if it earned no credit, otherwise they submit it again as a new review (or an administrator posts a BOE Credits adjustment).
          </p>
        ) : null}

        {flag.decision ? (
          <p style={{ margin: 0, fontSize: '12.5px', color: colors.primary, fontWeight: 600 }}>
            {decisionText(flag, names)}{flag.decision_note ? ` — ${flag.decision_note}` : ''}
          </p>
        ) : null}

        {!canDecide ? (
          <p style={{ margin: 0, fontSize: '12px', color: colors.secondary }}>
            This flag belongs to an earlier version of the review; it is kept as history and cannot be decided.
          </p>
        ) : own ? (
          <p style={{ margin: 0, fontSize: '12px', color: colors.secondary }}>
            You submitted this review, so another verifier must decide this flag.
          </p>
        ) : (
          <section aria-label="Decision" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>
                Note <span style={{ fontWeight: 400, color: colors.muted }}>(optional)</span>
              </span>
              <input
                type="text"
                value={note}
                maxLength={300}
                disabled={busy}
                onChange={e => setNote(e.target.value)}
                placeholder="Why you decided this"
                style={{
                  width: '100%', padding: '9px 11px', borderRadius: '8px', fontSize: '13.5px', minHeight: '44px',
                  border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
                  fontFamily: 'inherit', boxSizing: 'border-box',
                }}
              />
            </label>
            {confirmingDuplicate ? (
              <div role="alert" style={{
                display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', borderRadius: '9px',
                border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', fontSize: '12.5px', lineHeight: 1.55,
              }}>
                <strong>Mark {submission.submission_ref} as a duplicate?</strong>
                {rewarded ? (
                  <span>
                    This review has already been paid. Confirming reverses its reward once, and changing the decision to Different
                    review later will <strong>not</strong> restore it. It is rejected, counted as submitted, never as eligible, and cannot be approved while this decision stands.
                  </span>
                ) : (
                  <span>
                    This rejects the review. It has no reward on the ledger, so nothing is reversed. It is counted as submitted, never as eligible, and cannot be approved while this decision stands.
                  </span>
                )}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={() => { void decide('duplicate') }}
                    style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px', background: '#B91C1C', borderColor: '#B91C1C' }}>
                    {busy ? 'Recording…' : 'Yes, mark as duplicate'}
                  </button>
                  <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => setConfirmingDuplicate(false)}
                    style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px' }}>
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {flag.strength !== 'weak' && (
                  <button
                    type="button"
                    className="boe-btn boe-btn-primary"
                    disabled={busy}
                    onClick={() => setConfirmingDuplicate(true)}
                    style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px', background: '#B91C1C', borderColor: '#B91C1C' }}
                  >
                    Duplicate
                  </button>
                )}
                <button
                  type="button"
                  className="boe-btn boe-btn-ghost"
                  disabled={busy}
                  onClick={() => { void decide('different') }}
                  style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px' }}
                >
                  Different review
                </button>
              </div>
            )}
            <p style={{ margin: 0, fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
              <strong>Duplicate</strong> rejects the review and reverses its credit once. <strong>Different review</strong>{' '}changes nothing
              about the review&apos;s status or credit; if it follows a Duplicate decision it removes the duplicate mark but restores no credit.
              A shared name alone cannot be confirmed as a duplicate. If the employee edits the review it is checked again and this decision does not carry over.
            </p>
          </section>
        )}
      </div>
    </ReviewSheet>
  )
}

function ReviewSide({
  heading, supabase, row, names,
}: {
  heading: string
  supabase: SupabaseClient
  row: CustomReviewSubmission
  names: Map<string, string>
}) {
  const facts: { label: string; value: string }[] = [
    { label: 'Submitted by', value: names.get(row.submitted_by) ?? '—' },
    { label: 'Reference',    value: row.submission_ref },
    { label: 'Type',         value: CUSTOM_REVIEW_TYPE_LABELS[row.review_type] },
    { label: 'Submitted',    value: formatSubmissionDay(istDateOf(row.submitted_at)) },
    { label: 'Published',    value: formatSubmissionDay(row.published_on) },
    { label: 'Status',       value: row.deleted_at ? `Deleted ${formatSubmissionDay(istDateOf(row.deleted_at))}` : CUSTOM_SUBMISSION_STATUS_META[row.status].label },
    { label: 'Reviewer',     value: row.reviewer_name ?? '—' },
    { label: 'Review text',  value: row.review_text ?? '—' },
  ]
  return (
    <section aria-label={heading} style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: colors.primary }}>{heading}</h4>
      <CustomSubmissionProof
        key={row.proof_storage_path}
        supabase={supabase}
        path={row.proof_storage_path}
        alt={`Proof for ${row.submission_ref}`}
      />
      <dl style={{ margin: 0, display: 'grid', gap: '4px', fontSize: '12.5px', lineHeight: 1.5 }}>
        {facts.map(f => (
          <div key={f.label} style={{ display: 'flex', gap: '8px' }}>
            <dt style={{ minWidth: '92px', color: colors.secondary }}>{f.label}</dt>
            <dd style={{ margin: 0, color: colors.primary, fontWeight: 600, overflowWrap: 'anywhere' }}>{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
