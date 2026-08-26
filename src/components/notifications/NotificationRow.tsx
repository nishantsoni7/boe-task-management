'use client'

import type { Notification } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { timeAgo } from '@/lib/ui'
import { getNotificationMeta } from '@/lib/notificationMeta'
import { ExternalLink, Clock, Trash2, Check } from 'lucide-react'

// A standalone notification row — a notification with NO task_id.
//
// Lifted verbatim out of NotificationsView's list so that task-grouped events
// and taskless ones are rendered by different components with no shared
// branching: a Finance approval and a payroll issue have nothing in common but
// the absence of a task id, so they are never collapsed together and keep the
// exact row they have always had.

export function NotificationRow({
  n,
  isLast,
  selected: isSelectedProp,
  pending,
  onToggleSelect,
  onOpen,
  onDelete,
  onRowClick,
}: {
  n: Notification
  isLast: boolean
  selected: boolean
  pending: boolean
  onToggleSelect: (id: string) => void
  onOpen: (n: Notification) => void
  onDelete: (id: string) => void
  onRowClick: (n: Notification) => void
}) {
  const meta = getNotificationMeta(n)
  const isSelected = isSelectedProp
  // Primary line is the task title (body) for person-driven task rows;
  // for module rows and system rows it is the operational title so the
  // request number / headline stays visible. Body then becomes the
  // secondary context line (task title, or client name for modules).
  const primaryText   = meta.headingIsActor && n.body ? n.body : n.title
  const secondaryText = meta.headingIsActor && n.body ? null : n.body

  return (
    <div
      onClick={() => onRowClick(n)}
      style={{
        display: 'flex', alignItems: 'center',
        borderLeft: isSelected
          ? `3px solid ${colors.blue}`
          : n.is_read ? '3px solid transparent' : `3px solid ${colors.blue}`,
        background: isSelected
          ? 'rgba(85,133,232,0.10)'
          : n.is_read ? '#ffffff' : colors.blueTint,
        borderBottom: isLast ? 'none' : `1px solid ${colors.border}`,
        transition: 'background 0.12s',
        cursor: n.is_read ? 'default' : 'pointer',
      }}
    >
      {/* ── Checkbox ── */}
      <div
        onClick={e => { e.stopPropagation(); onToggleSelect(n.id) }}
        title={isSelected ? 'Deselect' : 'Select'}
        style={{
          flexShrink: 0,
          width: '40px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          alignSelf: 'stretch',
          cursor: 'pointer',
        }}
      >
        <span style={{
          width: '16px', height: '16px', borderRadius: '4px',
          border: `1.5px solid ${isSelected ? colors.blue : colors.borderSoft}`,
          background: isSelected ? colors.blue : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          transition: 'all 0.12s',
        }}>
          {isSelected && <Check size={10} color="#fff" strokeWidth={3} />}
        </span>
      </div>

      {/* ── Content ── */}
      <div style={{
        flex: 1, minWidth: 0,
        padding: '13px 8px 13px 0',
        display: 'flex', flexDirection: 'column', gap: '4px',
      }}>
        {/* Heading (task actor or module label) + badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
          <span style={{
            fontSize: '13px',
            fontWeight: meta.headingIsActor ? 700 : 600,
            color: meta.headingIsActor ? colors.primary : colors.secondary,
            lineHeight: 1,
          }}>
            {meta.heading}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 7px', borderRadius: '20px',
            fontSize: '10.5px', fontWeight: 600, lineHeight: 1,
            color: meta.badge.color, background: meta.badge.bg,
            letterSpacing: '0.01em',
          }}>
            {meta.badge.label}
          </span>
        </div>

        {/* Primary line */}
        {primaryText && (
          <div style={{
            fontSize: '12px',
            color: n.is_read ? colors.tertiary : colors.secondary,
            fontWeight: 500, lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {primaryText}
          </div>
        )}
        {/* Secondary context (task title, or client name for modules) */}
        {secondaryText && (
          <div style={{
            fontSize: '12px', color: colors.tertiary, lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {secondaryText}
          </div>
        )}

        {/* Time */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          fontSize: '11px', color: colors.muted, marginTop: '1px',
        }}>
          <Clock size={10} strokeWidth={1.8} />
          {timeAgo(n.created_at)}
        </div>
      </div>

      {/* ── Right: View action + trash — fixed width so all rows align ── */}
      <div style={{
        width: '148px',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: '6px',
        padding: '0 16px 0 8px', flexShrink: 0,
      }}>
        {meta.href ? (
          <button
            onClick={e => { e.stopPropagation(); onOpen(n) }}
            title={meta.actionLabel}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              padding: '5px 12px', borderRadius: '6px',
              fontSize: '11.5px', fontWeight: 600,
              background: colors.blue,
              color: '#fff',
              border: 'none', cursor: 'pointer',
              fontFamily: font.body, whiteSpace: 'nowrap',
            }}
          >
            <ExternalLink size={11} strokeWidth={2.2} />
            {meta.actionLabel}
          </button>
        ) : (
          <span style={{ display: 'inline-block', width: '82px' }} />
        )}

        {/* Per-row trash — disabled while THIS row's DELETE is in
            flight, so a second click cannot fire a duplicate request. */}
        <button
          onClick={e => { e.stopPropagation(); onDelete(n.id) }}
          disabled={pending}
          title="Delete notification"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '28px', height: '28px', borderRadius: '6px',
            background: 'transparent',
            color: colors.muted,
            border: `1.5px solid ${colors.border}`,
            cursor: pending ? 'not-allowed' : 'pointer',
            opacity: pending ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          <Trash2 size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
