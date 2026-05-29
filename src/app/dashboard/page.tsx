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
        const hasOverdue = typedTasks.some(t => isOverdue(t.due_date) && t.acknowledged_at)
        if (hasOverdue) setPromptOpen(true)
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

  const unacknowledged  = tasks.filter(t => !t.acknowledged_at)
  const allOverdueTasks = tasks.filter(t => isOverdue(t.due_date) && t.acknowledged_at)
  const pendingOverdue  = allOverdueTasks.filter(t => !resolvedIds.has(t.id))
  const actionRequired  = [...allOverdueTasks, ...unacknowledged]

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
        <KpiGrid>
          <KpiCard label="Active Tasks"  value={tasks.length}           meta="Assigned to me"  accent="blue"  />
          <KpiCard label="Need Update"   value={unacknowledged.length}  meta="Needs your tap"  accent="amber" />
          <KpiCard label="Overdue"       value={allOverdueTasks.length} meta="Action required" accent="red"   />
          <KpiCard label="In Progress"   value={continueWorking.length} meta="Acknowledged"    accent="green" />
        </KpiGrid>

        <SectionLabel title="Action Required" count={actionRequired.length} />
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
            padding: '10px 14px', marginBottom: '24px', borderRadius: '6px',
            background: 'rgba(94,163,79,0.05)', border: '1px solid rgba(94,163,79,0.12)',
            fontSize: '12px', color: 'rgba(94,163,79,0.8)',
          }}>
            Nothing needs your attention right now
          </div>
        )}

        <SectionLabel title="Continue Working" count={continueWorking.length} />
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

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="boe-section-label" style={{ marginBottom: '10px' }}>
      {title}
      <span style={{
        fontFamily: font.mono, fontSize: '10px',
        padding: '1px 6px', borderRadius: '3px',
        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.045)',
        color: colors.secondary, marginLeft: 'auto',
      }}>
        {count}
      </span>
    </div>
  )
}


