'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { MeetingModal, MeetingField, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { AssignmentNotificationNotice } from '@/components/tasks/AssignmentNotificationNotice'
import { requestAssignmentNotification } from '@/lib/tasks/assignmentNotification'
import { logMeetingFailure, meetingErrorMessage } from '@/lib/meetings/errors'
import { buildDiscussionTaskDraft } from '@/lib/meetings/taskDraft'
import { DISCUSSION_CATEGORY_META, type DiscussionRow } from '@/lib/meetings/discussion'
import type { Meeting } from '@/lib/meetings/types'

// Turn an order-discussion item into a task in Task Management.
//
// Deliberately the same shape, the same table, the same activity entry and the
// same assignee notification as MeetingTaskModal and /tasks/create, so a task born
// in a meeting is indistinguishable from any other once it reaches Tasks. What is
// prefilled is the order, the category, the issue and this meeting's position —
// enough for the assignee to act in three days without the meeting in front of
// them.
//
// Three things are NOT prefilled, because each is a decision: assignee, due date
// and priority. A task that arrives pre-assigned to a default person on a default
// date is a task nobody owns.
//
// It never quotes the SOURCE task. An issue captured from a task carries only the
// issue line somebody chose to write, so a task created here cannot leak the
// contents of a task its reader may not be entitled to open.

const PRIORITIES = ['low', 'medium', 'high'] as const
type Priority = typeof PRIORITIES[number]

const PRIORITY_STYLE: Record<Priority, { bg: string; border: string; text: string }> = {
  low:    { bg: '#16a34a', border: 'rgba(22,163,74,0.4)', text: '#16a34a' },
  medium: { bg: '#d97706', border: 'rgba(217,119,6,0.4)', text: '#d97706' },
  high:   { bg: '#dc2626', border: 'rgba(220,38,38,0.4)', text: '#dc2626' },
}

type MemberOption = { id: string; full_name: string; team: string }

export function DiscussionTaskModal({
  supabase, profile, meeting, row, onClose, onCreated,
}: {
  supabase: SupabaseClient
  profile: UserProfile
  meeting: Meeting
  row: DiscussionRow
  onClose: () => void
  onCreated: (taskId: string) => void
}) {
  const { item, appearance } = row
  const draft = useMemo(() => buildDiscussionTaskDraft(meeting, item, appearance), [meeting, item, appearance])

  const [title, setTitle]             = useState(draft.title)
  const [description, setDescription] = useState(draft.description)
  const [assigneeId, setAssignee]     = useState('')
  const [dueDate, setDueDate]         = useState(appearance.next_review_date ?? '')
  const [priority, setPriority]       = useState<Priority | ''>('')
  const [members, setMembers]         = useState<MemberOption[]>([])
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState<string | null>(null)
  // Outcome B: the created task's id, held only while the notice is on screen.
  // Its presence also disables Create, so the still-filled form cannot be
  // submitted a second time and produce a duplicate task.
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    supabase
      .from('users')
      .select('id, full_name, team')
      .eq('is_active', true)
      .order('full_name')
      .then(({ data }) => { if (active && data) setMembers(data as MemberOption[]) })
    return () => { active = false }
  }, [supabase])

  const canSubmit = createdTaskId === null
    && title.trim() !== '' && assigneeId !== '' && dueDate !== '' && priority !== ''

  const handleCreate = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    setError(null)

    const isSelf = assigneeId === profile.id
    const now = new Date().toISOString()

    const { data: task, error: taskErr } = await supabase
      .from('tasks')
      .insert({
        title: title.trim(),
        note: description.trim() || null,
        priority,
        type: 'completion',
        is_urgent: false,
        due_date: dueDate,
        assigned_to: assigneeId,
        created_by: profile.id,
        team: profile.team,
        // Mirrors /tasks/create: a task you assign to yourself is already
        // accepted, so it starts in `working`.
        status: isSelf ? 'working' : 'pending',
        acknowledged_at: isSelf ? now : null,
      })
      .select('id')
      .single()

    if (taskErr || !task) {
      logMeetingFailure('create-task', taskErr ?? { message: 'no row returned' })
      setError(meetingErrorMessage('create-task', taskErr ?? {}))
      setSaving(false)
      return
    }

    const [{ error: logErr }, notified] = await Promise.all([
      supabase.from('task_activity_log').insert({
        task_id: task.id,
        actor_id: profile.id,
        action: 'created',
        note: `Task created from meeting: ${meeting.title}`,
      }),
      requestAssignmentNotification(task.id),
    ])
    if (logErr) console.error('[meetings:create-task] activity log insert failed:', logErr.message)
    if (!notified.ok) console.error('[meetings:create-task] assignment notification failed:', notified.reason)

    // Record the relationship last. If this fails the task still exists and is
    // reported — losing the task would be far worse than losing the link, and the
    // link can be re-made by creating the task again from the item.
    const { error: linkErr } = await supabase.rpc('link_meeting_discussion_task', {
      p_appearance_id: appearance.id,
      p_task_id: task.id,
    })

    if (linkErr) {
      logMeetingFailure('link-discussion-task', linkErr)
      setError(
        'The task was created, but linking it back to this discussion item failed. '
        + 'The task is in Task Management; try creating the link again from this item.',
      )
      setSaving(false)
      return
    }

    if (!notified.ok) {
      setCreatedTaskId(task.id)
      setSaving(false)
      return
    }

    setSaving(false)
    onCreated(task.id)
  }

  return (
    <MeetingModal
      title="Create a follow-up task"
      subtitle={`${item.order_number} · ${DISCUSSION_CATEGORY_META[item.category].label} · ${item.title}`}
      onClose={onClose}
      width={540}
    >
      {createdTaskId && (
        <AssignmentNotificationNotice
          variant="inline"
          taskId={createdTaskId}
          onResolved={() => { const id = createdTaskId; setCreatedTaskId(null); onCreated(id) }}
          onDismiss={() => { const id = createdTaskId; setCreatedTaskId(null); onCreated(id) }}
        />
      )}
      {error && <MeetingModalError message={error} />}

      <MeetingField label="Task Title">
        <input className="boe-input" value={title} onChange={e => setTitle(e.target.value)} />
      </MeetingField>

      <MeetingField label="Assign To">
        <select className="boe-input" value={assigneeId} onChange={e => setAssignee(e.target.value)}>
          <option value="">Select team member</option>
          {members.map(member => (
            <option key={member.id} value={member.id}>{member.full_name} — {member.team}</option>
          ))}
        </select>
      </MeetingField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Priority" group>
          <div style={{ display: 'flex', gap: '5px' }}>
            {PRIORITIES.map(level => {
              const selected = priority === level
              const cfg = PRIORITY_STYLE[level]
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => setPriority(level)}
                  aria-pressed={selected}
                  style={{
                    flex: 1, textAlign: 'center', textTransform: 'capitalize',
                    fontSize: '12px', fontWeight: selected ? 700 : 500,
                    padding: '7px 4px', borderRadius: '6px',
                    border: `1px solid ${selected ? cfg.bg : cfg.border}`,
                    background: selected ? cfg.bg : 'transparent',
                    color: selected ? '#fff' : cfg.text,
                    cursor: 'pointer',
                  }}
                >
                  {level}
                </button>
              )
            })}
          </div>
        </MeetingField>
        <MeetingField
          label="Due Date"
          hint={appearance.next_review_date ? 'Prefilled from this item’s next review date.' : undefined}
        >
          <input
            type="date"
            className="boe-input"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            style={{ colorScheme: 'light' }}
          />
        </MeetingField>
      </div>

      <MeetingField
        label="Context for the assignee"
        hint="Prefilled from this discussion. A snapshot — later meeting updates do not change it."
      >
        <textarea
          className="boe-input"
          rows={7}
          value={description}
          onChange={e => setDescription(e.target.value)}
          style={{ resize: 'vertical', fontSize: '12px', lineHeight: 1.5 }}
        />
      </MeetingField>

      <p style={{ margin: 0, fontSize: '11px', color: colors.muted, lineHeight: 1.55 }}>
        The task lives in Task Management. Completing it does not resolve this discussion item, and
        resolving this item does not close the task — each is closed where it belongs.
      </p>

      <MeetingModalActions
        onClose={onClose}
        onSave={handleCreate}
        saving={saving}
        disabled={!canSubmit}
        saveLabel="Create Task"
      />
    </MeetingModal>
  )
}
