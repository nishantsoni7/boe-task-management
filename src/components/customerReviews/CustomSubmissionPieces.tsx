'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { istClockOf, istDateOf } from '@/lib/istDate'
import { formatCredits } from '@/lib/boeCredits/ledger'
import {
  CUSTOM_PROOF_BUCKET,
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_EVENT_COLUMNS,
  CUSTOM_SUBMISSION_EVENT_LABELS,
  CUSTOM_SUBMISSION_STATUS_META,
  formatSubmissionDay,
  type CustomReviewSubmission,
  type CustomSubmissionEvent,
} from '@/lib/customerReviews/customSubmissions'
import type { ReviewType } from '@/lib/customerReviews/types'

// The pieces the employee's history and the verifier's queue both show: the
// proof screenshot, the facts of one submission, and its history.
//
// THE PROOF IS READ THROUGH A SHORT-LIVED SIGNED URL, minted per open, governed
// by the bucket's SELECT policy — the same question the table's policy asks
// (the submitter, or a verifier). There is no public URL and no download
// control; "Open full size" opens the same signed URL in a new tab.

const SIGNED_URL_TTL_SECONDS = 300

export function CustomSubmissionProof({
  supabase, path, alt, large = false,
}: {
  supabase: SupabaseClient
  path: string
  alt: string
  /** The verifier's view: as tall as the screen allows, because this is what they are checking. */
  large?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Keyed by the caller on the path, so a different submission remounts rather
  // than briefly showing the previous screenshot.
  useEffect(() => {
    let active = true
    supabase.storage
      .from(CUSTOM_PROOF_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
      .then(({ data, error }) => {
        if (!active) return
        if (error || !data?.signedUrl) setFailed(true)
        else setUrl(data.signedUrl)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [supabase, path])

  const frame: React.CSSProperties = {
    width: '100%', borderRadius: '9px', border: `1px solid ${colors.border}`,
    background: colors.float, display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: large ? '240px' : '160px',
  }

  if (failed) {
    return (
      <div style={frame}>
        <span style={{ fontSize: '12px', color: colors.muted }}>The screenshot could not be loaded.</span>
      </div>
    )
  }
  if (!url) {
    return (
      <div style={frame} aria-busy="true">
        <span style={{ fontSize: '12px', color: colors.muted }}>Loading screenshot…</span>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }} title="Open full size">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt}
          style={{
            ...frame, display: 'block', objectFit: 'contain',
            maxHeight: large ? '70vh' : '320px', minHeight: 0,
          }}
        />
      </a>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: '12px', color: colors.secondary, textDecoration: 'underline', alignSelf: 'flex-start' }}
      >
        Open full size
      </a>
    </div>
  )
}

/** "12 Sep 2026, 14:05" in Asia/Kolkata. */
export function formatSubmissionMoment(iso: string | null): string {
  return iso ? `${formatSubmissionDay(istDateOf(iso))}, ${istClockOf(iso)}` : '—'
}

/** The facts of one submission. `names` adds the people (the verifier's view). */
export function CustomSubmissionFacts({
  row, names,
}: {
  row: CustomReviewSubmission
  names?: Map<string, string>
}) {
  const facts: { label: string; value: string }[] = []

  if (names) facts.push({ label: 'Employee', value: names.get(row.submitted_by) ?? '—' })
  facts.push(
    { label: 'Reference',    value: row.submission_ref },
    { label: 'Review Type',  value: CUSTOM_REVIEW_TYPE_LABELS[row.review_type] },
    { label: 'Published On', value: formatSubmissionDay(row.published_on) },
    { label: 'Submitted On', value: formatSubmissionMoment(row.submitted_at) },
    { label: 'Remark',       value: row.remark ?? '—' },
    { label: 'Status',       value: CUSTOM_SUBMISSION_STATUS_META[row.status].label },
  )
  if (row.reapplication_count > 0) {
    facts.push({
      label: 'Reapplied',
      value: `${row.reapplication_count} ${row.reapplication_count === 1 ? 'time' : 'times'} · last ${formatSubmissionMoment(row.last_reapplied_at)}`,
    })
    facts.push({ label: 'Employee Note', value: row.candidate_note ?? '—' })
  }
  if (row.status === 'approved') {
    facts.push({ label: 'Credits Awarded', value: formatCredits(Number(row.credits_awarded ?? 0)) })
    facts.push({ label: 'Approved On', value: formatSubmissionMoment(row.approved_at) })
    if (names && row.approved_by) facts.push({ label: 'Approved By', value: names.get(row.approved_by) ?? '—' })
  }
  if (row.status === 'rejected') {
    facts.push({ label: 'Rejection Reason', value: row.rejection_reason ?? '—' })
    facts.push({ label: 'Rejected On', value: formatSubmissionMoment(row.rejected_at) })
    if (row.rejected_by) {
      const by = names?.get(row.rejected_by)
      if (by) facts.push({ label: 'Rejected By', value: by })
    }
  }

  return (
    <dl style={{ margin: 0, display: 'grid', gap: '6px', fontSize: '12.5px', lineHeight: 1.55 }}>
      {facts.map(f => (
        <div key={f.label} style={{ display: 'flex', gap: '10px' }}>
          <dt style={{ minWidth: '118px', color: colors.secondary }}>{f.label}</dt>
          <dd style={{ margin: 0, color: colors.primary, fontWeight: 600, overflowWrap: 'anywhere' }}>{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

const EVENT_TONE: Record<CustomSubmissionEvent['event_type'], string> = {
  submitted: '#4F6FD0',
  reapplied: '#4F6FD0',
  rejected:  '#B91C1C',
  approved:  '#047857',
}

function typeLabel(value: unknown): string | null {
  return value === 'text' || value === 'image' ? CUSTOM_REVIEW_TYPE_LABELS[value as ReviewType] : null
}

/**
 * The history of one submission — every submission, rejection, reapplication
 * and approval, oldest first, read under the caller's own RLS (the same people
 * who may read the submission). Append-only in the database.
 */
export function CustomSubmissionTrail({
  supabase, submissionId, viewerId, names,
}: {
  supabase: SupabaseClient
  submissionId: string
  /** "You" for the viewer's own actions. */
  viewerId: string | null
  /** People already known to the screen; anyone else shows without a name. */
  names?: Map<string, string>
}) {
  const [events, setEvents] = useState<CustomSubmissionEvent[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const startFetch = () => {
      void (async () => {
        const { data, error } = await supabase
          .from('customer_review_custom_submission_events')
          .select(CUSTOM_SUBMISSION_EVENT_COLUMNS)
          .eq('submission_id', submissionId)
          .order('created_at', { ascending: true })
        if (!active) return
        if (error) { setFailed(true); return }
        setEvents((data ?? []) as unknown as CustomSubmissionEvent[])
      })()
    }
    startFetch()
    return () => { active = false }
  }, [supabase, submissionId])

  if (failed) return <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>The history could not be loaded.</p>
  if (!events) return <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Loading history…</p>
  if (events.length === 0) return null

  const who = (id: string | null) => (id == null ? null : id === viewerId ? 'You' : names?.get(id) ?? null)

  return (
    <section aria-label="History" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <h3 style={{ margin: 0, fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.secondary }}>
        History
      </h3>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {events.map(e => {
          const previous = (e.details?.previous ?? null) as Record<string, unknown> | null
          const current = (e.details?.current ?? null) as Record<string, unknown> | null
          const typeChange = previous && current && previous.review_type !== current.review_type
            ? `${typeLabel(previous.review_type) ?? '—'} → ${typeLabel(current.review_type) ?? '—'}`
            : null
          const actor = who(e.actor_id)
          return (
            <li key={e.id} style={{ display: 'flex', gap: '9px', alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: EVENT_TONE[e.event_type], marginTop: 6, flexShrink: 0 }} />
              <div style={{ minWidth: 0, fontSize: '12px', lineHeight: 1.5 }}>
                <div style={{ color: colors.primary, fontWeight: 600 }}>
                  {CUSTOM_SUBMISSION_EVENT_LABELS[e.event_type]}
                  <span style={{ color: colors.muted, fontWeight: 400 }}>
                    {' · '}{formatSubmissionMoment(e.created_at)}{actor ? ` · ${actor}` : ''}
                  </span>
                </div>
                {e.reason && <div style={{ color: '#B91C1C', overflowWrap: 'anywhere' }}>Reason: {e.reason}</div>}
                {e.note && <div style={{ color: colors.secondary, overflowWrap: 'anywhere' }}>Note: {e.note}</div>}
                {typeChange && <div style={{ color: colors.secondary }}>Type changed: {typeChange}</div>}
                {e.details?.proof_replaced === true && <div style={{ color: colors.secondary }}>Screenshot replaced</div>}
                {e.event_type === 'approved' && e.details?.credits_awarded != null && (
                  <div style={{ color: '#047857' }}>{formatCredits(Number(e.details.credits_awarded), { signed: true })}</div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
