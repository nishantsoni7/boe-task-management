'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, LogEntry, TaskStatus, UserProfile } from '@/lib/types'
import {
  isOverdue, formatFullDate, formatDateTime,
  formatLogAction, timeAgo, getTaskAging,
} from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { CircleCheckBig } from 'lucide-react'

// ─── Status config ─────────────────────────────────────────────────────────────

// Progress states for Update Status pills — completed is a separate action
const PROGRESS_STATUSES: TaskStatus[] = ['working', 'waiting', 'blocked']

const STATUS_COLORS: Record<string, string> = {
  pending:   colors.muted,
  started:   colors.secondary,
  working:   colors.blue,
  waiting:   colors.amber,
  blocked:   colors.red,
  completed: colors.green,
}

const STATUS_TINTS: Record<string, string> = {
  pending:   colors.float,
  started:   colors.float,
  working:   colors.blueTint,
  waiting:   colors.amberTint,
  blocked:   colors.redTint,
  completed: colors.greenTint,
}

const PRIORITY_COLORS: Record<string, { fg: string; bg: string }> = {
  high:   { fg: colors.red,   bg: colors.redTint   },
  medium: { fg: colors.amber, bg: colors.amberTint },
  low:    { fg: colors.muted, bg: colors.float      },
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TaskDetailPage() {
  const [profile,         setProfile]         = useState<UserProfile | null>(null)
  const [task,            setTask]            = useState<Task | null>(null)
  const [log,             setLog]             = useState<LogEntry[]>([])
  const [creatorName,     setCreatorName]     = useState<string | null>(null)
  const [currentUserId,   setCurrentUserId]   = useState('')
  const [loading,         setLoading]         = useState(true)

  const [selectedStatus,   setSelectedStatus]  = useState<string>('')
  const [updateNote,       setUpdateNote]      = useState('')
  const [waitingOnType,    setWaitingOnType]   = useState<'team_member' | 'external'>('team_member')
  const [waitingOnUserId,  setWaitingOnUserId] = useState('')
  const [waitingOnText,    setWaitingOnText]   = useState('')
  const [noteError,        setNoteError]       = useState(false)
  const [waitingOnError,   setWaitingOnError]  = useState(false)
  const [saving,           setSaving]          = useState(false)
  const [markingComplete,  setMarkingComplete] = useState(false)
  const [teamMembers,      setTeamMembers]     = useState<{ id: string; full_name: string }[]>([])

  // Creator-only: edit due date + priority
  const [editingMeta,   setEditingMeta]   = useState(false)
  const [editDueDate,   setEditDueDate]   = useState('')
  const [editPriority,  setEditPriority]  = useState<'high' | 'medium' | 'low'>('medium')
  const [savingMeta,    setSavingMeta]    = useState(false)
  const [metaSaveMsg,   setMetaSaveMsg]   = useState<{ ok: boolean; text: string } | null>(null)

  const router   = useRouter()
  const params   = useParams()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCurrentUserId(user.id)

      const [{ data: taskData }, { data: profileData }, { data: members }] = await Promise.all([
        supabase.from('tasks').select('*').eq('id', params.id).single(),
        supabase.from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', user.id).single(),
        supabase.from('users').select('id, full_name').eq('is_active', true).order('full_name'),
      ])
      if (members) setTeamMembers(members)

      if (taskData) {
        setTask(taskData)
        setSelectedStatus(taskData.status)
        if (taskData.created_by) {
          const { data: creator } = await supabase
            .from('users').select('full_name').eq('id', taskData.created_by).single()
          if (creator) setCreatorName(creator.full_name)
        }
      }
      if (profileData) setProfile(profileData as UserProfile)
      await loadLog(params.id as string)
      setLoading(false)
    }
    init()
  }, [])

  const loadLog = async (taskId: string) => {
    const { data } = await supabase
      .from('task_activity_log')
      .select(`id, action, note, from_status, to_status, created_at, actor_id,
               users:actor_id ( full_name )`)
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
    if (data) {
      setLog((data as any[]).map(e => ({
        ...e,
        actor_name: e.users?.full_name ?? null,
      })))
    }
  }

  const acknowledge = async () => {
    if (!task) return
    if (task.assigned_to !== currentUserId) return
    if (task.created_by === currentUserId) return
    const now = new Date().toISOString()
    const { error } = await supabase.from('tasks').update({ acknowledged_at: now }).eq('id', task.id)
    if (error) {
      alert('Failed to acknowledge task. Please try again.')
      return
    }
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId, action: 'acknowledged', note: null,
    })
    if (task.created_by && task.created_by !== currentUserId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by, title: 'Task acknowledged' }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[acknowledge] notification failed:', d))
      }).catch(err => console.error('[acknowledge] notification fetch error:', err))
    }
    setTask({ ...task, acknowledged_at: now })
    await loadLog(task.id)
  }

  const applyStatusChange = async (newStatus: string, reason: string | null) => {
    if (!task) return
    const oldStatus = task.status
    const now = new Date().toISOString()
    const updates: Record<string, unknown> = { status: newStatus, last_update_at: now }
    if (newStatus === 'blocked')   updates.blocker_reason = reason
    if (oldStatus === 'blocked' && newStatus !== 'blocked') updates.blocker_reason = null
    if (oldStatus === 'waiting' && newStatus !== 'waiting') {
      updates.waiting_on_type    = null
      updates.waiting_on_user_id = null
      updates.waiting_on_text    = null
    }
    if (newStatus === 'completed') updates.completed_at = now

    const { error: taskErr } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (taskErr) {
      console.error('[applyStatusChange] tasks update failed:', taskErr.message)
      window.alert('Failed to update task status. Please try again.')
      return
    }
    const { error: logErr } = await supabase.from('task_activity_log').insert({
      task_id:     task.id,
      actor_id:    currentUserId,
      action:      'status_changed',
      from_status: oldStatus,
      to_status:   newStatus,
      note:        reason ?? null,
    })
    if (logErr) console.error('[applyStatusChange] activity log insert failed:', logErr.message)
    if (task.created_by && task.created_by !== currentUserId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[applyStatusChange] notification failed:', d))
      }).catch(err => console.error('[applyStatusChange] notification fetch error:', err))
    }
    const localPatch: Partial<Task> = { status: newStatus as TaskStatus, last_update_at: now }
    if (newStatus === 'blocked')   localPatch.blocker_reason = reason
    if (oldStatus === 'blocked' && newStatus !== 'blocked') localPatch.blocker_reason = null
    if (oldStatus === 'waiting' && newStatus !== 'waiting') {
      localPatch.waiting_on_type    = null
      localPatch.waiting_on_user_id = null
      localPatch.waiting_on_text    = null
    }
    setTask({ ...task, ...localPatch })
    setSelectedStatus(newStatus)
    await loadLog(task.id)
    if (newStatus === 'completed') setTimeout(() => router.push('/dashboard'), 800)
  }

  const saveUpdate = async () => {
    if (!task) return
    if (selectedStatus === 'blocked' && !updateNote.trim()) { setNoteError(true); return }
    if (selectedStatus === 'waiting') {
      const filled = waitingOnType === 'team_member' ? !!waitingOnUserId : !!waitingOnText.trim()
      if (!filled) { setWaitingOnError(true); return }
    }
    setNoteError(false)
    setWaitingOnError(false)
    setSaving(true)

    if (selectedStatus !== task.status) {
      if (selectedStatus === 'waiting') {
        const now = new Date().toISOString()
        const updates: Record<string, unknown> = {
          status:            selectedStatus,
          last_update_at:    now,
          waiting_on_type:   waitingOnType,
          waiting_on_user_id: waitingOnType === 'team_member' ? (waitingOnUserId || null) : null,
          waiting_on_text:   waitingOnType === 'external' ? (waitingOnText.trim() || null) : null,
        }
        if (task.status === 'blocked') updates.blocker_reason = null
        const { error: waitTaskErr } = await supabase.from('tasks').update(updates).eq('id', task.id)
        if (waitTaskErr) {
          console.error('[saveUpdate/waiting] tasks update failed:', waitTaskErr.message)
          window.alert('Failed to save update. Please try again.')
          setSaving(false)
          return
        }
        const { error: waitLogErr } = await supabase.from('task_activity_log').insert({
          task_id: task.id, actor_id: currentUserId,
          action: 'status_changed', from_status: task.status, to_status: selectedStatus,
          note: updateNote.trim() || null,
        })
        if (waitLogErr) console.error('[saveUpdate/waiting] activity log insert failed:', waitLogErr.message)
        if (task.created_by && task.created_by !== currentUserId) {
          fetch('/api/notify-status-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by }),
          }).then(res => {
            if (!res.ok) res.json().then(d => console.error('[saveUpdate/waiting] notification failed:', d))
          }).catch(err => console.error('[saveUpdate/waiting] notification fetch error:', err))
        }
        const localPatch: Partial<Task> = {
          status:            selectedStatus as TaskStatus,
          last_update_at:    now,
          waiting_on_type:   waitingOnType,
          waiting_on_user_id: waitingOnType === 'team_member' ? (waitingOnUserId || null) : null,
          waiting_on_text:   waitingOnType === 'external' ? (waitingOnText.trim() || null) : null,
        }
        if (task.status === 'blocked') localPatch.blocker_reason = null
        setTask({ ...task, ...localPatch })
        setSelectedStatus(selectedStatus)
        await loadLog(task.id)
      } else {
        await applyStatusChange(selectedStatus, updateNote.trim() || null)
      }
    } else if (updateNote.trim()) {
      const now = new Date().toISOString()
      const { error: noteTaskErr } = await supabase.from('tasks').update({ last_update_at: now }).eq('id', task.id)
      if (noteTaskErr) {
        console.error('[saveUpdate/note] tasks update failed:', noteTaskErr.message)
        window.alert('Failed to save update. Please try again.')
        setSaving(false)
        return
      }
      const { error: noteLogErr } = await supabase.from('task_activity_log').insert({
        task_id:  task.id,
        actor_id: currentUserId,
        action:   'progress_update',
        note:     updateNote.trim(),
      })
      if (noteLogErr) console.error('[saveUpdate/note] activity log insert failed:', noteLogErr.message)
      setTask({ ...task, last_update_at: now })
      await loadLog(task.id)
    }

    setUpdateNote('')
    setSaving(false)
  }

  const saveMetaChanges = async () => {
    if (!task) return
    setSavingMeta(true)
    setMetaSaveMsg(null)
    const updates: Record<string, unknown> = {}
    const logEntries: { action: string; note: string }[] = []
    if (editDueDate !== (task.due_date ?? '')) {
      updates.due_date = editDueDate || null
      logEntries.push({ action: 'deadline_changed', note: editDueDate ? `Due date set to ${editDueDate}` : 'Due date cleared' })
    }
    if (editPriority !== task.priority) {
      updates.priority = editPriority
      logEntries.push({ action: 'priority_changed', note: `Priority changed from ${task.priority} to ${editPriority}` })
    }
    if (Object.keys(updates).length === 0) {
      setEditingMeta(false)
      setSavingMeta(false)
      return
    }
    const { error } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (error) {
      setMetaSaveMsg({ ok: false, text: 'Failed to save. Please try again.' })
      setSavingMeta(false)
      return
    }
    for (const entry of logEntries) {
      await supabase.from('task_activity_log').insert({
        task_id: task.id, actor_id: currentUserId,
        action: entry.action, note: entry.note,
      })
    }
    setTask({ ...task, ...updates as Partial<Task> })
    await loadLog(task.id)
    setMetaSaveMsg({ ok: true, text: 'Saved successfully.' })
    setEditingMeta(false)
    setSavingMeta(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <LoadingScreen />
  if (!task)   return <LoadingScreen message="Task not found" />

  const overdue      = isOverdue(task.due_date ?? null)
  const isAssignee   = task.assigned_to === currentUserId
  const isCreator    = task.created_by === currentUserId
  const isSelfTask   = isCreator && isAssignee
  const isDelegated  = !isAssignee && task.created_by === currentUserId
  const riskOverdue  = overdue && task.status !== 'completed'
  const assigneeName = isAssignee ? (profile?.full_name ?? 'You') : (task.assignee_name ?? '—')

  // Delegated task not yet acknowledged — block all modifications
  const isUnacknowledged = isAssignee && !isSelfTask && !task.acknowledged_at

  const relationLabel = isSelfTask  ? 'Self Assigned Task'
    : isAssignee                    ? 'Assigned To Me'
    : isDelegated                   ? 'Delegated Task'
    : 'Task'

  const relationColor = isSelfTask  ? colors.blue
    : isAssignee                    ? colors.green
    : isDelegated                   ? colors.amber
    : colors.muted

  const statusColor   = STATUS_COLORS[task.status] ?? colors.muted
  const statusTint    = STATUS_TINTS[task.status]  ?? colors.float
  const priorityStyle = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.low

  // Current Status: first log entry that has a note (log is newest-first)
  const latestNoteEntry   = log.find(e => e.note) ?? null
  const currentStatusNote = latestNoteEntry?.note ?? null
  const noteIsDuplicateOfBlocker =
    task.status === 'blocked' &&
    currentStatusNote !== null &&
    currentStatusNote === task.blocker_reason

  const summaryLabel: React.CSSProperties = { color: colors.muted, fontSize: '11px', flexShrink: 0 }
  const summaryValue: React.CSSProperties = { fontSize: '12px', fontWeight: 500, color: colors.secondary, textAlign: 'right' }

  return (
    <DashboardLayout profile={profile} title="" onSignOut={handleLogout}>

<div className="boe-task-3col">

        {/* ══ COLUMN 1 — unified task workspace card ═════════════════════════ */}
        <div style={{ minWidth: 0 }}>
          <div className="boe-card" style={{ padding: '0', overflow: 'hidden' }}>

            {/* § Task title + description */}
            <div style={{ padding: '18px 20px' }}>
              <h2 style={{
                fontSize: '16px', fontWeight: 700,
                color: colors.primary, lineHeight: 1.4,
                letterSpacing: '-0.01em', margin: '0 0 10px',
              }}>
                {task.title}
              </h2>

              {task.note ? (
                <p style={{
                  fontSize: '13px', fontWeight: 400,
                  color: colors.secondary, lineHeight: 1.65,
                  margin: 0, whiteSpace: 'pre-wrap',
                }}>
                  {task.note}
                </p>
              ) : (
                <p style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                  No task description added.
                </p>
              )}

              {/* Attachment */}
              {task.attachment_url && (
                <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: colors.muted, flexShrink: 0,
                  }}>
                    Attachment
                  </span>
                  <a
                    href={task.attachment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      fontSize: '12px', fontWeight: 500,
                      color: colors.blue,
                      textDecoration: 'none',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      border: `1px solid ${colors.blueTint}`,
                      background: colors.blueTint,
                    }}
                  >
                    View Attachment
                  </a>
                </div>
              )}
            </div>

            {/* § Current Status */}
            <div style={{
              borderTop: `1px solid ${colors.border}`,
              padding: '14px 20px',
              display: 'flex', flexDirection: 'column', gap: '10px',
            }}>
              {/* Header row: label + status pill */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: colors.muted,
                }}>
                  Current Status
                </span>
                <span style={{
                  fontSize: '11px', fontWeight: 600,
                  color: statusColor, background: statusTint,
                  padding: '2px 9px', borderRadius: '10px',
                }}>
                  {task.status.charAt(0).toUpperCase() + task.status.slice(1)}
                </span>
              </div>

              {/* Waiting On */}
              {task.status === 'waiting' && task.waiting_on_type && (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: statusColor, flexShrink: 0,
                  }}>
                    Waiting On
                  </span>
                  <span style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.4 }}>
                    {task.waiting_on_type === 'team_member'
                      ? (teamMembers.find(m => m.id === task.waiting_on_user_id)?.full_name ?? 'Team member')
                      : (task.waiting_on_text ?? '—')
                    }
                  </span>
                  <span style={{ fontSize: '10px', color: colors.muted }}>
                    ({task.waiting_on_type === 'team_member' ? 'Team Member' : 'External'})
                  </span>
                </div>
              )}

              {/* Blocker */}
              {task.status === 'blocked' && task.blocker_reason && (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: statusColor, flexShrink: 0,
                  }}>
                    Blocker
                  </span>
                  <span style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.4 }}>
                    {task.blocker_reason}
                  </span>
                </div>
              )}

              {/* Latest remark — hidden when it duplicates the blocker line */}
              {!noteIsDuplicateOfBlocker && (
                currentStatusNote ? (
                  <p style={{ fontSize: '13px', color: colors.primary, lineHeight: 1.55, margin: 0 }}>
                    {currentStatusNote}
                  </p>
                ) : (
                  <p style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                    No status update added yet.
                  </p>
                )
              )}

              {/* Meta: updated by + time */}
              {latestNoteEntry && (
                <p style={{ fontSize: '10px', color: colors.muted, margin: 0 }}>
                  Updated by{' '}
                  {latestNoteEntry.actor_name && (
                    <span style={{ fontWeight: 600, color: colors.tertiary }}>
                      {latestNoteEntry.actor_name}
                    </span>
                  )}
                  {' · '}
                  {timeAgo(latestNoteEntry.created_at)}
                </p>
              )}
            </div>

            {/* § Unacknowledged notice */}
            {isUnacknowledged && (
              <div style={{
                borderTop: `1px solid ${colors.border}`,
                padding: '14px 20px',
                background: colors.amberTint,
              }}>
                <p style={{ fontSize: '12px', color: colors.amber, fontWeight: 600, margin: 0 }}>
                  ⚠️ Please acknowledge this task before updating it.
                </p>
              </div>
            )}

            {/* § Update Status — assignee only, task not completed, acknowledged */}
            {isAssignee && task.status !== 'completed' && !isUnacknowledged && (
              <div style={{
                borderTop: `1px solid ${colors.border}`,
                padding: '14px 20px',
                display: 'flex', flexDirection: 'column', gap: '10px',
              }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: colors.muted,
                }}>
                  Update Status
                </span>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {PROGRESS_STATUSES.map(s => {
                    const active = selectedStatus === s
                    return (
                      <button
                        key={s}
                        onClick={() => {
                          setSelectedStatus(s)
                          setNoteError(false)
                          setWaitingOnError(false)
                          if (s !== 'waiting') {
                            setWaitingOnType('team_member')
                            setWaitingOnUserId('')
                            setWaitingOnText('')
                          }
                        }}
                        style={{
                          padding: '5px 13px', borderRadius: '20px',
                          border: `1.5px solid ${active ? STATUS_COLORS[s] : colors.border}`,
                          background: active ? STATUS_TINTS[s] : 'transparent',
                          color: active ? STATUS_COLORS[s] : colors.tertiary,
                          fontSize: '12px', fontWeight: active ? 600 : 400,
                          cursor: 'pointer', textTransform: 'capitalize',
                          transition: 'all 0.15s',
                        }}
                      >
                        {s}
                      </button>
                    )
                  })}
                </div>

                {selectedStatus === 'waiting' && (
                  <div style={{
                    padding: '10px 12px', borderRadius: '7px',
                    background: `${colors.amber}0a`,
                    border: `1px solid ${waitingOnError ? colors.red : colors.amber + '40'}`,
                  }}>
                    <p style={{
                      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.07em', marginBottom: '8px',
                      color: waitingOnError ? colors.red : colors.amber,
                    }}>
                      Waiting On <span style={{ color: colors.red }}>*</span>
                      {waitingOnError && <span> — required</span>}
                    </p>

                    {/* Type selector */}
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      {(['team_member', 'external'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => { setWaitingOnType(t); setWaitingOnUserId(''); setWaitingOnText(''); setWaitingOnError(false) }}
                          style={{
                            flex: 1, padding: '5px 8px', borderRadius: '5px',
                            border: `1.5px solid ${waitingOnType === t ? colors.amber : colors.border}`,
                            background: waitingOnType === t ? `${colors.amber}18` : 'transparent',
                            color: waitingOnType === t ? colors.amber : colors.tertiary,
                            fontSize: '11.5px', fontWeight: waitingOnType === t ? 600 : 400,
                            cursor: 'pointer', transition: 'all 0.12s',
                          }}
                        >
                          {t === 'team_member' ? 'Team Member' : 'External Dependency'}
                        </button>
                      ))}
                    </div>

                    {/* Team member dropdown */}
                    {waitingOnType === 'team_member' && (
                      <select
                        value={waitingOnUserId}
                        onChange={e => { setWaitingOnUserId(e.target.value); setWaitingOnError(false) }}
                        className="boe-input"
                        style={{ width: '100%', border: waitingOnError ? `1.5px solid ${colors.red}` : undefined }}
                      >
                        <option value="">Select team member…</option>
                        {teamMembers.map(m => (
                          <option key={m.id} value={m.id}>{m.full_name}</option>
                        ))}
                      </select>
                    )}

                    {/* External text input */}
                    {waitingOnType === 'external' && (
                      <input
                        type="text"
                        value={waitingOnText}
                        onChange={e => { setWaitingOnText(e.target.value); setWaitingOnError(false) }}
                        placeholder="e.g. Client approval, Vendor quotation, Architect drawing…"
                        className="boe-input"
                        style={{ width: '100%', boxSizing: 'border-box', border: waitingOnError ? `1.5px solid ${colors.red}` : undefined }}
                      />
                    )}
                  </div>
                )}

                <div>
                  <p style={{
                    fontSize: '11px', fontWeight: 500, marginBottom: '5px',
                    color: noteError ? colors.red : colors.tertiary,
                  }}>
                    Notes
                    {selectedStatus === 'blocked' && (
                      <span style={{ color: colors.red }}> (required for blocked)</span>
                    )}
                  </p>
                  <textarea
                    value={updateNote}
                    onChange={e => { setUpdateNote(e.target.value); if (noteError) setNoteError(false) }}
                    placeholder="Add your update or notes..."
                    rows={3}
                    className="boe-input"
                    style={{ resize: 'none', border: noteError ? `1.5px solid ${colors.red}` : undefined }}
                  />
                  <p style={{ textAlign: 'right', fontSize: '10px', color: colors.muted, marginTop: '2px' }}>
                    {updateNote.length} / 1000
                  </p>
                </div>

                <div>
                  <button
                    onClick={saveUpdate}
                    disabled={saving || markingComplete}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '8px 18px', borderRadius: '7px',
                      border: `1.5px solid ${colors.blue}`,
                      background: colors.blueTint,
                      color: colors.blue,
                      fontSize: '12px', fontWeight: 600,
                      cursor: saving || markingComplete ? 'not-allowed' : 'pointer',
                      fontFamily: font.body,
                      opacity: saving || markingComplete ? 0.6 : 1,
                      transition: 'all 0.15s',
                    }}
                  >
                    {saving ? 'Saving…' : 'Update Status'}
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* ══ COLUMN 2 — Task Summary ════════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0', minWidth: 0 }}>
          <div className="boe-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '0' }}>

            <div style={{ marginBottom: '12px' }}>
              <span style={{
                display: 'inline-block',
                fontSize: '11px', fontWeight: 700,
                color: relationColor,
                background: relationColor + '14',
                border: `1px solid ${relationColor}30`,
                padding: '4px 10px', borderRadius: '20px',
              }}>
                {relationLabel}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={summaryLabel}>Status</span>
              <span style={{ fontSize: '11px', fontWeight: 600, color: statusColor, background: statusTint, padding: '2px 8px', borderRadius: '10px' }}>
                {task.status.charAt(0).toUpperCase() + task.status.slice(1)}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={summaryLabel}>Priority</span>
              <span style={{ fontSize: '11px', fontWeight: 600, color: priorityStyle.fg, background: priorityStyle.bg, padding: '2px 8px', borderRadius: '10px' }}>
                {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={summaryLabel}>Due Date</span>
              <span style={{ ...summaryValue, color: riskOverdue ? colors.red : colors.secondary }}>
                {task.due_date ? formatFullDate(task.due_date) : '—'}
                {riskOverdue && <span style={{ fontSize: '10px', marginLeft: '4px', color: colors.red }}>· Overdue</span>}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
              <span style={summaryLabel}>Owner</span>
              <span style={summaryValue}>{assigneeName}</span>
            </div>

            {(() => {
              const aging = getTaskAging(task)
              if (!aging) return (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: task.is_urgent ? `1px solid ${colors.border}` : 'none' }}>
                  <span style={summaryLabel}>Assigned By</span>
                  <span style={summaryValue}>{creatorName ?? '—'}</span>
                </div>
              )
              const agingColor = aging.severity === 'danger' ? colors.red : colors.amber
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: `1px solid ${colors.border}` }}>
                    <span style={summaryLabel}>Assigned By</span>
                    <span style={summaryValue}>{creatorName ?? '—'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: task.is_urgent ? `1px solid ${colors.border}` : 'none' }}>
                    <span style={summaryLabel}>Aging</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{
                        fontSize: '11px', fontWeight: 700,
                        color: agingColor, background: `${agingColor}14`,
                        border: `1px solid ${agingColor}30`,
                        padding: '2px 8px', borderRadius: '10px',
                      }}>
                        {aging.label}
                      </span>
                      <span style={{ fontSize: '10px', color: colors.muted }}>{aging.daysSinceUpdate}d</span>
                    </div>
                  </div>
                </>
              )
            })()}

            {task.is_urgent && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
                <span style={summaryLabel}>Important</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#C49A28', background: 'rgba(196,154,40,0.1)', padding: '2px 8px', borderRadius: '10px' }}>
                  ⭐ Yes
                </span>
              </div>
            )}

            {/* Acknowledge — delegated + unacknowledged only */}
            {!task.acknowledged_at && isAssignee && task.created_by !== currentUserId && (
              <div style={{ marginTop: '12px', borderTop: `1px solid ${colors.border}`, paddingTop: '12px' }}>
                <button
                  onClick={acknowledge}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                    padding: '8px 14px', borderRadius: '7px',
                    border: `1.5px solid ${colors.amber}50`,
                    background: colors.amberTint,
                    color: colors.amber,
                    fontSize: '12px', fontWeight: 600,
                    cursor: 'pointer', fontFamily: font.body,
                    transition: 'background 0.15s',
                  }}
                >
                  Tap to Acknowledge
                </button>
              </div>
            )}
            {!task.acknowledged_at && !isAssignee && (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${colors.border}` }}>
                <p style={{ fontSize: '11px', color: colors.amber, fontWeight: 600, textAlign: 'center' }}>
                  ⏳ Awaiting acknowledgement
                </p>
              </div>
            )}

            {/* Creator-only: Edit Due Date & Priority */}
            {isCreator && task.status !== 'completed' && (
              <div style={{ marginTop: '14px', borderTop: `1px solid ${colors.border}`, paddingTop: '12px' }}>
                {!editingMeta ? (
                  <button
                    onClick={() => {
                      setEditDueDate(task.due_date ?? '')
                      setEditPriority(task.priority)
                      setMetaSaveMsg(null)
                      setEditingMeta(true)
                    }}
                    style={{
                      width: '100%', padding: '7px 14px', borderRadius: '7px',
                      border: `1.5px solid ${colors.border}`,
                      background: 'transparent', color: colors.tertiary,
                      fontSize: '12px', fontWeight: 500,
                      cursor: 'pointer', fontFamily: font.body,
                    }}
                  >
                    Edit Due Date / Priority
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.muted }}>
                      Edit Due Date &amp; Priority
                    </span>

                    <div>
                      <p style={{ fontSize: '11px', color: colors.tertiary, marginBottom: '4px', fontWeight: 500 }}>Due Date</p>
                      <input
                        type="date"
                        value={editDueDate}
                        onChange={e => setEditDueDate(e.target.value)}
                        className="boe-input"
                        style={{ width: '100%', boxSizing: 'border-box' }}
                      />
                    </div>

                    <div>
                      <p style={{ fontSize: '11px', color: colors.tertiary, marginBottom: '4px', fontWeight: 500 }}>Priority</p>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {(['high', 'medium', 'low'] as const).map(p => {
                          const ps = PRIORITY_COLORS[p]
                          const active = editPriority === p
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setEditPriority(p)}
                              style={{
                                flex: 1, padding: '5px 8px', borderRadius: '5px',
                                border: `1.5px solid ${active ? ps.fg : colors.border}`,
                                background: active ? ps.bg : 'transparent',
                                color: active ? ps.fg : colors.tertiary,
                                fontSize: '11.5px', fontWeight: active ? 600 : 400,
                                cursor: 'pointer', textTransform: 'capitalize',
                                fontFamily: font.body, transition: 'all 0.12s',
                              }}
                            >
                              {p}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {metaSaveMsg && (
                      <p style={{ fontSize: '11px', color: metaSaveMsg.ok ? colors.green : colors.red, margin: 0 }}>
                        {metaSaveMsg.text}
                      </p>
                    )}

                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={saveMetaChanges}
                        disabled={savingMeta}
                        style={{
                          flex: 1, padding: '7px 12px', borderRadius: '7px',
                          border: `1.5px solid ${colors.blue}`,
                          background: colors.blueTint, color: colors.blue,
                          fontSize: '12px', fontWeight: 600,
                          cursor: savingMeta ? 'not-allowed' : 'pointer',
                          fontFamily: font.body, opacity: savingMeta ? 0.6 : 1,
                        }}
                      >
                        {savingMeta ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingMeta(false); setMetaSaveMsg(null) }}
                        disabled={savingMeta}
                        style={{
                          padding: '7px 12px', borderRadius: '7px',
                          border: `1.5px solid ${colors.border}`,
                          background: 'transparent', color: colors.tertiary,
                          fontSize: '12px', fontWeight: 500,
                          cursor: savingMeta ? 'not-allowed' : 'pointer',
                          fontFamily: font.body,
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Mark Task Completed / completed state */}
            <div style={{ marginTop: '14px', borderTop: `1px solid ${colors.border}`, paddingTop: '12px' }}>
              {task.status === 'completed' ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  padding: '10px 14px', borderRadius: '7px',
                  background: colors.greenTint,
                  border: `1px solid ${colors.green}28`,
                }}>
                  <CircleCheckBig size={14} color={colors.green} strokeWidth={2.2} />
                  <span style={{ fontSize: '12px', fontWeight: 600, color: colors.green }}>Task Completed</span>
                </div>
              ) : isAssignee && !isUnacknowledged ? (
                <button
                  onClick={async () => {
                    setMarkingComplete(true)
                    await applyStatusChange('completed', null)
                    setMarkingComplete(false)
                  }}
                  disabled={saving || markingComplete}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                    padding: '11px 14px', borderRadius: '7px',
                    border: `1.5px solid ${colors.green}`,
                    background: colors.greenTint,
                    color: colors.green,
                    fontSize: '13px', fontWeight: 600,
                    cursor: saving || markingComplete ? 'not-allowed' : 'pointer',
                    fontFamily: font.body,
                    opacity: saving || markingComplete ? 0.6 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  <CircleCheckBig size={15} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                  {markingComplete ? 'Marking Complete…' : 'Mark Task Completed'}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* ══ COLUMN 3 — Activity (far right, internal scroll) ══════════════ */}
        <div style={{ minWidth: 0 }}>
          {log.length > 0 ? (
            <div className="boe-card" style={{ overflow: 'hidden', padding: '0', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '9px 14px 8px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: colors.muted,
                }}>
                  Activity
                </span>
              </div>
              {/* Internal scroll — page height unaffected by entry count */}
              <div style={{
                maxHeight: '480px',
                overflowY: 'auto',
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(0,0,0,0.08) transparent',
              }}>
                {log.map((entry, i) => {
                  const dotColor =
                    entry.action === 'acknowledged'     ? colors.green
                    : entry.action === 'status_changed' && entry.to_status
                      ? (STATUS_COLORS[entry.to_status] ?? colors.muted)
                    : colors.muted

                  return (
                    <div
                      key={entry.id}
                      style={{
                        display: 'flex', gap: '8px', alignItems: 'flex-start',
                        padding: '7px 12px',
                        borderBottom: i < log.length - 1 ? `1px solid ${colors.border}` : 'none',
                      }}
                    >
                      <span style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: dotColor, flexShrink: 0, marginTop: '4px',
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <p style={{ color: colors.secondary, fontSize: '11px', lineHeight: 1.3 }}>
                            {formatLogAction(entry.action, entry.from_status, entry.to_status)}
                          </p>
                          {entry.actor_name && (
                            <span style={{ color: colors.muted, fontSize: '10px', flexShrink: 0 }}>
                              {entry.actor_name}
                            </span>
                          )}
                        </div>
                        {entry.note && (
                          <p style={{ color: colors.muted, fontSize: '11px', marginTop: '1px', lineHeight: 1.3 }}>
                            {entry.note}
                          </p>
                        )}
                        <p style={{ color: colors.muted, fontSize: '10px', marginTop: '1px', fontFamily: font.mono, opacity: 0.75 }}>
                          {formatDateTime(entry.created_at)}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            /* Empty state — keeps column visible but doesn't add noise */
            <div className="boe-card" style={{ padding: '14px', opacity: 0.5 }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.muted }}>
                Activity
              </span>
              <p style={{ fontSize: '11px', color: colors.muted, fontStyle: 'italic', marginTop: '8px', marginBottom: 0 }}>
                No activity yet.
              </p>
            </div>
          )}
        </div>

      </div>
    </DashboardLayout>
  )
}
