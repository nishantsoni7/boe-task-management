'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

type Task = {
  id: string
  title: string
  status: string
  priority: string
  is_urgent: boolean
  due_date: string | null
  acknowledged_at: string | null
  created_at: string
  assigned_to: string
}

type UserProfile = {
  id: string
  full_name: string
  role: string
  team: string
}

export default function DashboardPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single()

      if (profileData) setProfile(profileData)

      const { data: taskData } = await supabase
        .from('tasks')
        .select('*')
        .eq('assigned_to', user.id)
        .not('status', 'eq', 'completed')
        .order('created_at', { ascending: false })

      if (taskData) setTasks(taskData)
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isOverdue = (task: Task) =>
    task.due_date && new Date(task.due_date) < new Date()

  const unacknowledged = tasks.filter(t => !t.acknowledged_at)
  const overdue = tasks.filter(t => isOverdue(t))
  const active = tasks.filter(t => t.acknowledged_at && !isOverdue(t))

  const priorityColor = (p: string) => ({
    high: 'text-red-400',
    medium: 'text-yellow-400',
    low: 'text-gray-400',
  }[p] || 'text-gray-400')

  const statusBg = (s: string) => ({
    pending: 'bg-gray-700 text-gray-300',
    started: 'bg-blue-900 text-blue-300',
    working: 'bg-yellow-900 text-yellow-300',
    waiting: 'bg-purple-900 text-purple-300',
    blocked: 'bg-red-900 text-red-300',
    completed: 'bg-green-900 text-green-300',
  }[s] || 'bg-gray-700 text-gray-300')

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Loading...</p>
    </div>
  )

  const TaskCard = ({ task }: { task: Task }) => (
    <div
      onClick={() => router.push(`/tasks/${task.id}`)}
      className={`bg-gray-900 rounded-2xl p-4 border cursor-pointer active:scale-95 transition-transform ${
        task.is_urgent ? 'border-red-700' : 'border-gray-800'
      }`}
    >
      {task.is_urgent && (
        <div className="text-red-400 text-xs font-semibold mb-2 uppercase tracking-wide">
          Urgent
        </div>
      )}
      <p className="text-white text-sm font-medium leading-snug mb-3">
        {task.title}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBg(task.status)}`}>
          {task.status}
        </span>
        <span className={`text-xs font-medium ${priorityColor(task.priority)}`}>
          {task.priority}
        </span>
        {task.due_date && (
          <span className={`text-xs ml-auto ${isOverdue(task) ? 'text-red-400 font-semibold' : 'text-gray-500'}`}>
            {isOverdue(task) ? 'Overdue · ' : ''}
            {new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </span>
        )}
      </div>
    </div>
  )

  const Section = ({ title, count, color, children }: {
    title: string, count: number, color: string, children: React.ReactNode
  }) => (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">{title}</p>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${color}`}>{count}</span>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 sticky top-0 z-10">
        <div className="boe-container py-4 flex items-center justify-between">
        <div>
          <h1 className="text-white font-semibold text-base">My Tasks</h1>
          <p className="text-gray-400 text-xs mt-0.5">{profile?.full_name} · {profile?.team}</p>
        </div>

      <div className="flex items-center gap-3">
  {(profile?.role === 'admin' || profile?.role === 'manager') && (
    <button
      onClick={() => router.push('/manager')}
      className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
    >
      Team
    </button>
  )}
  {profile?.role === 'admin' && (
    <button
      onClick={() => router.push('/admin/members')}
      className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
    >
      Members
    </button>
  )}
  <button
    onClick={() => router.push('/tasks/create')}
    className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
  >
    + New
  </button>
  <button onClick={handleLogout} className="text-gray-500 text-sm hover:text-white transition-colors">
    Sign out
  </button>
</div>
      </div>
      </div>

      {/* Content */}
      <div className="boe-container py-6">

        {tasks.length === 0 && (
          <div className="text-center py-16">
            <p className="text-gray-500 text-sm">No active tasks</p>
            <p className="text-gray-600 text-xs mt-1">Tap + New to create one</p>
          </div>
        )}

        {unacknowledged.length > 0 && (
          <Section title="Needs acknowledgement" count={unacknowledged.length} color="bg-red-900 text-red-300">
            {unacknowledged.map(t => <TaskCard key={t.id} task={t} />)}
          </Section>
        )}

        {overdue.length > 0 && (
          <Section title="Overdue" count={overdue.length} color="bg-red-900 text-red-300">
            {overdue.map(t => <TaskCard key={t.id} task={t} />)}
          </Section>
        )}

        {active.length > 0 && (
          <Section title="Active" count={active.length} color="bg-gray-700 text-gray-300">
            {active.map(t => <TaskCard key={t.id} task={t} />)}
          </Section>
        )}

      </div>
    </div>
  )
}