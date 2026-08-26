'use client'

import { notifyTaskAssignment } from '@/lib/tasks/assignmentNotification'
import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { MeetingModal, MeetingField, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import { buildMeetingTaskDraft, meetingTaskTeam } from '@/lib/meetings/taskDraft'
import type { Meeting, MeetingOrder, MeetingOrderItem } from '@/lib/meetings/types'

// Turn a SKU discussion into a task in Task Management.
//
// The title, the description and the team are prefilled from the discussion —
// order reference, SKU, meeting, stage, issue, latest update — so the assignee
// can act on it in three days without the meeting in front of them.
//
// Three things are NOT prefilled, because each is a decision: assignee, due
// date and priority. A task that arrives pre-assigned to a default person on a
// default date is a task nobody owns.
//
// This writes a task exactly the way /tasks/create does — same table, same
// activity-log entry, same assignee notification — and then records the LINK.
// Meetings never mirrors acknowledgement, status or completion: Task Management
// stays the execution source of truth.

const PRIORITIES = ['low', 'medium', 'high'] as const
type Priority = typeof PRIORITIES[number]

const PRIORITY_STYLE: Record<Priority, { bg: string; border: string; text: string }> = {
  low:    { bg: '#16a34a', border: 'rgba(22,163,74,0.4)', text: '#16a34a' },
  medium: { bg: '#d97706', border: 'rgba(217,119,6,0.4)', text: '#d97706' },
  high:   { bg: '#dc2626', border: 'rgba(220,38,38,0.4)', text: '#dc2626' },
}

type MemberOption = { id: string; full_name: string; team: string }

export function MeetingTaskModal({
  supabase, profile, meeting, order, item, onClose, onCreated,
}: {
  supabase: SupabaseClient
  profile: UserProfile
  meeting: Meeting
  order: MeetingOrder
  item: MeetingOrderItem
  onClose: () => void
  onCreated: (taskId: string) => void
}) {
  const draft = useMemo(() => buildMeetingTaskDraft(meeting, order, item), [meeting, order, item])

  const [title, setTitle]         = useState(draft.title)
  const [description, setDescription] = useState(draft.description)
  const [assigneeId, setAssignee] = useState('')
  const [dueDate, setDueDate]     = useState(item.next_follow_up_date ?? '')
  const [priority, setPriority]   = useState<Priority | ''>('')
  const [members, setMembers]     = useState<MemberOption[]>([])
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)

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

  const canSubmit = title.trim() !== '' && assigneeId !== '' && dueDate !== '' && priority !== ''

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
        team: meetingTaskTeam(item, profile.team),
        // Mirrors /tasks/create: a task you assign to yourself is already
        // accepted, so it starts in `working` rather than waiting for you to
        // acknowledge your own decision.
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

    // The activity entry and the assignee's notification depend only on the new
    // id and not on each other — the same pair /tasks/create writes, in the same
    // shape, so a meeting-born task is indistinguishable from any other once it
    // reaches Task Management.
    const [{ error: logErr }, { error: notifErr }] = await Promise.all([
      supabase.from('task_activity_log').insert({
        task_id: task.id,
        actor_id: profile.id,
        action: 'created',
        note: `Task created from meeting: ${meeting.title}`,
      }),
      notifyTaskAssignment(supabase, {
        assigneeId, actorId: profile.id,
        taskId: task.id, taskTitle: title.trim(),
      }),
    ])
    if (logErr)   console.error('[meetings:create-task] activity log insert failed:', logErr.message)
    if (notifErr) console.error('[meetings:create-task] notification insert failed:', notifErr.message)

    // Record the relationship last. If this fails the task still exists and is
    // reported — losing the task would be far worse than losing the link, and
    // the link can be re-made by creating the task again from the row.
    const { error: linkErr } = await supabase.rpc('link_meeting_item_task', {
      p_item_id: item.id,
      p_task_id: task.id,
    })

    if (linkErr) {
      logMeetingFailure('create-task', linkErr)
      setError(
        'The task was created, but linking it back to this SKU failed. '
        + 'The task is in Task Management; try creating the link again from this row.',
      )
      setSaving(false)
      return
    }

    setSaving(false)
    onCreated(task.id)
  }

  return (
    <MeetingModal
      title="Create Task"
      subtitle={`${item.sku} · ${item.product_name} · Order ${order.order_number}`}
      onClose={onClose}
      width={540}
    >
      {error && <MeetingModalError message={error} />}

      <MeetingField label="Task Title">
        <input className="boe-input" value={title} onChange={e => setTitle(e.target.value)} />
      </MeetingField>

      <MeetingField label="Assign To">
        <select className="boe-input" value={assigneeId} onChange={e => setAssignee(e.target.value)}>
          <option value="">Select team member</option>
          {members.map(m => (
            <option key={m.id} value={m.id}>{m.full_name} — {m.team}</option>
          ))}
        </select>
      </MeetingField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Priority" group>
          <div style={{ display: 'flex', gap: '5px' }}>
            {PRIORITIES.map(p => {
              const selected = priority === p
              const cfg = PRIORITY_STYLE[p]
              return (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  aria-pressed={selected}
                  style={{
                    flex: 1, textAlign: 'center', textTransform: 'capitalize',
                    fontSize: '12px', fontWeight: selected ? 700 : 500,
                    padding: '7px 4px', borderRadius: '6px',
                    border: `1px solid ${selected ? cfg.bg : cfg.border}`,
                    background: selected ? cfg.bg : 'transparent',
                    color: selected ? '#fff' : cfg.text,
                    cursor: 'pointer', transition: 'all 0.12s',
                  }}
                >
                  {p}
                </button>
              )
            })}
          </div>
        </MeetingField>
        <MeetingField
          label="Due Date"
          hint={item.next_follow_up_date ? 'Prefilled from this SKU’s follow-up date.' : undefined}
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

      <div style={{ fontSize: '11px', color: colors.muted }}>
        The task lives in Task Management. Its status, updates and completion stay there — this
        screen only shows where it stands.
      </div>

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
