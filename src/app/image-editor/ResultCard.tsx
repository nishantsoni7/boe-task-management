'use client'

import { Download, RotateCcw, Trash2, AlertTriangle } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { QueueItem } from '@/lib/imageEditor/queue'

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

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px', alignItems: 'center' }}>
        {item.result && (
          <button className="boe-btn boe-btn-primary" onClick={() => onDownload(item)} disabled={busy}>
            <Download size={13} strokeWidth={2} />
            Download
          </button>
        )}

        {failed && (
          <button className="boe-btn boe-btn-ghost" onClick={() => onRetry(item.id)} disabled={busy}>
            <RotateCcw size={13} strokeWidth={2} />
            Retry
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
