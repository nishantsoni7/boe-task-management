'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { KpiGrid, KpiCard } from '@/components/ui/KpiCard'
import { LoadingScreen } from '@/components/ui/atoms'
import { OverduePrompt, type OverdueAction } from '@/components/ui/OverduePrompt'
import { TaskCard } from '@/components/ui/TaskCard'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'

export default function DashboardPage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [tasks,         setTasks]         = useState<Task[]>([])
  const [loading,       setLoading]       = useState(true)
  const [currentUserId, setCurrentUserId] = useState('')
  const [promptOpen,    setPromptOpen]    = useState(false)
  const [promptSaving,  setPromptSaving]  = useState(false)
  const [resolvedIds,   setResolvedIds]   = useState<Set<string>>(new Set())

  // ── Phase 2 Step 1: task detail panel ─────────────────────────────────────
  const [selectedTask,  setSelectedTask]  = useState<Task | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCurrentUserId(user.id)

      // Profile and tasks are independent — fetch in parallel after auth
      const [{ data: profileData }, { data: taskData }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', user.id)
          .single(),
        supabase
          .from('tasks')
          .select('*')
          .eq('assigned_to', user.id)
          .not('status', 'eq', 'completed')
          .order('created_at', { ascending: false }),
      ])

      if (profileData) setProfile(profileData)

      if (taskData) {
        setTasks(taskData)
        const hasOverdue = taskData.some(t => isOverdue(t.due_date) && t.acknowledged_at)
        if (hasOverdue) setPromptOpen(true)
      }
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const unacknowledged  = tasks.filter(t => !t.acknowledged_at)
  const allOverdueTasks = tasks.filter(t => isOverdue(t.due_date) && t.acknowledged_at)
  const pendingOverdue  = allOverdueTasks.filter(t => !resolvedIds.has(t.id))

  // Action Required: overdue first, then unacknowledged
  const actionRequired = [...allOverdueTasks, ...unacknowledged]

  // Continue Working: acknowledged + not overdue, sorted urgent → due-soon → priority
  const PRIORITY_WEIGHT: Record<string, number> = { high: 0, medium: 1, low: 2 }
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
        await supabase.from('tasks').update({ last_update_at: now }).eq('id', task.id)
        await supabase.from('task_activity_log').insert({
          task_id: task.id, actor_id: currentUserId,
          action: 'progress_update', note: action.note || null,
          from_status: task.status, to_status: task.status,
        })
        setTasks(prev => prev.map(t =>
          t.id === task.id ? { ...t, last_update_at: now } : t
        ))
      } else if (action.type === 'blocked' || action.type === 'waiting') {
        const newStatus = action.type
        await supabase.from('tasks').update({
          status: newStatus, blocker_reason: action.reason, last_update_at: now,
        }).eq('id', task.id)
        await supabase.from('task_activity_log').insert({
          task_id: task.id, actor_id: currentUserId, action: 'status_changed',
          note: action.reason, from_status: task.status, to_status: newStatus,
        })
        setTasks(prev => prev.map(t =>
          t.id === task.id
            ? { ...t, status: newStatus, blocker_reason: action.reason, last_update_at: now }
            : t
        ))
      } else if (action.type === 'completed') {
        await supabase.from('tasks').update({
          status: 'completed', completed_at: now, last_update_at: now,
        }).eq('id', task.id)
        await supabase.from('task_activity_log').insert({
          task_id: task.id, actor_id: currentUserId, action: 'status_changed',
          note: null, from_status: task.status, to_status: 'completed',
        })
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

  // Keep selectedTask in sync: if a mutation removes or changes the task in
  // the `tasks` array, update or close the panel accordingly.
  useEffect(() => {
    if (!selectedTask) return
    const updated = tasks.find(t => t.id === selectedTask.id)
    if (!updated) {
      // Task was removed (e.g. marked complete) — close panel cleanly
      setSelectedTask(null)
    } else if (updated !== selectedTask) {
      // Task data changed — keep panel open with fresh data
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
        {/* KPI row — 4-col desktop, 2-col mobile */}
        <KpiGrid>
          <KpiCard label="Active Tasks"    value={tasks.length}           meta="Assigned to me"  accent="blue"  />
          <KpiCard label="Need Update"     value={unacknowledged.length}  meta="Needs your tap"  accent="amber" />
          <KpiCard label="Overdue"         value={allOverdueTasks.length} meta="Action required" accent="red"   />
          <KpiCard label="In Progress"     value={continueWorking.length}   meta="Acknowledged"    accent="green" />
        </KpiGrid>

        {/* Section 1: Action Required — overdue first, then unacknowledged */}
        <SectionLabel title="Action Required" count={actionRequired.length} />
        {actionRequired.length > 0 ? (
          <div style={{ marginBottom: '24px' }}>

            {/* Overdue sub-group */}
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

            {/* Subtle separator between sub-groups */}
            {allOverdueTasks.length > 0 && unacknowledged.length > 0 && (
              <div style={{
                borderTop: '1px solid rgba(255,255,255,0.04)',
                margin: '10px 0',
              }} />
            )}

            {/* Unacknowledged sub-group */}
            {unacknowledged.length > 0 && (
              <div className="boe-dashboard-grid">
                {unacknowledged.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onClick={() => setSelectedTask(task)}
                    cardStyle={{
                      backgroundColor: 'rgba(232,160,48,0.025)',
                      borderLeftColor: colors.amber,
                    }}
                  />
                ))}
              </div>
            )}

          </div>
        ) : (
          <div style={{
            padding: '10px 14px',
            marginBottom: '24px',
            borderRadius: '6px',
            background: 'rgba(94,163,79,0.05)',
            border: '1px solid rgba(94,163,79,0.12)',
            fontSize: '12px',
            color: 'rgba(94,163,79,0.8)',
          }}>
            Nothing needs your attention right now
          </div>
        )}

        {/* Section 2: Continue Working — acknowledged, not overdue */}
        <SectionLabel title="Continue Working" count={continueWorking.length} />
        {continueWorking.length > 0 ? (
          <div className="boe-dashboard-grid" style={{ marginBottom: '8px' }}>
            {continueWorking.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => setSelectedTask(task)}
              />
            ))}
          </div>
        ) : (
          <div style={{
            padding: '10px 14px',
            marginBottom: '8px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.045)',
            fontSize: '12px',
            color: colors.muted,
          }}>
            No active tasks — tap + New Task to create one
          </div>
        )}

      </DashboardLayout>

      {/* ── Task detail panel — Phase 2 Step 1 ─────────────────────────────── */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </>
  )
}

// ─── SectionLabel ─────────────────────────────────────────────────────────────
function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="boe-section-label" style={{ marginBottom: '10px' }}>
      {title}
      <span style={{
        fontFamily: font.mono, fontSize: '10px',
        padding: '1px 6px', borderRadius: '3px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.045)',
        color: colors.secondary,
        marginLeft: 'auto',
      }}>
        {count}
      </span>
    </div>
  )
}
