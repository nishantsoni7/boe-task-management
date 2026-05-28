'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, LogEntry, TaskStatus } from '@/lib/types'
import { isOverdue, formatFullDate, formatDateTime, formatLogAction, timeSince } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { BackBarShell } from '@/components/layout/PageShell'
import { StatusBadge, AlertBanner, LoadingScreen } from '@/components/ui/atoms'

const STATUSES: TaskStatus[] = ['pending', 'started', 'working', 'waiting', 'blocked']

export default function TaskDetailPage() {
  const [task,             setTask]             = useState<Task | null>(null)
  const [log,              setLog]              = useState<LogEntry[]>([])
  const [currentUserId,    setCurrentUserId]    = useState('')
  const [loading,          setLoading]          = useState(true)
  const [blockerReason,    setBlockerReason]    = useState('')
  const [showBlockerInput, setShowBlockerInput] = useState(false)
  const [pendingStatus,    setPendingStatus]    = useState('')
  const router   = useRouter()
  const params   = useParams()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCurrentUserId(user.id)
      const { data: taskData } = await supabase
        .from('tasks').select('*').eq('id', params.id).single()
      if (taskData) setTask(taskData)
      await loadLog(params.id as string)
      setLoading(false)
    }
    init()
  }, [])

  const loadLog = async (taskId: string) => {
    const { data } = await supabase
      .from('task_activity_log')
      .select(`
        id, action, note, from_status, to_status, created_at, actor_id,
        users:actor_id ( full_name )
      `)
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

    // Notify creator — skip if self-assigned
    if (task.created_by !== currentUserId) {
      await supabase.from('notifications').insert({
        user_id:      task.created_by,
        task_id:      task.id,
        type:         'task_acknowledged',
        title:        'Task acknowledged',
        body:         task.title,
        is_push_sent: true,
      })
    }

    setTask({ ...task, acknowledged_at: now })
    await loadLog(task.id)
  }

  const updateStatus = async (newStatus: string) => {
    if (!task) return
    if (newStatus === 'waiting' || newStatus === 'blocked') {
      setPendingStatus(newStatus)
      setShowBlockerInput(true)
      return
    }
    await applyStatusChange(newStatus, null)
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

    setTask({ ...task, status: newStatus as TaskStatus, blocker_reason: reason })
    setShowBlockerInput(false)
    setBlockerReason('')
    setPendingStatus('')
    await loadLog(task.id)
    if (newStatus === 'completed') setTimeout(() => router.push('/dashboard'), 800)
  }

  const overdue    = isOverdue(task?.due_date ?? null)
  const isAssignee = task?.assigned_to === currentUserId

  if (loading) return <LoadingScreen />
  if (!task)   return <LoadingScreen message="Task not found" />

  const statusDotColor = (s: TaskStatus): string => ({
    pending:   task.status === s ? colors.secondary : colors.muted,
    started:   task.status === s ? colors.secondary : colors.muted,
    working:   task.status === s ? colors.blue      : colors.muted,
    waiting:   task.status === s ? colors.amber     : colors.muted,
    blocked:   task.status === s ? colors.red       : colors.muted,
    completed: colors.green,
  }[s] ?? colors.muted)

  return (
    <BackBarShell
      title="Task Detail"
      onBack={() => router.push('/dashboard')}
      actions={<StatusBadge status={task.status} />}
    >

      {/* Alert banners */}
      {task.is_urgent && (
        <AlertBanner variant="red">
          <p style={{
            color: colors.red, fontSize: '11px', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            ⚡ Urgent Task
          </p>
        </AlertBanner>
      )}

      {overdue && task.status !== 'completed' && (
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '11px', fontWeight: 600 }}>
            ⚠ Overdue — action required
          </p>
        </AlertBanner>
      )}

      {/* Title card */}
      <div className="boe-card" style={{ padding: '14px' }}>
        <p style={{
          color: colors.primary, fontWeight: 500,
          fontSize: '14px', lineHeight: 1.4, marginBottom: '10px',
        }}>
          {task.title}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <span className={`boe-badge ${
            task.priority === 'high'   ? 'boe-badge-blocked' :
            task.priority === 'medium' ? 'boe-badge-waiting' : 'boe-badge-pending'
          }`}>
            {task.priority} priority
          </span>
          <span className="boe-badge boe-badge-pending" style={{ textTransform: 'capitalize' }}>
            {task.type}
          </span>
          {task.due_date && (
            <span className={`boe-badge ${overdue ? 'boe-badge-blocked' : 'boe-badge-pending'}`}>
              Due {formatFullDate(task.due_date)}
            </span>
          )}
        </div>
        {task.note && (
          <p style={{
            color: colors.secondary, fontSize: '13px',
            marginTop: '10px', paddingTop: '10px',
            borderTop: `1px solid ${colors.border}`,
          }}>
            {task.note}
          </p>
        )}
      </div>

      {/* Acknowledge */}
      {!task.acknowledged_at && isAssignee && (
        <button
          onClick={acknowledge}
          className="boe-btn boe-btn-primary"
          style={{
            width: '100%', justifyContent: 'center',
            padding: '14px', fontSize: '14px',
          }}
        >
          Tap to Acknowledge Task
        </button>
      )}
      {!task.acknowledged_at && !isAssignee && (
        <AlertBanner variant="amber">
          <p style={{ color: colors.amber, fontSize: '11px', fontWeight: 600 }}>
            ⏳ Awaiting acknowledgement — escalation clock not yet started
          </p>
        </AlertBanner>
      )}
      {task.acknowledged_at && (
        <AlertBanner variant="green">
          <div style={{
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: '8px',
          }}>
            <p style={{ color: colors.green, fontSize: '12px' }}>
              ✓ Acknowledged {formatDateTime(task.acknowledged_at)}
            </p>
            <span style={{
              fontSize: '10px', fontFamily: font.mono,
              color: colors.green, opacity: 0.7, flexShrink: 0,
            }}>
              clock running · {timeSince(task.acknowledged_at)}
            </span>
          </div>
        </AlertBanner>
      )}

      {/* Blocker display */}
      {task.blocker_reason && (
        <AlertBanner variant="red">
          <p style={{ color: colors.red, fontSize: '11px', fontWeight: 700, marginBottom: '3px' }}>
            Blocker
          </p>
          <p style={{ color: colors.red, fontSize: '13px', opacity: 0.85 }}>
            {task.blocker_reason}
          </p>
        </AlertBanner>
      )}

      {/* Status buttons */}
      {isAssignee && task.status !== 'completed' && (
        <div>
          <p className="boe-input-label">Update Status</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {STATUSES.map(s => (
              <button
                key={s}
                onClick={() => updateStatus(s)}
                className={`boe-status-btn${task.status === s ? ` boe-status-btn-active-${s}` : ''}`}
              >
                <span style={{
                  width: '7px', height: '7px', borderRadius: '50%',
                  background: statusDotColor(s), flexShrink: 0,
                }} />
                <span style={{ textTransform: 'capitalize' }}>{s}</span>
                {task.status === s && (
                  <span style={{
                    marginLeft: 'auto', fontSize: '10px',
                    opacity: 0.4, fontWeight: 400,
                  }}>
                    current
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Blocker input */}
          {showBlockerInput && (
            <div className="boe-card" style={{ marginTop: '10px', padding: '14px' }}>
              <p style={{
                color: colors.primary, fontSize: '13px',
                fontWeight: 500, marginBottom: '8px',
              }}>
                Who or what is blocking this?
              </p>
              <textarea
                value={blockerReason}
                onChange={e => setBlockerReason(e.target.value)}
                placeholder="e.g. Waiting for client to send fabric sample"
                rows={2}
                className="boe-input"
                style={{ resize: 'none', marginBottom: '10px' }}
              />
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => applyStatusChange(pendingStatus, blockerReason)}
                  disabled={!blockerReason.trim()}
                  className="boe-btn boe-btn-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Confirm
                </button>
                <button
                  onClick={() => { setShowBlockerInput(false); setBlockerReason('') }}
                  className="boe-btn boe-btn-ghost"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => updateStatus('completed')}
            className="boe-btn boe-btn-primary"
            style={{
              width: '100%', justifyContent: 'center',
              marginTop: '10px', padding: '13px', fontSize: '13px',
            }}
          >
            ✓ Mark as Completed
          </button>
        </div>
      )}

      {/* Completed state */}
      {task.status === 'completed' && (
        <AlertBanner variant="green">
          <p style={{
            color: colors.green, fontWeight: 600,
            fontSize: '14px', textAlign: 'center',
          }}>
            ✓ Task Completed
          </p>
        </AlertBanner>
      )}

      {/* Activity log */}
      {log.length > 0 && (
        <div>
          <p className="boe-input-label">Activity Log</p>
          <div className="boe-panel">
            {log.map((entry, i) => (
              <div
                key={entry.id}
                style={{
                  display: 'flex', gap: '10px', alignItems: 'flex-start',
                  padding: '9px 14px',
                  borderBottom: i < log.length - 1 ? `1px solid ${colors.border}` : 'none',
                }}
              >
                <span className="boe-timeline-dot" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: colors.secondary, fontSize: '12px', lineHeight: 1.4 }}>
                    {formatLogAction(entry.action, entry.from_status, entry.to_status)}
                    {entry.note && (
                      <span style={{ color: colors.muted }}> — {entry.note}</span>
                    )}
                  </p>
                  <p style={{
                    color: colors.muted, fontSize: '10px',
                    marginTop: '2px', fontFamily: font.mono,
                  }}>
                    {entry.actor_name && (
                      <span style={{ color: colors.tertiary, marginRight: '4px' }}>
                        {entry.actor_name} ·
                      </span>
                    )}
                    {formatDateTime(entry.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </BackBarShell>
  )
}