'use client'

import { useEffect, useState } from 'react'
import type { Task } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { isOverdue, formatShortDate } from '@/lib/ui'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  task: Task
  userMap?: Record<string, string>
  onClose: () => void
  onOpenFullPage?: () => void
  currentUserId?: string
  onAddUpdate?: (note: string, newStatus: string) => Promise<void>
}

// ─── Priority display ─────────────────────────────────────────────────────────

const PRIORITY: Record<string, { label: string; color: string; bg: string }> = {
  high:   { label: 'High',   color: colors.red,   bg: colors.redTint   },
  medium: { label: 'Medium', color: colors.amber,  bg: colors.amberTint },
  low:    { label: 'Low',    color: colors.muted,  bg: colors.float     },
}

const STATUS_COLOR: Record<string, string> = {
  pending:   colors.muted,
  started:   colors.secondary,
  working:   colors.blue,
  waiting:   colors.amber,
  blocked:   colors.red,
  completed: colors.green,
}

// ─── Meta row ─────────────────────────────────────────────────────────────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minHeight: '22px' }}>
      <span style={{
        flexShrink: 0, width: '90px',
        fontSize: '10.5px', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.06em',
        color: colors.muted, paddingTop: '1px',
      }}>
        {label}
      </span>
      <span style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.5 }}>
        {children}
      </span>
    </div>
  )
}

// ─── TaskDetailPanel ──────────────────────────────────────────────────────────

export function TaskDetailPanel({ task, userMap, onClose, onOpenFullPage, currentUserId, onAddUpdate }: Props) {
  const [open,            setOpen]           = useState(false)
  const [updateNote,      setUpdateNote]     = useState('')
  const [selectedStatus,  setSelectedStatus] = useState(task.status)
  const [submitting,      setSubmitting]     = useState(false)
  const [completingTask,  setCompletingTask] = useState(false)

  // Reset form when a different task is opened
  useEffect(() => {
    setUpdateNote('')
    setSelectedStatus(task.status)
  }, [task.id, task.status])

  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Entrance animation
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const overdue      = isOverdue(task.due_date)
  const priority     = PRIORITY[task.priority] ?? PRIORITY.low
  const statusColor  = STATUS_COLOR[task.status] ?? colors.muted
  const isSelfAssigned = task.assigned_to === task.created_by
  const assignedByName = isSelfAssigned
    ? 'Myself'
    : (userMap?.[task.created_by] ?? '—')

  // Animation values
  const desktopTransform = open ? 'translateX(0)' : 'translateX(100%)'
  const mobileTransform  = open ? 'translateY(0)' : 'translateY(100%)'
  const duration         = isMobile ? '220ms' : '180ms'

  const panelBase: React.CSSProperties = {
    position:      'fixed',
    zIndex:        50,
    background:    colors.base,
    display:       'flex',
    flexDirection: 'column',
    overflowY:     'hidden',
    willChange:    'transform',
  }

  const desktopStyles: React.CSSProperties = {
    top:        0,
    right:      0,
    bottom:     0,
    width:      '400px',
    borderLeft: `1px solid ${colors.borderSoft}`,
    boxShadow:  '-8px 0 32px rgba(0,0,0,0.1)',
    transform:  desktopTransform,
    transition: `transform ${duration} ease-out`,
  }

  const mobileStyles: React.CSSProperties = {
    bottom:       0,
    left:         0,
    right:        0,
    height:       '92vh',
    borderRadius: '12px 12px 0 0',
    borderTop:    `1px solid ${colors.borderSoft}`,
    boxShadow:    '0 -8px 32px rgba(0,0,0,0.1)',
    transform:    mobileTransform,
    transition:   `transform ${duration} ease-out`,
  }

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position:   'fixed',
          inset:      0,
          background: 'rgba(0,0,0,0.38)',
          zIndex:     49,
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        style={{ ...panelBase, ...(isMobile ? mobileStyles : desktopStyles) }}
      >

        {/* Sticky header */}
        <div style={{
          padding:      '13px 16px 11px',
          borderBottom: `1px solid ${colors.border}`,
          background:   colors.raised,
          flexShrink:   0,
          display:      'flex',
          alignItems:   'flex-start',
          gap:          '10px',
        }}>
          <div style={{ flex: 1 }}>
            {task.is_urgent && (
              <div style={{
                fontSize: '9px', fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                color: '#C49A28', marginBottom: '4px',
              }}>
                Important
              </div>
            )}
            <p style={{
              fontSize: '13px', fontWeight: 600,
              color: colors.primary, lineHeight: 1.45, margin: 0,
            }}>
              {task.title}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: 'none', border: 'none',
              color: colors.muted, cursor: 'pointer',
              fontSize: '18px', lineHeight: 1,
              padding: '0 2px', flexShrink: 0,
              transition: 'color 0.14s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
            onMouseLeave={e => (e.currentTarget.style.color = colors.muted)}
          >
            x
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{
          flex:       1,
          overflowY:  'auto',
          scrollbarWidth: 'thin',
          scrollbarColor: `rgba(0,0,0,0.08) transparent`,
          padding:    '14px 16px',
          display:    'flex',
          flexDirection: 'column',
          gap:        '14px',
        }}>

          {/* Metadata */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>

            <MetaRow label="Status">
              <span style={{
                display: 'inline-block',
                fontSize: '11px', fontWeight: 600, textTransform: 'capitalize',
                color: statusColor,
                background: `${statusColor}14`,
                padding: '2px 8px', borderRadius: '4px',
              }}>
                {task.status}
              </span>
            </MetaRow>

            <MetaRow label="Priority">
              <span style={{
                display: 'inline-block',
                fontSize: '11px', fontWeight: 600,
                color: priority.color, background: priority.bg,
                padding: '2px 8px', borderRadius: '4px',
              }}>
                {priority.label}
              </span>
            </MetaRow>

            <MetaRow label="Due Date">
              {task.due_date ? (
                <span style={{
                  fontSize: '12.5px',
                  color: overdue ? colors.red : colors.secondary,
                  fontWeight: overdue ? 600 : 400,
                }}>
                  {formatShortDate(task.due_date)}
                  {overdue && (
                    <span style={{ marginLeft: '5px', fontSize: '10px', color: colors.red }}>
                      Overdue
                    </span>
                  )}
                </span>
              ) : '—'}
            </MetaRow>

            <MetaRow label="Assigned By">{assignedByName}</MetaRow>

          </div>

          {/* Divider */}
          <div style={{ height: '1px', background: colors.border }} />

          {/* Note */}
          <div>
            <div style={{
              fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: colors.muted, marginBottom: '7px',
            }}>
              Note
            </div>
            {task.note ? (
              <p style={{
                fontSize: '12.5px', color: colors.secondary,
                lineHeight: 1.6, margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {task.note}
              </p>
            ) : (
              <p style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                No note added.
              </p>
            )}
          </div>

          {/* Divider */}
          <div style={{ height: '1px', background: colors.border }} />

          {/* Add Update — assignee only, not completed */}
          {onAddUpdate && currentUserId === task.assigned_to && task.status !== 'completed' && (
            <div>
              <div style={{
                fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.07em', color: colors.muted, marginBottom: '8px',
              }}>
                Add Update
              </div>

              {/* Status picker */}
              <div style={{ marginBottom: '7px' }}>
                <div style={{
                  fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.05em', color: colors.muted, marginBottom: '5px',
                }}>
                  Status
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                  {(['pending', 'started', 'working', 'waiting', 'blocked'] as const).map(s => {
                    const active = selectedStatus === s
                    const c = STATUS_COLOR[s]
                    return (
                      <button
                        key={s}
                        onClick={() => setSelectedStatus(s)}
                        style={{
                          padding: '4px 11px', borderRadius: '20px',
                          border: `1.5px solid ${active ? c : colors.border}`,
                          background: active ? `${c}18` : 'transparent',
                          color: active ? c : colors.muted,
                          fontSize: '11px', fontWeight: active ? 600 : 400,
                          cursor: 'pointer', textTransform: 'capitalize',
                          transition: 'all 0.12s',
                        }}
                      >
                        {s}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Note textarea */}
              <textarea
                value={updateNote}
                onChange={e => setUpdateNote(e.target.value)}
                placeholder="What's the latest progress… (optional)"
                rows={2}
                className="boe-input"
                style={{ resize: 'none', width: '100%', boxSizing: 'border-box', fontSize: '12px' }}
              />

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', gap: '8px' }}>
                {/* Mark as Completed — secondary, left-aligned */}
                <button
                  disabled={completingTask || submitting}
                  onClick={async () => {
                    setCompletingTask(true)
                    try {
                      await onAddUpdate('', 'completed')
                    } finally {
                      setCompletingTask(false)
                    }
                  }}
                  style={{
                    padding: '6px 12px', borderRadius: '6px',
                    border: `1px solid ${colors.green}50`,
                    background: completingTask || submitting ? colors.float : colors.greenTint,
                    color: completingTask || submitting ? colors.muted : colors.green,
                    fontSize: '11.5px', fontWeight: 600,
                    cursor: completingTask || submitting ? 'not-allowed' : 'pointer',
                    transition: 'background 0.12s',
                  }}
                >
                  {completingTask ? 'Completing…' : 'Mark as Completed'}
                </button>

                {/* Post Update — primary action, right-aligned */}
                {(() => {
                  const statusChanged = selectedStatus !== task.status
                  const hasNote = updateNote.trim().length > 0
                  const canSubmit = !submitting && !completingTask && (statusChanged || hasNote)
                  return (
                    <button
                      disabled={!canSubmit}
                      onClick={async () => {
                        if (!canSubmit) return
                        setSubmitting(true)
                        try {
                          await onAddUpdate(updateNote.trim(), selectedStatus)
                          setUpdateNote('')
                        } finally {
                          setSubmitting(false)
                        }
                      }}
                      style={{
                        padding: '6px 14px', borderRadius: '6px', border: 'none',
                        background: canSubmit ? colors.amber : colors.float,
                        color: canSubmit ? '#fff' : colors.muted,
                        fontSize: '11.5px', fontWeight: 600,
                        cursor: canSubmit ? 'pointer' : 'not-allowed',
                        transition: 'background 0.12s',
                      }}
                    >
                      {submitting ? 'Posting…' : 'Post Update'}
                    </button>
                  )
                })()}
              </div>
            </div>
          )}

        </div>

        {/* Sticky footer */}
        <div style={{
          padding:      '10px 14px',
          borderTop:    `1px solid ${colors.border}`,
          background:   colors.raised,
          flexShrink:   0,
          display:      'flex',
          gap:          '8px',
          justifyContent: 'flex-end',
        }}>
          {onOpenFullPage && (
            <button
              onClick={onOpenFullPage}
              style={{
                padding: '7px 14px', borderRadius: '7px',
                border: `1px solid ${colors.borderSoft}`,
                background: colors.base,
                cursor: 'pointer',
                fontSize: '12px', fontWeight: 600,
                color: colors.secondary,
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = colors.float)}
              onMouseLeave={e => (e.currentTarget.style.background = colors.base)}
            >
              Open Full Page
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px', borderRadius: '7px',
              border: 'none',
              background: colors.primary,
              color: '#fff',
              cursor: 'pointer',
              fontSize: '12px', fontWeight: 600,
              transition: 'opacity 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Close
          </button>
        </div>

      </div>
    </>
  )
}
