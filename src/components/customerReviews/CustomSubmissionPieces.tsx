'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { istDateOf } from '@/lib/istDate'
import { formatCredits } from '@/lib/boeCredits/ledger'
import {
  CUSTOM_PROOF_BUCKET,
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_STATUS_META,
  formatSubmissionDay,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'

// The two pieces the employee's history and the verifier's queue both show: the
// proof screenshot, and the facts of one submission.
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

/** The facts of one submission. `names` adds the people (the verifier's view). */
export function CustomSubmissionFacts({
  row, names,
}: {
  row: CustomReviewSubmission
  names?: Map<string, string>
}) {
  const day = (iso: string | null) => (iso ? formatSubmissionDay(istDateOf(iso)) : '—')
  const facts: { label: string; value: string }[] = []

  if (names) facts.push({ label: 'Employee', value: names.get(row.submitted_by) ?? '—' })
  facts.push(
    { label: 'Reference',    value: row.submission_ref },
    { label: 'Review Type',  value: CUSTOM_REVIEW_TYPE_LABELS[row.review_type] },
    { label: 'Published On', value: formatSubmissionDay(row.published_on) },
    { label: 'Submitted On', value: day(row.submitted_at) },
    { label: 'Remark',       value: row.remark ?? '—' },
    { label: 'Status',       value: CUSTOM_SUBMISSION_STATUS_META[row.status].label },
  )
  if (row.status === 'approved') {
    facts.push({ label: 'Credits Awarded', value: formatCredits(Number(row.credits_awarded ?? 0)) })
    facts.push({ label: 'Approved On', value: day(row.approved_at) })
    if (names && row.approved_by) facts.push({ label: 'Approved By', value: names.get(row.approved_by) ?? '—' })
  }
  if (row.status === 'rejected') {
    facts.push({ label: 'Rejection Reason', value: row.rejection_reason ?? '—' })
    facts.push({ label: 'Rejected On', value: day(row.rejected_at) })
    if (names && row.rejected_by) facts.push({ label: 'Rejected By', value: names.get(row.rejected_by) ?? '—' })
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
