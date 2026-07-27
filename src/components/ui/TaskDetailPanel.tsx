'use client'

import { useEffect, useState, useMemo } from 'react'
import type { Task, LogEntry } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { isOverdue, formatShortDate, formatDateTime, timeAgo, formatLogAction, getTaskAging } from '@/lib/ui'
import { createClient } from '@/lib/supabase/client'
import { MultilineText } from '@/components/ui/MultilineText'
import { CheckCircle } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  task: Task
  userMap?: Record<string, string>
  onClose: () => void
  onOpenFullPage?: () => void
  currentUserId?: string
  onAcknowledge?: () => Promise<void>
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

export function TaskDetailPanel({ task, userMap, onClose, onOpenFullPage, currentUserId, onAcknowledge }: Props) {
  const [open,          setOpen]        = useState(false)
  const [acknowledging, setAcknowledging] = useState(false)
  const [activityLog,   setActivityLog] = useState<LogEntry[]>([])
  const [logLoading,    setLogLoading]  = useState(true)

  const supabase = useMemo(() => createClient(), [])

  // Reload log when a different task is opened
  useEffect(() => {
    const loadLog = () => {
      setActivityLog([])
      setLogLoading(true)

      supabase
        .from('task_activity_log')
        .select('id, action, note, from_status, to_status, created_at, actor_id')
        .eq('task_id', task.id)
        .order('created_at', { ascending: false })
        .limit(20)
        .then(({ data }: { data: LogEntry[] | null }) => {
          if (data) setActivityLog(data)
          setLogLoading(false)
        })
    }
    loadLog()
  }, [task.id, task.status, supabase])

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

  const overdue        = isOverdue(task.due_date)
  const priority       = PRIORITY[task.priority] ?? PRIORITY.low
  const statusColor    = STATUS_COLOR[task.status] ?? colors.muted
  const isSelfAssigned = task.assigned_to === task.created_by
  const assignedByName = isSelfAssigned
    ? 'Self'
    : (userMap?.[task.created_by] ?? '—')

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
              fontSize: '15px', fontWeight: 600,
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
              padding: '8px', flexShrink: 0,
              minWidth: '40px', minHeight: '40px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '6px',
              transition: 'color 0.14s, background 0.14s',
              marginRight: '-6px',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.primary; e.currentTarget.style.background = colors.float }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.muted; e.currentTarget.style.background = 'none' }}
          >
            ×
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{
          flex:           1,
          overflowY:      'auto',
          scrollbarWidth: 'thin',
          scrollbarColor: `rgba(0,0,0,0.08) transparent`,
          padding:        '12px 16px',
          display:        'flex',
          flexDirection:  'column',
          gap:            '10px',
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

            <MetaRow label="Last Update">
              {task.last_update_at
                ? <span title={formatDateTime(task.last_update_at)}>{timeAgo(task.last_update_at)}</span>
                : <span title={formatDateTime(task.created_at)}>{timeAgo(task.created_at)} (created)</span>
              }
            </MetaRow>

            {(() => {
              const aging = getTaskAging(task)
              if (!aging) return null
              const color = aging.severity === 'danger' ? '#D94F4F' : '#E8A030'
              return (
                <MetaRow label="Aging">
                  <span style={{
                    fontSize: '11px', fontWeight: 700,
                    color,
                    background: `${color}12`,
                    border: `1px solid ${color}30`,
                    padding: '2px 8px', borderRadius: '4px',
                  }}>
                    {aging.label}
                  </span>
                  <span style={{ fontSize: '11px', color: '#6B7384', marginLeft: '6px' }}>
                    {aging.message}
                  </span>
                </MetaRow>
              )
            })()}

          </div>

          {/* Waiting On — shown when task is in waiting status */}
          {task.status === 'waiting' && (task.waiting_on_type) && (
            <div style={{
              padding: '8px 10px',
              borderRadius: '7px',
              background: `${colors.amber}0d`,
              border: `1.5px solid ${colors.amber}40`,
              borderLeft: `3px solid ${colors.amber}`,
            }}>
              <div style={{
                fontSize: '9.5px', fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: colors.amber, marginBottom: '5px',
              }}>
                Waiting On
              </div>
              <p style={{
                fontSize: '12.5px', color: colors.amber,
                margin: 0, lineHeight: 1.55,
              }}>
                {task.waiting_on_type === 'team_member'
                  ? (userMap?.[task.waiting_on_user_id ?? ''] ?? 'Team member')
                  : (task.waiting_on_text ?? '—')
                }
              </p>
              <p style={{ fontSize: '10px', color: colors.muted, margin: '3px 0 0' }}>
                {task.waiting_on_type === 'team_member' ? 'Team Member' : 'External Dependency'}
              </p>
            </div>
          )}

          {/* Blocker reason — prominent section, visible above Note */}
          {task.status === 'blocked' && task.blocker_reason && (
            <div style={{
              padding: '8px 10px',
              borderRadius: '7px',
              background: `${colors.red}0d`,
              border: `1.5px solid ${colors.red}40`,
              borderLeft: `3px solid ${colors.red}`,
            }}>
              <div style={{
                fontSize: '9.5px', fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: colors.red, marginBottom: '5px',
              }}>
                Blocker Reason
              </div>
              <MultilineText style={{
                fontSize: '12.5px', color: colors.red,
                margin: 0, lineHeight: 1.55,
              }}>
                {task.blocker_reason}
              </MultilineText>
            </div>
          )}

          {/* Divider */}
          <div style={{ height: '1px', background: colors.border }} />

          {/* Task Description */}
          <div>
            <div style={{
              fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: colors.muted, marginBottom: '7px',
            }}>
              Task Description
            </div>
            <div style={{
              padding: '7px 10px', borderRadius: '6px',
              background: colors.raised,
              border: `1px solid ${colors.border}`,
            }}>
              {task.note ? (
                <MultilineText style={{
                  fontSize: '12.5px', color: colors.secondary,
                  lineHeight: 1.6, margin: 0,
                }}>
                  {task.note}
                </MultilineText>
              ) : (
                <p style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                  No task description provided.
                </p>
              )}
            </div>
          </div>

          {/* Acknowledge Task — delegated, unacknowledged, assignee only */}
          {onAcknowledge && !task.acknowledged_at && task.status !== 'completed'
            && currentUserId === task.assigned_to && task.created_by !== currentUserId && (
            <div style={{
              padding: '9px 10px',
              borderRadius: '8px',
              border: `1.5px solid ${colors.amber}60`,
              background: `${colors.amber}0a`,
            }}>
              <div style={{
                fontSize: '9px', fontWeight: 700,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                color: colors.amber, marginBottom: '8px',
              }}>
                Action Required
              </div>
              <button
                disabled={acknowledging}
                onClick={async () => {
                  setAcknowledging(true)
                  try { await onAcknowledge() } finally { setAcknowledging(false) }
                }}
                style={{
                  width: '100%', padding: '8px 14px', borderRadius: '6px',
                  border: `1.5px solid ${colors.amber}`,
                  background: acknowledging ? colors.float : colors.amberTint,
                  color: acknowledging ? colors.muted : '#92600A',
                  cursor: acknowledging ? 'not-allowed' : 'pointer',
                  fontSize: '12.5px', fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => { if (!acknowledging) e.currentTarget.style.background = `${colors.amber}28` }}
                onMouseLeave={e => { e.currentTarget.style.background = acknowledging ? colors.float : colors.amberTint }}
              >
                <CheckCircle size={15} />
                {acknowledging ? 'Acknowledging…' : 'Acknowledge Task'}
              </button>
            </div>
          )}

          {/* Divider */}
          <div style={{ height: '1px', background: colors.border }} />

          {/* Recent Update */}
          <div>
            <div style={{
              fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: colors.muted, marginBottom: '8px',
            }}>
              Recent Update
            </div>

            {logLoading ? (
              <p style={{ fontSize: '11.5px', color: colors.muted, margin: 0 }}>Loading…</p>
            ) : activityLog.length === 0 ? (
              <p style={{ fontSize: '11.5px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                No activity recorded yet.
              </p>
            ) : (() => {
              const entry = activityLog[0]
              const actorName = userMap?.[entry.actor_id] ?? 'Someone'
              const label     = formatLogAction(entry.action, entry.from_status, entry.to_status)
              return (
                <div style={{
                  padding: '8px 10px', borderRadius: '6px',
                  background: colors.raised,
                  border: `1px solid ${colors.borderSoft}`,
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', gap: '8px', marginBottom: entry.note ? '4px' : 0,
                  }}>
                    <span style={{ fontSize: '11px', fontWeight: 500, color: colors.secondary }}>
                      {label}
                    </span>
                    <span style={{
                      fontSize: '10px', color: colors.muted,
                      whiteSpace: 'nowrap', flexShrink: 0,
                    }}
                      title={formatDateTime(entry.created_at)}
                    >
                      {timeAgo(entry.created_at)}
                    </span>
                  </div>
                  {entry.note && (
                    <MultilineText style={{
                      fontSize: '11px', color: colors.muted,
                      margin: '0 0 3px', lineHeight: 1.5,
                    }}>
                      {entry.note}
                    </MultilineText>
                  )}
                  <span style={{ fontSize: '10px', color: colors.muted }}>
                    by {actorName}
                  </span>
                </div>
              )
            })()}
          </div>

        </div>

        {/* Sticky footer */}
        <div style={{
          padding:       '10px 14px',
          borderTop:     `1px solid ${colors.border}`,
          background:    colors.raised,
          flexShrink:    0,
          display:       'flex',
          flexDirection: 'column',
          gap:           '7px',
        }}>
          {onOpenFullPage && (
            <button
              onClick={onOpenFullPage}
              style={{
                width: '100%', padding: '9px 14px', borderRadius: '7px',
                border: 'none',
                background: colors.blue,
                color: '#fff',
                cursor: 'pointer',
                fontSize: '13px', fontWeight: 600,
                transition: 'opacity 0.12s',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              View Task Page ↗
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              width: '100%', padding: '7px 14px', borderRadius: '7px',
              border: `1px solid ${colors.borderSoft}`,
              background: 'transparent',
              color: colors.secondary,
              cursor: 'pointer',
              fontSize: '12px', fontWeight: 500,
              transition: 'background 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = colors.float)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            Close
          </button>
        </div>

      </div>
    </>
  )
}
