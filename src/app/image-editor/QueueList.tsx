'use client'

import { X, CheckCircle2, AlertTriangle, Clock, Loader2 } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MAX_QUEUE_SIZE, type QueueItem, type QueueStatus } from '@/lib/imageEditor/queue'

// The chosen images, before and during a run.
//
// One row per image: what it looks like, what it is called, what state it is in
// and — until a run starts — a way to take it out again. Nothing here sends
// anything; choosing an image costs nothing, and the row says so by sitting in
// "Waiting" until somebody confirms.

const STATE_LABEL: Record<QueueStatus, string> = {
  waiting:    'Waiting',
  processing: 'Processing',
  done:       'Completed',
  failed:     'Failed',
}

function StatusPill({ status }: { status: QueueStatus }) {
  const style: Record<QueueStatus, { color: string; background: string }> = {
    waiting:    { color: colors.tertiary, background: colors.float },
    processing: { color: '#1D4ED8',       background: 'rgba(85,133,232,0.12)' },
    done:       { color: '#1E7B4B',       background: 'rgba(69,168,112,0.14)' },
    failed:     { color: '#C13030',       background: 'rgba(217,79,79,0.12)' },
  }
  const icon = {
    waiting:    <Clock size={11} strokeWidth={2} />,
    processing: <Loader2 size={11} strokeWidth={2} />,
    done:       <CheckCircle2 size={11} strokeWidth={2} />,
    failed:     <AlertTriangle size={11} strokeWidth={2} />,
  }[status]

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      fontSize: '10px', fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: '4px', whiteSpace: 'nowrap',
      ...style[status],
    }}>
      {icon}
      {STATE_LABEL[status]}
    </span>
  )
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function QueueList({
  items,
  locked,
  onRemove,
}: {
  items: QueueItem[]
  /** True while a run is in flight: nothing may be added or taken away then. */
  locked: boolean
  onRemove: (id: string) => void
}) {
  if (items.length === 0) return null

  return (
    <div className="boe-card" style={{ padding: '12px', marginBottom: '14px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '10px', gap: '10px', flexWrap: 'wrap',
      }}>
        <div style={{
          fontSize: '11px', fontWeight: 600, color: colors.tertiary,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {items.length} of {MAX_QUEUE_SIZE} images
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {items.map(item => (
          <div
            key={item.id}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px', borderRadius: '8px',
              background: colors.raised,
              border: `1px solid ${item.status === 'failed' ? 'rgba(217,79,79,0.20)' : colors.border}`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.previewUrl}
              alt=""
              style={{
                width: 44, height: 44, objectFit: 'cover', flexShrink: 0,
                borderRadius: '6px', background: colors.float,
              }}
            />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '13px', color: colors.primary, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {item.name}
              </div>
              <div style={{ fontSize: '11px', color: colors.muted, marginTop: '1px' }}>
                {sizeLabel(item.size)}
                {item.error && (
                  <span style={{ color: '#C13030' }}> · {item.error}</span>
                )}
              </div>
            </div>

            <StatusPill status={item.status} />

            <button
              onClick={() => onRemove(item.id)}
              disabled={locked}
              aria-label={`Remove ${item.name}`}
              title={locked ? 'Wait for the current run to finish' : `Remove ${item.name}`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 26, height: 26, flexShrink: 0,
                borderRadius: '6px', border: `1px solid ${colors.border}`,
                background: 'transparent',
                color: locked ? colors.muted : colors.tertiary,
                cursor: locked ? 'not-allowed' : 'pointer',
              }}
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
