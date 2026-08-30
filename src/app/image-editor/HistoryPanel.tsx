'use client'

import { useState } from 'react'
import { Download, Trash2, Star, Loader2, Eye, Clock } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { HistoryResult } from '@/lib/imageEditor/history'
import { RETENTION_DAYS, retentionLabel, isExpired } from '@/lib/imageEditor/retention'
import { MANUAL_REVIEW_NOTE, needsManualReview } from '@/lib/imageEditor/verification'

// The employee's own recent results.
//
// WHAT THIS IS NOT
// ----------------
// Not a gallery, not a shared library, not an archive. It is the answer to
// "I closed the tab and lost my picture", and nothing more. Only the person who
// generated an image can see it here — administrators included — so nothing on
// this panel needs to say whose it is.
//
// EVERY CARD STATES ITS OWN FATE
// ------------------------------
// A result is deleted seven days after it was generated unless it is kept, and
// a person cannot make a sensible decision about Keep without knowing how long
// is left. So the countdown is on the card, in words, always — never a tooltip
// and never a date an employee has to do arithmetic on.

/** The one destructive confirmation on this panel. Unkeeping something already
 *  past its window deletes it in the next sweep, and that must be said BEFORE
 *  it happens rather than reported after. */
const UNKEEP_EXPIRED_WARNING =
  'This result is already older than seven days. Removing Keep will delete it in the next cleanup. Continue?'

function Countdown({ result }: { result: HistoryResult }) {
  const kept = result.kept
  const label = retentionLabel(result)
  const urgent = !kept && isExpired(result)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '5px',
      fontSize: '11px', fontWeight: 500,
      color: kept ? colors.amber : urgent ? '#C13030' : colors.tertiary,
    }}>
      {kept ? <Star size={11} strokeWidth={2} fill="currentColor" /> : <Clock size={11} strokeWidth={2} />}
      {label}
    </div>
  )
}

export function HistoryPanel({
  results,
  loading,
  busyId,
  onToggleKeep,
  onDelete,
  onDownload,
}: {
  results: HistoryResult[]
  loading: boolean
  /** The one row with a request in flight, so only its own buttons go quiet. */
  busyId: string | null
  onToggleKeep: (result: HistoryResult, kept: boolean) => void
  onDelete: (result: HistoryResult) => void
  onDownload: (result: HistoryResult) => void
}) {
  // Which row is awaiting a "really delete?" answer. Held here rather than in a
  // browser confirm() so the question appears in the card it belongs to.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  if (loading && results.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '14px', fontSize: '12px', color: colors.tertiary,
      }}>
        <Loader2 size={14} strokeWidth={2} />
        Loading your recent results...
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div style={{
        padding: '18px', fontSize: '12px', color: colors.tertiary,
        background: colors.raised, borderRadius: '10px', lineHeight: 1.5,
      }}>
        Nothing here yet. Studio images you generate are kept for {RETENTION_DAYS} days
        so you can come back for them. Mark one <strong>Keep</strong> to hold on to it
        for longer.
      </div>
    )
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap: '12px',
    }}>
      {results.map(result => {
        const busy = busyId === result.id
        const confirming = confirmingDelete === result.id

        return (
          <div key={result.id} className="boe-card" style={{ padding: '10px' }}>
            {/* A signed URL can be missing if signing failed. The row is still
                shown — knowing the result exists is worth more than hiding it —
                but nothing pretends there is a picture. */}
            {result.url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={result.url}
                alt={`${result.sourceFileName}, studio version`}
                style={{
                  width: '100%', aspectRatio: '1 / 1', objectFit: 'contain',
                  borderRadius: '8px', background: colors.float,
                }}
              />
            ) : (
              <div style={{
                width: '100%', aspectRatio: '1 / 1', borderRadius: '8px',
                background: colors.float, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '11px', color: colors.tertiary,
                textAlign: 'center', padding: '10px',
              }}>
                This image could not be loaded just now.
              </div>
            )}

            <div style={{
              marginTop: '8px', fontSize: '12px', color: colors.secondary, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {result.sourceFileName}
            </div>

            <div style={{ marginTop: '4px' }}>
              <Countdown result={result} />
            </div>

            {needsManualReview(result.verification) && (
              <div style={{
                display: 'flex', gap: '5px', alignItems: 'flex-start', marginTop: '6px',
                fontSize: '10px', lineHeight: 1.4, color: colors.tertiary,
              }}>
                <Eye size={11} strokeWidth={2} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{MANUAL_REVIEW_NOTE}</span>
              </div>
            )}

            {confirming ? (
              <div className="boe-alert-red" style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '11px', color: '#C13030', lineHeight: 1.4 }}>
                  Delete this result permanently?
                </div>
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                  <button
                    className="boe-btn boe-btn-ghost"
                    style={{ fontSize: '11px', padding: '4px 8px', color: '#C13030' }}
                    onClick={() => { setConfirmingDelete(null); onDelete(result) }}
                    disabled={busy}
                  >
                    Delete
                  </button>
                  <button
                    className="boe-btn boe-btn-ghost"
                    style={{ fontSize: '11px', padding: '4px 8px' }}
                    onClick={() => setConfirmingDelete(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{
                display: 'flex', gap: '6px', flexWrap: 'wrap',
                marginTop: '10px', alignItems: 'center',
              }}>
                <button
                  className="boe-btn boe-btn-ghost"
                  style={{ fontSize: '11px', padding: '4px 8px' }}
                  onClick={() => onDownload(result)}
                  disabled={busy || !result.url}
                  title={result.url ? 'Download' : 'This image could not be loaded just now'}
                >
                  <Download size={12} strokeWidth={2} />
                  Download
                </button>

                <button
                  className="boe-btn boe-btn-ghost"
                  style={{
                    fontSize: '11px', padding: '4px 8px',
                    color: result.kept ? colors.amber : undefined,
                  }}
                  onClick={() => {
                    // Unkeeping something already past its window is a deletion
                    // in all but name, so it is confirmed like one.
                    if (result.kept && isExpired({ kept: false, expiresAt: result.expiresAt })) {
                      if (!window.confirm(UNKEEP_EXPIRED_WARNING)) return
                    }
                    onToggleKeep(result, !result.kept)
                  }}
                  disabled={busy}
                >
                  {busy
                    ? <Loader2 size={12} strokeWidth={2} />
                    : <Star size={12} strokeWidth={2} fill={result.kept ? 'currentColor' : 'none'} />}
                  {result.kept ? 'Kept' : 'Keep'}
                </button>

                <button
                  className="boe-btn boe-btn-ghost"
                  style={{ fontSize: '11px', padding: '4px 8px', marginLeft: 'auto' }}
                  onClick={() => setConfirmingDelete(result.id)}
                  disabled={busy}
                  aria-label={`Delete ${result.sourceFileName}`}
                >
                  <Trash2 size={12} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
