'use client'

import { colors } from '@/lib/tokens'

// The check before a task is approved, on the list and on Task Detail alike.
// "Back", not "Cancel": beside a Cancel task button, that word would read as
// cancelling the task.
export function ApproveTaskDialog({
  title, assigneeName, busy, onClose, onConfirm,
}: {
  title: string
  assigneeName: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-task-title"
        onClick={e => e.stopPropagation()}
        style={{
          background: '#ffffff', borderRadius: '12px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          width: '100%', maxWidth: '400px',
          padding: '20px',
          display: 'flex', flexDirection: 'column', gap: '8px',
        }}
      >
        <span id="approve-task-title" style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>
          Approve this task?
        </span>
        <p style={{ fontSize: '13px', color: colors.secondary, margin: 0, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
          {title} will be completed and recorded against {assigneeName}.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
          <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button type="button" className="boe-btn boe-btn-primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  )
}
