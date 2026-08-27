'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Check, CheckCheck, Trash2, User } from 'lucide-react'
import type { Notification } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { timeAgo } from '@/lib/ui'
import { getNotificationMeta } from '@/lib/notificationMeta'
import {
  orderGroupEvents,
  type NotificationFilter,
  type NotificationTaskGroup as TaskGroup,
} from '@/lib/notifications/grouping'
import {
  describeNotificationEvent,
  actorMetaFor,
  updateCountLabel,
} from '@/lib/notifications/eventPresentation'
import {
  assigneeLabel,
  taskTitleFor,
  type TaskHeaderInfo,
  type ActivityDetailMap,
  type ActivityDetail,
} from '@/lib/notifications/pageEnrichment'

// One task, one card.
//
// ── THE HEADER SAYS WHAT THE CARD IS ────────────────────────────────────────
//
//   test task                          Assigned to: Nishant    3 updates  ˅
//
// Task title left and strongest; assignee and count right and muted. The count
// is EVENTS — notification rows for this task — and is always called "updates"
// so it can never be read as a number of subtasks.
//
// ASSIGNED TO IS THE TASK'S OWNER, not the actor of the newest event. Those are
// different facts and conflating them produces "Assigned to: Dhruv" on a task
// belonging to Nishant because Dhruv happened to comment last. The name comes
// from a page-level batch lookup (src/lib/notifications/taskAssignees.ts), not
// from the notification rows and not from one query per card.
//
// ── ONE EVENT IS NOT AN ACCORDION ───────────────────────────────────────────
//
// A single notification renders its event directly: no chevron, no panel, no
// "1 update". A disclosure control that reveals one row it could have shown is
// a click that buys nothing, and the label is noise.
//
// ── EVENTS DO NOT REPEAT THE HEADER ─────────────────────────────────────────
//
// Inside a group each event shows what happened, one short detail, and when.
// Not the task title, not the assignee, not a large actor badge, not a second
// View Task — all four are already above, and repeating them four times is how
// one task filled a screen.
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
// attachments, or anybody else's notifications.

/**
 * The header facts carried ON the row, when it has them.
 *
 * Returns undefined — not an empty object — when the row has no context, so the
 * caller falls through to the page-level map instead of overriding it with
 * nothing.
 */
function headerInfoFromContext(n: Notification): TaskHeaderInfo | undefined {
  const ctx = n.context
  if (!ctx) return undefined
  if (!ctx.taskTitle && !ctx.assigneeName) return undefined
  return { title: ctx.taskTitle ?? '', assigneeName: ctx.assigneeName }
}

/**
 * The linked activity detail for one event.
 *
 * ROW FIRST. `n.context.activity` came back attached to this exact row, so it
 * cannot be stale relative to it. The page-level map is the fallback for a row
 * from a payload written before `context` existed. A row with no link resolves
 * to undefined in both, which is the historical case and renders "Comment
 * added" / "Status updated".
 */
function activityDetailFor(
  n: Notification,
  activityDetails?: ActivityDetailMap,
): ActivityDetail | undefined {
  if (n.context?.activity) return n.context.activity
  if (n.context) return undefined      // resolved, and there is genuinely none
  return n.activity_log_id ? activityDetails?.[n.activity_log_id] : undefined
}

export function NotificationTaskGroup({
  group,
  headerInfo,
  activityDetails,
  filter,
  selected,
  pendingDeletes,
  busy,
  onToggleSelect,
  onMarkGroupRead,
  onDeleteGroup,
  onDeleteOne,
  onRowClick,
  isMobile = false,
}: {
  group: TaskGroup
  /**
   * Title + assignee from the page-level batch lookup.
   *
   * A FALLBACK NOW, NOT THE SOURCE. Each row carries its own `context` (see
   * NotificationRowContext), which is what this reads first — a map held
   * beside the rows goes out of step with them the moment a cached page is
   * served without its query function running. Still accepted so a caller that
   * has the map, or a row from a payload written before `context` existed,
   * renders exactly as it did.
   */
  headerInfo?: TaskHeaderInfo
  /**
   * Linked activity detail, keyed by activity id, for the whole page.
   *
   * Same story as `headerInfo`: consulted only when the row itself carries no
   * context. A historical notification has no link and finds nothing in either,
   * which is the normal case and renders the fallbacks it always has.
   */
  activityDetails?: ActivityDetailMap
  filter: NotificationFilter
  selected: ReadonlySet<string>
  pendingDeletes: ReadonlySet<string>
  /** True while a group-level mutation is in flight — disables its own actions. */
  busy?: boolean
  onToggleSelect: (id: string) => void
  onMarkGroupRead: (group: TaskGroup) => void
  onDeleteGroup: (group: TaskGroup) => void
  onDeleteOne: (id: string) => void
  onRowClick: (n: Notification) => void
  isMobile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const panelId = `notif-group-${useId().replace(/:/g, '')}`

  const hasUnread = group.unreadCount > 0
  const events = orderGroupEvents(group, filter)
  // The row's own context wins over the page-level map — see the prop docs.
  const rowHeader = headerInfoFromContext(group.latest) ?? headerInfo
  const taskTitle = taskTitleFor(rowHeader, group.title)
  const assignee = assigneeLabel(rowHeader)
  const href = getNotificationMeta(group.latest).href

  // One loaded event is not a group. The count is what decides, not the filter:
  // hiding read events under "Unread" must not turn a three-event task into a
  // card that claims to be one.
  const isSingle = group.loadedCount === 1

  // The assignee's REAL name, or null. `assigneeLabel` folds "unknown" into a
  // sentence; the icon treatment must only be drawn for a person who exists, so
  // the two are kept apart here.
  const assigneeName = rowHeader?.assigneeName?.trim() ? rowHeader.assigneeName.trim() : null

  // ── THE TITLE IS THE LINK ────────────────────────────────────────────────
  //
  // It replaces the "View Task" button, which sat in the action row saying what
  // the title already implied. Same destination, arrived at from
  // getNotificationMeta(group.latest).href — exactly what the removed button's
  // handler pushed — but as a REAL anchor, so Enter works without a key
  // handler, the browser paints its own focus ring, and cmd/middle-click opens
  // a tab the way people expect a title to.
  //
  // A notification with no resolvable href (no task id) renders the same text
  // unlinked rather than a control that goes nowhere.
  const titleStyle: React.CSSProperties = {
    fontSize: '13.5px', fontWeight: 700, color: colors.primary, lineHeight: 1.35,
    minWidth: 0, textDecoration: 'none',
    ...(isMobile
      ? { overflowWrap: 'anywhere' }
      : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  }
  const titleNode = href ? (
    <Link href={href} className="boe-notif-task-title" style={titleStyle}>
      {taskTitle}
    </Link>
  ) : (
    <span style={titleStyle}>{taskTitle}</span>
  )

  // ── WHO IS HANDLING THIS TASK, BESIDE ITS NAME ───────────────────────────
  //
  // The words "Assigned to:" are gone from the screen: at this size they cost
  // more room than the fact is worth, and the person icon carries the meaning.
  // They are NOT gone from the accessibility tree — the tooltip and the
  // screen-reader text both still say "Assigned to <name>", so an icon on its
  // own is never the only thing carrying it.
  //
  // Blue, and deliberately the same blue as the unread accent, because this is
  // the card's one piece of secondary identity. Smaller and lighter than the
  // title: it must never compete with the task's own name.
  //
  // THIS IS THE TASK'S ASSIGNEE, NOT THE ACTOR OF ANY EVENT. The person who
  // did each thing is named under that thing, as "By <name> · <time>". Two
  // different facts; conflating them is how a card claims its owner performed
  // an action somebody else did.
  const assigneeNode = assigneeName ? (
    <span
      title={`Assigned to ${assigneeName}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0,
        fontSize: '11.5px', fontWeight: 500, color: colors.blue,
        whiteSpace: 'nowrap', minWidth: 0,
      }}
    >
      <User size={11} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span className="boe-notif-sr-only">Assigned to </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{assigneeName}</span>
    </span>
  ) : (
    // No icon and no blue for a person who could not be resolved: an empty
    // person chip would read as somebody whose name failed to load.
    <span style={{
      flexShrink: 0, fontSize: '11.5px', fontWeight: 500,
      color: colors.muted, whiteSpace: 'nowrap',
    }}>
      {assignee}
    </span>
  )

  return (
    <div
      className="boe-card"
      style={{
        overflow: 'hidden', padding: 0, maxWidth: '900px', marginBottom: '8px',
        // White card, light grey border, no full blue wash. Unread is one
        // subtle left accent plus a dot beside the event — enough to find, not
        // enough to shout.
        background: '#ffffff',
        border: `1px solid ${colors.border}`,
        borderLeft: hasUnread ? `3px solid ${colors.blue}` : `3px solid ${colors.border}`,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: isMobile ? 'flex-start' : 'center',
        flexDirection: isMobile ? 'column' : 'row',
        gap: isMobile ? '8px' : '10px',
        padding: isMobile ? '12px 14px' : '12px 16px',
      }}>
        {/* ── ONE LEFT-SIDE IDENTITY BLOCK ──────────────────────────────
            Title, then who is handling it, then the disclosure. It used to be
            `justify-content: space-between`, which pushed the assignee to the
            far right of a 900px card and left a wide empty band across the
            middle of every row. `flex: 1` on this block and `flex-shrink: 0`
            on the actions puts the space where it belongs — after the identity,
            before the actions — instead of inside it.

            THE TITLE LINK IS NOT NESTED IN THE DISCLOSURE. It used to be: the
            whole header was the accordion's <button>, which cannot legally
            contain an anchor and would have made one control do two jobs.
            They are siblings now, so Tab reaches each in turn and neither
            fires the other. */}
        <div style={{
          flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined,
          display: 'flex',
          alignItems: isMobile ? 'flex-start' : 'center',
          gap: isMobile ? '6px' : '10px',
          flexWrap: 'wrap',
        }}>
          {titleNode}
          {assigneeNode}
          {!isSingle && (
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${updateCountLabel(group.loadedCount)} for ${taskTitle}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px', flexShrink: 0,
                background: 'transparent', border: 'none', padding: 0,
                // The card's other controls hit 44px on a phone; so does this.
                minHeight: isMobile ? '44px' : undefined,
                minWidth: isMobile ? '44px' : undefined,
                cursor: 'pointer', textAlign: 'left', fontFamily: font.body,
                fontSize: '11.5px', fontWeight: 500, color: colors.muted,
              }}
            >
              <ChevronRight
                size={13}
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  transform: open ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.12s',
                }}
              />
              {updateCountLabel(group.loadedCount)}
            </button>
          )}
        </div>

        {/* Secondary by treatment: outlined, muted, never competing with the
            title. Siblings of the trigger, never nested inside it. */}
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
              label={`Mark all updates for this task as read: ${taskTitle}`}
              icon={<CheckCheck size={12} strokeWidth={2.2} />}
              text="Mark all read"
              isMobile={isMobile}
            />
          )}
          {/* NO "View Task" HERE ANY MORE. The task title above IS the link,
              to the same route this button pushed. Two controls for one
              destination is what made this row feel crowded. */}
          {/* Destructive: quiet icon treatment, not a red block. */}
          <GroupAction
            onClick={() => onDeleteGroup(group)}
            disabled={busy}
            label={`Delete all notifications for this task: ${taskTitle}`}
            icon={<Trash2 size={12} strokeWidth={2} />}
            text={isMobile ? 'Delete all' : ''}
            danger
            isMobile={isMobile}
          />
        </div>
      </div>

      {/* ── Events ──
          A single event renders unconditionally and unindented; a group's
          events sit behind the disclosure with a rail. */}
      <div
        id={panelId}
        role={isSingle ? undefined : 'region'}
        aria-label={isSingle ? undefined : `Updates for ${taskTitle}`}
        hidden={!isSingle && !open}
        style={{ borderTop: (isSingle || open) ? `1px solid ${colors.border}` : 'none' }}
      >
        {(isSingle || open) && events.map((n, i) => {
          if (pendingDeletes.has(n.id)) return null
          return (
            <EventRow
              key={n.id}
              notification={n}
              detail={activityDetailFor(n, activityDetails)}
              // The SAME assignee the header drew — row context first, map
              // second. Reading the prop directly here made the event line
              // show "By Nishant" on Nishant's own card whenever the context
              // came from the row and the map was absent.
              assigneeName={rowHeader?.assigneeName ?? null}
              selected={selected.has(n.id)}
              isLast={i === events.length - 1}
              indented={!isSingle}
              isMobile={isMobile}
              onToggleSelect={onToggleSelect}
              onDeleteOne={onDeleteOne}
              onRowClick={onRowClick}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * One event: what happened, a brief detail, when.
 *
 * NO TASK TITLE, NO ASSIGNEE, NO ACTOR BADGE, NO VIEW TASK — the header owns
 * all four. The actor appears at most once, as muted metadata beside the time,
 * and only when it is somebody other than the assignee: repeating the owner's
 * name on their own card implies they performed an action they may not have.
 */
function EventRow({
  notification: n, detail, assigneeName, selected, isLast, indented, isMobile,
  onToggleSelect, onDeleteOne, onRowClick,
}: {
  notification: Notification
  /** The linked activity row's detail, when this notification has a link. */
  detail?: ActivityDetail
  assigneeName: string | null
  selected: boolean
  isLast: boolean
  indented: boolean
  isMobile: boolean
  onToggleSelect: (id: string) => void
  onDeleteOne: (id: string) => void
  onRowClick: (n: Notification) => void
}) {
  // The linked activity row supplies what the notification cannot: the comment
  // text, both status values, and the actor as a resolved name rather than a
  // name parsed out of a sentence. A row with no link passes nothing and gets
  // exactly the fallbacks it got before 20261016000000.
  const event = describeNotificationEvent(n, {
    commentPreview: detail?.note ?? null,
    fromStatus:     detail?.fromStatus ?? null,
    toStatus:       detail?.toStatus ?? null,
    actorName:      detail?.actorName ?? null,
  })
  const meta = actorMetaFor(event.actorName, assigneeName, timeAgo(n.created_at))

  return (
    <div
      onClick={() => onRowClick(n)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '8px',
        padding: indented
          ? (isMobile ? '10px 14px 10px 20px' : '10px 16px 10px 30px')
          : (isMobile ? '10px 14px' : '10px 16px'),
        borderBottom: isLast ? 'none' : `1px solid ${colors.borderSoft ?? colors.border}`,
        background: 'transparent',
        ...(indented ? {
          borderLeft: `2px solid ${colors.border}`,
          marginLeft: isMobile ? '14px' : '26px',
        } : {}),
        cursor: n.is_read ? 'default' : 'pointer',
      }}
    >
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onToggleSelect(n.id) }}
        aria-label={`${selected ? 'Deselect' : 'Select'} update: ${event.action}`}
        aria-pressed={selected}
        style={{
          flexShrink: 0,
          width: isMobile ? '44px' : '18px',
          height: isMobile ? '44px' : '18px',
          marginTop: isMobile ? '0' : '2px',
          borderRadius: '4px', padding: 0,
          border: `1.5px solid ${selected ? colors.blue : colors.borderSoft ?? colors.border}`,
          background: selected ? colors.blue : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        {selected && <Check size={10} color="#fff" strokeWidth={3} />}
      </button>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {/* 1. What happened. Medium weight — present, not shouting. */}
        <span style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '12.5px', fontWeight: 600, color: colors.primary, lineHeight: 1.35,
        }}>
          {!n.is_read && (
            <span
              aria-label="Unread"
              style={{
                flexShrink: 0, width: '6px', height: '6px', borderRadius: '50%',
                background: colors.blue, display: 'inline-block',
              }}
            />
          )}
          {event.action}
        </span>

        {/* 2. The brief detail, when the row honestly has one. */}
        {event.detail && (
          <span style={{
            fontSize: '12px', fontWeight: 400, color: colors.secondary, lineHeight: 1.4,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {event.detail.kind === 'comment' && <>“{event.detail.text}”</>}
            {event.detail.kind === 'transition' && (
              <>{event.detail.from} <span aria-hidden="true">→</span> {event.detail.to}</>
            )}
            {event.detail.kind === 'plain' && event.detail.text}
          </span>
        )}

        {/* 3. When — and who, once, only if it is not the assignee. */}
        <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.4 }}>
          {meta}
        </span>
      </div>

      <button
        type="button"
        onClick={e => { e.stopPropagation(); onDeleteOne(n.id) }}
        aria-label={`Delete this update: ${event.action}`}
        style={{
          flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: isMobile ? '44px' : '30px',
          height: isMobile ? '44px' : '30px',
          borderRadius: '6px',
          background: 'transparent', color: colors.muted,
          border: `1.5px solid ${colors.border}`,
          cursor: 'pointer',
        }}
      >
        <Trash2 size={12} strokeWidth={2} />
      </button>
    </div>
  )
}

/** A group-level action. Always a real button, always labelled with the task. */
function GroupAction({
  onClick, label, icon, text, danger, disabled, isMobile,
}: {
  onClick: () => void
  label: string
  icon: React.ReactNode
  text: string
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
        // 44px on a phone, matching the project's established mobile minimum.
        minHeight: isMobile ? '44px' : '32px',
        minWidth: isMobile ? '44px' : undefined,
        padding: text ? (isMobile ? '10px 13px' : '6px 11px') : (isMobile ? '10px' : '6px 8px'),
        borderRadius: '6px',
        fontSize: '11.5px', fontWeight: 600, fontFamily: font.body,
        whiteSpace: 'nowrap',
        // Every action here is SECONDARY: outlined and muted, never a filled
        // block competing with the task title for attention.
        border: `1.5px solid ${danger ? `${colors.red}44` : colors.border}`,
        background: 'transparent',
        color: danger ? colors.red : colors.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {icon}
      {text}
    </button>
  )
}
