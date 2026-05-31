'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, LogEntry, TaskStatus, UserProfile } from '@/lib/types'
import {
  isOverdue, formatFullDate, formatDateTime,
  formatLogAction, timeAgo,
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

  const [selectedStatus,  setSelectedStatus]  = useState<string>('')
  const [updateNote,      setUpdateNote]      = useState('')
  const [waitingOn,       setWaitingOn]       = useState('')
  const [noteError,       setNoteError]       = useState(false)
  const [waitingOnError,  setWaitingOnError]  = useState(false)
  const [saving,          setSaving]          = useState(false)
  const [markingComplete, setMarkingComplete] = useState(false)

  const WAITING_ON_OPTIONS = [
    'Client', 'Vendor', 'Design Team', 'Purchase Team',
    'Production', 'Management', 'Transport', 'Other',
  ]

  const router   = useRouter()
  const params   = useParams()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCurrentUserId(user.id)

      const [{ data: taskData }, { data: profileData }] = await Promise.all([
        supabase.from('tasks').select('*').eq('id', params.id).single(),
        supabase.from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', user.id).single(),
      ])

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
    const now = new Date().toISOString()
    await supabase.from('tasks').update({ acknowledged_at: now }).eq('id', task.id)
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId, action: 'acknowledged', note: null,
    })
    if (task.created_by !== currentUserId) {
      await supabase.from('notifications').insert({
        user_id: task.created_by, task_id: task.id, type: 'task_acknowledged',
        title: 'Task acknowledged', body: task.title, is_push_sent: true,
      })
    }
    setTask({ ...task, acknowledged_at: now })
    await loadLog(task.id)
  }

  const applyStatusChange = async (newStatus: string, reason: string | null) => {
    if (!task) return
    const oldStatus = task.status
    const updates: Record<string, unknown> = {
      status:         newStatus,
      last_update_at: new Date().toISOString(),
    }
    if (reason)                    updates.blocker_reason = reason
    if (newStatus === 'completed') updates.completed_at   = new Date().toISOString()

    await supabase.from('tasks').update(updates).eq('id', task.id)
    await supabase.from('task_activity_log').insert({
      task_id:     task.id,
      actor_id:    currentUserId,
      action:      'status_changed',
      from_status: oldStatus,
      to_status:   newStatus,
      note:        reason ?? null,
    })
    setTask({ ...task, status: newStatus as TaskStatus, blocker_reason: reason ?? task.blocker_reason })
    setSelectedStatus(newStatus)
    await loadLog(task.id)
    if (newStatus === 'completed') setTimeout(() => router.push('/dashboard'), 800)
  }

  const saveUpdate = async () => {
    if (!task) return
    const needsNote = selectedStatus === 'waiting' || selectedStatus === 'blocked'
    if (needsNote && !updateNote.trim()) { setNoteError(true); return }
    if (selectedStatus === 'waiting' && !waitingOn) { setWaitingOnError(true); return }
    setNoteError(false)
    setWaitingOnError(false)
    setSaving(true)

    if (selectedStatus !== task.status) {
      const reasonParts = []
      if (selectedStatus === 'waiting' && waitingOn) reasonParts.push(`Waiting on: ${waitingOn}`)
      if (updateNote.trim()) reasonParts.push(updateNote.trim())
      await applyStatusChange(selectedStatus, reasonParts.join(' — ') || null)
    } else if (updateNote.trim()) {
      const now = new Date().toISOString()
      await supabase.from('tasks').update({ last_update_at: now }).eq('id', task.id)
      await supabase.from('task_activity_log').insert({
        task_id:  task.id,
        actor_id: currentUserId,
        action:   'progress_update',
        note:     updateNote.trim(),
      })
      setTask({ ...task, last_update_at: now })
      await loadLog(task.id)
    }

    setUpdateNote('')
    setSaving(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <LoadingScreen />
  if (!task)   return <LoadingScreen message="Task not found" />

  const overdue      = isOverdue(task.due_date ?? null)
  const isAssignee   = task.assigned_to === currentUserId
  const isSelfTask   = task.created_by === currentUserId && task.assigned_to === currentUserId
  const isDelegated  = !isAssignee && task.created_by === currentUserId
  const riskOverdue  = overdue && task.status !== 'completed'
  const assigneeName = isAssignee ? (profile?.full_name ?? 'You') : (task.assignee_name ?? '—')

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
  // Suppress note display when it is identical to the blocker_reason already
  // shown in the Waiting On / Blocker strip — they are the same string when a
  // status-change is saved (applyStatusChange writes reason to both fields).
  const noteIsDuplicateOfBlocker =
    (task.status === 'waiting' || task.status === 'blocked') &&
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

              {/* Waiting On / Blocker — one clean inline line */}
              {(task.status === 'waiting' || task.status === 'blocked') && task.blocker_reason && (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: statusColor, flexShrink: 0,
                  }}>
                    {task.status === 'waiting' ? 'Waiting On' : 'Blocker'}
                  </span>
                  <span style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.4 }}>
                    {task.status === 'waiting' && task.blocker_reason.startsWith('Waiting on: ')
                      ? task.blocker_reason.slice('Waiting on: '.length)
                      : task.blocker_reason}
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

            {/* § Update Status — assignee only, task not completed */}
            {isAssignee && task.status !== 'completed' && (
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
                          if (s !== 'waiting') setWaitingOn('')
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
                  <div>
                    <p style={{
                      fontSize: '11px', fontWeight: 500, marginBottom: '6px',
                      color: waitingOnError ? colors.red : colors.tertiary,
                    }}>
                      Waiting On <span style={{ color: colors.red }}>*</span>
                      {waitingOnError && <span style={{ color: colors.red }}> — required</span>}
                    </p>
                    <select
                      value={waitingOn}
                      onChange={e => { setWaitingOn(e.target.value); setWaitingOnError(false) }}
                      className="boe-input"
                      style={{ width: '100%', border: waitingOnError ? `1.5px solid ${colors.red}` : undefined }}
                    >
                      <option value="">Select who/what you&apos;re waiting on…</option>
                      {WAITING_ON_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <p style={{
                    fontSize: '11px', fontWeight: 500, marginBottom: '5px',
                    color: noteError ? colors.red : colors.tertiary,
                  }}>
                    Notes
                    {(selectedStatus === 'waiting' || selectedStatus === 'blocked') && (
                      <span style={{ color: colors.red }}> (required for {selectedStatus})</span>
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

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: task.is_urgent ? `1px solid ${colors.border}` : 'none' }}>
              <span style={summaryLabel}>Assigned By</span>
              <span style={summaryValue}>{creatorName ?? '—'}</span>
            </div>

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
              ) : isAssignee ? (
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
