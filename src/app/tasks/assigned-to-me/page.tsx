'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskCard } from '@/components/ui/TaskCard'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

export default function AssignedToMePage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [tasks,         setTasks]         = useState<Task[]>([])
  const [loading,       setLoading]       = useState(true)
  const [selectedTask,  setSelectedTask]  = useState<Task | null>(null)
  const [assignerNames, setAssignerNames] = useState<Map<string, string>>(new Map())

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
          .neq('created_by', session.user.id)
          .not('status', 'eq', 'completed')
          .order('created_at', { ascending: false }),
      ])

      if (profileData) setProfile(profileData as UserProfile)

      if (taskData) {
        const typed = taskData as unknown as Task[]
        setTasks(typed)

        // Batch-fetch names for all task creators
        const creatorIds = [...new Set(typed.map(t => t.created_by))]
        if (creatorIds.length > 0) {
          const { data: creators } = await supabase
            .from('users')
            .select('id, full_name')
            .in('id', creatorIds)
          if (creators) {
            setAssignerNames(
              new Map(creators.map((u: { id: string; full_name: string }) => [u.id, u.full_name]))
            )
          }
        }
      }

      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Assigned To Me"
        subtitle="Tasks assigned to you by other members"
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
        {tasks.length > 0 ? (
          <div className="boe-dashboard-grid">
            {tasks.map(task => {
              const assignerName = assignerNames.get(task.created_by)
              return (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => setSelectedTask(task)}
                  footer={
                    assignerName ? (
                      <div style={{ fontSize: '11px', color: colors.muted }}>
                        Assigned by:{' '}
                        <span style={{ color: colors.secondary, fontWeight: 500 }}>
                          {assignerName}
                        </span>
                      </div>
                    ) : undefined
                  }
                />
              )
            })}
          </div>
        ) : (
          <div style={{
            padding: '10px 14px', borderRadius: '6px',
            background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(0,0,0,0.06)',
            fontSize: '12px', color: colors.muted,
          }}>
            No tasks have been assigned to you by others
          </div>
        )}
      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </>
  )
}
