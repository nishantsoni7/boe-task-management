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

// ─── Static timeline items ────────────────────────────────────────────────────

const TIMELINE_ITEMS = [
  { text: 'Task created',               time: 'May 28, 2026 · 10:14 AM', dot: colors.green   },
  { text: 'Status changed to In Progress', time: 'May 29, 2026 · 2:03 PM',  dot: colors.blue    },
  { text: 'Marked as Important',        time: 'May 30, 2026 · 9:47 AM',  dot: '#C49A28'      },
]

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

export function TaskDetailPanel({ task, userMap, onClose, onOpenFullPage }: Props) {
  const [open, setOpen] = useState(false)

  const isMobile =
    typeof window !== 'undefined' ? window.innerWidth < 768 : false

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

  // ── Animation values ───────────────────────────────────────────────────
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

        {/* ── Sticky header ─────────────────────────────────────────────── */}
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
                ⭐ Important
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
            ×
          </button>
        </div>

        {/* ── Scrollable body ────────────────────────────────────────────── */}
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
                  {overdue && <span style={{ marginLeft: '5px', fontSize: '10px', color: colors.red }}>Overdue</span>}
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

          {/* Activity Timeline */}
          <div>
            <div style={{
              fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: colors.muted, marginBottom: '10px',
            }}>
              Activity
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              {TIMELINE_ITEMS.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  {/* Track */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                    <div style={{
                      width: '7px', height: '7px', borderRadius: '50%',
                      background: item.dot, marginTop: '4px', flexShrink: 0,
                    }} />
                    {i < TIMELINE_ITEMS.length - 1 && (
                      <div style={{ width: '1px', flex: 1, background: colors.border, minHeight: '20px', marginTop: '3px' }} />
                    )}
                  </div>
                  {/* Content */}
                  <div style={{ paddingBottom: i < TIMELINE_ITEMS.length - 1 ? '12px' : '0' }}>
                    <p style={{ fontSize: '12px', color: colors.secondary, margin: 0, lineHeight: 1.45 }}>
                      {item.text}
                    </p>
                    <p style={{ fontSize: '10.5px', color: colors.muted, margin: '2px 0 0' }}>
                      {item.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* ── Sticky footer ──────────────────────────────────────────────── */}
        <div style={{
          padding:      '10px 14px',
          borderTop:    `1px solid ${colors.border}`,
          background:   colors.raised,
          flexShrink:   0,
          display:      'flex',
          gap:          '8px',
          justifyContent: 'flex-end',
        }}>
          {onOpenFullPage && <button
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
          </button>}
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
