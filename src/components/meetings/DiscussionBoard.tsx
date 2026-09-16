'use client'

import { CheckCircle2, ChevronRight, ClipboardList, Inbox, Paperclip, Plus, Search } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { MeetingBadge } from './MeetingModal'
import {
  AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORY_META, DISCUSSION_FILTERS,
  DISCUSSION_FILTER_LABEL, DISCUSSION_STATE_META, discussionSummary,
  filterDiscussionRows, isDiscussedHere,
  type DiscussionFilter, type DiscussionRow,
} from '@/lib/meetings/discussion'
import { formatMeetingDate } from '@/lib/meetings/types'

// The meeting's discussion board — every issue on this agenda, one row each.
//
// The row answers the five things asked before anyone opens it:
//
//   which issue is this?     category, order, customer, the issue line
//   where does it stand?     the latest position recorded in THIS meeting
//   covered today?           discussed / not yet
//   how long has it run?     earlier meetings, images, follow-up tasks
//   is it finished?          Open or Resolved, and the next review date
//
// Clicking a row opens that issue's discussion. Nothing is edited here: the board
// is for finding the next issue, not a second place to type. Same contract as
// MeetingBoard, which is why this component also reads and writes nothing.

type Props = {
  rows: DiscussionRow[]
  filter: DiscussionFilter
  onFilter: (next: DiscussionFilter) => void
  search: string
  onSearch: (value: string) => void
  isMobile: boolean
  onOpen: (appearanceId: string) => void
  /** Absent for a view-only user or a completed meeting. */
  onNewIssue?: () => void
  /** Open items waiting for a meeting. Undefined while the count is unknown. */
  inboxCount?: number
  onOpenInbox?: () => void
  /**
   * A completed meeting is read as a record, not as "today": an issue resolved in
   * last month's review was resolved IN THAT MEETING, and saying "today" would be
   * false. The words change; the counts do not.
   */
  meetingCompleted?: boolean
  /**
   * The agenda read failed. A failure is never drawn as an empty agenda: no
   * counts, no filters, no "Add the first issue" — only what happened and Retry.
   */
  loadFailed?: boolean
  onRetry?: () => void
}

export function DiscussionBoard({
  rows, filter, onFilter, search, onSearch, isMobile, onOpen, onNewIssue,
  inboxCount, onOpenInbox, meetingCompleted = false, loadFailed = false, onRetry,
}: Props) {
  if (loadFailed) {
    return (
      <section
        aria-labelledby="discussion-board-heading"
        style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: '10px', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '11px 13px 9px', borderBottom: `1px solid ${colors.border}` }}>
          <h2
            id="discussion-board-heading"
            style={{ fontSize: '13.5px', fontWeight: 700, color: colors.primary, margin: 0 }}
          >
            Discussion items
          </h2>
        </div>
        <div role="alert" style={{
          padding: '22px 18px', textAlign: 'center', fontSize: '12.5px', color: colors.red, lineHeight: 1.55,
        }}>
          The discussion items for this meeting could not be loaded. This does not mean the agenda is empty.
          {onRetry && (
            <div>
              <button
                type="button"
                onClick={onRetry}
                className="boe-btn boe-btn-ghost"
                style={{ marginTop: '10px', padding: '6px 14px', fontSize: '12.5px' }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </section>
    )
  }

  const resolvedWords = meetingCompleted ? 'resolved in this meeting' : 'resolved today'
  const summary = discussionSummary(rows)
  const visible = filterDiscussionRows(rows, filter, search)

  return (
    <section
      aria-labelledby="discussion-board-heading"
      style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', overflow: 'hidden',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: '10px', flexWrap: 'wrap', padding: '11px 13px 9px',
        borderBottom: `1px solid ${colors.border}`,
      }}>
        <div style={{ minWidth: 0 }}>
          <h2
            id="discussion-board-heading"
            style={{ fontSize: '13.5px', fontWeight: 700, color: colors.primary, margin: 0 }}
          >
            Discussion items
          </h2>
          {/* The compact meeting summary. Every number is a word as well as a
              colour, so nothing here depends on colour to be understood. */}
          <p style={{ fontSize: '11.5px', color: colors.muted, margin: '2px 0 0' }}>
            {summary.total} item{summary.total === 1 ? '' : 's'}
            {' · '}
            <span style={{ color: '#2E8A58', fontWeight: 600 }}>{summary.discussed} discussed</span>
            {' · '}
            <span style={{ color: summary.toDiscuss > 0 ? '#92400E' : colors.muted, fontWeight: 600 }}>
              {summary.toDiscuss} still to discuss
            </span>
            {summary.resolvedHere > 0 && (
              <>
                {' · '}
                <span style={{ color: '#166534', fontWeight: 600 }}>
                  {summary.resolvedHere} {resolvedWords}
                </span>
              </>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {onOpenInbox && (
            <button
              type="button"
              onClick={onOpenInbox}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '6px 11px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Inbox size={13} strokeWidth={2} />
              Meeting Inbox{typeof inboxCount === 'number' && inboxCount > 0 ? ` (${inboxCount})` : ''}
            </button>
          )}
          {onNewIssue && (
            <button
              type="button"
              onClick={onNewIssue}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '6px 11px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Plus size={13} strokeWidth={2.2} /> New Issue
            </button>
          )}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '8px 13px', borderBottom: `1px solid ${colors.border}`,
      }}>
        <div role="group" aria-label="Filter discussion items" style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          {DISCUSSION_FILTERS.map(key => {
            const selected = filter === key
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected}
                onClick={() => onFilter(key)}
                style={{
                  padding: '5px 11px', borderRadius: '7px', cursor: 'pointer',
                  fontSize: '12px', fontWeight: selected ? 700 : 500,
                  border: `1px solid ${selected ? colors.borderMed : colors.border}`,
                  background: selected ? colors.float : 'transparent',
                  color: selected ? colors.primary : colors.secondary,
                }}
              >
                {DISCUSSION_FILTER_LABEL[key]}
              </button>
            )
          })}
        </div>
        {/* Right-aligned beside the filters on a wide screen; on a phone it wraps
            onto its own line, where it fills the row instead of floating right. */}
        <div style={{
          position: 'relative', flex: '1 1 200px',
          maxWidth: isMobile ? 'none' : '300px', marginLeft: isMobile ? 0 : 'auto',
        }}>
          <Search
            size={13}
            color={colors.muted}
            style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            className="boe-input"
            aria-label="Find a discussion item"
            placeholder="Find order, customer or issue…"
            value={search}
            onChange={e => onSearch(e.target.value)}
            style={{ padding: '6px 10px 6px 28px', fontSize: '12px' }}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyBoard onNewIssue={onNewIssue} />
      ) : visible.length === 0 ? (
        <p style={{ padding: '22px 13px', fontSize: '12.5px', color: colors.muted, textAlign: 'center', margin: 0 }}>
          No discussion item matches this filter.
        </p>
      ) : isMobile ? (
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visible.map(row => (
            <DiscussionCard key={row.appearance.id} row={row} resolvedWords={resolvedWords} onOpen={() => onOpen(row.appearance.id)} />
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <caption className="meeting-discussion-sr-only">
              Discussion items on this meeting&rsquo;s agenda. Select a row to open its discussion.
            </caption>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Issue', 'Latest position', 'This meeting', 'History', 'Next review', 'Status', ''].map(head => (
                  <th key={head} scope="col" style={{
                    padding: '7px 12px', textAlign: 'left',
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                  }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr
                  key={row.appearance.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open ${row.item.order_number}: ${row.item.title}`}
                  onClick={() => onOpen(row.appearance.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row.appearance.id) }
                  }}
                  style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer', verticalAlign: 'top' }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.raised }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <td style={{ padding: '10px 12px', minWidth: '230px', maxWidth: '330px' }}>
                    <IssueCell row={row} />
                  </td>
                  <td style={{ padding: '10px 12px', minWidth: '200px', maxWidth: '300px' }}>
                    <PositionCell row={row} />
                  </td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <TodayCell row={row} resolvedWords={resolvedWords} />
                  </td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: colors.secondary }}>
                    <HistoryCell row={row} />
                  </td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: colors.secondary }}>
                    {formatMeetingDate(row.appearance.next_review_date)}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <StateCell row={row} />
                  </td>
                  <td style={{ padding: '10px 8px', color: colors.muted }}>
                    <ChevronRight size={15} strokeWidth={2} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function EmptyBoard({ onNewIssue }: { onNewIssue?: () => void }) {
  return (
    <div style={{ padding: '30px 18px', textAlign: 'center' }}>
      <ClipboardList size={24} strokeWidth={1.5} color={colors.muted} />
      <p style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, margin: '9px 0 0' }}>
        No discussion items on this agenda yet
      </p>
      <p style={{ fontSize: '12px', color: colors.muted, margin: '4px auto 0', maxWidth: '440px', lineHeight: 1.5 }}>
        Items arrive here in two ways: somebody adds one from a task with{' '}
        <strong style={{ fontWeight: 600 }}>Add to Meeting</strong>, or an unresolved item from an
        earlier review of this type is carried forward automatically when the meeting is created.
      </p>
      {onNewIssue && (
        <button
          type="button"
          onClick={onNewIssue}
          className="boe-btn boe-btn-ghost"
          style={{ marginTop: '12px', padding: '7px 14px', fontSize: '12.5px' }}
        >
          Add the first issue
        </button>
      )}
    </div>
  )
}

function IssueCell({ row }: { row: DiscussionRow }) {
  const { item } = row
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <MeetingBadge meta={DISCUSSION_CATEGORY_META[item.category]} />
        {item.after_sales_tag && (
          <span style={{ fontSize: '11px', color: colors.muted }}>
            {AFTER_SALES_TAG_LABEL[item.after_sales_tag]}
          </span>
        )}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, marginTop: '3px', lineHeight: 1.35 }}>
        {item.title}
      </div>
      <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
        Order {item.order_number}
        {item.customer_name ? ` · ${item.customer_name}` : ''}
      </div>
    </div>
  )
}

function PositionCell({ row }: { row: DiscussionRow }) {
  const text = row.appearance.latest_update
  if (!text) {
    return (
      <span style={{ fontSize: '12px', color: colors.muted }}>
        {row.appearance.carried_from_id ? 'Carried forward — nothing recorded yet' : 'Nothing recorded yet'}
      </span>
    )
  }
  return (
    <div style={{
      fontSize: '12px', color: colors.secondary, lineHeight: 1.4,
      display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
    }}>
      {text}
    </div>
  )
}

/**
 * The state THIS meeting recorded, and — only when it differs — the state now.
 *
 * A completed meeting must keep reading as it read when it closed. So the badge is
 * the recorded state; a later reopen or resolution is shown BESIDE it as "Now …",
 * never in its place.
 */
function StateCell({ row }: { row: DiscussionRow }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '3px' }}>
      <MeetingBadge meta={DISCUSSION_STATE_META[row.recordedState]} />
      {row.changedSince && (
        <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
          Now {DISCUSSION_STATE_META[row.item.state].label}
        </span>
      )}
    </span>
  )
}

function TodayCell({ row, resolvedWords }: { row: DiscussionRow; resolvedWords: string }) {
  if (row.recordedState === 'resolved' && row.resolvedHere) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#166534', fontWeight: 600 }}>
        <CheckCircle2 size={12} strokeWidth={2.2} aria-hidden="true" /> {resolvedWords.charAt(0).toUpperCase() + resolvedWords.slice(1)}
      </span>
    )
  }
  if (!isDiscussedHere(row.appearance)) {
    return (
      <span style={{ fontSize: '12px', color: row.recordedState === 'open' ? '#92400E' : colors.muted, fontWeight: 600 }}>
        {row.recordedState === 'open' ? 'Not discussed yet' : 'Resolved earlier'}
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#2E8A58', fontWeight: 600 }}>
      <CheckCircle2 size={12} strokeWidth={2.2} /> Discussed
    </span>
  )
}

function HistoryCell({ row }: { row: DiscussionRow }) {
  const parts: string[] = []
  parts.push(row.earlierMeetings === 0
    ? 'First meeting'
    : `${row.earlierMeetings} earlier meeting${row.earlierMeetings === 1 ? '' : 's'}`)
  if (row.linkedTaskIds.length > 0) {
    parts.push(`${row.linkedTaskIds.length} task${row.linkedTaskIds.length === 1 ? '' : 's'}`)
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px' }}>
      <span>{parts.join(' · ')}</span>
      {row.evidenceCount > 0 && (
        <span
          title={`${row.evidenceCount} image${row.evidenceCount === 1 ? '' : 's'} attached`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: colors.muted }}
        >
          <Paperclip size={11} strokeWidth={2} aria-hidden="true" />
          {row.evidenceCount}
          <span className="meeting-discussion-sr-only">
            {' '}image{row.evidenceCount === 1 ? '' : 's'} attached
          </span>
        </span>
      )}
    </span>
  )
}

function DiscussionCard({ row, resolvedWords, onOpen }: { row: DiscussionRow; resolvedWords: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        width: '100%', textAlign: 'left', display: 'block', cursor: 'pointer',
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', padding: '11px 13px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <IssueCell row={row} />
        <StateCell row={row} />
      </div>
      <div style={{ marginTop: '8px' }}>
        <PositionCell row={row} />
      </div>
      <div style={{
        display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px',
        fontSize: '11.5px', color: colors.muted, alignItems: 'center',
      }}>
        <TodayCell row={row} resolvedWords={resolvedWords} />
        <HistoryCell row={row} />
        {row.appearance.next_review_date && (
          <span>Next review {formatMeetingDate(row.appearance.next_review_date)}</span>
        )}
      </div>
    </button>
  )
}
