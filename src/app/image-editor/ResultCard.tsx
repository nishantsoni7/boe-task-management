'use client'

import { Download, RotateCcw, Trash2, AlertTriangle, ImageOff, Eye } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { QueueItem } from '@/lib/imageEditor/queue'
import { MANUAL_REVIEW_NOTE, needsManualReview } from '@/lib/imageEditor/verification'

// One finished — or one failed — image.
//
// A completed card shows the photograph beside the studio image, because the
// comparison is the only way to judge whether the product survived. A failed
// card shows why, and offers a retry — which the person presses, never the
// runner: nothing here retries on its own.

function Panel({ label, src, alt, accent }: {
  label: string
  src: string
  alt: string
  accent?: boolean
}) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '6px',
        color: accent ? colors.amber : colors.tertiary,
      }}>
        {label}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        style={{
          width: '100%', aspectRatio: '1 / 1', objectFit: 'contain',
          borderRadius: '8px', background: colors.float,
        }}
      />
    </div>
  )
}

export function ResultCard({
  item,
  busy,
  onDownload,
  onRemove,
  onRetry,
}: {
  item: QueueItem
  /** True while any run is in flight: retries must not start over a run. */
  busy: boolean
  onDownload: (item: QueueItem) => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  const failed = item.status === 'failed'

  return (
    <div className="boe-card" style={{ padding: '12px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px',
        fontSize: '12px', color: colors.secondary, fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {item.name}
      </div>

      {failed ? (
        <div className="boe-alert-red" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <AlertTriangle size={14} strokeWidth={2} color="#C13030" style={{ flexShrink: 0, marginTop: '1px' }} />
          <div style={{ fontSize: '12px', color: '#C13030' }}>
            {item.error ?? 'This image could not be generated.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Panel label="Original" src={item.previewUrl} alt={`${item.name}, as photographed`} />
          {item.result && (
            <Panel label="Studio image" src={item.result.dataUrl} alt={`${item.name}, studio version`} accent />
          )}
        </div>
      )}

      {/* A note, not a warning, and not a blocker: the image is fine as far as
          anyone knows — nobody has checked it. It sits under the panels so the
          comparison above it is unchanged, and Download is untouched. */}
      {item.result && needsManualReview(item.verification) && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'flex-start', marginTop: '10px',
          fontSize: '11px', lineHeight: 1.4, color: colors.tertiary,
        }}>
          <Eye size={12} strokeWidth={2} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>{MANUAL_REVIEW_NOTE}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px', alignItems: 'center' }}>
        {item.result && (
          <button className="boe-btn boe-btn-primary" onClick={() => onDownload(item)} disabled={busy}>
            <Download size={13} strokeWidth={2} />
            Download
          </button>
        )}

        {/* Retry only where a retry could work. A product too small in the frame
            is the same size on the next press, and that press costs a request —
            so this failure offers the thing that WOULD help instead. */}
        {failed && !item.noRetry && (
          <button className="boe-btn boe-btn-ghost" onClick={() => onRetry(item.id)} disabled={busy}>
            <RotateCcw size={13} strokeWidth={2} />
            Retry
          </button>
        )}

        {failed && item.noRetry && (
          <button className="boe-btn boe-btn-ghost" onClick={() => onRemove(item.id)} disabled={busy}>
            <ImageOff size={13} strokeWidth={2} />
            Choose a different photo
          </button>
        )}

        <button
          className="boe-btn boe-btn-ghost"
          onClick={() => onRemove(item.id)}
          disabled={busy}
          style={{ marginLeft: 'auto' }}
        >
          <Trash2 size={13} strokeWidth={2} />
          Remove
        </button>
      </div>
    </div>
  )
}
