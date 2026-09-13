'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Image as ImageIcon, ImagePlus, Upload } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { istDateOf, istToday } from '@/lib/istDate'
import { formatCredits } from '@/lib/boeCredits/ledger'
import {
  TEST_SCREENSHOT_ACCEPT,
  TEST_SCREENSHOT_TYPES_LABEL,
  validateTestScreenshot,
} from '@/lib/customerReviews/photos'
import {
  CUSTOM_REVIEW_TYPE_LABELS,
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_STATUS_META,
  MAX_CUSTOM_REMARK_LENGTH,
  formatSubmissionDay,
  parseCustomSubmissionInput,
  type CustomReviewSubmission,
} from '@/lib/customerReviews/customSubmissions'
import { REVIEW_TYPE_META, type ReviewType } from '@/lib/customerReviews/types'
import { ReviewBadge } from './ReviewPieces'
import { ReviewSheet } from './ReviewSheet'
import { CustomSubmissionFacts, CustomSubmissionProof } from './CustomSubmissionPieces'

// ── Custom Reviews, on the employee's own screen ─────────────────────────────
//
// A review the employee arranged THEMSELVES, handed over as proof. It is kept
// apart from the assigned reviews above it on purpose: nothing here is booked,
// shared or generated, and no count on My Reviews includes it.
//
// ONE SMALL FORM. Type, the date it was published, a screenshot, an optional
// remark — Submit for Verification. The row is created Pending Verification by
// the upload route; the browser cannot create one, decide one or award a
// credit. The history below is read through this employee's own RLS.

export function CustomReviewSubmissions({
  supabase, profileId, canSubmit,
}: {
  supabase: SupabaseClient
  profileId: string
  /** customer_review_requests.use — the route and the database ask again. */
  canSubmit: boolean
}) {
  const [rows, setRows] = useState<CustomReviewSubmission[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [viewing, setViewing] = useState<CustomReviewSubmission | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('customer_review_custom_submissions')
      .select(CUSTOM_SUBMISSION_COLUMNS)
      .eq('submitted_by', profileId)
      .order('submitted_at', { ascending: false })
      .limit(50)
    if (error) {
      setLoadError('Your custom reviews could not be loaded. Refresh to try again.')
      setLoaded(true)
      return
    }
    setLoadError(null)
    setRows((data ?? []) as unknown as CustomReviewSubmission[])
    setLoaded(true)
  }, [supabase, profileId])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  return (
    <section aria-labelledby="custom-reviews-heading" style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 id="custom-reviews-heading" style={{
            margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: colors.primary,
          }}>
            Custom Reviews
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
            A review you arranged yourself. BOE Credits are awarded once management verifies it.
          </p>
        </div>
        {canSubmit && (
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            onClick={() => { setNotice(null); setFormOpen(true) }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '13px', minHeight: '44px' }}
          >
            <Upload size={14} strokeWidth={2.2} />
            Submit Custom Review
          </button>
        )}
      </header>

      {notice && (
        <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>{notice}</p>
      )}
      {loadError && (
        <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{loadError}</p>
      )}

      {!loaded ? (
        <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Loading your custom reviews…</p>
      ) : rows.length === 0 ? (
        <p style={{
          margin: 0, padding: '14px 16px', borderRadius: '8px', fontSize: '12px',
          border: `1px dashed ${colors.border}`, color: colors.muted,
        }}>
          No custom reviews submitted yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {rows.map(row => (
            <SubmissionRow key={row.id} row={row} onView={() => setViewing(row)} />
          ))}
        </ul>
      )}

      {formOpen && (
        <SubmitCustomReviewSheet
          onClose={() => setFormOpen(false)}
          onSubmitted={async () => {
            setFormOpen(false)
            setNotice('Submitted for verification. It is listed below as Pending Verification.')
            await load()
          }}
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
            <CustomSubmissionFacts row={viewing} />
          </div>
        </ReviewSheet>
      )}
    </section>
  )
}

function SubmissionRow({ row, onView }: { row: CustomReviewSubmission; onView: () => void }) {
  const Icon = row.review_type === 'image' ? ImageIcon : FileText
  return (
    <li style={{
      padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.borderSoft}`, background: colors.base,
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px',
    }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Icon size={14} strokeWidth={2.2} style={{ color: REVIEW_TYPE_META[row.review_type].color, flexShrink: 0 }} />
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
            {CUSTOM_REVIEW_TYPE_LABELS[row.review_type]}
          </span>
          <ReviewBadge meta={CUSTOM_SUBMISSION_STATUS_META[row.status]} />
        </div>
        <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
          Published {formatSubmissionDay(row.published_on)} · Submitted {formatSubmissionDay(istDateOf(row.submitted_at))}
        </div>
        {row.status === 'rejected' && row.rejection_reason && (
          <div style={{ fontSize: '12px', color: '#B91C1C', marginTop: '4px', overflowWrap: 'anywhere' }}>
            Rejected: {row.rejection_reason}
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
        className="boe-btn boe-btn-ghost"
        onClick={onView}
        style={{ padding: '7px 12px', fontSize: '12px', minHeight: '44px' }}
      >
        View Proof
      </button>
    </li>
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

function SubmitCustomReviewSheet({
  onClose, onSubmitted,
}: {
  onClose: () => void
  onSubmitted: () => Promise<void>
}) {
  const today = istToday()
  const [reviewType, setReviewType] = useState<ReviewType | null>(null)
  const [publishedOn, setPublishedOn] = useState('')
  const [remark, setRemark] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // State is too slow to stop a double click; the ref stops the second POST,
  // and the database refuses the same screenshot twice whatever raced.
  const submitting = useRef(false)
  const previewUrl = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // The preview is a local object URL of the chosen file — nothing is uploaded
  // until Submit. Released when the sheet closes.
  useEffect(() => () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
  }, [])

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
  }

  const submit = async () => {
    if (submitting.current) return
    const parsed = parseCustomSubmissionInput({ reviewType, publishedOn, remark, hasProof: file !== null }, today)
    if (!parsed.ok || !file) {
      setError(parsed.ok ? 'Upload a screenshot of the published review.' : parsed.issues[0].message)
      return
    }
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const body = new FormData()
      body.append('reviewType', parsed.value.reviewType)
      body.append('publishedOn', parsed.value.publishedOn)
      if (parsed.value.remark) body.append('remark', parsed.value.remark)
      body.append('file', file)

      const response = await fetch('/api/customer-reviews/custom-submissions', { method: 'POST', body })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        setError(typeof payload?.error === 'string' ? payload.error : 'That submission could not be saved. Try again.')
        return
      }
      await onSubmitted()
    } catch {
      setError('That submission could not be saved. Check your connection and try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <ReviewSheet
      title="Submit Custom Review"
      subtitle="Proof that a review you arranged was published"
      maxWidth="520px"
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
          <button
            type="button"
            className="boe-btn boe-btn-primary"
            onClick={() => { void submit() }}
            disabled={busy}
            style={{ padding: '8px 16px', fontSize: '13px', minHeight: '44px' }}
          >
            {busy ? 'Submitting…' : 'Submit for Verification'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => { setReviewType(type); setError(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                    minHeight: '44px', padding: '8px 10px', borderRadius: '9px',
                    fontSize: '13px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
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

        <div style={fieldStyle}>
          <span style={labelStyle}>Screenshot / Proof</span>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Screenshot preview"
              style={{
                width: '100%', maxHeight: '260px', objectFit: 'contain', borderRadius: '9px',
                border: `1px solid ${colors.border}`, background: colors.float,
              }}
            />
          )}
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
            {file ? 'Replace screenshot' : 'Upload screenshot'}
          </label>
          <span style={hintStyle}>
            {TEST_SCREENSHOT_TYPES_LABEL}, up to 5 MB. Only you and a verifier can see it.
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
      </div>
    </ReviewSheet>
  )
}
