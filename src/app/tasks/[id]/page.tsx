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

  const [updateFile,     setUpdateFile]     = useState<File | null>(null)
  const [uploadError,    setUploadError]    = useState<string | null>(null)

  const [editingDueDate,   setEditingDueDate]   = useState(false)
  const [editingPriority,  setEditingPriority]  = useState(false)
  const [editDueDate,      setEditDueDate]      = useState('')
  const [editPriority,     setEditPriority]     = useState<'high' | 'medium' | 'low'>('medium')
  const [savingDueDate,    setSavingDueDate]    = useState(false)
  const [savingPriority,   setSavingPriority]   = useState(false)
  const [dueDateMsg,       setDueDateMsg]       = useState<{ ok: boolean; text: string } | null>(null)
  const [priorityMsg,      setPriorityMsg]      = useState<{ ok: boolean; text: string } | null>(null)

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
      .select(`id, action, note, from_status, to_status, created_at, actor_id, attachment_url,
               users:actor_id ( full_name )`)
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
    if (data) {
      setLog((data as any[]).map(e => ({
        ...e,
        actor_name:     e.users?.full_name ?? null,
        attachment_url: e.attachment_url ?? null,
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

  const applyStatusChange = async (newStatus: string, reason: string | null, attachmentUrl?: string | null) => {
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
      task_id:        task.id,
      actor_id:       currentUserId,
      action:         'status_changed',
      from_status:    oldStatus,
      to_status:      newStatus,
      note:           reason ?? null,
      attachment_url: attachmentUrl ?? null,
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

  const uploadUpdateAttachment = async (): Promise<string | null> => {
    if (!updateFile || !task) return null
    const ext  = updateFile.name.split('.').pop() ?? 'bin'
    const path = `updates/${task.id}/${Date.now()}.${ext}`
    const { error } = await supabase.storage
      .from('task-attachments')
      .upload(path, updateFile, { upsert: false })
    if (error) {
      setUploadError('Attachment upload failed. Update was saved without it.')
      return null
    }
    const { data } = supabase.storage.from('task-attachments').getPublicUrl(path)
    return data.publicUrl
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
    setUploadError(null)
    setSaving(true)

    const attachmentUrl = await uploadUpdateAttachment()

    const hasStatusChange = selectedStatus !== task.status
    const hasNote         = !!updateNote.trim()
    const hasAttachment   = !!attachmentUrl

    if (!hasStatusChange && !hasNote && !hasAttachment) {
      setSaving(false)
      return
    }

    if (hasStatusChange) {
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
          attachment_url: attachmentUrl ?? null,
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
        await applyStatusChange(selectedStatus, updateNote.trim() || null, attachmentUrl)
      }
    } else if (hasNote || hasAttachment) {
      const now = new Date().toISOString()
      const { error: noteTaskErr } = await supabase.from('tasks').update({ last_update_at: now }).eq('id', task.id)
      if (noteTaskErr) {
        console.error('[saveUpdate/note] tasks update failed:', noteTaskErr.message)
        window.alert('Failed to save update. Please try again.')
        setSaving(false)
        return
      }
      const { error: noteLogErr } = await supabase.from('task_activity_log').insert({
        task_id:        task.id,
        actor_id:       currentUserId,
        action:         'progress_update',
        note:           updateNote.trim() || null,
        attachment_url: attachmentUrl ?? null,
      })
      if (noteLogErr) console.error('[saveUpdate/note] activity log insert failed:', noteLogErr.message)
      setTask({ ...task, last_update_at: now })
      await loadLog(task.id)
    }

    setUpdateNote('')
    setUpdateFile(null)
    setSaving(false)
  }

  const saveDueDate = async () => {
    if (!task) return
    setSavingDueDate(true)
    setDueDateMsg(null)
    if (editDueDate === (task.due_date ?? '')) { setEditingDueDate(false); setSavingDueDate(false); return }
    const updates = { due_date: editDueDate || null }
    const { error } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (error) { setDueDateMsg({ ok: false, text: 'Failed to save.' }); setSavingDueDate(false); return }
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId,
      action: 'deadline_changed', note: editDueDate ? `Due date set to ${editDueDate}` : 'Due date cleared',
    })
    setTask({ ...task, ...updates as Partial<Task> })
    await loadLog(task.id)
    setEditingDueDate(false)
    setSavingDueDate(false)
  }

  const savePriority = async () => {
    if (!task) return
    setSavingPriority(true)
    setPriorityMsg(null)
    if (editPriority === task.priority) { setEditingPriority(false); setSavingPriority(false); return }
    const updates = { priority: editPriority }
    const { error } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (error) { setPriorityMsg({ ok: false, text: 'Failed to save.' }); setSavingPriority(false); return }
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId,
      action: 'priority_changed', note: `Priority changed from ${task.priority} to ${editPriority}`,
    })
    setTask({ ...task, ...updates as Partial<Task> })
    await loadLog(task.id)
    setEditingPriority(false)
    setSavingPriority(false)
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

  const latestNoteEntry   = log.find(e => e.note) ?? null
  const currentStatusNote = latestNoteEntry?.note ?? null
  const noteIsDuplicateOfBlocker =
    task.status === 'blocked' &&
    currentStatusNote !== null &&
    currentStatusNote === task.blocker_reason

  const aging = getTaskAging(task)
  const agingColor = aging ? (aging.severity === 'danger' ? colors.red : colors.amber) : colors.muted

  return (
    <DashboardLayout
      profile={profile}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              fontSize: '13px', fontWeight: 600,
              color: colors.muted,
              background: 'none', border: 'none',
              cursor: 'pointer', padding: '3px 8px',
              borderRadius: '6px',
              transition: 'background 0.15s',
              fontFamily: 'inherit',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = colors.float)}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            aria-label="Go back"
          >
            ← Back
          </button>
          <span>Task Details</span>
          <span style={{
            fontSize: '11px', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: relationColor,
            background: relationColor + '14',
            border: `1px solid ${relationColor}28`,
            padding: '3px 10px', borderRadius: '20px',
          }}>
            {relationLabel}
          </span>
        </div>
      }
      onSignOut={handleLogout}
    >

      <div className="boe-task-2col">

        {/* ══ LEFT COLUMN ══════════════════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>

            {/* ─ A. Task Summary Card ─ */}
            <div className="boe-card" style={{
              padding: '14px 22px',
              background: '#ffffff',
              borderLeft: `3px solid ${relationColor}`,
            }}>
              {/* Task title */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
                {task.is_urgent && (
                  <span style={{ fontSize: '15px', lineHeight: '1.35', flexShrink: 0, marginTop: '1px' }} title="Starred">⭐</span>
                )}
                <h2 style={{
                  fontSize: '18px', fontWeight: 800,
                  color: colors.primary, lineHeight: 1.3,
                  letterSpacing: '-0.02em', margin: 0,
                }}>
                  {task.title}
                </h2>
              </div>

              {/* Assigned by */}
              {creatorName && (
                <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px' }}>👤</span>
                  <span style={{ fontSize: '13px', color: colors.muted, fontWeight: 500 }}>Assigned by:</span>
                  <strong style={{ fontSize: '14px', color: colors.primary, fontWeight: 700 }}>{creatorName}</strong>
                </div>
              )}

              {/* Due date chip + inline edit */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'flex-start' }}>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '4px 10px', borderRadius: '20px',
                    background: riskOverdue ? colors.redTint : colors.float,
                    border: `1px solid ${riskOverdue ? colors.red + '40' : colors.border}`,
                  }}>
                    <span style={{ fontSize: '11.5px', color: riskOverdue ? colors.red : colors.secondary, fontWeight: 500 }}>
                      {task.due_date ? <>Due: <strong>{formatFullDate(task.due_date)}</strong>{riskOverdue && ' · Overdue'}</> : 'No due date'}
                    </span>
                    {isCreator && task.status !== 'completed' && !editingDueDate && (
                      <button
                        onClick={() => { setEditDueDate(task.due_date ? task.due_date.slice(0, 10) : ''); setDueDateMsg(null); setEditingDueDate(true); setEditingPriority(false) }}
                        style={{ fontSize: '10px', fontWeight: 600, color: colors.blue, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: font.body, textDecoration: 'underline' }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {editingDueDate && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <input
                        type="date"
                        value={editDueDate}
                        onChange={e => setEditDueDate(e.target.value)}
                        className="boe-input"
                        style={{ width: '150px', boxSizing: 'border-box' }}
                      />
                      <button
                        onClick={saveDueDate}
                        disabled={savingDueDate}
                        style={{ padding: '5px 12px', borderRadius: '6px', border: `1.5px solid ${colors.blue}`, background: colors.blue, color: '#ffffff', fontSize: '11.5px', fontWeight: 600, cursor: savingDueDate ? 'not-allowed' : 'pointer', fontFamily: font.body, opacity: savingDueDate ? 0.6 : 1 }}
                      >
                        {savingDueDate ? '…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingDueDate(false); setDueDateMsg(null) }}
                        disabled={savingDueDate}
                        style={{ padding: '5px 10px', borderRadius: '6px', border: `1.5px solid ${colors.border}`, background: 'transparent', color: colors.tertiary, fontSize: '11.5px', fontWeight: 500, cursor: 'pointer', fontFamily: font.body }}
                      >
                        Cancel
                      </button>
                      {dueDateMsg && <span style={{ fontSize: '11px', color: dueDateMsg.ok ? colors.green : colors.red }}>{dueDateMsg.text}</span>}
                    </div>
                  )}
                </div>

                {/* Priority chip + inline edit */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '4px 10px', borderRadius: '20px',
                    background: priorityStyle.bg,
                    border: `1px solid ${priorityStyle.fg}30`,
                  }}>
                    <span style={{ fontSize: '11.5px', color: priorityStyle.fg, fontWeight: 600 }}>
                      Priority: {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                    </span>
                    {isCreator && task.status !== 'completed' && !editingPriority && (
                      <button
                        onClick={() => { setEditPriority(task.priority); setPriorityMsg(null); setEditingPriority(true); setEditingDueDate(false) }}
                        style={{ fontSize: '10px', fontWeight: 600, color: colors.blue, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: font.body, textDecoration: 'underline' }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {editingPriority && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {(['high', 'medium', 'low'] as const).map(p => {
                        const ps = PRIORITY_COLORS[p]
                        const active = editPriority === p
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setEditPriority(p)}
                            style={{
                              padding: '5px 10px', borderRadius: '5px',
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
                      <button
                        onClick={savePriority}
                        disabled={savingPriority}
                        style={{ padding: '5px 12px', borderRadius: '6px', border: `1.5px solid ${colors.blue}`, background: colors.blue, color: '#ffffff', fontSize: '11.5px', fontWeight: 600, cursor: savingPriority ? 'not-allowed' : 'pointer', fontFamily: font.body, opacity: savingPriority ? 0.6 : 1 }}
                      >
                        {savingPriority ? '…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingPriority(false); setPriorityMsg(null) }}
                        disabled={savingPriority}
                        style={{ padding: '5px 10px', borderRadius: '6px', border: `1.5px solid ${colors.border}`, background: 'transparent', color: colors.tertiary, fontSize: '11.5px', fontWeight: 500, cursor: 'pointer', fontFamily: font.body }}
                      >
                        Cancel
                      </button>
                      {priorityMsg && <span style={{ fontSize: '11px', color: priorityMsg.ok ? colors.green : colors.red }}>{priorityMsg.text}</span>}
                    </div>
                  )}
                </div>

              </div>

              {/* Description */}
              {task.note ? (
                <p style={{
                  fontSize: '13px', color: colors.secondary, lineHeight: 1.7,
                  margin: '12px 0 0', whiteSpace: 'pre-wrap',
                }}>
                  {task.note}
                </p>
              ) : (
                <p style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: '12px 0 0' }}>
                  No description.
                </p>
              )}

              {/* Task attachment */}
              {task.attachment_url && (
                <div style={{ marginTop: '10px' }}>
                  <a
                    href={task.attachment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      fontSize: '11.5px', fontWeight: 500,
                      color: colors.blue, textDecoration: 'none',
                      padding: '4px 10px', borderRadius: '6px',
                      border: `1px solid ${colors.blue}28`,
                      background: colors.blueTint,
                    }}
                  >
                    📎 View Attachment
                  </a>
                </div>
              )}
            </div>

            {/* ─ B. Current Status Card ─ */}
            <div className="boe-card" style={{
              padding: '16px 20px',
              background: statusTint,
              borderLeft: `3px solid ${statusColor}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: statusColor,
                }}>
                  Current Status
                </span>
                <span style={{
                  fontSize: '13px', fontWeight: 700, letterSpacing: '0.01em',
                  color: '#ffffff',
                  padding: '4px 14px', borderRadius: '20px',
                  background: statusColor,
                  boxShadow: `0 1px 4px ${statusColor}40`,
                }}>
                  {task.status.charAt(0).toUpperCase() + task.status.slice(1)}
                </span>
              </div>

              {/* Waiting On */}
              {task.status === 'waiting' && task.waiting_on_type && (
                <p style={{ fontSize: '12px', color: colors.secondary, margin: '0 0 4px', lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 700, color: statusColor }}>Waiting on: </span>
                  {task.waiting_on_type === 'team_member'
                    ? (teamMembers.find(m => m.id === task.waiting_on_user_id)?.full_name ?? 'Team member')
                    : (task.waiting_on_text ?? '—')
                  }
                  <span style={{ fontSize: '10.5px', color: colors.muted }}> ({task.waiting_on_type === 'team_member' ? 'Team Member' : 'External'})</span>
                </p>
              )}

              {/* Blocker */}
              {task.status === 'blocked' && task.blocker_reason && (
                <p style={{ fontSize: '12px', color: colors.secondary, margin: '0 0 4px', lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 700, color: statusColor }}>Blocker: </span>
                  {task.blocker_reason}
                </p>
              )}

              {/* Latest note — focal point */}
              {!noteIsDuplicateOfBlocker && currentStatusNote && (
                <p style={{
                  fontSize: '14px', color: colors.primary,
                  lineHeight: 1.6, margin: '4px 0',
                  fontWeight: 500,
                }}>
                  {currentStatusNote}
                </p>
              )}

              {latestNoteEntry && (
                <p style={{ fontSize: '10.5px', color: statusColor, margin: '4px 0 0', fontWeight: 500 }}>
                  Updated by{latestNoteEntry.actor_name && <strong> {latestNoteEntry.actor_name}</strong>} · {timeAgo(latestNoteEntry.created_at)}
                </p>
              )}
            </div>

            {/* § Unacknowledged notice */}
            {isUnacknowledged && (
              <div className="boe-card" style={{
                padding: '12px 18px',
                background: colors.amberTint,
                borderLeft: `3px solid ${colors.amber}`,
              }}>
                <p style={{ fontSize: '12px', color: colors.amber, fontWeight: 600, margin: 0 }}>
                  ⚠️ Please acknowledge this task before updating it.
                </p>
              </div>
            )}

            {/* ─ C. Update Status Card ─ */}
            {isAssignee && task.status !== 'completed' && !isUnacknowledged && (
              <div className="boe-card" style={{
                padding: '16px 20px',
                display: 'flex', flexDirection: 'column', gap: '12px',
                background: '#ffffff',
              }}>

                {/* Row: label + pills */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700,
                    letterSpacing: '0.09em', textTransform: 'uppercase',
                    color: colors.muted, flexShrink: 0, whiteSpace: 'nowrap',
                  }}>
                    Update Status
                  </span>
                  <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
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
                            flex: 1,
                            padding: '6px 0', borderRadius: '7px',
                            border: `1.5px solid ${active ? STATUS_COLORS[s] : colors.border}`,
                            background: active ? STATUS_TINTS[s] : '#ffffff',
                            color: active ? STATUS_COLORS[s] : colors.tertiary,
                            fontSize: '11.5px', fontWeight: active ? 700 : 500,
                            cursor: 'pointer', textTransform: 'capitalize',
                            transition: 'all 0.15s',
                            boxShadow: active ? `0 1px 5px ${STATUS_COLORS[s]}30` : 'none',
                            fontFamily: font.body,
                          }}
                        >
                          {s}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Waiting On selector */}
                {selectedStatus === 'waiting' && (
                  <div style={{
                    padding: '10px 12px', borderRadius: '8px',
                    background: `${colors.amber}08`,
                    border: `1.5px solid ${waitingOnError ? colors.red : colors.amber + '40'}`,
                  }}>
                    <p style={{
                      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.07em', marginBottom: '8px',
                      color: waitingOnError ? colors.red : colors.amber,
                    }}>
                      Waiting On <span style={{ color: colors.red }}>*</span>
                      {waitingOnError && <span> — required</span>}
                    </p>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      {(['team_member', 'external'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => { setWaitingOnType(t); setWaitingOnUserId(''); setWaitingOnText(''); setWaitingOnError(false) }}
                          style={{
                            flex: 1, padding: '6px 8px', borderRadius: '7px',
                            border: `1.5px solid ${waitingOnType === t ? colors.amber : colors.border}`,
                            background: waitingOnType === t ? `${colors.amber}18` : colors.float,
                            color: waitingOnType === t ? colors.amber : colors.tertiary,
                            fontSize: '11.5px', fontWeight: waitingOnType === t ? 600 : 400,
                            cursor: 'pointer', transition: 'all 0.12s',
                          }}
                        >
                          {t === 'team_member' ? 'Team Member' : 'External Dependency'}
                        </button>
                      ))}
                    </div>
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

                {/* Textarea + footer row */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {noteError && selectedStatus === 'blocked' && (
                    <p style={{ fontSize: '11px', color: colors.red, margin: 0 }}>Note required for blocked status.</p>
                  )}
                  <div style={{ position: 'relative' }}>
                    <textarea
                      value={updateNote}
                      onChange={e => { setUpdateNote(e.target.value); if (noteError) setNoteError(false) }}
                      placeholder="Add update or notes…"
                      className="boe-input"
                      style={{
                        resize: 'none',
                        height: '72px',
                        paddingBottom: '36px',
                        width: '100%',
                        boxSizing: 'border-box',
                        border: noteError ? `1.5px solid ${colors.red}` : `1.5px solid ${colors.border}`,
                        background: '#F0F2F5',
                        borderRadius: '8px',
                        fontSize: '12.5px',
                        lineHeight: 1.5,
                      }}
                    />
                    <label
                      title="Attach a file"
                      style={{
                        position: 'absolute', bottom: '9px', right: '10px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: '28px', height: '28px',
                        borderRadius: '50%',
                        background: updateFile ? colors.blueTint : '#ffffff',
                        border: `1.5px solid ${updateFile ? colors.blue + '55' : colors.border}`,
                        fontSize: '13px',
                        cursor: 'pointer',
                        userSelect: 'none',
                        transition: 'all 0.15s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                      }}
                    >
                      📎
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
                        onChange={e => { setUpdateFile(e.target.files?.[0] ?? null); setUploadError(null) }}
                        style={{ display: 'none' }}
                      />
                    </label>
                  </div>

                  {/* Footer: file info + char count + submit */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10px', color: updateFile ? colors.blue : colors.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {updateFile
                        ? `📎 ${updateFile.name} (${(updateFile.size / 1024).toFixed(0)} KB)`
                        : uploadError
                          ? <span style={{ color: colors.red }}>{uploadError}</span>
                          : ''}
                    </span>
                    <span style={{ fontSize: '10px', color: colors.muted, flexShrink: 0 }}>{updateNote.length}/1000</span>
                    <button
                      onClick={saveUpdate}
                      disabled={saving || markingComplete}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '6px 18px', borderRadius: '7px',
                        border: `1.5px solid ${colors.blue}`,
                        background: colors.blue,
                        color: '#ffffff',
                        fontSize: '12px', fontWeight: 600,
                        cursor: saving || markingComplete ? 'not-allowed' : 'pointer',
                        fontFamily: font.body,
                        opacity: saving || markingComplete ? 0.6 : 1,
                        transition: 'all 0.15s',
                        boxShadow: '0 2px 6px rgba(85,133,232,0.25)',
                        flexShrink: 0,
                      }}
                    >
                      {saving ? 'Saving…' : 'Update Status'}
                    </button>
                  </div>
                  {uploadError && !updateFile && (
                    <p style={{ fontSize: '11px', color: colors.red, margin: 0 }}>{uploadError}</p>
                  )}
                </div>

              </div>
            )}

        </div>

        {/* ══ RIGHT COLUMN ════════════════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>

          {/* ─ A. Complete Task Card ─ */}
          {(task.status === 'completed' || (isAssignee && !isUnacknowledged)) && (
            <div className="boe-card" style={{
              padding: '14px',
              background: colors.greenTint,
              borderColor: `${colors.green}30`,
            }}>
              {task.status === 'completed' ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  padding: '11px 14px', borderRadius: '8px',
                  background: '#ffffff', border: `1px solid ${colors.green}28`,
                }}>
                  <CircleCheckBig size={16} color={colors.green} strokeWidth={2.2} />
                  <span style={{ fontSize: '13.5px', fontWeight: 700, color: colors.green }}>Task Completed</span>
                </div>
              ) : (
                <button
                  onClick={async () => {
                    const confirmed = window.confirm(
                      'Are you sure this task is completed? This will move it out of active work.'
                    )
                    if (!confirmed) return
                    setMarkingComplete(true)
                    await applyStatusChange('completed', null)
                    setMarkingComplete(false)
                  }}
                  disabled={saving || markingComplete}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    padding: '12px 14px', borderRadius: '8px',
                    border: `1.5px solid ${colors.green}`,
                    background: colors.green, color: '#ffffff',
                    fontSize: '14px', fontWeight: 700,
                    cursor: saving || markingComplete ? 'not-allowed' : 'pointer',
                    fontFamily: font.body,
                    opacity: saving || markingComplete ? 0.6 : 1,
                    transition: 'all 0.15s',
                    boxShadow: `0 2px 8px ${colors.green}38`,
                  }}
                >
                  <CircleCheckBig size={17} strokeWidth={2.4} style={{ flexShrink: 0 }} />
                  {markingComplete ? 'Marking Complete…' : 'Mark Task Completed'}
                </button>
              )}
            </div>
          )}

          {/* Acknowledge / awaiting */}
          {!task.acknowledged_at && isAssignee && task.created_by !== currentUserId && (
            <div className="boe-card" style={{ padding: '12px 14px' }}>
              <button
                onClick={acknowledge}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  padding: '8px 14px', borderRadius: '7px',
                  border: `1.5px solid ${colors.amber}50`,
                  background: colors.amberTint, color: colors.amber,
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
            <div className="boe-card" style={{ padding: '10px 14px', textAlign: 'center' }}>
              <p style={{ fontSize: '11px', color: colors.amber, fontWeight: 600, margin: 0 }}>
                ⏳ Awaiting acknowledgement
              </p>
            </div>
          )}

          {/* Aging badge */}
          {aging && (
            <div className="boe-card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: colors.muted }}>Aging</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
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
          )}

          {/* Activity */}
          <div className="boe-card" style={{ overflow: 'hidden', padding: '0' }}>
            <div style={{ padding: '10px 14px 9px', borderBottom: `1px solid ${colors.border}` }}>
              <span style={{
                fontSize: '11px', fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                color: colors.secondary,
              }}>
                Activity
              </span>
            </div>
            {log.length === 0 ? (
              <div style={{ padding: '14px', opacity: 0.5 }}>
                <p style={{ fontSize: '11px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                  No activity yet.
                </p>
              </div>
            ) : (
              <div style={{ padding: '4px 0' }}>
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
                        display: 'flex', gap: '0', alignItems: 'stretch',
                        padding: '0',
                      }}
                    >
                      {/* Timeline rail */}
                      <div style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        width: '32px', flexShrink: 0, paddingTop: '12px',
                      }}>
                        <div style={{
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: dotColor, border: `2px solid #ffffff`,
                          boxShadow: `0 0 0 1.5px ${dotColor}`,
                          flexShrink: 0, zIndex: 1,
                        }} />
                        {i < log.length - 1 && (
                          <div style={{
                            width: '1.5px', flex: 1, minHeight: '12px',
                            background: colors.border, marginTop: '3px',
                          }} />
                        )}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0, padding: '10px 14px 10px 0' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <p style={{ color: colors.secondary, fontSize: '12px', lineHeight: 1.35, fontWeight: 600, margin: 0 }}>
                            {formatLogAction(entry.action, entry.from_status, entry.to_status)}
                          </p>
                          {entry.actor_name && (
                            <span style={{ color: colors.muted, fontSize: '10.5px', flexShrink: 0 }}>
                              {entry.actor_name}
                            </span>
                          )}
                        </div>
                        {entry.note && (
                          <p style={{ color: colors.secondary, fontSize: '12px', marginTop: '3px', lineHeight: 1.5, margin: '3px 0 0' }}>
                            {entry.note}
                          </p>
                        )}
                        {entry.attachment_url && (
                          <a
                            href={entry.attachment_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              fontSize: '10.5px', fontWeight: 500,
                              color: colors.blue, marginTop: '3px',
                              textDecoration: 'none',
                            }}
                          >
                            📎 View Attachment
                          </a>
                        )}
                        <p style={{ color: colors.muted, fontSize: '10px', marginTop: '3px', fontFamily: font.mono }}>
                          {formatDateTime(entry.created_at)}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

        </div>{/* end right column */}

      </div>
    </DashboardLayout>
  )
}
