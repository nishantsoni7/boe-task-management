'use client'

import { useState } from 'react'
import { colors, font } from '@/lib/tokens'

const CANCEL_REASONS = [
  'No longer required',
  'Duplicate task',
  'Created by mistake',
  'Requirement changed',
  'Completed outside system',
  'Other',
]

// Cancelling needs a reason: /api/cancel-task refuses a blank one and the assignee
// is told. One popup for Task Detail and the Assigned By Me list, so the two offer
// the same reasons. It holds only the choice; the caller sends the request.
export function CancelTaskModal({
  busy, onClose, onConfirm,
}: {
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason,    setReason]    = useState('')
  const [otherText, setOtherText] = useState('')

  const finalReason = reason === 'Other' ? otherText.trim() : reason
  const canConfirm  = !busy && finalReason !== ''

  return (
    <div
      onClick={onClose}
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
        aria-labelledby="cancel-task-title"
        onClick={e => e.stopPropagation()}
        style={{
          background: '#ffffff', borderRadius: '12px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          width: '100%', maxWidth: '420px',
          padding: '24px',
          display: 'flex', flexDirection: 'column', gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span id="cancel-task-title" style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Cancel Task</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: colors.muted, lineHeight: 1, padding: '2px 6px', borderRadius: '6px', fontFamily: font.body }}
          >
            ×
          </button>
        </div>

        <p style={{ fontSize: '12.5px', color: colors.secondary, margin: 0, lineHeight: 1.6 }}>
          Cancelling this task is permanent until restored. The assignee will be notified. Select a reason below.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <p style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0, color: colors.secondary }}>
            Reason <span style={{ color: colors.red }}>*</span>
          </p>
          {CANCEL_REASONS.map(r => (
            <button
              key={r}
              type="button"
              onClick={() => { setReason(r); if (r !== 'Other') setOtherText('') }}
              style={{
                padding: '9px 12px', borderRadius: '8px', textAlign: 'left',
                border: `1.5px solid ${reason === r ? '#686D6C' : colors.border}`,
                background: reason === r ? '#F1EEE9' : colors.float,
                color: reason === r ? '#303536' : colors.secondary,
                fontSize: '13px', fontWeight: reason === r ? 600 : 400,
                cursor: 'pointer', transition: 'all 0.12s', fontFamily: font.body,
              }}
            >
              {r}
            </button>
          ))}
        </div>

        {reason === 'Other' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0, color: colors.secondary }}>
              Specify reason <span style={{ color: colors.red }}>*</span>
            </p>
            <input
              type="text"
              value={otherText}
              onChange={e => setOtherText(e.target.value)}
              placeholder="Enter reason…"
              className="boe-input"
              style={{ width: '100%', boxSizing: 'border-box' }}
              autoFocus
            />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '7px 16px', borderRadius: '8px',
              border: `1.5px solid ${colors.border}`,
              background: 'transparent', color: colors.tertiary,
              fontSize: '12px', fontWeight: 500,
              cursor: 'pointer', fontFamily: font.body,
            }}
          >
            Back
          </button>
          <button
            onClick={() => onConfirm(finalReason)}
            disabled={!canConfirm}
            style={{
              padding: '7px 18px', borderRadius: '8px',
              border: '1.5px solid #686D6C',
              background: '#686D6C', color: '#ffffff',
              fontSize: '12px', fontWeight: 600,
              cursor: canConfirm ? 'pointer' : 'not-allowed',
              fontFamily: font.body,
              opacity: canConfirm ? 1 : 0.5,
              transition: 'all 0.15s',
            }}
          >
            {busy ? 'Cancelling…' : 'Confirm Cancellation'}
          </button>
        </div>
      </div>
    </div>
  )
}
