'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import Link from 'next/link'
import type { Task, LogEntry } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { isOverdue, formatShortDate, formatDateTime, timeAgo, getTaskAging } from '@/lib/ui'
import { headlineOf, statusReasonOf, latestUpdatesOf } from '@/lib/tasks/taskDrawerBrief'
import { createClient } from '@/lib/supabase/client'
import { MultilineText } from '@/components/ui/MultilineText'
import { ExpandableText } from '@/components/ui/ExpandableText'
import { CheckCircle } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  task: Task
  userMap?: Record<string, string>
  onClose: () => void
  onOpenFullPage?: () => void
  /** The full task page. When given, View Task Page is a real link and
   *  onOpenFullPage is not used — see the footer for why. */
  fullPageHref?: string
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
  pending:          colors.muted,
  started:          colors.secondary,
  working:          colors.blue,
  waiting:          colors.amber,
  blocked:          colors.red,
  pending_approval: '#805B0D',
  completed:        colors.green,
}

// View Task Page — one look whether it renders as a link or a button.
const FULL_PAGE_BUTTON: React.CSSProperties = {
  width: '100%', minHeight: '44px', padding: '9px 14px', borderRadius: '8px',
  border: 'none',
  background: colors.brand,
  color: '#fff',
  cursor: 'pointer',
  fontSize: '14px', fontWeight: 600,
  transition: 'opacity 0.12s',
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.07em', color: colors.muted, margin: '0 0 7px',
}

// "Show more" only appears under a text that runs long. 44 px to tap, but the
// negative margin keeps the gap under the text from growing by the same amount.
const SHOW_MORE: React.CSSProperties = {
  minHeight: '44px', display: 'flex', alignItems: 'center', margin: '-10px 0',
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: colors.muted, marginBottom: '3px',
      }}>
        {label}
      </div>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  )
}

// ─── TaskDetailPanel ──────────────────────────────────────────────────────────

export function TaskDetailPanel({ task, userMap, onClose, onOpenFullPage, fullPageHref, currentUserId, onAcknowledge }: Props) {
  const [open,          setOpen]        = useState(false)
  const [opening,       setOpening]     = useState(false)
  // Read synchronously, so a second click in the same tick is refused before
  // React has re-rendered the link as busy.
  const openingRef = useRef(false)
  const [acknowledging, setAcknowledging] = useState(false)
  const [activityLog,   setActivityLog] = useState<LogEntry[]>([])
  const [logLoading,    setLogLoading]  = useState(true)
  const [logFailed,     setLogFailed]   = useState(false)

  const supabase = useMemo(() => createClient(), [])

  // Reload log when a different task is opened
  useEffect(() => {
    // A slow answer for the task just left must not paint over the one now open:
    // the headline's reason is read from these rows.
    let stale = false
    const loadLog = () => {
      setActivityLog([])
      setLogLoading(true)
      setLogFailed(false)

      supabase
        .from('task_activity_log')
        .select('id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id')
        .eq('task_id', task.id)
        .order('created_at', { ascending: false })
        .limit(20)
        .then(({ data, error }: { data: LogEntry[] | null; error: unknown }) => {
          if (stale) return
          if (data) setActivityLog(data)
          setLogFailed(Boolean(error) || !data)
          setLogLoading(false)
        })
    }
    loadLog()
    return () => { stale = true }
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

  const overdue        = isOverdue(task.due_date, task.status)
  const priority       = PRIORITY[task.priority] ?? PRIORITY.low
  const statusColor    = STATUS_COLOR[task.status] ?? colors.muted
  const isSelfAssigned = task.assigned_to === task.created_by
  const assignedByName = isSelfAssigned
    ? 'Self'
    : (userMap?.[task.created_by] ?? '—')
  const nameOf         = (id: string) => userMap?.[id] ?? 'Someone'

  // The brief: read off the task and the log rows already loaded above.
  const headline = headlineOf(task, {
    userMap, currentUserId, today: new Date().toISOString().slice(0, 10),
  })
  const statusReason = statusReasonOf(task, activityLog)
  // The update that set the status is already said, with its reason, in the
  // headline card above; its line keeps who and when but not the same words twice.
  const updates      = latestUpdatesOf(activityLog).map(u => u.id === statusReason.id ? { ...u, detail: null } : u)
  const aging        = getTaskAging(task)
  const agingColor   = aging?.severity === 'danger' ? colors.red : colors.amber

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
          <div style={{ flex: 1, minWidth: 0 }}>
            {task.is_urgent && (
              <div style={{
                fontSize: '12px', fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                color: '#805B0D', marginBottom: '4px',
              }}>
                Important
              </div>
            )}
            <p style={{
              fontSize: '15px', fontWeight: 600,
              color: colors.primary, lineHeight: 1.45, margin: 0,
              overflowWrap: 'anywhere',
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
              fontSize: '20px', lineHeight: 1,
              padding: '8px', flexShrink: 0,
              minWidth: '44px', minHeight: '44px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '6px',
              transition: 'color 0.14s, background 0.14s',
              margin: '-6px -8px -6px 0',
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
          overscrollBehavior: 'contain',
          scrollbarWidth: 'thin',
          scrollbarColor: `rgba(0,0,0,0.08) transparent`,
          padding:        '14px 16px',
          display:        'flex',
          flexDirection:  'column',
          gap:            '14px',
        }}>

          {/* Where the task stands: status, when it is due, who holds it — and why. */}
          <div style={{
            padding: '12px 14px',
            borderRadius: '8px',
            background: colors.raised,
            border: `1px solid ${colors.border}`,
            borderLeft: `4px solid ${statusColor}`,
          }}>
            <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: colors.secondary }}>
              <strong style={{ fontWeight: 700, color: statusColor }}>{headline.status}</strong>
              {' · '}
              <span style={overdue ? { color: colors.red, fontWeight: 600 } : undefined}>{headline.due}</span>
              {headline.who && <>{' · '}{headline.who}</>}
            </p>
            {statusReason.reason && (
              <ExpandableText
                clampLines={3}
                moreLabel="Show more"
                toggleStyle={SHOW_MORE}
                style={{ fontSize: '13px', color: colors.primary, lineHeight: 1.55, margin: '8px 0 0' }}
              >
                {statusReason.reason}
              </ExpandableText>
            )}
            {statusReason.actorId && statusReason.at && (
              <p style={{ margin: '8px 0 0', fontSize: '12px', color: colors.muted }}>
                Set by {nameOf(statusReason.actorId)}{' · '}
                <span title={formatDateTime(statusReason.at)}>{timeAgo(statusReason.at)}</span>
              </p>
            )}
          </div>

          {/* Waiting On — shown when task is in waiting status */}
          {task.status === 'waiting' && (task.waiting_on_type) && (
            <div style={{
              padding: '10px 12px',
              borderRadius: '8px',
              background: `${colors.amber}0d`,
              border: `1.5px solid ${colors.amber}40`,
              borderLeft: `3px solid ${colors.amber}`,
            }}>
              <div style={{
                fontSize: '12px', fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: colors.amber, marginBottom: '5px',
              }}>
                Waiting On
              </div>
              <p style={{
                fontSize: '13px', color: colors.amber,
                margin: 0, lineHeight: 1.55,
              }}>
                {task.waiting_on_type === 'team_member'
                  ? (userMap?.[task.waiting_on_user_id ?? ''] ?? 'Team member')
                  : (task.waiting_on_text ?? '—')
                }
              </p>
              <p style={{ fontSize: '12px', color: colors.muted, margin: '3px 0 0' }}>
                {task.waiting_on_type === 'team_member' ? 'Team Member' : 'External Dependency'}
              </p>
            </div>
          )}

          {/* Blocker reason — prominent section, visible above everything else */}
          {task.status === 'blocked' && task.blocker_reason && (
            <div style={{
              padding: '10px 12px',
              borderRadius: '8px',
              background: `${colors.red}0d`,
              border: `1.5px solid ${colors.red}40`,
              borderLeft: `3px solid ${colors.red}`,
            }}>
              <div style={{
                fontSize: '12px', fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: colors.red, marginBottom: '5px',
              }}>
                Blocker Reason
              </div>
              <MultilineText style={{
                fontSize: '13px', color: colors.red,
                margin: 0, lineHeight: 1.55,
              }}>
                {task.blocker_reason}
              </MultilineText>
            </div>
          )}

          {/* Acknowledge Task — delegated, unacknowledged, assignee only */}
          {onAcknowledge && !task.acknowledged_at && task.status !== 'completed'
            && currentUserId === task.assigned_to && task.created_by !== currentUserId && (
            <div style={{
              padding: '10px 12px',
              borderRadius: '8px',
              border: `1.5px solid ${colors.amber}60`,
              background: `${colors.amber}0a`,
            }}>
              <div style={{
                fontSize: '12px', fontWeight: 700,
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
                  width: '100%', minHeight: '44px', padding: '8px 14px', borderRadius: '8px',
                  border: `1.5px solid ${colors.amber}`,
                  background: acknowledging ? colors.float : colors.amberTint,
                  color: acknowledging ? colors.muted : '#92600A',
                  cursor: acknowledging ? 'not-allowed' : 'pointer',
                  fontSize: '13px', fontWeight: 600,
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

          {/* Latest updates — the last few real ones; system lines are skipped */}
          <section aria-label="Latest updates">
            <h3 style={SECTION_LABEL}>Latest updates</h3>
            {logLoading ? (
              <p style={{ fontSize: '13px', color: colors.muted, margin: 0 }}>Loading…</p>
            ) : logFailed ? (
              <p style={{ fontSize: '13px', color: colors.muted, margin: 0 }}>
                Could not load the updates. Open the task page to see them.
              </p>
            ) : updates.length === 0 ? (
              <p style={{ fontSize: '13px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                No updates yet.
              </p>
            ) : (
              <ol style={{
                listStyle: 'none', margin: 0, padding: 0,
                borderRadius: '8px', background: colors.raised,
                border: `1px solid ${colors.border}`,
              }}>
                {updates.map((u, i) => (
                  <li key={u.id} style={{
                    padding: '10px 12px',
                    borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                      <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.45, color: colors.secondary, minWidth: 0 }}>
                        <strong style={{ fontWeight: 600, color: colors.primary }}>{nameOf(u.actorId)}</strong>{' '}{u.what}
                      </p>
                      <span
                        title={formatDateTime(u.at)}
                        style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap', flexShrink: 0, paddingTop: '1px' }}
                      >
                        {timeAgo(u.at)}
                      </span>
                    </div>
                    {u.detail && (
                      <ExpandableText
                        clampLines={3}
                        moreLabel="Show more"
                        toggleStyle={SHOW_MORE}
                        style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.5, margin: '4px 0 0' }}
                      >
                        {u.detail}
                      </ExpandableText>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Facts */}
          <section aria-label="Task facts">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <Fact label="Priority">
                <span style={{
                  display: 'inline-block',
                  fontSize: '12px', fontWeight: 600,
                  color: priority.color, background: priority.bg,
                  padding: '2px 8px', borderRadius: '6px',
                }}>
                  {priority.label}
                </span>
              </Fact>
              <Fact label="Due">
                {task.due_date ? (
                  <span style={{ color: overdue ? colors.red : colors.secondary, fontWeight: overdue ? 600 : 400 }}>
                    {formatShortDate(task.due_date)}
                    {overdue && <span style={{ marginLeft: '5px', fontSize: '12px' }}>Overdue</span>}
                  </span>
                ) : '—'}
              </Fact>
              <Fact label="Assigned by">{assignedByName}</Fact>
              <Fact label="Last update">
                {task.last_update_at
                  ? <span title={formatDateTime(task.last_update_at)}>{timeAgo(task.last_update_at)}</span>
                  : <span title={formatDateTime(task.created_at)}>{timeAgo(task.created_at)} (created)</span>
                }
              </Fact>
            </div>
            {aging && (
              <p style={{ margin: '10px 0 0', fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
                <span style={{
                  fontWeight: 700,
                  color: agingColor,
                  background: `${agingColor}12`,
                  border: `1px solid ${agingColor}30`,
                  padding: '2px 8px', borderRadius: '6px',
                }}>
                  {aging.label}
                </span>
                {' '}{aging.message}
              </p>
            )}
          </section>

          {/* Task Description — three lines, then "Show more" */}
          <section aria-label="Task description">
            <h3 style={SECTION_LABEL}>Task Description</h3>
            <div style={{
              padding: '8px 12px', borderRadius: '8px',
              background: colors.raised,
              border: `1px solid ${colors.border}`,
            }}>
              {task.note ? (
                <ExpandableText
                  clampLines={3}
                  moreLabel="Show more"
                  toggleStyle={SHOW_MORE}
                  style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6, margin: 0 }}
                >
                  {task.note}
                </ExpandableText>
              ) : (
                <p style={{ fontSize: '13px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                  No task description provided.
                </p>
              )}
            </div>
          </section>

        </div>

        {/* Sticky footer */}
        <div style={{
          // Bottom padding clears a phone's home bar.
          padding:       '10px 14px max(10px, env(safe-area-inset-bottom))',
          borderTop:    `1px solid ${colors.border}`,
          background:    colors.raised,
          flexShrink:    0,
          display:       'flex',
          flexDirection: 'column',
          gap:           '8px',
        }}>
          {/* View Task Page as a LINK. What it does that close-then-router.push
              did not:
                1. Next prefetches the route while the drawer is open (the
                   route's loading.tsx is what makes that prefetch useful), so
                   the click has little or nothing left to wait for.
                2. The drawer is NOT closed first. Closing it before the page
                   arrived left the Dashboard on screen with no sign the click
                   had landed — which is why people clicked three or four times.
                3. It says "Opening task…" and ignores repeat activation until
                   the task page takes over and this drawer unmounts with it.
              Enter activates it like any link; a modified click opens a tab. */}
          {fullPageHref ? (
            <Link
              href={fullPageHref}
              aria-busy={opening || undefined}
              onClick={e => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                if (openingRef.current) { e.preventDefault(); return }
                openingRef.current = true
                setOpening(true)
              }}
              style={{
                ...FULL_PAGE_BUTTON,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxSizing: 'border-box',
                textAlign: 'center', textDecoration: 'none',
                cursor: opening ? 'progress' : 'pointer',
                opacity: opening ? 0.8 : 1,
              }}
              onMouseEnter={e => { if (!opening) e.currentTarget.style.opacity = '0.88' }}
              onMouseLeave={e => { e.currentTarget.style.opacity = opening ? '0.8' : '1' }}
            >
              {opening ? 'Opening task…' : 'View Task Page ↗'}
            </Link>
          ) : onOpenFullPage && (
            <button
              onClick={onOpenFullPage}
              style={FULL_PAGE_BUTTON}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              View Task Page ↗
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              width: '100%', minHeight: '44px', padding: '7px 14px', borderRadius: '8px',
              border: `1px solid ${colors.borderSoft}`,
              background: 'transparent',
              color: colors.secondary,
              cursor: 'pointer',
              fontSize: '14px', fontWeight: 500,
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
