'use client'

import { useRouter } from 'next/navigation'
import type { Task } from '@/lib/types'
import {
  statusBadgeClass,
  isOverdue,
  formatShortDate,
  escalationLevel,
  initials,
  timeAgo,
  timeSince,
  getTaskAging,
} from '@/lib/ui'
import { colors, font } from '@/lib/tokens'

// ─── TaskCard ─────────────────────────────────────────────────────────────────
// Default behaviour: navigates to /tasks/[id].
// Pass `onClick` to override — used by dashboard to open the detail panel
// instead of navigating. Manager view does not pass `onClick`, so it keeps
// the navigate-on-click behaviour unchanged.
//
// showAssignee    — show assignee avatar + last update time (manager view)
// showEscalation  — show escalation/stale banner (manager view)

type TaskCardProps = {
  task: Task
  showAssignee?: boolean
  showEscalation?: boolean
  cardStyle?: React.CSSProperties
  /** Optional override for click behaviour. If omitted, navigates to /tasks/[id]. */
  onClick?: () => void
  /** Optional content rendered inside the card below the main body. */
  footer?: React.ReactNode
}

export function TaskCard({
  task,
  showAssignee = false,
  showEscalation = false,
  cardStyle,
  onClick,
  footer,
}: TaskCardProps) {
  const router  = useRouter()
  const overdue = isOverdue(task.due_date)
  const level   = showEscalation
    ? escalationLevel(task.last_update_at, task.status, task.due_date, task.created_at)
    : null

  const getCardModifier = (): string => {
    if (task.is_urgent)            return 'boe-card-urgent'
    if (overdue)                   return 'boe-card-overdue'
    if (task.status === 'blocked') return 'boe-card-blocked'
    return ''
  }

  const escalationStyle =
    level === 'overdue' || level === 'danger'
      ? { borderLeftColor: colors.red,   backgroundColor: 'rgba(217,79,79,0.03)' }
      : level === 'caution'
      ? { borderLeftColor: colors.amber, backgroundColor: 'rgba(232,160,48,0.02)' }
      : {}

  const handleClick = onClick ?? (() => router.push(`/tasks/${task.id}`))

  return (
    <div
      onClick={handleClick}
      className={`boe-card-interactive ${getCardModifier()}`}
      style={{ padding: '11px 13px', ...escalationStyle, ...cardStyle }}
    >

      {/* Escalation banners — manager view only */}
      {showEscalation && level === 'overdue' && (
        <EscalationBanner color={colors.red} text="⚠ Overdue — no action taken" />
      )}
      {showEscalation && level === 'danger' && !overdue && (
        <EscalationBanner color={colors.red} text="72h — escalation reached" />
      )}
      {showEscalation && level === 'caution' && !overdue && (
        <EscalationBanner color={colors.amber} text="48h — no update" />
      )}
      {showEscalation && task.is_stale && !level && (
        <EscalationBanner
          color={colors.secondary}
          text={`Same status for ${task.stale_day_count ?? 0}d — no visible progress`}
        />
      )}

      {/* Important flag */}
      {task.is_urgent && (
        <p style={{
          fontSize: '10px', color: '#C49A28', fontWeight: 600,
          letterSpacing: '0.04em', marginBottom: '5px',
        }}>
          ⭐ Important
        </p>
      )}

      {/* Title */}
      <p style={{
        color: colors.primary, fontSize: '15px', fontWeight: 600,
        lineHeight: 1.35, marginBottom: '9px',
      }}>
        {task.title}
      </p>

      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className={statusBadgeClass(task.status)}>{task.status}</span>

        {task.status === 'blocked' && task.blocker_reason && (
          <span style={{
            fontSize: '11px', color: colors.red,
            background: 'rgba(217,79,79,0.06)',
            padding: '2px 6px', borderRadius: '3px',
            fontFamily: font.mono,
          }}>
            ⛔ {task.blocker_reason}
          </span>
        )}

        {task.status === 'waiting' && task.waiting_on_type && (
          <span style={{
            fontSize: '11px', color: colors.amber,
            background: 'rgba(232,160,48,0.08)',
            padding: '2px 6px', borderRadius: '3px',
            fontFamily: font.mono,
          }}>
            ⏳ {task.waiting_on_type === 'external'
              ? (task.waiting_on_text ?? 'External')
              : 'Team member'
            }
          </span>
        )}

        <PriorityBadge priority={task.priority} />
        <AgingBadge task={task} />

        {/* Right side: due date + ack state */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px' }}>
          {task.due_date && (
            <span style={{
              fontSize: '10px',
              fontFamily: font.mono,
              color:      overdue ? colors.red  : colors.muted,
              background: overdue ? 'rgba(217,79,79,0.07)' : 'transparent',
              padding:    overdue ? '1px 5px'  : '0',
              borderRadius: '3px',
            }}>
              {overdue ? 'Overdue · ' : ''}
              {formatShortDate(task.due_date)}
            </span>
          )}

          {!task.acknowledged_at && task.status !== 'completed' && (
            <span className="boe-unack-pill">
              {timeSince(task.created_at)} unacked
            </span>
          )}
          {task.acknowledged_at && task.status !== 'completed' && (
            <span className="boe-ack-pill">
              ✓ {timeSince(task.acknowledged_at)}
            </span>
          )}
        </div>
      </div>

      {/* Assignee footer — manager view only */}
      {showAssignee && task.assignee_name && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: '10px', paddingTop: '8px',
          borderTop: `1px solid ${colors.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Avatar name={task.assignee_name} size={20} />
            <span style={{ fontSize: '11px', color: colors.tertiary }}>
              {task.assignee_name}
            </span>
          </div>
          {task.last_update_at && (
            <span style={{ fontSize: '10px', color: colors.muted, fontFamily: font.mono }}>
              {timeAgo(task.last_update_at)}
            </span>
          )}
        </div>
      )}

      {/* Optional footer slot — e.g. Acknowledge button on dashboard */}
      {footer && (
        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${colors.border}` }}>
          {footer}
        </div>
      )}

    </div>
  )
}

// ─── PriorityBadge ────────────────────────────────────────────────────────────
function PriorityBadge({ priority }: { priority: string }) {
  const cfg: Record<string, { label: string; color: string; bg: string; border: string }> = {
    high:   { label: 'High',   color: '#B03030', bg: 'rgba(217,79,79,0.12)',  border: 'rgba(217,79,79,0.30)' },
    medium: { label: 'Medium', color: '#A06010', bg: 'rgba(232,160,48,0.12)', border: 'rgba(232,160,48,0.30)' },
    low:    { label: 'Low',    color: '#6B7384', bg: 'rgba(0,0,0,0.05)',       border: 'rgba(0,0,0,0.10)'     },
  }
  const { label, color, bg, border } = cfg[priority] ?? cfg.low
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em',
      textTransform: 'uppercase', color, background: bg,
      border: `1px solid ${border}`,
      padding: '1px 6px', borderRadius: '4px', flexShrink: 0,
    }}>
      {label}
    </span>
  )
}

// ─── AgingBadge ───────────────────────────────────────────────────────────────
function AgingBadge({ task }: { task: Task }) {
  const aging = getTaskAging(task)
  if (!aging) return null
  const color = aging.severity === 'danger' ? colors.red : colors.amber
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700,
      color,
      background: `${color}12`,
      border: `1px solid ${color}30`,
      padding: '1px 6px', borderRadius: '4px',
      flexShrink: 0,
      letterSpacing: '0.03em',
    }}>
      {aging.label}
    </span>
  )
}

// ─── EscalationBanner ─────────────────────────────────────────────────────────
function EscalationBanner({ color, text }: { color: string; text: string }) {
  return (
    <p style={{
      fontSize: '10px', color, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.04em',
      marginBottom: '6px',
    }}>
      {text}
    </p>
  )
}

// ─── Avatar (internal) ────────────────────────────────────────────────────────
function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <div
      className="boe-avatar"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials(name)}
    </div>
  )
}

// ─── TaskSection ──────────────────────────────────────────────────────────────
// Titled group of TaskCards with a count badge.
// Used on dashboard for Unacknowledged / Overdue / Active sections.

type TaskSectionProps = {
  title: string
  tasks: Task[]
  showAssignee?: boolean
  showEscalation?: boolean
}

export function TaskSection({
  title,
  tasks,
  showAssignee,
  showEscalation,
}: TaskSectionProps) {
  if (tasks.length === 0) return null

  return (
    <div style={{ marginBottom: '20px' }}>
      <div className="boe-section-label">
        {title}
        <span style={{
          marginLeft: 'auto',
          fontFamily: font.mono,
          fontSize: '10px',
          padding: '1px 6px',
          borderRadius: '3px',
          background: 'rgba(255,255,255,0.03)',
          border: `1px solid ${colors.border}`,
          color: colors.secondary,
        }}>
          {tasks.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {tasks.map(t => (
          <TaskCard
            key={t.id}
            task={t}
            showAssignee={showAssignee}
            showEscalation={showEscalation}
          />
        ))}
      </div>
    </div>
  )
}
