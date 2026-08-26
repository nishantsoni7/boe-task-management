'use client'

import { useId, useState } from 'react'
import { ChevronRight, Check, CheckCheck, ExternalLink, Clock, Trash2 } from 'lucide-react'
import type { Notification } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { timeAgo } from '@/lib/ui'
import { getNotificationMeta } from '@/lib/notificationMeta'
import {
  orderGroupEvents,
  type NotificationFilter,
  type NotificationTaskGroup as TaskGroup,
} from '@/lib/notifications/grouping'

// One task, one card.
//
// Collapsed it is a single line about the task; expanded it is the task's
// events, indented under a rail so it reads as a sequence belonging to one
// thing rather than four unrelated rows that happen to be adjacent.
//
// ── WHAT THE CONTROLS DO, AND WHAT THEY DELIBERATELY DO NOT ─────────────────
//
// Expanding is a disclosure and NOTHING else. It does not mark anything read:
// a reader who opens a group to see what happened has not decided they are done
// with it, and silently clearing the unread state would take that decision away
// and lose the badge that was the reason to look. Marking read is its own
// button.
//
// "Delete these updates" removes NOTIFICATION ROWS for this reader and this
// task. It cannot reach the task, its activity history, its comments, its
// attachments, or anybody else's notifications: it calls the existing
// /api/notifications/delete-selected with this group's loaded ids, and that
// endpoint is scoped to `user_id = caller`. It confirms first, because several
// records go at once — expanding, collapsing and marking read do not, because
// they are cheap and reversible.

export function NotificationTaskGroup({
  group,
  filter,
  selected,
  pendingDeletes,
  busy,
  onToggleSelect,
  onOpenTask,
  onMarkGroupRead,
  onDeleteGroup,
  onDeleteOne,
  onRowClick,
  isMobile = false,
}: {
  group: TaskGroup
  filter: NotificationFilter
  selected: ReadonlySet<string>
  pendingDeletes: ReadonlySet<string>
  /** True while a group-level mutation is in flight — disables its own actions. */
  busy?: boolean
  onToggleSelect: (id: string) => void
  onOpenTask: (group: TaskGroup) => void
  onMarkGroupRead: (group: TaskGroup) => void
  onDeleteGroup: (group: TaskGroup) => void
  onDeleteOne: (id: string) => void
  onRowClick: (n: Notification) => void
  isMobile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const panelId = `notif-group-${useId().replace(/:/g, '')}`

  const latestMeta = getNotificationMeta(group.latest)
  const hasUnread = group.unreadCount > 0
  const events = orderGroupEvents(group, filter)

  // "Dhruv added a comment" — actor and event, from the newest row. Falls back
  // to the badge alone when the title carries no parseable actor.
  const latestLine = latestMeta.headingIsActor
    ? `${latestMeta.heading} — ${latestMeta.badge.label}`
    : latestMeta.badge.label

  return (
    <div
      className="boe-card"
      style={{
        overflow: 'hidden', padding: 0, maxWidth: '900px', marginBottom: '8px',
        borderLeft: hasUnread ? `3px solid ${colors.blue}` : '3px solid transparent',
        background: hasUnread ? colors.blueTint : '#ffffff',
      }}
    >
      {/* ── Collapsed summary ── */}
      <div style={{
        display: 'flex',
        alignItems: isMobile ? 'flex-start' : 'center',
        flexDirection: isMobile ? 'column' : 'row',
        gap: isMobile ? '8px' : '10px',
        padding: isMobile ? '12px 14px' : '12px 16px',
      }}>
        {/* The accordion trigger. A real button wrapping only the summary text,
            so the actions beside it are siblings and cannot toggle the panel by
            being nested inside the trigger. */}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Collapse' : 'Expand'} updates for ${group.title}`}
          style={{
            flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined,
            display: 'flex', alignItems: 'flex-start', gap: '9px',
            background: 'transparent', border: 'none',
            // The trigger is the primary control on the card, so it gets the
            // same 44px floor as the buttons beside it.
            padding: isMobile ? '6px 0' : 0,
            minHeight: isMobile ? '44px' : undefined,
            cursor: 'pointer', textAlign: 'left', fontFamily: font.body,
          }}
        >
          <ChevronRight
            size={15}
            aria-hidden="true"
            style={{
              flexShrink: 0, marginTop: '2px', color: colors.muted,
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.12s',
            }}
          />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span style={{
              fontSize: '13px', fontWeight: 700, color: colors.primary, lineHeight: 1.3,
              // Wraps on mobile rather than truncating: the task title is the
              // only thing identifying the card.
              overflowWrap: 'anywhere',
              ...(isMobile ? {} : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
            }}>
              {group.title}
            </span>
            <span style={{
              fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.4,
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px',
            }}>
              {hasUnread && (
                <span style={{
                  fontSize: '10.5px', fontWeight: 700, color: '#fff', background: colors.blue,
                  borderRadius: '999px', padding: '1px 7px', whiteSpace: 'nowrap',
                }}>
                  {group.unreadCount} unread
                </span>
              )}
              <span style={{ overflowWrap: 'anywhere' }}>Latest: {latestLine}</span>
              <span aria-hidden="true">·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', whiteSpace: 'nowrap' }}>
                <Clock size={10} strokeWidth={1.8} />{timeAgo(group.latest.created_at)}
              </span>
              <span aria-hidden="true">·</span>
              {/* HONEST: what is loaded, not a claim about the server's total.
                  The list is bounded, so a group may hold older events that
                  have not been fetched. */}
              <span style={{ whiteSpace: 'nowrap' }}>
                {group.loadedCount} loaded update{group.loadedCount === 1 ? '' : 's'}
              </span>
            </span>
          </span>
        </button>

        {/* ── Group actions. Siblings of the trigger, never inside it. ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
          width: isMobile ? '100%' : undefined,
          justifyContent: isMobile ? 'flex-start' : 'flex-end',
          flexWrap: 'wrap',
        }}>
          {hasUnread && (
            <GroupAction
              onClick={() => onMarkGroupRead(group)}
              disabled={busy}
              label={`Mark all updates for this task as read: ${group.title}`}
              icon={<CheckCheck size={12} strokeWidth={2.2} />}
              text="Mark all read"
              isMobile={isMobile}
            />
          )}
          {latestMeta.href && (
            <GroupAction
              onClick={() => onOpenTask(group)}
              label={`View task ${group.title}`}
              icon={<ExternalLink size={11} strokeWidth={2.2} />}
              text="View Task"
              primary
              isMobile={isMobile}
            />
          )}
          <GroupAction
            onClick={() => onDeleteGroup(group)}
            disabled={busy}
            label={`Delete all notifications for this task: ${group.title}`}
            icon={<Trash2 size={12} strokeWidth={2} />}
            text={isMobile ? 'Delete all' : ''}
            danger
            isMobile={isMobile}
          />
        </div>
      </div>

      {/* ── Expanded events ── */}
      <div
        id={panelId}
        role="region"
        aria-label={`Updates for ${group.title}`}
        hidden={!open}
        style={{ borderTop: open ? `1px solid ${colors.border}` : 'none' }}
      >
        {open && events.map((n, i) => {
          const meta = getNotificationMeta(n)
          const isSelected = selected.has(n.id)
          const isPending = pendingDeletes.has(n.id)
          if (isPending) return null
          return (
            <div
              key={n.id}
              onClick={() => onRowClick(n)}
              style={{
                display: 'flex', alignItems: 'flex-start',
                gap: '8px',
                // The timeline rail: one indent, one line, so the events read
                // as belonging to the task above them.
                padding: isMobile ? '10px 14px 10px 20px' : '10px 16px 10px 30px',
                borderBottom: i < events.length - 1 ? `1px solid ${colors.borderSoft ?? colors.border}` : 'none',
                background: n.is_read ? 'transparent' : 'rgba(85,133,232,0.06)',
                borderLeft: `2px solid ${n.is_read ? colors.border : colors.blue}`,
                marginLeft: isMobile ? '14px' : '26px',
                cursor: n.is_read ? 'default' : 'pointer',
              }}
            >
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onToggleSelect(n.id) }}
                aria-label={`${isSelected ? 'Deselect' : 'Select'} ${meta.badge.label} update`}
                aria-pressed={isSelected}
                style={{
                  flexShrink: 0,
                  // 44px hit area on a phone around an 18px box: the padding is
                  // the target, the border is the mark.
                  width: isMobile ? '44px' : '18px',
                  height: isMobile ? '44px' : '18px',
                  marginTop: isMobile ? '0' : '2px',
                  borderRadius: '4px', padding: 0,
                  border: `1.5px solid ${isSelected ? colors.blue : colors.borderSoft ?? colors.border}`,
                  background: isSelected ? colors.blue : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                {isSelected && <Check size={10} color="#fff" strokeWidth={3} />}
              </button>

              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '12.5px',
                    fontWeight: n.is_read ? 500 : 700,
                    color: meta.headingIsActor ? colors.primary : colors.secondary,
                  }}>
                    {meta.heading}
                  </span>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center',
                    padding: '2px 7px', borderRadius: '20px',
                    fontSize: '10.5px', fontWeight: 600, lineHeight: 1,
                    color: meta.badge.color, background: meta.badge.bg,
                  }}>
                    {meta.badge.label}
                  </span>
                  {!n.is_read && (
                    <span style={{ fontSize: '10px', fontWeight: 700, color: colors.blue }}>UNREAD</span>
                  )}
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '4px',
                  fontSize: '11px', color: colors.muted,
                }}>
                  <Clock size={10} strokeWidth={1.8} />{timeAgo(n.created_at)}
                </div>
              </div>

              {/* No second View Task here: the group owns that action. */}
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onDeleteOne(n.id) }}
                disabled={isPending}
                aria-label={`Delete this ${meta.badge.label} update`}
                style={{
                  flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: isMobile ? '44px' : '30px',
                  height: isMobile ? '44px' : '30px',
                  borderRadius: '6px',
                  background: 'transparent', color: colors.muted,
                  border: `1.5px solid ${colors.border}`,
                  cursor: isPending ? 'not-allowed' : 'pointer',
                }}
              >
                <Trash2 size={12} strokeWidth={2} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A group-level action. Always a real button, always labelled with the task. */
function GroupAction({
  onClick, label, icon, text, primary, danger, disabled, isMobile,
}: {
  onClick: () => void
  label: string
  icon: React.ReactNode
  text: string
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  isMobile?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        // 44px on a phone. The project already uses 44 and 48 as its mobile
        // minimums elsewhere; 34 was below anything established here and below
        // what a thumb reliably hits.
        minHeight: isMobile ? '44px' : '32px',
        minWidth: isMobile ? '44px' : undefined,
        padding: text ? (isMobile ? '10px 13px' : '6px 11px') : (isMobile ? '10px' : '6px 8px'),
        borderRadius: '6px',
        fontSize: '11.5px', fontWeight: 600, fontFamily: font.body,
        whiteSpace: 'nowrap',
        border: `1.5px solid ${primary ? colors.blue : danger ? `${colors.red}55` : colors.border}`,
        background: primary ? colors.blue : 'transparent',
        color: primary ? '#fff' : danger ? colors.red : colors.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {icon}
      {text}
    </button>
  )
}
