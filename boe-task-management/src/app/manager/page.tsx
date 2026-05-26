'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

type TaskRow = {
  id: string
  title: string
  status: string
  priority: string
  is_urgent: boolean
  is_stale: boolean
  stale_day_count: number
  due_date: string | null
  last_update_at: string | null
  created_at: string
  assigned_to: string
  assignee_name: string
  assignee_team: string
  blocker_reason: string | null
}

type TeamMember = {
  id: string
  full_name: string
  team: string
  role: string
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  pending:   { bg: '#1f2937', color: '#9ca3af' },
  started:   { bg: '#1e3a8a', color: '#bfdbfe' },
  working:   { bg: '#713f12', color: '#fef08a' },
  waiting:   { bg: '#581c87', color: '#e9d5ff' },
  blocked:   { bg: '#7f1d1d', color: '#fecaca' },
  completed: { bg: '#14532d', color: '#bbf7d0' },
}

const PRIORITY_STYLE: Record<string, { bg: string; color: string }> = {
  high:   { bg: '#450a0a', color: '#f87171' },
  medium: { bg: '#422006', color: '#fbbf24' },
  low:    { bg: '#1f2937', color: '#9ca3af' },
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = Math.floor(diff / 3600000)
  if (hours < 1)  return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function isUpdatedToday(dateStr: string | null): boolean {
  if (!dateStr) return false
  const d = new Date(dateStr)
  const now = new Date()
  return d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
}

function escalationLevel(task: TaskRow): 'overdue' | 'danger' | 'caution' | null {
  if (!task.last_update_at) return null
  if (task.status === 'completed' || task.status === 'waiting') return null
  const hoursSince = (Date.now() - new Date(task.last_update_at).getTime()) / 3600000

  // Overdue fast lane — 24h after deadline passes
  if (task.due_date && new Date(task.due_date) < new Date()) {
    if (hoursSince >= 24) return 'overdue'
  }
  if (hoursSince >= 72) return 'danger'
  if (hoursSince >= 48) return 'caution'
  return null
}

export default function ManagerPage() {
  const [tasks,   setTasks]   = useState<TaskRow[]>([])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [filter,  setFilter]  = useState<'all' | 'no_update' | 'escalated' | 'stale' | 'blocked'>('all')
  const [selectedMember, setSelectedMember] = useState<string>('all')
  const [currentUser, setCurrentUser] = useState<TeamMember | null>(null)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('users').select('*').eq('id', user.id).single()

      if (profile) {
        if (profile.role !== 'admin' && profile.role !== 'manager') {
          router.push('/dashboard')
          return
        }
        setCurrentUser(profile)
      }

      await loadData()
      setLoading(false)
    }
    init()
  }, [])

  const loadData = async () => {
    const { data: memberData } = await supabase
      .from('users')
      .select('id, full_name, team, role')
      .eq('is_active', true)
      .order('full_name')

    if (memberData) setMembers(memberData)

    // Load all non-completed tasks with assignee info
    const { data: taskData } = await supabase
      .from('tasks')
      .select(`
        id, title, status, priority, is_urgent, is_stale,
        stale_day_count, due_date, last_update_at, created_at,
        assigned_to, blocker_reason,
        assignee:assigned_to ( full_name, team )
      `)
      .neq('status', 'completed')
      .order('created_at', { ascending: false })

    if (taskData) {
      const enriched: TaskRow[] = (taskData as any[]).map(t => ({
        ...t,
        assignee_name: t.assignee?.full_name ?? 'Unknown',
        assignee_team: t.assignee?.team ?? '',
      }))
      setTasks(enriched)
    }
  }

  // Derived lists
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const filteredTasks = tasks.filter(t => {
    if (selectedMember !== 'all' && t.assigned_to !== selectedMember) return false
    if (filter === 'no_update') return !isUpdatedToday(t.last_update_at)
    if (filter === 'escalated') return escalationLevel(t) !== null
    if (filter === 'stale')     return t.is_stale
    if (filter === 'blocked')   return t.status === 'blocked'
    return true
  })

  const noUpdateToday   = tasks.filter(t => !isUpdatedToday(t.last_update_at))
  const escalatedTasks  = tasks.filter(t => escalationLevel(t) !== null)
  const staleTasks      = tasks.filter(t => t.is_stale)
  const blockedTasks    = tasks.filter(t => t.status === 'blocked')

  // Who hasn't updated today — unique assignees
  const noUpdateMembers = [...new Map(
    noUpdateToday.map(t => [t.assigned_to, { id: t.assigned_to, name: t.assignee_name, team: t.assignee_team }])
  ).values()]

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Loading...</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950">

      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push('/dashboard')} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-white font-semibold text-base flex-1">Manager View</h1>
        <button onClick={loadData} className="text-gray-400 hover:text-white text-xs px-3 py-1.5 bg-gray-800 rounded-lg">
          Refresh
        </button>
      </div>

      <div className="px-4 py-5 max-w-2xl mx-auto flex flex-col gap-5">

        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Active',    value: tasks.length,           bg: '#1f2937', color: '#e5e7eb' },
            { label: 'No update', value: noUpdateToday.length,   bg: '#422006', color: '#fbbf24' },
            { label: 'Escalated', value: escalatedTasks.length,  bg: '#450a0a', color: '#f87171' },
            { label: 'Blocked',   value: blockedTasks.length,    bg: '#3b0764', color: '#d8b4fe' },
          ].map(card => (
            <div key={card.label} style={{ background: card.bg, borderRadius: '12px', padding: '12px 10px', textAlign: 'center' }}>
              <p style={{ fontSize: '22px', fontWeight: 600, color: card.color, lineHeight: 1 }}>{card.value}</p>
              <p style={{ fontSize: '11px', color: card.color, opacity: 0.7, marginTop: '4px' }}>{card.label}</p>
            </div>
          ))}
        </div>

        {/* Who hasn't updated today */}
        {noUpdateMembers.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
              <p className="text-yellow-400 text-xs font-semibold uppercase tracking-wider">
                No update today — {noUpdateMembers.length} {noUpdateMembers.length === 1 ? 'person' : 'people'}
              </p>
            </div>
            {noUpdateMembers.map((m, i) => (
              <div key={m.id}
                className={`flex items-center gap-3 px-4 py-3 ${i < noUpdateMembers.length - 1 ? 'border-b border-gray-800' : ''}`}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600, color: '#9ca3af', flexShrink: 0 }}>
                  {m.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">{m.name}</p>
                  <p className="text-gray-500 text-xs capitalize">{m.team}</p>
                </div>
                <p className="text-gray-600 text-xs">
                  {noUpdateToday.filter(t => t.assigned_to === m.id).length} task{noUpdateToday.filter(t => t.assigned_to === m.id).length !== 1 ? 's' : ''}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[
            { key: 'all',       label: `All (${tasks.length})` },
            { key: 'no_update', label: `No update (${noUpdateToday.length})` },
            { key: 'escalated', label: `Escalated (${escalatedTasks.length})` },
            { key: 'stale',     label: `Stale (${staleTasks.length})` },
            { key: 'blocked',   label: `Blocked (${blockedTasks.length})` },
          ].map(tab => (
            <button key={tab.key} onClick={() => setFilter(tab.key as any)}
              style={{
                padding: '6px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                whiteSpace: 'nowrap', flexShrink: 0, transition: 'all 0.15s',
                background: filter === tab.key ? '#3b82f6' : '#1f2937',
                color:      filter === tab.key ? '#ffffff'  : '#9ca3af',
              }}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Member filter */}
        <select
          value={selectedMember}
          onChange={e => setSelectedMember(e.target.value)}
          className="w-full bg-gray-900 text-white rounded-xl px-4 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
        >
          <option value="all">All team members</option>
          {members.map(m => (
            <option key={m.id} value={m.id}>{m.full_name} — {m.team}</option>
          ))}
        </select>

        {/* Task list */}
        <div className="flex flex-col gap-2">
          {filteredTasks.length === 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-2xl px-4 py-8 text-center">
              <p className="text-gray-500 text-sm">No tasks in this view</p>
            </div>
          )}

          {filteredTasks.map(task => {
            const level = escalationLevel(task)
            const isOverdue = task.due_date && new Date(task.due_date) < new Date()

            return (
              <div key={task.id}
                onClick={() => router.push(`/tasks/${task.id}`)}
                style={{
                  background: '#111827',
                  border: `1px solid ${
                    level === 'overdue' ? '#7f1d1d' :
                    level === 'danger'  ? '#991b1b' :
                    level === 'caution' ? '#78350f' :
                    task.is_stale       ? '#1e3a5f' :
                    '#1f2937'
                  }`,
                  borderRadius: '16px',
                  padding: '14px',
                  cursor: 'pointer',
                }}>

                {/* Escalation / stale banner */}
                {level === 'overdue' && (
                  <p style={{ fontSize: '11px', color: '#f87171', fontWeight: 600, marginBottom: '8px' }}>
                    ⚠ OVERDUE — no action taken
                  </p>
                )}
                {level === 'danger' && !isOverdue && (
                  <p style={{ fontSize: '11px', color: '#f87171', fontWeight: 600, marginBottom: '8px' }}>
                    🔴 72h — escalation reached
                  </p>
                )}
                {level === 'caution' && !isOverdue && (
                  <p style={{ fontSize: '11px', color: '#fbbf24', fontWeight: 600, marginBottom: '8px' }}>
                    🟡 48h — no update
                  </p>
                )}
                {task.is_stale && !level && (
                  <p style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 500, marginBottom: '8px' }}>
                    Same status for {task.stale_day_count}d — no visible progress
                  </p>
                )}

                {/* Title row */}
                <p style={{ color: '#f9fafb', fontSize: '14px', fontWeight: 500, lineHeight: 1.4, marginBottom: '10px' }}>
                  {task.is_urgent && <span style={{ color: '#f87171', marginRight: '6px' }}>⚡</span>}
                  {task.title}
                </p>

                {/* Meta row */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                  <span style={{ ...STATUS_STYLE[task.status], fontSize: '11px', fontWeight: 500, padding: '2px 8px', borderRadius: '20px' }}>
                    {task.status}
                  </span>
                  <span style={{ ...PRIORITY_STYLE[task.priority], fontSize: '11px', fontWeight: 500, padding: '2px 8px', borderRadius: '20px' }}>
                    {task.priority}
                  </span>
                  {isOverdue && (
                    <span style={{ background: '#450a0a', color: '#f87171', fontSize: '11px', fontWeight: 500, padding: '2px 8px', borderRadius: '20px' }}>
                      overdue
                    </span>
                  )}
                  {task.due_date && !isOverdue && (
                    <span style={{ background: '#1f2937', color: '#6b7280', fontSize: '11px', padding: '2px 8px', borderRadius: '20px' }}>
                      due {formatDate(task.due_date)}
                    </span>
                  )}
                </div>

                {/* Blocker */}
                {task.status === 'blocked' && task.blocker_reason && (
                  <div style={{ background: '#450a0a', borderRadius: '8px', padding: '6px 10px', marginBottom: '8px' }}>
                    <p style={{ color: '#fca5a5', fontSize: '12px' }}>⛔ {task.blocker_reason}</p>
                  </div>
                )}

                {/* Footer */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 600, color: '#9ca3af' }}>
                      {task.assignee_name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <p style={{ fontSize: '12px', color: '#6b7280' }}>{task.assignee_name}</p>
                  </div>
                  <p style={{ fontSize: '11px', color: '#4b5563' }}>
                    {task.last_update_at ? `Updated ${timeAgo(task.last_update_at)}` : 'Never updated'}
                  </p>
                </div>

              </div>
            )
          })}
        </div>

      </div>
    </div>
  )
}