'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'

import { LoadingScreen } from '@/components/ui/atoms'
import { OverduePrompt, type OverdueAction } from '@/components/ui/OverduePrompt'
import { TaskCard } from '@/components/ui/TaskCard'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'

const PRIORITY_WEIGHT: Record<string, number> = { high: 0, medium: 1, low: 2 }

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

export default function DashboardPage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [tasks,         setTasks]         = useState<Task[]>([])
  const [loading,       setLoading]       = useState(true)
  const [currentUserId, setCurrentUserId] = useState('')
  const [promptOpen,    setPromptOpen]    = useState(false)
  const [promptSaving,  setPromptSaving]  = useState(false)
  const [resolvedIds,   setResolvedIds]   = useState<Set<string>>(new Set())
  const [selectedTask,  setSelectedTask]  = useState<Task | null>(null)
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set())

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const pageStart = performance.now()
      console.log('[dashboard] init started')

      // ── CHANGE 1 ──────────────────────────────────────────────────────────
      // Was: supabase.auth.getUser()
      // Now: supabase.auth.getSession()
      //
      // getUser() makes a verified network call to Supabase auth servers.
      // getSession() reads the cached session from localStorage — zero network
      // cost. Safe here because:
      //   (a) this is a client-side UI gate only (redirect to /login)
      //   (b) real data security is enforced by Supabase RLS on every query
      //   (c) user.id is only used to filter queries; wrong id = RLS rejection
      // ──────────────────────────────────────────────────────────────────────
      const authStart = performance.now()
      const { data: { session } } = await supabase.auth.getSession()
      console.log('[dashboard] getSession', Math.round(performance.now() - authStart), 'ms')

      if (!session) { router.push('/login'); return }
      setCurrentUserId(session.user.id)

      // ── CHANGE 2 ──────────────────────────────────────────────────────────
      // Profile and tasks remain in Promise.all (parallel — was already correct).
      // Each branch now has its own .then() timing log so we can see whether
      // profile or tasks is the slower query without breaking parallelism.
      // Both start at the same instant; each reports when it individually finishes.
      // ──────────────────────────────────────────────────────────────────────
      const dataStart    = performance.now()
      const profileStart = performance.now()
      const tasksStart   = performance.now()

      const [{ data: profileData }, { data: taskData }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', session.user.id)
          .single()
          .then((r: any) => {
            console.log('[dashboard] profile fetch', Math.round(performance.now() - profileStart), 'ms')
            return r
          }),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', session.user.id)
          .not('status', 'eq', 'completed')
          .order('created_at', { ascending: false })
          .then((r: any) => {
            console.log('[dashboard] tasks fetch', Math.round(performance.now() - tasksStart), 'ms')
            return r
          }),
      ])

      console.log('[dashboard] parallel data TOTAL', Math.round(performance.now() - dataStart), 'ms')

      if (profileData) setProfile(profileData)

      if (taskData) {
        const typedTasks = taskData as unknown as Task[]
        setTasks(typedTasks)
      }

      console.log('[dashboard] TOTAL', Math.round(performance.now() - pageStart), 'ms')
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleAcknowledge = async (task: Task) => {
    // Guard: skip if already acknowledged or a write is already in flight
    if (task.acknowledged_at || acknowledging.has(task.id)) return

    setAcknowledging(prev => new Set([...prev, task.id]))

    const now = new Date().toISOString()
    try {
      await Promise.all([
        supabase
          .from('tasks')
          .update({ acknowledged_at: now })
          .eq('id', task.id),
        supabase
          .from('task_activity_log')
          .insert({
            task_id:     task.id,
            actor_id:    currentUserId,
            action:      'acknowledged',
            note:        null,
            from_status: task.status,
            to_status:   task.status,
          }),
      ])
      // Optimistic update — moves task from Action Required → Continue Working
      setTasks(prev =>
        prev.map(t => t.id === task.id ? { ...t, acknowledged_at: now } : t)
      )
      // Success: clean up in-flight Set
      setAcknowledging(prev => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    } catch {
      // Failure: also clean up so user can retry
      setAcknowledging(prev => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }

  const unacknowledged  = tasks.filter(t => !t.acknowledged_at)
  const allOverdueTasks = tasks.filter(t => isOverdue(t.due_date) && t.acknowledged_at)
  const pendingOverdue  = allOverdueTasks.filter(t => !resolvedIds.has(t.id))
  const actionRequired  = [...allOverdueTasks, ...unacknowledged]

  const WAITING_DEPS = [
    'Client', 'Vendor', 'Design Team', 'Purchase Team',
    'Production', 'Management', 'Transport', 'Other',
  ] as const

  const waitingTasks = tasks.filter(t => t.status === 'waiting')

  const waitingByDep = WAITING_DEPS.reduce<Record<string, number>>((acc, dep) => {
    acc[dep] = waitingTasks.filter(t => {
      const reason = t.blocker_reason ?? ''
      // Format: "Waiting on: Client — note" — extract dep after "Waiting on: "
      const match = reason.match(/^Waiting on:\s*([^—\n]+)/i)
      return match ? match[1].trim() === dep : dep === 'Other'
    }).length
    return acc
  }, {} as Record<string, number>)

  const continueWorking = tasks
    .filter(t => t.acknowledged_at && !isOverdue(t.due_date))
    .slice()
    .sort((a, b) => {
      if (a.is_urgent !== b.is_urgent) return a.is_urgent ? -1 : 1
      const aHasDue = a.due_date != null
      const bHasDue = b.due_date != null
      if (aHasDue !== bHasDue) return aHasDue ? -1 : 1
      if (aHasDue && bHasDue) {
        const dateDiff = new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime()
        if (dateDiff !== 0) return dateDiff
      }
      return (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1)
    })

  const handleOverdueAction = async (task: Task, action: OverdueAction) => {
    setPromptSaving(true)
    const now = new Date().toISOString()
    try {
      if (action.type === 'continue') {
        await Promise.all([
          supabase.from('tasks')
            .update({ last_update_at: now })
            .eq('id', task.id),
          supabase.from('task_activity_log').insert({
            task_id: task.id, actor_id: currentUserId,
            action: 'progress_update', note: action.note || null,
            from_status: task.status, to_status: task.status,
          }),
        ])
        setTasks(prev => prev.map(t =>
          t.id === task.id ? { ...t, last_update_at: now } : t
        ))

      } else if (action.type === 'blocked' || action.type === 'waiting') {
        const newStatus = action.type
        await Promise.all([
          supabase.from('tasks')
            .update({ status: newStatus, blocker_reason: action.reason, last_update_at: now })
            .eq('id', task.id),
          supabase.from('task_activity_log').insert({
            task_id: task.id, actor_id: currentUserId, action: 'status_changed',
            note: action.reason, from_status: task.status, to_status: newStatus,
          }),
        ])
        setTasks(prev => prev.map(t =>
          t.id === task.id
            ? { ...t, status: newStatus, blocker_reason: action.reason, last_update_at: now }
            : t
        ))

      } else if (action.type === 'completed') {
        await Promise.all([
          supabase.from('tasks')
            .update({ status: 'completed', completed_at: now, last_update_at: now })
            .eq('id', task.id),
          supabase.from('task_activity_log').insert({
            task_id: task.id, actor_id: currentUserId, action: 'status_changed',
            note: null, from_status: task.status, to_status: 'completed',
          }),
        ])
        setTasks(prev => prev.filter(t => t.id !== task.id))
      }
    } finally {
      setPromptSaving(false)
    }
    setResolvedIds(prev => new Set([...prev, task.id]))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (promptOpen && pendingOverdue.length === 0) setPromptOpen(false)
  }, [pendingOverdue.length, promptOpen])

  useEffect(() => {
    if (!selectedTask) return
    const updated = tasks.find(t => t.id === selectedTask.id)
    if (!updated) {
      setSelectedTask(null)
    } else if (updated !== selectedTask) {
      setSelectedTask(updated)
    }
  }, [tasks, selectedTask])

  if (loading) return <LoadingScreen />

  const currentOverdueTask = pendingOverdue[0] ?? null

  return (
    <>
      {promptOpen && currentOverdueTask && (
        <OverduePrompt
          key={currentOverdueTask.id}
          tasks={pendingOverdue}
          currentIdx={0}
          saving={promptSaving}
          onAction={handleOverdueAction}
        />
      )}

      <DashboardLayout
        profile={profile}
        title="Dashboard"
        subtitle={
          profile
            ? `${new Date().toLocaleDateString('en-IN', {
                weekday: 'long', day: 'numeric', month: 'long',
              })} · ${profile.team}`
            : undefined
        }
        actions={
          <button
            onClick={() => router.push('/tasks/create')}
            className="boe-btn boe-btn-primary"
          >
            + New Task
          </button>
        }
        onSignOut={handleLogout}
      >
        <FocusSummary
          actionCount={actionRequired.length}
          blockerCount={waitingTasks.length}
          overdueCount={allOverdueTasks.length}
        />

        <SectionLabel title={`ACTION REQUIRED (${actionRequired.length})`} variant="action" />
        {actionRequired.length > 0 ? (
          <div style={{ marginBottom: '24px' }}>
            {allOverdueTasks.length > 0 && (
              <div className="boe-dashboard-grid">
                {allOverdueTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onClick={() => setSelectedTask(task)}
                    cardStyle={{ backgroundColor: 'rgba(217,79,79,0.03)' }}
                  />
                ))}
              </div>
            )}
            {allOverdueTasks.length > 0 && unacknowledged.length > 0 && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)', margin: '10px 0' }} />
            )}
            {unacknowledged.length > 0 && (
              <div className="boe-dashboard-grid">
                {unacknowledged.map(task => {
                  const isAcking = acknowledging.has(task.id)
                  return (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onClick={() => setSelectedTask(task)}
                      cardStyle={{
                        backgroundColor: 'rgba(232,160,48,0.025)',
                        borderLeftColor: colors.amber,
                      }}
                      footer={
                        <button
                          onClick={e => { e.stopPropagation(); handleAcknowledge(task) }}
                          disabled={isAcking}
                          style={{
                            display:       'block',
                            width:         '160px',
                            margin:        '0 auto',
                            padding:       '9px 0',
                            fontSize:      '13px',
                            fontWeight:    600,
                            letterSpacing: '0.02em',
                            color:         isAcking ? '#B8892A' : '#FFFFFF',
                            background:    isAcking ? 'rgba(232,160,48,0.12)' : '#E8A030',
                            border:        '1px solid transparent',
                            borderRadius:  '6px',
                            cursor:        isAcking ? 'default' : 'pointer',
                            boxShadow:     isAcking ? 'none' : '0 1px 4px rgba(232,160,48,0.35)',
                            transition:    'opacity 0.15s',
                          }}
                        >
                          {isAcking ? 'Acknowledging…' : '✓ Acknowledge'}
                        </button>
                      }
                    />
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div style={{
            padding: '10px 14px', marginBottom: '24px', borderRadius: '6px',
            background: 'rgba(94,163,79,0.05)', border: '1px solid rgba(94,163,79,0.12)',
            fontSize: '12px', color: 'rgba(94,163,79,0.8)',
          }}>
            Nothing needs your attention right now
          </div>
        )}

        <SectionLabel title={`BLOCKERS (${waitingTasks.length})`} variant="blocker" />
        <WaitingWidget byDep={waitingByDep} deps={WAITING_DEPS} />

        <SectionLabel title={`CONTINUE WORKING (${continueWorking.length})`} />
        {continueWorking.length > 0 ? (
          <div className="boe-dashboard-grid" style={{ marginBottom: '8px' }}>
            {continueWorking.map(task => (
              <TaskCard key={task.id} task={task} onClick={() => setSelectedTask(task)} />
            ))}
          </div>
        ) : (
          <div style={{
            padding: '10px 14px', marginBottom: '8px', borderRadius: '6px',
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.045)',
            fontSize: '12px', color: colors.muted,
          }}>
            No active tasks — tap + New Task to create one
          </div>
        )}

      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </>
  )
}

function FocusSummary({
  actionCount,
  blockerCount,
  overdueCount,
}: {
  actionCount: number
  blockerCount: number
  overdueCount: number
}) {
  return (
    <div style={{
      padding: '12px 14px', marginBottom: '20px', borderRadius: '8px',
      background: '#F8F9FB', border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em',
        color: colors.muted, marginBottom: '10px', textTransform: 'uppercase',
      }}>
        Today&apos;s Focus
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
        <div style={{
          padding: '10px 12px', borderRadius: '6px',
          background: actionCount > 0 ? 'rgba(232,160,48,0.07)' : 'rgba(0,0,0,0.02)',
          border: `1px solid ${actionCount > 0 ? 'rgba(232,160,48,0.2)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: font.mono, color: actionCount > 0 ? colors.amber : colors.muted, lineHeight: 1 }}>
            {actionCount}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '4px' }}>
            Tasks need action
          </div>
        </div>
        <div style={{
          padding: '10px 12px', borderRadius: '6px',
          background: blockerCount > 0 ? 'rgba(200,162,74,0.07)' : 'rgba(0,0,0,0.02)',
          border: `1px solid ${blockerCount > 0 ? 'rgba(200,162,74,0.2)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: font.mono, color: blockerCount > 0 ? '#C8A24A' : colors.muted, lineHeight: 1 }}>
            {blockerCount}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '4px' }}>
            Blockers
          </div>
        </div>
        <div style={{
          padding: '10px 12px', borderRadius: '6px',
          background: overdueCount > 0 ? 'rgba(217,79,79,0.07)' : 'rgba(0,0,0,0.02)',
          border: `1px solid ${overdueCount > 0 ? 'rgba(217,79,79,0.2)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: font.mono, color: overdueCount > 0 ? colors.red : colors.muted, lineHeight: 1 }}>
            {overdueCount}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '4px' }}>
            Overdue
          </div>
        </div>
      </div>
    </div>
  )
}

function WaitingWidget({
  byDep,
  deps,
}: {
  byDep: Record<string, number>
  deps: readonly string[]
}) {
  const active = deps.filter(d => byDep[d] > 0)

  if (active.length === 0) {
    return (
      <div style={{
        padding: '10px 14px', marginBottom: '24px', borderRadius: '6px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.045)',
        fontSize: '12px', color: colors.muted,
      }}>
        No blockers right now
      </div>
    )
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
      gap: '8px',
      marginBottom: '24px',
    }}>
      {active.map(dep => (
        <div
          key={dep}
          style={{
            padding: '10px 12px', borderRadius: '7px',
            background: 'rgba(232,160,48,0.055)',
            border: '1px solid rgba(232,160,48,0.14)',
            borderLeft: '3px solid rgba(232,160,48,0.42)',
          }}
        >
          <div style={{ fontSize: '11px', color: colors.secondary, fontWeight: 500, marginBottom: '5px' }}>
            {dep}
          </div>
          <div style={{
            fontFamily: font.mono, fontSize: '22px', fontWeight: 700,
            color: '#C8A24A', lineHeight: 1,
          }}>
            {byDep[dep]}
          </div>
          <div style={{ fontSize: '10px', color: colors.muted, marginTop: '3px', letterSpacing: '0.02em' }}>
            waiting tasks
          </div>
        </div>
      ))}
    </div>
  )
}

function SectionLabel({ title, variant = 'default' }: { title: string; variant?: 'action' | 'blocker' | 'default' }) {
  const extra: React.CSSProperties =
    variant === 'action'  ? { color: '#D4893A', borderLeft: '2px solid #D4893A', paddingLeft: '8px' } :
    variant === 'blocker' ? { color: 'rgba(200,162,74,0.75)', borderLeft: '2px solid rgba(200,162,74,0.35)', paddingLeft: '8px' } :
    { color: colors.muted }
  return (
    <div className="boe-section-label" style={{ marginBottom: '10px', ...extra }}>
      {title}
    </div>
  )
}


