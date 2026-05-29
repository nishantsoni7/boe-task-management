'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, LogEntry, TaskStatus, UserProfile } from '@/lib/types'
import {
  isOverdue, formatFullDate, formatDateTime,
  formatLogAction, timeSince, timeAgo,
} from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { AlertBanner, LoadingScreen } from '@/components/ui/atoms'
import { CircleCheckBig } from 'lucide-react'

// ─── Status config ─────────────────────────────────────────────────────────────

const STATUSES: TaskStatus[] = ['pending', 'started', 'working', 'waiting', 'blocked', 'completed']

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

// ─── Atoms ─────────────────────────────────────────────────────────────────────

function Chip({ label, color, bg, icon }: {
  label: string; color?: string; bg?: string; icon?: string
}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '5px 10px', borderRadius: '20px',
      fontSize: '11px', fontWeight: 500,
      color:      color ?? colors.secondary,
      background: bg    ?? colors.float,
      border:     `1px solid ${color ? color + '28' : colors.border}`,
      whiteSpace: 'nowrap',
    }}>
      {icon && <span style={{ fontSize: '10px' }}>{icon}</span>}
      {label}
    </span>
  )
}

function AccRow({ label, value, valueColor, badge }: {
  label: string; value: string; valueColor?: string; badge?: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: '8px', padding: '5px 0', borderBottom: `1px solid ${colors.border}`,
    }}>
      <span style={{ color: colors.muted, fontSize: '11px', flexShrink: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        {badge}
        {value && (
          <span style={{ color: valueColor ?? colors.secondary, fontSize: '12px', fontWeight: 500, textAlign: 'right' }}>
            {value}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TaskDetailPage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [task,          setTask]          = useState<Task | null>(null)
  const [log,           setLog]           = useState<LogEntry[]>([])
  const [creatorName,   setCreatorName]   = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState('')
  const [loading,       setLoading]       = useState(true)

  const [selectedStatus, setSelectedStatus] = useState<string>('')
  const [updateNote,     setUpdateNote]     = useState('')
  const [waitingOn,      setWaitingOn]      = useState('')
  const [noteError,      setNoteError]      = useState(false)
  const [waitingOnError, setWaitingOnError] = useState(false)
  const [saving,         setSaving]         = useState(false)

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

  const overdue        = isOverdue(task.due_date ?? null)
  const isAssignee     = task.assigned_to === currentUserId
  const riskOverdue    = overdue && task.status !== 'completed'
  const assigneeName   = isAssignee ? (profile?.full_name ?? 'You') : (task.assignee_name ?? '—')
  const latestEntry    = log[0] ?? null
  const lastUpdatedBy  = latestEntry?.actor_name ?? '—'
  const lastUpdateRef  = task.last_update_at ?? task.created_at
  const openDays       = Math.floor((Date.now() - new Date(task.created_at).getTime()) / 86_400_000)
  const noProgressTime = timeSince(lastUpdateRef)
  const situationNote  = latestEntry?.note ?? task.note ?? null

  const statusColor = STATUS_COLORS[task.status] ?? colors.muted
  const statusTint  = STATUS_TINTS[task.status]  ?? colors.float

  return (
    // No `actions` prop — status badge removed from header (shown in snapshot strip)
    <DashboardLayout
      profile={profile}
      title={task.title}
      subtitle={task.type === 'daily_update' ? 'Daily Update' : 'Completion Task'}
      onSignOut={handleLogout}
    >

      {/* ── ALERT BANNERS ──────────────────────────────────────────────────── */}
      {task.is_urgent && (
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            ⚡ Urgent Task
          </p>
        </AlertBanner>
      )}
      {riskOverdue && (
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '11px', fontWeight: 600 }}>⚠ Overdue — action required</p>
        </AlertBanner>
      )}

      {/* ── SNAPSHOT CHIPS ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        <Chip
          label={task.status.charAt(0).toUpperCase() + task.status.slice(1)}
          color={statusColor} bg={statusTint}
        />
        <Chip
          label={task.priority === 'high' ? 'High Priority' : task.priority === 'medium' ? 'Medium Priority' : 'Low Priority'}
          color={task.priority === 'high' ? colors.red : task.priority === 'medium' ? colors.amber : undefined}
          bg={task.priority === 'high' ? colors.redTint : task.priority === 'medium' ? colors.amberTint : undefined}
          icon={task.priority !== 'low' ? '⚑' : undefined}
        />
        {task.due_date && (
          <Chip
            label={`Due ${formatFullDate(task.due_date)}`}
            color={riskOverdue ? colors.red : undefined}
            bg={riskOverdue ? colors.redTint : undefined}
          />
        )}
        <Chip label={`Open ${openDays === 0 ? 'Today' : `${openDays} Day${openDays !== 1 ? 's' : ''}`}`} />
        <Chip label={`No Progress ${noProgressTime}`} color={colors.amber} bg={colors.amberTint} />
        {riskOverdue && <Chip label="Overdue" color={colors.red} bg={colors.redTint} />}
      </div>

      {/* ── TWO-COLUMN BODY ────────────────────────────────────────────────── */}
      <div className="boe-detail-layout" style={{ marginTop: '20px' }}>

        {/* ═══ LEFT COLUMN ═══════════════════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* CURRENT SITUATION — primary hero */}
          <div style={{
            background:    statusTint,
            border:        `1.5px solid ${statusColor}30`,
            borderRadius:  '10px',
            padding:       '22px',
            display:       'flex',
            flexDirection: 'column',
            gap:           '16px',
          }}>
            {/* Header row: label + status name */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{
                fontSize: '10px', fontWeight: 700,
                letterSpacing: '0.09em', textTransform: 'uppercase',
                color: statusColor, opacity: 0.65,
              }}>
                Current Situation
              </span>
              <span style={{
                fontSize: '16px', fontWeight: 800,
                color: statusColor, textTransform: 'capitalize',
                letterSpacing: '-0.01em',
              }}>
                {task.status}
              </span>
            </div>

            {/* Primary note — dominant typography */}
            <p style={{
              color:      situationNote ? colors.primary : colors.muted,
              fontSize:   situationNote ? '18px' : '14px',
              fontWeight: situationNote ? 500 : 400,
              lineHeight: 1.55,
              fontStyle:  situationNote ? 'normal' : 'italic',
              margin:     0,
            }}>
              {situationNote ?? 'No update provided yet.'}
            </p>

            {/* Waiting On / Blocker reason */}
            {(task.status === 'waiting' || task.status === 'blocked') && task.blocker_reason && (
              <div style={{
                padding:      '8px 12px',
                background:   colors.base + 'aa',
                borderRadius: '6px',
                borderLeft:   `3px solid ${statusColor}`,
              }}>
                <p style={{ color: statusColor, fontSize: '10px', fontWeight: 700, marginBottom: '3px', opacity: 0.75, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {task.status === 'waiting' ? 'Waiting On' : 'Blocker'}
                </p>
                <p style={{ color: statusColor, fontSize: '13px', lineHeight: 1.4 }}>
                  {task.blocker_reason}
                </p>
              </div>
            )}

            {/* Meta: Last Updated · Updated By — deliberately quiet */}
            <p style={{
              color: statusColor, fontSize: '11px', opacity: 0.6,
              margin: 0, display: 'flex', gap: '6px', flexWrap: 'wrap',
            }}>
              <span>{timeAgo(lastUpdateRef)}</span>
              <span>·</span>
              <span>{lastUpdatedBy}</span>
            </p>

            {/* Acknowledge — inline in hero, only if unacknowledged and assignee */}
            {!task.acknowledged_at && isAssignee && (
              <button
                onClick={acknowledge}
                style={{
                  alignSelf:     'flex-start',
                  padding:       '8px 16px',
                  borderRadius:  '6px',
                  border:        `1.5px solid ${statusColor}50`,
                  background:    colors.base + 'cc',
                  color:         statusColor,
                  fontSize:      '12px',
                  fontWeight:    600,
                  cursor:        'pointer',
                  fontFamily:    font.body,
                  transition:    'background 0.15s',
                }}
              >
                Tap to Acknowledge
              </button>
            )}

            {/* Non-assignee waiting for ack */}
            {!task.acknowledged_at && !isAssignee && (
              <p style={{
                color:      colors.amber,
                fontSize:   '11px',
                fontWeight: 600,
                opacity:    0.85,
              }}>
                ⏳ Awaiting acknowledgement
              </p>
            )}
          </div>

          {/* COMPLETED */}
          {task.status === 'completed' && (
            <AlertBanner variant="green">
              <p style={{ color: colors.green, fontWeight: 600, fontSize: '14px', textAlign: 'center' }}>
                ✓ Task Completed
              </p>
            </AlertBanner>
          )}

          {/* NEXT ACTION */}
          {isAssignee && task.status !== 'completed' && (
            <div className="boe-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <span style={{
                fontSize: '10px', fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: colors.muted,
              }}>
                Next Action
              </span>

              {/* Status pills */}
              <div>
                <p style={{ fontSize: '11px', color: colors.tertiary, fontWeight: 500, marginBottom: '7px' }}>
                  Status
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {STATUSES.map(s => {
                    const active = selectedStatus === s
                    return (
                      <button
                        key={s}
                        onClick={() => { setSelectedStatus(s); setNoteError(false); setWaitingOnError(false); if (s !== 'waiting') setWaitingOn('') }}
                        style={{
                          padding:       '5px 12px',
                          borderRadius:  '20px',
                          border:        `1.5px solid ${active ? STATUS_COLORS[s] : colors.border}`,
                          background:    active ? STATUS_TINTS[s] : 'transparent',
                          color:         active ? STATUS_COLORS[s] : colors.tertiary,
                          fontSize:      '12px',
                          fontWeight:    active ? 600 : 400,
                          cursor:        'pointer',
                          textTransform: 'capitalize',
                          transition:    'all 0.15s',
                        }}
                      >
                        {s}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Waiting On dropdown */}
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
                    style={{
                      width: '100%',
                      border: waitingOnError ? `1.5px solid ${colors.red}` : undefined,
                    }}
                  >
                    <option value="">Select who/what you&apos;re waiting on…</option>
                    {WAITING_ON_OPTIONS.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Notes */}
              <div>
                <p style={{
                  fontSize: '11px', fontWeight: 500, marginBottom: '6px',
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
                  style={{
                    resize: 'none',
                    border: noteError ? `1.5px solid ${colors.red}` : undefined,
                  }}
                />
                <p style={{ textAlign: 'right', fontSize: '10px', color: colors.muted, marginTop: '3px' }}>
                  {updateNote.length} / 1000
                </p>
              </div>

              <button
                onClick={saveUpdate}
                disabled={saving}
                className="boe-btn boe-btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '13px', fontSize: '13px' }}
              >
                {saving
                  ? 'Saving…'
                  : <><CircleCheckBig size={15} strokeWidth={2.2} style={{ flexShrink: 0 }} /> Save Update</>
                }
              </button>
            </div>
          )}
        </div>

        {/* ═══ RIGHT COLUMN ══════════════════════════════════════════════════ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* ACCOUNTABILITY */}
          <div className="boe-card" style={{ padding: '14px 16px' }}>
            <span style={{
              fontSize: '10px', fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              color: colors.muted, display: 'block', marginBottom: '4px',
            }}>
              Accountability
            </span>

            <AccRow label="Assigned By"  value={creatorName ?? '—'} />
            <AccRow label="Accountable"  value={assigneeName} />
            <AccRow label="Responsible"  value={assigneeName} />
            <AccRow
              label="Due Date"
              value={task.due_date ? formatFullDate(task.due_date) : '—'}
              valueColor={riskOverdue ? colors.red : undefined}
            />
            <AccRow
              label="Acknowledged"
              value={task.acknowledged_at ? '' : 'Pending'}
              valueColor={colors.amber}
              badge={task.acknowledged_at
                ? <span className="boe-ack-pill">✓ Yes</span>
                : undefined}
            />
            {/* Last row — no bottom border */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', paddingTop: '5px' }}>
              <span style={{ color: colors.muted, fontSize: '11px' }}>No Progress</span>
              <span style={{ color: colors.amber, fontSize: '12px', fontWeight: 500 }}>{noProgressTime}</span>
            </div>
          </div>

          {/* TIMELINE */}
          {log.length > 0 && (
            <div className="boe-card" style={{ overflow: 'hidden', padding: '0' }}>
              <div style={{ padding: '9px 14px 8px', borderBottom: `1px solid ${colors.border}` }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: colors.muted,
                }}>
                  Timeline
                </span>
              </div>
              {/* No fixed maxHeight — card grows naturally, stays compact for few entries */}
              <div>
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
                        display:      'flex',
                        gap:          '8px',
                        alignItems:   'flex-start',
                        padding:      '7px 14px',
                        borderBottom: i < log.length - 1 ? `1px solid ${colors.border}` : 'none',
                      }}
                    >
                      <span style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: dotColor, flexShrink: 0, marginTop: '3px',
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', alignItems: 'baseline' }}>
                          <p style={{ color: colors.secondary, fontSize: '12px', lineHeight: 1.3 }}>
                            {formatLogAction(entry.action, entry.from_status, entry.to_status)}
                          </p>
                          {entry.actor_name && (
                            <span style={{ color: colors.muted, fontSize: '10px', flexShrink: 0 }}>{entry.actor_name}</span>
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
          )}
        </div>
      </div>

    </DashboardLayout>
  )
}
