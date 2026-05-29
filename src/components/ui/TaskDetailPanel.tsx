'use client'

import { useEffect, useState } from 'react'
import type { Task } from '@/lib/types'
import {
  statusBadgeClass,
  isOverdue,
  formatShortDate,
  timeAgo,
  escalationLevel,
} from '@/lib/ui'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  task: Task
  onClose: () => void
}

// ─── Status options shown in the update row (visual-only in this phase) ───────
const STATUS_OPTIONS = [
  { key: 'started',   label: 'Started'   },
  { key: 'working',   label: 'Working'   },
  { key: 'waiting',   label: 'Waiting'   },
  { key: 'blocked',   label: 'Blocked'   },
  { key: 'completed', label: 'Done'      },
] as const

// ─── TaskDetailPanel ──────────────────────────────────────────────────────────
//
// Phase 2 Step 1 — read-only panel. No Supabase mutations.
//
// Desktop (≥ 768px):  fixed right-side drawer, 420px wide, full height.
// Mobile  (< 768px):  fixed bottom sheet, 92vh, slides up.
//
// Interactions wired:
//   ✓  close button
//   ✓  Escape key
//   ✓  backdrop click
//   ✓  body scroll lock
//
// Not yet interactive:
//   ✗  status buttons
//   ✗  add note
//   ✗  details strip

export function TaskDetailPanel({ task, onClose }: Props) {
  // Entrance animation: mount with panel off-screen → rAF → slide in.
  const [open, setOpen] = useState(false)

  // Read isMobile synchronously — panel is always client-side (rendered after click).
  const isMobile =
    typeof window !== 'undefined' ? window.innerWidth < 768 : false

  // ── Entrance animation ────────────────────────────────────────────────────
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // ── Escape key ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // ── Body scroll lock ──────────────────────────────────────────────────────
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // ── State helpers ─────────────────────────────────────────────────────────
  const overdue = isOverdue(task.due_date)
  const level   = escalationLevel(task.last_update_at, task.status, task.due_date)

  const showAlert = overdue || level === 'danger' || level === 'caution'
  const alertIsRed =
    overdue || level === 'danger' || level === 'overdue'

  const alertText = overdue
    ? '⚠ Overdue — action required'
    : level === 'danger'
    ? '72h without update — escalation reached'
    : '48h without update — check in required'

  // ── Animation values ──────────────────────────────────────────────────────
  const desktopTransform = open ? 'translateX(0)' : 'translateX(100%)'
  const mobileTransform  = open ? 'translateY(0)' : 'translateY(100%)'
  const duration         = isMobile ? '220ms' : '180ms'

  // ── Shared panel styles ───────────────────────────────────────────────────
  const panelBase: React.CSSProperties = {
    position:         'fixed',
    zIndex:           50,
    background:       '#FFFFFF',
    display:          'flex',
    flexDirection:    'column',
    overflowY:        'auto',
    scrollbarWidth:   'thin',
    scrollbarColor:   'rgba(0,0,0,0.08) transparent',
    willChange:       'transform',
  }

  const desktopStyles: React.CSSProperties = {
    top:             0,
    right:           0,
    bottom:          0,
    width:           '420px',
    borderLeft:      '1px solid rgba(0,0,0,0.1)',
    boxShadow:       '-8px 0 32px rgba(0,0,0,0.1)',
    transform:       desktopTransform,
    transition:      `transform ${duration} ease-out`,
  }

  const mobileStyles: React.CSSProperties = {
    bottom:          0,
    left:            0,
    right:           0,
    height:          '92vh',
    borderRadius:    '12px 12px 0 0',
    borderTop:       '1px solid rgba(0,0,0,0.1)',
    boxShadow:       '0 -8px 32px rgba(0,0,0,0.1)',
    transform:       mobileTransform,
    transition:      `transform ${duration} ease-out`,
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop ──────────────────────────────────────────────────────── */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position:   'fixed',
          inset:      0,
          background: 'rgba(0,0,0,0.42)',
          zIndex:     49,
        }}
      />

      {/* Panel ─────────────────────────────────────────────────────────── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        style={{ ...panelBase, ...(isMobile ? mobileStyles : desktopStyles) }}
      >

        {/* ── Sticky header ──────────────────────────────────────────── */}
        <div style={{
          padding:      '13px 16px 11px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          background:   '#F8F9FB',
          position:     'sticky',
          top:          0,
          zIndex:       1,
          flexShrink:   0,
          display:      'flex',
          alignItems:   'flex-start',
          gap:          '10px',
        }}>
          <p style={{
            flex:       1,
            fontSize:   '13px',
            fontWeight: 600,
            color:      '#111318',
            lineHeight: 1.45,
          }}>
            {task.is_urgent && (
              <span style={{
                display:       'inline-block',
                fontSize:      '9px',
                color:         '#D94F4F',
                fontWeight:    700,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                marginBottom:  '4px',
              }}>
                ⚡ Urgent &nbsp;·&nbsp;
              </span>
            )}
            {task.title}
          </p>
          <button
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: 'none',
              border:     'none',
              color:      '#6B7384',
              cursor:     'pointer',
              fontSize:   '18px',
              lineHeight: 1,
              padding:    '0 2px',
              flexShrink: 0,
              marginTop:  '0px',
              transition: 'color 0.14s ease',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = '#111318')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7384')}
          >
            ×
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div style={{
          padding:       '12px 16px',
          flex:          1,
          display:       'flex',
          flexDirection: 'column',
          gap:           '12px',
        }}>

          {/* Meta row: status + due date + last updated */}
          <div style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '7px',
            flexWrap:   'wrap',
          }}>
            <span className={statusBadgeClass(task.status)}>
              {task.status}
            </span>

            {task.due_date && (
              <span style={{
                fontSize:   '11px',
                fontFamily: 'DM Mono, monospace',
                color:      overdue ? '#C13030' : '#6B7384',
                background: overdue
                  ? 'rgba(217,79,79,0.08)'
                  : 'rgba(0,0,0,0.05)',
                padding:    '2px 6px',
                borderRadius: '3px',
              }}>
                {formatShortDate(task.due_date)}
              </span>
            )}

            <span style={{
              marginLeft: 'auto',
              fontSize:   '10px',
              fontFamily: 'DM Mono, monospace',
              color:      '#8C94A6',
            }}>
              {task.last_update_at
                ? `updated ${timeAgo(task.last_update_at)}`
                : 'never updated'}
            </span>
          </div>

          {/* Alert strip — one only, highest severity */}
          {showAlert && (
            <div className={alertIsRed ? 'boe-alert-red' : 'boe-alert-amber'}>
              <p style={{
                fontSize:   '11px',
                fontWeight: 600,
                color:      alertIsRed ? '#D94F4F' : '#E8A030',
                lineHeight: 1.4,
              }}>
                {alertText}
              </p>
            </div>
          )}

          {/* Divider */}
          <div className="boe-divider" style={{ margin: 0 }} />

          {/* ── Update status row — visual only ────────────────────── */}
          <div>
            <p style={{
              fontSize:      '9px',
              fontWeight:    700,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color:         '#6B7384',
              marginBottom:  '7px',
            }}>
              Update Status
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {STATUS_OPTIONS.map(({ key, label }) => {
                const isCurrent = task.status === key
                return (
                  <button
                    key={key}
                    type="button"
                    className={`boe-status-btn${isCurrent ? ` boe-status-btn-active-${key}` : ''}`}
                    style={{
                      cursor:        'default',
                      pointerEvents: 'none',
                      // Non-current: lift text to readable secondary colour directly.
                      // Do NOT use opacity — it blends with the dark panel and kills contrast.
                      ...(!isCurrent && { color: '#6B7384', background: '#F4F5F7' }),
                    }}
                  >
                    <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
                    {isCurrent && (
                      <span style={{
                        fontSize:   '9px',
                        fontFamily: 'DM Mono, monospace',
                        color:      'inherit',
                        opacity:    0.65,
                      }}>
                        current
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Add note row — visual only ──────────────────────────── */}
          <div style={{
            padding:       '9px 11px',
            borderRadius:  '8px',
            background:    '#F4F5F7',
            border:        '1px solid rgba(0,0,0,0.08)',
            cursor:        'default',
            userSelect:    'none',
            pointerEvents: 'none',
          }}>
            <p style={{
              fontSize:  '12px',
              color:     '#8C94A6',
              fontStyle: 'italic',
            }}>
              Add a note…
            </p>
          </div>

          {/* Divider */}
          <div className="boe-divider" style={{ margin: 0 }} />

          {/* ── Recent activity — slot ready, empty this phase ─────── */}
          <div>
            <p style={{
              fontSize:      '9px',
              fontWeight:    700,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color:         '#6B7384',
              marginBottom:  '8px',
            }}>
              Recent Activity
            </p>
            {/* Placeholder rows — will be replaced with real LogEntry data */}
            <p style={{ fontSize: '11px', color: '#8C94A6', fontStyle: 'italic' }}>
              No recent activity loaded
            </p>
          </div>

          {/* ── Details & full history — collapsed strip ────────────── */}
          <div style={{ marginTop: 'auto', paddingTop: '4px' }}>
            <div style={{
              borderTop:      '1px solid rgba(0,0,0,0.08)',
              paddingTop:     '10px',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'space-between',
              opacity:        0.4,
              userSelect:     'none',
            }}>
              <span style={{
                fontSize:   '11px',
                color:      '#4A5261',
                fontWeight: 500,
              }}>
                Details &amp; full history
              </span>
              <span style={{ fontSize: '13px', color: '#6B7384' }}>›</span>
            </div>
          </div>

        </div>
      </div>
    </>
  )
}
