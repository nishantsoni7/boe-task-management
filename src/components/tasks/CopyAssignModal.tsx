'use client'

import { useEffect, useState } from 'react'
import { colors, font } from '@/lib/tokens'

type Priority = 'high' | 'medium' | 'low'

type Member = { id: string; full_name: string }

const PRIORITY_STYLE: Record<Priority, { fg: string; bg: string }> = {
  high:   { fg: colors.red,   bg: colors.redTint   },
  medium: { fg: colors.amber, bg: colors.amberTint },
  low:    { fg: colors.muted, bg: colors.float     },
}

export type CopyAssignModalProps = {
  sourceTitle:     string
  attachmentCount: number
  initialPriority: Priority
  members:         Member[]
  excludeUserId:   string
  submitting:      boolean
  error:           string | null
  onClose:         () => void
  onSubmit:        (args: { assigneeId: string; dueDate: string; priority: Priority }) => void
}

/**
 * Compact "Copy & Assign" modal. Field state lives here; the parent owns the
 * async submit (API call, toast, refresh) and passes back `submitting`/`error`.
 * The parent mounts this only while open, so each open starts with fresh fields.
 */
export function CopyAssignModal({
  sourceTitle, attachmentCount, initialPriority, members, excludeUserId,
  submitting, error, onClose, onSubmit,
}: CopyAssignModalProps) {
  const [assigneeId, setAssigneeId] = useState('')
  const [dueDate,    setDueDate]    = useState('')
  const [priority,   setPriority]   = useState<Priority>(initialPriority)

  // Escape closes the modal, but not while the critical submit is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting, onClose])

  const canSubmit = !!assigneeId && !!dueDate && !submitting

  return (
    <div
      onClick={() => { if (!submitting) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Copy and assign task"
        style={{
          background: '#ffffff', borderRadius: '12px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          width: '100%', maxWidth: '420px',
          padding: '24px',
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Copy &amp; Assign</div>
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px' }}>
              Creates a new task from this one for another person.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: submitting ? 'not-allowed' : 'pointer', fontSize: '18px', color: colors.muted, lineHeight: 1, padding: '2px 6px', borderRadius: '6px', fontFamily: font.body }}
          >
            ×
          </button>
        </div>

        {/* Compact source summary — title, copied priority, attachment count */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          padding: '9px 12px', borderRadius: '8px',
          background: colors.float, border: `1px solid ${colors.border}`,
        }}>
          <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.secondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sourceTitle}
          </span>
          <span style={{ fontSize: '10.5px', fontWeight: 600, color: colors.muted, whiteSpace: 'nowrap' }}>
            {attachmentCount > 0 ? `📎 ${attachmentCount}` : 'No attachments'}
          </span>
        </div>
        <p style={{ fontSize: '11.5px', color: colors.muted, margin: '-4px 0 0' }}>
          Title, description and attachments are copied. Choose a new assignee and due date.
        </p>

        {/* Assign to */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: colors.secondary }}>
            Assign to <span style={{ color: colors.red }}>*</span>
          </label>
          <select
            value={assigneeId}
            onChange={e => setAssigneeId(e.target.value)}
            className="boe-input"
            style={{ width: '100%', height: '38px' }}
            autoFocus
          >
            <option value="">Select team member…</option>
            {members
              .filter(m => m.id !== excludeUserId)
              .map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
        </div>

        {/* Due date */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: colors.secondary }}>
            Due date <span style={{ color: colors.red }}>*</span>
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className="boe-input"
            style={{ width: '100%', height: '38px', boxSizing: 'border-box' }}
          />
        </div>

        {/* Priority — prefilled from source, editable */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: colors.secondary }}>
            Priority
          </label>
          <div style={{ display: 'flex', gap: '6px' }}>
            {(['high', 'medium', 'low'] as const).map(p => {
              const ps = PRIORITY_STYLE[p]
              const active = priority === p
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  style={{
                    flex: 1, height: '34px', borderRadius: '6px',
                    border: `1.5px solid ${active ? ps.fg : colors.border}`,
                    background: active ? ps.bg : 'transparent',
                    color: active ? ps.fg : colors.tertiary,
                    fontSize: '12px', fontWeight: active ? 600 : 400,
                    cursor: 'pointer', textTransform: 'capitalize',
                    fontFamily: font.body, transition: 'all 0.12s',
                  }}
                >
                  {p}
                </button>
              )
            })}
          </div>
        </div>

        {error && <p style={{ fontSize: '11.5px', color: colors.red, margin: 0 }}>{error}</p>}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' }}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: '8px 16px', borderRadius: '7px',
              border: `1.5px solid ${colors.border}`,
              background: 'transparent', color: colors.tertiary,
              fontSize: '12px', fontWeight: 500,
              cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: font.body,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit({ assigneeId, dueDate, priority })}
            disabled={!canSubmit}
            style={{
              padding: '8px 18px', borderRadius: '7px',
              border: `1.5px solid ${colors.blue}`,
              background: colors.blue, color: '#ffffff',
              fontSize: '12px', fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              fontFamily: font.body, opacity: canSubmit ? 1 : 0.5,
              transition: 'all 0.15s',
            }}
          >
            {submitting ? 'Copying…' : 'Copy & Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}
