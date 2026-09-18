'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CalendarPlus, CheckCircle2, Inbox } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  MeetingModal, MeetingField, MeetingModalActions, MeetingModalError,
} from '@/components/meetings/MeetingModal'
import { AfterSalesTagPicker, CategoryPicker } from '@/components/meetings/DiscussionModals'
import { logMeetingFailure, meetingErrorMessage, type MeetingErrorLike } from '@/lib/meetings/errors'
import {
  CAPTURE_INBOX, buildTaskCapturePrefill, capturePrefillIsSubmittable, captureDetails,
  captureSubmitAllowed, captureTargetId, captureTargetMeetings,
} from '@/lib/meetings/taskCapture'
import { istToday } from '@/lib/istDate'
import { meetingTypeForCategory, type AfterSalesTag, type DiscussionCategory } from '@/lib/meetings/discussion'
import { canEditThisMeeting, deriveMeetingsCapabilities } from '@/lib/permissions/meetings'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { MEETING_TYPE_META, formatMeetingDate, type Meeting, type MeetingType } from '@/lib/meetings/types'

// "Add to Meeting", from Task Detail.
//
// THE PROBLEM IT SOLVES
// ---------------------
// Sales assigns a task to management that says "Order 2041 — customer says the
// finish is wrong". Management has to get that onto the next review's agenda
// before the thought is lost. Four fields, three of them already filled in, and
// one Add.
//
// WHAT IT DOES NOT DO
// -------------------
// It changes NOTHING about the task. No status, no assignee, no due date, no
// activity entry, no notification — the task carries on exactly as it was, and the
// issue simply records where it came from. Task Detail itself is not redesigned:
// this is one compact action in the row that is already there.
//
// PREFILL IS A SUGGESTION, NEVER A DECISION
// -----------------------------------------
// public.tasks has no order or customer column, so the order number and customer
// are read out of the task's own words (a labelled "Order:" line first, then an
// order-shaped token) and the category is suggested from the language used. All of
// it stays editable, and the form refuses to submit without an order number the
// person has actually looked at.
//
// PRESSING IT TWICE IS SAFE
// -------------------------
// capture_meeting_discussion_item() returns the issue already open for this task
// rather than making a second one, and a partial unique index in the database
// keeps that true under a double submit or two tabs. The dialog then says so
// plainly instead of pretending it created something.

type MeetingOption = Pick<Meeting, 'id' | 'title' | 'meeting_date' | 'meeting_type' | 'status' | 'lead_id' | 'created_by' | 'created_at'>

type CaptureResult = {
  item_id: string
  status: 'created' | 'existing'
  appearance_id: string | null
  /** The most recent meeting it is on that THIS caller can open — null otherwise. */
  meeting_id: string | null
  /** On any agenda at all, including one this caller cannot open. */
  on_agenda: boolean
  in_inbox: boolean
}

/** The toast for a finished capture. Each one says only what the result proves. */
export function captureToastMessage(result: Pick<CaptureResult, 'status' | 'in_inbox'>): string {
  if (result.status === 'existing') return 'This task already has an open discussion item'
  return result.in_inbox ? 'Saved to the Meeting Inbox' : 'Added to the meeting agenda'
}

/** No meeting chosen — the issue waits in the Meeting Inbox. */
const INBOX = CAPTURE_INBOX

export function AddToMeetingModal({
  supabase, task, userId, userRole, onClose, onDone, onOpenMeeting,
}: {
  supabase: SupabaseClient
  task: { id: string; title: string; note: string | null }
  userId: string
  userRole: string | null | undefined
  onClose: () => void
  /** Called when the dialog is finished with; `message` is the toast to show. */
  onDone: (message: string) => void
  onOpenMeeting: (meetingId: string) => void
}) {
  const prefill = useMemo(
    () => buildTaskCapturePrefill({ title: task.title, note: task.note }),
    [task.title, task.note],
  )

  const [category, setCategory]   = useState<DiscussionCategory>(prefill.category)
  const [tag, setTag]             = useState<AfterSalesTag | null>(prefill.afterSalesTag)
  const [orderNumber, setOrder]   = useState(prefill.orderNumber)
  const [customer, setCustomer]   = useState(prefill.customerName)
  const [issue, setIssue]         = useState(prefill.issue)
  const [details, setDetails]     = useState('')
  // null means "the user has not chosen", so the default below can keep following
  // the category. Derived during render rather than pushed in by an effect: a
  // setState inside an effect would cascade a render for a value that is a pure
  // function of what is already in state.
  const [chosenMeetingId, setChosenMeetingId] = useState<string | null>(null)
  const [meetings, setMeetings]   = useState<MeetingOption[] | null>(null)
  // The Indian business date the meeting list was read for. Quick capture offers
  // only meetings dated on or after it.
  const [meetingsDay, setMeetingsDay] = useState<string | null>(null)
  // A failed meeting read is NOT "no meetings". Treating it as one would quietly
  // send the issue to the Inbox while a live review exists, so it blocks the Add
  // and says what happened instead.
  const [meetingsError, setMeetingsError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt]     = useState(0)

  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [result, setResult]   = useState<CaptureResult | null>(null)

  const preferredType: MeetingType = meetingTypeForCategory(category)

  // The UPCOMING live meetings this person may actually WRITE to. RLS narrows the
  // read to meetings they can see; canEditThisMeeting — the browser mirror of
  // can_edit_meeting() — narrows it to the ones the RPC will accept. Offering one
  // it would refuse is the defect this avoids.
  //
  // Only meetings dated TODAY OR LATER, in Indian business dates (istToday, never
  // the browser's UTC date). A live meeting dated in the past is a stale draft or
  // a QA meeting left behind; a few taps from a task must never put a real issue
  // on one. Those stay manageable inside Meetings — they are just not offered here.
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const day = istToday()
        const [{ data, error: readError }, effective] = await Promise.all([
          supabase
            .from('meetings')
            .select('id, title, meeting_date, meeting_type, status, lead_id, created_by, created_at')
            .in('status', ['draft', 'in_progress'])
            .gte('meeting_date', day)
            .order('meeting_date', { ascending: true }),
          getEffectivePermissions(supabase, userId, 'meetings'),
        ])
        if (!active) return
        if (readError) throw readError
        const caps = deriveMeetingsCapabilities(userRole, effective)
        const rows = ((data ?? []) as MeetingOption[]).filter(m => canEditThisMeeting(m, userId, caps))
        setMeetingsError(null)
        setMeetingsDay(day)
        setMeetings(rows)
      } catch (loadError) {
        if (!active) return
        logMeetingFailure('capture-discussion', loadError instanceof Error ? { message: loadError.message } : (loadError as MeetingErrorLike))
        setMeetings(null)
        setMeetingsError('The meetings you can add to could not be loaded, so nothing can be added yet.')
      }
    }
    void load()
    return () => { active = false }
  }, [supabase, userId, userRole, loadAttempt])

  // Only upcoming meetings of the review type this category belongs in, nearest
  // first. The database refuses any other type (attach_meeting_discussion_item
  // raises MEETING_DISCUSSION_CATEGORY_MISMATCH), so offering one would only
  // produce an error. Switching the category therefore changes the list.
  const matchingMeetings = useMemo(
    () => (meetings && meetingsDay ? captureTargetMeetings(meetings, category, meetingsDay) : []),
    [meetings, meetingsDay, category],
  )

  // The nearest upcoming meeting leads; with none, the Meeting Inbox. A choice the
  // user made is kept only while it is still in the list — so a category change can
  // never leave a meeting of the wrong type selected, and nothing ever falls back
  // to a past meeting.
  const meetingId = captureTargetId(chosenMeetingId, matchingMeetings)

  // Not while the meeting list is still loading or failed to load: the target would
  // silently be the Inbox although an upcoming meeting of the right type may exist.
  const canSubmit = captureSubmitAllowed({
    saving,
    finished: result !== null,
    meetingsLoaded: meetings !== null,
    meetingsError,
    draftSubmittable: capturePrefillIsSubmittable({ category, orderNumber, issue, afterSalesTag: tag }),
  })

  const save = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)

    const { data, error: rpcError } = await supabase.rpc('capture_meeting_discussion_item', {
      p_category: category,
      p_order_number: orderNumber.trim(),
      p_title: issue.trim(),
      p_meeting_id: meetingId === INBOX ? null : meetingId,
      p_customer_name: customer.trim() || null,
      p_after_sales_tag: category === 'after_sales' ? tag : null,
      p_details: captureDetails({ extra: details }),
      p_source_task_id: task.id,
    })

    if (rpcError) {
      logMeetingFailure('capture-discussion', rpcError)
      setError(meetingErrorMessage('capture-discussion', rpcError))
      setSaving(false)
      return
    }

    setResult(data as CaptureResult)
    setSaving(false)
  }

  // There is deliberately NO Undo. Nothing in Meetings removes an agenda entry
  // or deletes a record, and the only closing operation — Resolve — would record
  // that the business issue was finished, which a mis-click is not. A wrong entry
  // is corrected in the meeting itself, where the trail shows who added it.

  // ── Outcome ──
  if (result) {
    const addedTo = result.meeting_id
      ? (meetings?.find(m => m.id === result.meeting_id)?.title ?? 'the meeting')
      : null

    return (
      <MeetingModal
        title={result.status === 'existing'
          ? 'Already raised from this task'
          : result.in_inbox ? 'Saved to the Meeting Inbox' : 'Added to the meeting'}
        onClose={() => onDone(captureToastMessage(result))}
        width={460}
      >
        {error && <MeetingModalError message={error} />}

        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: '9px',
          padding: '11px 13px', borderRadius: '9px',
          background: result.in_inbox ? colors.amberTint : '#F0FDF4',
          border: `1px solid ${result.in_inbox ? 'rgba(232,160,48,0.28)' : '#BBF7D0'}`,
        }}>
          {result.in_inbox
            ? <Inbox size={15} strokeWidth={2} color="#8A5A12" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }} />
            : <CheckCircle2 size={15} strokeWidth={2} color="#166534" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }} />}
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: result.in_inbox ? '#8A5A12' : '#166534' }}>
            {/* Each sentence says only what the result proves. An existing issue
                that is on an agenda is named as such and gets View Agenda below;
                one still waiting says so. Neither claims something was created. */}
            {result.status === 'existing' ? (
              result.in_inbox ? (
                <>
                  This task already has an open discussion item, so nothing new was created. It is
                  waiting in the <strong>Meeting Inbox</strong> for the next review.
                </>
              ) : result.meeting_id ? (
                <>
                  This task already has an open discussion item, so nothing new was created. It is
                  already on a meeting agenda.
                </>
              ) : (
                <>
                  This task already has an open discussion item, so nothing new was created. It is
                  already on the agenda of a meeting you are not part of.
                </>
              )
            ) : result.in_inbox ? (
              <>
                Saved to the <strong>Meeting Inbox</strong>. It is waiting for a meeting and will be
                brought into the next {MEETING_TYPE_META[preferredType].label} review as soon as one
                is created.
              </>
            ) : (
              <>Added to <strong>{addedTo}</strong>.</>
            )}
          </div>
        </div>

        <p style={{ margin: 0, fontSize: '11.5px', color: colors.muted, lineHeight: 1.6 }}>
          The task is unchanged — its status, assignee and due date are exactly as they were. The
          issue stays linked to it for context.
        </p>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {result.meeting_id && (
            <button
              type="button"
              onClick={() => onOpenMeeting(result.meeting_id!)}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '8px 14px', fontSize: '12.5px' }}
            >
              View Agenda
            </button>
          )}
          <button
            type="button"
            onClick={() => onDone(captureToastMessage(result))}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 16px', fontSize: '12.5px' }}
          >
            Done
          </button>
        </div>
      </MeetingModal>
    )
  }

  // ── The quick sheet ──
  return (
    <MeetingModal
      title="Add to Meeting"
      subtitle="Puts this on a review agenda. The task itself is not changed."
      onClose={onClose}
      width={520}
    >
      {error && <MeetingModalError message={error} />}
      {meetingsError && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap',
          padding: '9px 12px', borderRadius: '8px', background: colors.redTint,
          fontSize: '12px', color: colors.red, lineHeight: 1.5,
        }}>
          <span>{meetingsError}</span>
          <button
            type="button"
            onClick={() => { setMeetingsError(null); setLoadAttempt(n => n + 1) }}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '5px 12px', fontSize: '12px' }}
          >
            Try again
          </button>
        </div>
      )}

      <MeetingField label="Category" group>
        <CategoryPicker
          category={category}
          disabled={saving}
          onChange={next => { setCategory(next); if (next !== 'after_sales') setTag(null) }}
        />
      </MeetingField>

      {category === 'after_sales' && (
        <MeetingField label="After Sales type" optional group hint="A quick label. Not a separate category.">
          <AfterSalesTagPicker tag={tag} onChange={setTag} disabled={saving} />
        </MeetingField>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField
          label="Order Number"
          hint={prefill.orderNumber ? 'Read from this task. Correct it if it is wrong.' : undefined}
        >
          <input
            className="boe-input"
            value={orderNumber}
            disabled={saving}
            onChange={e => setOrder(e.target.value)}
            placeholder="e.g. 2041"
          />
        </MeetingField>
        <MeetingField
          label="Customer"
          optional
          hint={prefill.customerName ? 'Read from this task.' : undefined}
        >
          <input
            className="boe-input"
            value={customer}
            disabled={saving}
            onChange={e => setCustomer(e.target.value)}
          />
        </MeetingField>
      </div>

      <MeetingField label="Short issue" hint="Prefilled from the task title. One line the board can show.">
        <input
          className="boe-input"
          value={issue}
          disabled={saving}
          onChange={e => setIssue(e.target.value)}
        />
      </MeetingField>

      <MeetingField
        label="Target meeting"
        hint={meetingsError
          ? 'Unavailable until the meetings load.'
          : meetings === null
          ? 'Looking for meetings you can add to…'
          : matchingMeetings.length === 0
            ? `No upcoming ${MEETING_TYPE_META[preferredType].label} review is scheduled, so this issue will go to the Meeting Inbox and join the next one created.`
            : `Upcoming ${MEETING_TYPE_META[preferredType].label} reviews you can record in, nearest first. Choose the Inbox to let the next one pick it up.`}
      >
        <select
          className="boe-input"
          value={meetingId}
          disabled={saving || meetings === null}
          onChange={e => setChosenMeetingId(e.target.value)}
        >
          {matchingMeetings.map(meeting => (
            <option key={meeting.id} value={meeting.id}>
              {meeting.title} — {formatMeetingDate(meeting.meeting_date)}
            </option>
          ))}
          <option value={INBOX}>Meeting Inbox — wait for the next review</option>
        </select>
      </MeetingField>

      <MeetingField label="Anything else the meeting should know" optional>
        <textarea
          className="boe-input"
          rows={2}
          value={details}
          disabled={saving}
          onChange={e => setDetails(e.target.value)}
          style={{ resize: 'vertical' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={!canSubmit}
        saveLabel="Add to Meeting"
      />
    </MeetingModal>
  )
}

/** The compact Task Detail action. Nothing else on that screen changes. */
// `compact`: the Task Details active-task row, where .boe-task-actions--compact
// sets the geometry and the visible label shortens to "Meeting".
export function AddToMeetingButton({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return (
    <button
      className="boe-task-action-secondary"
      onClick={onClick}
      aria-label="Add to Meeting"
      title="Add to Meeting"
      style={{
        ...(compact ? {} : {
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
          padding: '9px 14px',
          fontSize: '12.5px',
        }),
        borderRadius: '8px',
        border: `1.5px solid ${colors.amber}55`,
        background: '#ffffff', color: '#8A5A12',
        fontWeight: 600, cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = colors.amberTint }}
      onMouseLeave={e => { e.currentTarget.style.background = '#ffffff' }}
    >
      <CalendarPlus size={compact ? 17 : 15} strokeWidth={2.2} style={{ flexShrink: 0 }} aria-hidden="true" />
      {compact ? <span className="boe-task-action-label">Meeting</span> : 'Add to Meeting'}
    </button>
  )
}
