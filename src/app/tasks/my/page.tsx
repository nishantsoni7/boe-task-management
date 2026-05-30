'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

const TODAY = new Date().toISOString().slice(0, 10)

function isOverdue(task: Task) {
  return !!task.due_date && task.due_date < TODAY && task.status !== 'completed'
}

function priorityLabel(p: string) {
  if (p === 'high')   return { label: 'High',   color: colors.red }
  if (p === 'medium') return { label: 'Med',    color: colors.amber }
  return                       { label: 'Low',    color: colors.muted }
}

function typeLabel(t: string) {
  return t === 'daily_update' ? 'Daily Update' : 'Completion'
}

function formatDate(d: string | null) {
  if (!d) return null
  const dt = new Date(d)
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ─── Single compact row ────────────────────────────────────────────────────────
function TaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  const overdue = isOverdue(task)
  const pri = priorityLabel(task.priority)

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 14px',
        borderBottom: `1px solid ${colors.border}`,
        cursor: 'pointer',
        background: colors.base,
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = colors.raised)}
      onMouseLeave={e => (e.currentTarget.style.background = colors.base)}
    >
      {/* Urgent dot */}
      <span style={{ width: '8px', flexShrink: 0 }}>
        {task.is_urgent && (
          <span
            title="Urgent"
            style={{
              display: 'block',
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: colors.red,
            }}
          />
        )}
      </span>

      {/* Title */}
      <span style={{
        flex: 1,
        fontSize: '13px',
        fontWeight: 500,
        color: overdue ? colors.red : colors.primary,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {task.title}
      </span>

      {/* Type */}
      <span style={{
        fontSize: '11px',
        color: colors.muted,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        {typeLabel(task.type)}
      </span>

      {/* Priority */}
      <span style={{
        fontSize: '11px',
        fontWeight: 600,
        color: pri.color,
        width: '34px',
        textAlign: 'right',
        flexShrink: 0,
      }}>
        {pri.label}
      </span>

      {/* Due date */}
      <span style={{
        fontSize: '11px',
        color: overdue ? colors.red : colors.muted,
        width: '60px',
        textAlign: 'right',
        flexShrink: 0,
      }}>
        {formatDate(task.due_date) ?? '—'}
      </span>
    </div>
  )
}

// ─── Group block ───────────────────────────────────────────────────────────────
function TaskGroup({
  label,
  tasks,
  accentColor,
  onSelect,
}: {
  label: string
  tasks: Task[]
  accentColor: string
  onSelect: (t: Task) => void
}) {
  if (tasks.length === 0) return null
  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 14px',
        background: colors.raised,
        borderBottom: `1px solid ${colors.border}`,
        borderTop: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: '6px 6px 0 0',
      }}>
        <span style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.06em',
          color: accentColor,
        }}>
          {label}
        </span>
        <span style={{
          fontSize: '11px',
          color: colors.muted,
          fontWeight: 500,
        }}>
          ({tasks.length})
        </span>
      </div>
      <div style={{
        border: `1px solid ${colors.border}`,
        borderTop: 'none',
        borderRadius: '0 0 6px 6px',
        overflow: 'hidden',
      }}>
        {tasks.map(t => (
          <TaskRow key={t.id} task={t} onClick={() => onSelect(t)} />
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function MyTasksPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [tasks,        setTasks]        = useState<Task[]>([])
  const [loading,      setLoading]      = useState(true)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: profileData }, { data: taskData }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', session.user.id)
          .eq('created_by', session.user.id)
          .not('status', 'eq', 'completed')
          .order('due_date', { ascending: true, nullsFirst: false }),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      if (taskData)    setTasks(taskData as unknown as Task[])
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ─── Group classification (a task can only appear in one group) ─────────────
  const groups = useMemo(() => {
    const overdue:    Task[] = []
    const blocked:    Task[] = []
    const waiting:    Task[] = []
    const inProgress: Task[] = []

    for (const t of tasks) {
      if (isOverdue(t))            { overdue.push(t);    continue }
      if (t.status === 'blocked')  { blocked.push(t);    continue }
      if (t.status === 'waiting')  { waiting.push(t);    continue }
      inProgress.push(t)
    }

    return { overdue, blocked, waiting, inProgress }
  }, [tasks])

  const urgentCount  = tasks.filter(t => t.is_urgent).length
  const overdueCount = groups.overdue.length

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="My Tasks"
        subtitle={`${tasks.length} Open · ${urgentCount} Urgent · ${overdueCount} Overdue`}
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
        {tasks.length === 0 ? (
          <div style={{
            padding: '10px 14px', borderRadius: '6px',
            background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(0,0,0,0.06)',
            fontSize: '12px', color: colors.muted,
          }}>
            No active tasks — tap + New Task to create one
          </div>
        ) : (
          <div>
            <TaskGroup
              label="OVERDUE"
              tasks={groups.overdue}
              accentColor={colors.red}
              onSelect={setSelectedTask}
            />
            <TaskGroup
              label="BLOCKED"
              tasks={groups.blocked}
              accentColor={colors.red}
              onSelect={setSelectedTask}
            />
            <TaskGroup
              label="WAITING"
              tasks={groups.waiting}
              accentColor={colors.amber}
              onSelect={setSelectedTask}
            />
            <TaskGroup
              label="IN PROGRESS"
              tasks={groups.inProgress}
              accentColor={colors.blue}
              onSelect={setSelectedTask}
            />
          </div>
        )}
      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </>
  )
}
