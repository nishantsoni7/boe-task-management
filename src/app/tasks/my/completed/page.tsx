'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, TaskStatus, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import {
  CheckCircle2, ExternalLink, Star, AlertCircle,
  Search, RotateCcw,
} from 'lucide-react'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

const TODAY_STR = new Date().toISOString().slice(0, 10)

function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
  low:    { label: 'Low',  color: colors.muted },
}

// ─── Task card (completed view) ───────────────────────────────────────────────
function CompletedTaskCard({
  task, userId, userMap, onClick, onRestore,
}: {
  task: Task
  userId: string
  userMap: Record<string, string>
  onClick: () => void
  onRestore: () => void
}) {
  const [hovered,        setHovered]        = useState(false)
  const [hoveredRestore, setHoveredRestore] = useState(false)
  const [hoveredView,    setHoveredView]    = useState(false)

  const priority     = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const dateStr      = formatDate(task.due_date)
  const isSelf       = task.created_by === userId
  const assignerName = isSelf ? null : (userMap[task.created_by] ?? 'member')
  const wasOverdue   = !!task.due_date && task.due_date < TODAY_STR

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center',
        background: hovered ? colors.raised : colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '8px',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.09)' : '0 1px 3px rgba(0,0,0,0.04)',
        opacity: 0.72,
        transition: 'background 0.12s, box-shadow 0.12s',
        minHeight: '48px',
        cursor: 'pointer',
      }}
    >
      {/* Star indicator */}
      <div style={{
        width: '28px', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {task.is_urgent
          ? <Star size={11} fill="#C49A28" color="#C49A28" />
          : <div style={{ width: '11px' }} />
        }
      </div>

      {/* Title + note */}
      <div style={{ flex: 1, minWidth: 0, padding: '10px 8px 10px 0' }}>
        <div style={{
          fontSize: '13px', fontWeight: 500, color: colors.muted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: 'line-through', letterSpacing: '-0.01em',
        }}>
          {task.title}
        </div>
        {task.note && (
          <div style={{
            fontSize: '11px', color: colors.muted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginTop: '2px',
          }}>
            {task.note}
          </div>
        )}
      </div>

      {/* Assigned by — fixed 140px */}
      <div style={{
        flexShrink: 0, width: '140px',
        display: 'flex', alignItems: 'center',
        paddingLeft: '8px', paddingRight: '6px',
        overflow: 'hidden',
      }}>
        <span
          title={isSelf ? 'Assigned by you' : `Assigned by ${assignerName}`}
          style={{
            display: 'inline-block',
            maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: '10.5px', fontWeight: 600,
            padding: '1px 7px', borderRadius: '20px',
            ...(isSelf
              ? { color: colors.muted, background: 'rgba(0,0,0,0.05)' }
              : { color: '#6B4FA0', background: 'rgba(155,111,212,0.10)' }
            ),
          }}
        >
          {isSelf ? 'By you' : assignerName}
        </span>
      </div>

      {/* Priority — fixed 52px */}
      <div style={{
        flexShrink: 0, width: '52px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.6 }}>
          {priority.label}
        </span>
      </div>

      {/* Due date — fixed 106px */}
      <div style={{
        flexShrink: 0, width: '106px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {dateStr ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '11px', fontWeight: 500,
            color: wasOverdue ? colors.red : colors.muted,
            whiteSpace: 'nowrap', opacity: 0.7,
          }}>
            {wasOverdue && <AlertCircle size={9} />}
            {dateStr}
          </span>
        ) : (
          <span style={{ fontSize: '11px', color: colors.muted }}>—</span>
        )}
      </div>

      {/* Actions: Restore + View */}
      <div style={{
        flexShrink: 0, width: '84px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '2px',
      }}>
        <button
          onClick={e => { e.stopPropagation(); onRestore() }}
          onMouseEnter={() => setHoveredRestore(true)}
          onMouseLeave={() => setHoveredRestore(false)}
          title="Restore to In Progress"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: '6px',
            background: hoveredRestore ? 'rgba(91,166,127,0.12)' : 'transparent',
            border: `1px solid ${hoveredRestore ? 'rgba(91,166,127,0.35)' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredRestore ? '#4CAF7D' : colors.muted,
          }}
        >
          <RotateCcw size={11} />
        </button>
        <div style={{ width: '26px', height: '26px', flexShrink: 0 }} />
        <button
          onClick={e => { e.stopPropagation(); onClick() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="View task details"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: '6px',
            background: hoveredView ? 'rgba(76,175,125,0.12)' : 'transparent',
            border: `1px solid ${hoveredView ? 'rgba(76,175,125,0.35)' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredView ? '#4CAF7D' : colors.muted,
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '48px 24px', gap: '6px',
    }}>
      <span style={{
        width: '32px', height: '32px', borderRadius: '50%',
        background: 'rgba(0,0,0,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: '4px',
      }}>
        <CheckCircle2 size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>
        No completed tasks
      </span>
      <span style={{ fontSize: '12px', color: colors.muted }}>
        Completed tasks will appear here.
      </span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function CompletedTasksPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [allTasks,     setAllTasks]     = useState<Task[]>([])
  const [userId,       setUserId]       = useState<string>('')
  const [userMap,      setUserMap]      = useState<Record<string, string>>({})
  const [loading,      setLoading]      = useState(true)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)

  const [search,           setSearch]           = useState('')
  const [filterPriority,   setFilterPriority]   = useState('')
  const [filterAssignedBy, setFilterAssignedBy] = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id
      setUserId(uid)
      const [{ data: profileData }, { data: tasks }, { data: userData }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, is_active, created_at').eq('id', uid).single(),
        supabase.from('tasks').select(TASK_COLUMNS).eq('assigned_to', uid).eq('status', 'completed').order('last_update_at', { ascending: false }),
        supabase.from('users').select('id, full_name'),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      setAllTasks((tasks ?? []) as unknown as Task[])
      if (userData) {
        const map: Record<string, string> = {}
        for (const u of userData) map[u.id] = u.full_name
        setUserMap(map)
      }
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleRestore = async (task: Task) => {
    const now = new Date().toISOString()
    const { error: taskErr } = await supabase
      .from('tasks')
      .update({ status: 'pending', last_update_at: now })
      .eq('id', task.id)
    if (taskErr) { console.error('[restore] tasks update failed:', taskErr.message); return }

    await supabase.from('task_activity_log').insert({
      task_id:     task.id,
      actor_id:    userId,
      action:      'status_changed',
      from_status: 'completed',
      to_status:   'pending',
      note:        'Restored to In Progress',
    })

    setAllTasks(prev => prev.filter(t => t.id !== task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
  }

  const handleAddUpdate = async (note: string, newStatus: string) => {
    if (!selectedTask) return
    const now = new Date().toISOString()
    const statusChanged = newStatus !== selectedTask.status
    const trimmedNote = note.trim() || null

    if (statusChanged) {
      await supabase.from('tasks').update({ status: newStatus, last_update_at: now }).eq('id', selectedTask.id)
      await supabase.from('task_activity_log').insert({
        task_id:     selectedTask.id,
        actor_id:    userId,
        action:      'status_changed',
        from_status: selectedTask.status,
        to_status:   newStatus,
        note:        trimmedNote,
      })
      if (newStatus !== 'completed') {
        setAllTasks(prev => prev.filter(t => t.id !== selectedTask.id))
        setSelectedTask(null)
      } else {
        setSelectedTask(prev => prev ? { ...prev, status: newStatus as TaskStatus, last_update_at: now } : prev)
        setAllTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, status: newStatus as TaskStatus, last_update_at: now } : t))
      }
    } else if (trimmedNote) {
      await supabase.from('tasks').update({ last_update_at: now }).eq('id', selectedTask.id)
      await supabase.from('task_activity_log').insert({
        task_id:     selectedTask.id,
        actor_id:    userId,
        action:      'status_changed',
        from_status: selectedTask.status,
        to_status:   selectedTask.status,
        note:        trimmedNote,
      })
      setAllTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, last_update_at: now } : t))
    }
  }

  const assignerOptions = useMemo(() => {
    const ids = [...new Set(allTasks.map(t => t.created_by))]
    return ids.map(id => ({
      value: id,
      label: id === userId ? 'You' : (userMap[id] ?? 'Unknown'),
    })).sort((a, b) => a.label.localeCompare(b.label))
  }, [allTasks, userId, userMap])

  const visibleTasks = useMemo(() => {
    let tasks = allTasks
    if (filterAssignedBy) tasks = tasks.filter(t => t.created_by === filterAssignedBy)
    if (filterPriority)   tasks = tasks.filter(t => t.priority === filterPriority)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      tasks = tasks.filter(t => t.title.toLowerCase().includes(q))
    }
    return tasks
  }, [allTasks, filterAssignedBy, filterPriority, search])

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout profile={profile} title="My Tasks" onSignOut={handleLogout}>

        {/* Header row */}
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#4CAF7D' }}>
            Completed Tasks
          </div>
          <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
            {allTasks.length} task{allTasks.length !== 1 ? 's' : ''} completed
          </div>
        </div>

        {/* Search + filter toolbar */}
        <div style={{
          background: colors.raised,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '8px',
          padding: '8px 10px',
          marginBottom: '10px',
          display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
        }}>
          <Search size={13} color={colors.muted} style={{ flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Find tasks…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, minWidth: '140px', padding: '4px 6px',
              background: 'transparent', border: 'none', outline: 'none',
              fontSize: '12px', color: colors.primary,
            }}
          />
          {assignerOptions.length > 1 && (
            <select
              value={filterAssignedBy}
              onChange={e => setFilterAssignedBy(e.target.value)}
              style={{
                padding: '4px 10px', minWidth: '130px',
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: '6px', outline: 'none',
                fontSize: '11.5px', color: filterAssignedBy ? colors.primary : colors.muted,
                cursor: 'pointer',
              }}
            >
              <option value="">All Assigners</option>
              {assignerOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
          <select
            value={filterPriority}
            onChange={e => setFilterPriority(e.target.value)}
            style={{
              padding: '4px 10px', minWidth: '110px',
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: '6px', outline: 'none',
              fontSize: '11.5px', color: filterPriority ? colors.primary : colors.muted,
              cursor: 'pointer',
            }}
          >
            <option value="">All Priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {/* Task list */}
        {visibleTasks.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {visibleTasks.map(task => (
              <CompletedTaskCard
                key={task.id}
                task={task}
                userId={userId}
                userMap={userMap}
                onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                onRestore={() => handleRestore(task)}
              />
            ))}
            <div style={{ padding: '4px', fontSize: '11px', color: colors.muted }}>
              {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
            </div>
          </div>
        )}

      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={userId}
          onAddUpdate={handleAddUpdate}
        />
      )}
    </>
  )
}
