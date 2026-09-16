'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarPlus, ExternalLink, Inbox } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { colors } from '@/lib/tokens'
import { MeetingsLayout } from '@/components/layout/MeetingsLayout'
import { MeetingBadge } from '@/components/meetings/MeetingModal'
import { AttachDiscussionItemModal } from '@/components/meetings/DiscussionModals'
import { useMeetings } from '@/hooks/useMeetings'
import {
  AFTER_SALES_TAG_LABEL, DISCUSSION_CATEGORY_META, meetingTypeForCategory,
  type MeetingDiscussionItem,
} from '@/lib/meetings/discussion'
import { fetchMeetingInbox } from '@/lib/meetings/discussionReads'
import { MEETING_TYPE_META, formatMeetingTimestamp } from '@/lib/meetings/types'

// The Meeting Inbox — issues raised with no meeting to put them on yet.
//
// WHAT THE INBOX ACTUALLY IS
// --------------------------
// Not a table, and not a queue anything is moved out of: it is the set of OPEN
// issues that no meeting has claimed. That is the whole implementation, and it is
// what makes the two promises hold —
//
//   * nothing can be LOST from the Inbox, because there is nothing to move; and
//   * the source task link cannot be dropped on the way in or out, because the
//     issue row itself never changes.
//
// An item leaves the Inbox exactly when it gains an appearance on a meeting, which
// happens in one of two ways: an editor attaches it here, or the next relevant
// meeting is created and the carry-forward inside that transaction brings it in
// once. Both paths go through the same UNIQUE (meeting, item) constraint, so it
// can never arrive twice.
//
// WHO SEES WHAT
// -------------
// An Inbox item has no meeting, so it cannot derive visibility from one. It is
// readable by its creator — the person who raised it from a task, who must be able
// to see what became of it — and by meeting editors and managers, who are the
// people who triage it. That rule lives in can_view_discussion_item(); this screen
// simply reads what comes back.

export function MeetingInboxScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useMeetings()
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  const [items, setItems]       = useState<MeetingDiscussionItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setError]   = useState<string | null>(null)
  const [attaching, setAttach]  = useState<MeetingDiscussionItem | null>(null)
  // Which source tasks THIS viewer may actually open. Read under their own
  // permissions, so a link is offered only where it will work — and a reader with
  // no access to the task is told the issue came from one and given no route to it.
  const [readableTasks, setReadableTasks] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    const rows = await fetchMeetingInbox(supabase)
    if (!rows) {
      setError('Could not load the Meeting Inbox. Check your connection and try again.')
      setLoading(false)
      return
    }
    setError(null)
    setItems(rows)

    const taskIds = [...new Set(rows.map(row => row.source_task_id).filter((id): id is string => !!id))]
    if (taskIds.length > 0) {
      const { data } = await supabase.from('tasks').select('id').in('id', taskIds)
      setReadableTasks(new Set(((data ?? []) as { id: string }[]).map(row => row.id)))
    } else {
      setReadableTasks(new Set())
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    if (authLoading) return
    const run = () => { void load() }
    run()
  }, [authLoading, load])

  if (authLoading || loading) return <LoadingScreen />

  return (
    <MeetingsLayout
      profile={profile}
      title="Meeting Inbox"
      subtitle="Issues raised from a task that are waiting for a meeting."
      onSignOut={signOut}
    >
      <MeetingInboxBody
        items={items}
        loadError={loadError}
        readableTasks={readableTasks}
        canAttach={caps.canConductMeeting}
        onRetry={() => { setLoading(true); void load() }}
        onAttach={setAttach}
        onOpenTask={taskId => router.push(`/tasks/${taskId}`)}
      />

      {attaching && (
        <AttachDiscussionItemModal
          supabase={supabase}
          item={attaching}
          onClose={() => setAttach(null)}
          onAttached={(message, meetingId) => {
            setAttach(null)
            show(message)
            router.push(`/meetings/${meetingId}`)
          }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </MeetingsLayout>
  )
}


// ─── The body ─────────────────────────────────────────────────────────────────

/**
 * Everything the Inbox shows, without the module shell or the session: the error
 * banner, the count line, the empty state and one row per waiting issue.
 *
 * Kept separate from the screen so the screen owns only the reads and the
 * permissions, and so the rows can be rendered and reviewed on their own. Every
 * decision about WHAT may be offered arrives as a prop the screen resolved:
 * `readableTasks` from a read under the viewer's own permissions, `canAttach` from
 * the Meetings capabilities.
 */
export function MeetingInboxBody({
  items, loadError, readableTasks, canAttach, onRetry, onAttach, onOpenTask,
}: {
  items: MeetingDiscussionItem[]
  loadError: string | null
  /** Source tasks THIS viewer may open. A task not in here is never linked. */
  readableTasks: Set<string>
  /** A meeting editor may place an item on a live meeting now. */
  canAttach: boolean
  onRetry: () => void
  onAttach: (item: MeetingDiscussionItem) => void
  onOpenTask: (taskId: string) => void
}) {
  return (
    <>
      {loadError && (
        <div role="alert" style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '10px',
          background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
          fontSize: '13px', color: colors.red,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
        }}>
          <span>{loadError}</span>
          <button
            onClick={onRetry}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 12px', fontSize: '12px' }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', overflow: 'hidden',
      }}>
        <div style={{ padding: '11px 14px', borderBottom: `1px solid ${colors.border}` }}>
          <p style={{ margin: 0, fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
            {items.length === 0
              ? 'Nothing is waiting. Every issue raised so far is on a meeting agenda.'
              : `${items.length} issue${items.length === 1 ? '' : 's'} waiting for a meeting. `
                + 'Each one is brought into the next review of its kind as soon as that meeting is '
                + 'created — or you can add it to a live meeting now.'}
          </p>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: '32px 18px', textAlign: 'center' }}>
            <Inbox size={24} strokeWidth={1.5} color={colors.muted} aria-hidden="true" />
            <p style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, margin: '9px 0 0' }}>
              The Inbox is empty
            </p>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item, index) => {
              const meta = DISCUSSION_CATEGORY_META[item.category]
              const review = MEETING_TYPE_META[meetingTypeForCategory(item.category)]
              return (
                <li key={item.id} style={{
                  padding: '12px 14px',
                  borderTop: index === 0 ? 'none' : `1px solid ${colors.border}`,
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                  gap: '12px', flexWrap: 'wrap',
                }}>
                  <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                      <MeetingBadge meta={meta} />
                      {item.after_sales_tag && (
                        <span style={{ fontSize: '11px', color: colors.muted }}>
                          {AFTER_SALES_TAG_LABEL[item.after_sales_tag]}
                        </span>
                      )}
                      {/* Neutral on purpose: amber is the After Sales category's colour,
                          and a waiting state wearing it read as a second category chip. */}
                      <span style={{
                        fontSize: '11px', color: colors.secondary, fontWeight: 600,
                        background: colors.raised, border: `1px solid ${colors.borderSoft}`,
                        padding: '2px 8px', borderRadius: '5px',
                      }}>
                        Waiting for a meeting
                      </span>
                    </div>
                    <div style={{
                      fontSize: '13.5px', fontWeight: 700, color: colors.primary,
                      marginTop: '4px', lineHeight: 1.35,
                    }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px' }}>
                      Order {item.order_number}
                      {item.customer_name ? ` · ${item.customer_name}` : ''}
                      {' · raised by '}{item.created_by_name ?? 'Unknown'}
                      {' · '}{formatMeetingTimestamp(item.created_at)}
                    </div>
                    {item.details && (
                      <p style={{
                        margin: '6px 0 0', fontSize: '12px', color: colors.secondary,
                        lineHeight: 1.5, whiteSpace: 'pre-wrap',
                      }}>
                        {item.details}
                      </p>
                    )}
                    <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '6px' }}>
                      Next {review.label} review will pick this up automatically.
                      {item.source_task_id && !readableTasks.has(item.source_task_id)
                        && ' Raised from a task you do not have access to.'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', flexShrink: 0 }}>
                    {/* The source task, only when this viewer may open it. The link
                        is drawn from a read made under their own permissions on the
                        Task module — a meeting reader never gains task access here,
                        and is never offered a link that would bounce. */}
                    {item.source_task_id && readableTasks.has(item.source_task_id) && (
                      <button
                        onClick={() => onOpenTask(item.source_task_id!)}
                        className="boe-btn boe-btn-ghost"
                        style={{
                          padding: '6px 11px', fontSize: '12px',
                          display: 'flex', alignItems: 'center', gap: '5px',
                        }}
                      >
                        <ExternalLink size={12} strokeWidth={2} aria-hidden="true" /> Source task
                      </button>
                    )}
                    {canAttach && (
                      <button
                        onClick={() => onAttach(item)}
                        className="boe-btn boe-btn-primary"
                        style={{
                          padding: '6px 12px', fontSize: '12px',
                          display: 'flex', alignItems: 'center', gap: '5px',
                        }}
                      >
                        <CalendarPlus size={12} strokeWidth={2} aria-hidden="true" /> Add to a meeting
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}
