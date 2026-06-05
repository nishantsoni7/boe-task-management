'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import {
  CheckCircle2, ExternalLink, Star,
  Search, RotateCcw,
} from 'lucide-react'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')


const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
  low:    { label: 'Low',  color: colors.muted },
}

// ─── Task card (completed view) ───────────────────────────────────────────────
function InfoPanel() {
  return (
    <div style={{
      width: '220px',
      flexShrink: 0,
      background: 'rgba(76,175,125,0.04)',
      border: '1.5px solid rgba(76,175,125,0.18)',
      borderRadius: '10px',
      padding: '16px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      alignSelf: 'flex-start',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <CheckCircle2 size={14} color="#4CAF7D" />
        <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
          About Completed Tasks
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {[
          'You can restore a completed task if it was marked completed by mistake.',
          'Restored tasks will move back to Pending.',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <span style={{
              marginTop: '3px', flexShrink: 0,
              width: '5px', height: '5px', borderRadius: '50%',
              background: 'rgba(76,175,125,0.5)',
              display: 'inline-block',
            }} />
            <span style={{ fontSize: '11.5px', color: colors.secondary, lineHeight: '1.5' }}>
              {text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CompletedTaskCard({
  task, userId, userMap, onClick, onRestore, isMobile,
}: {
  task: Task
  userId: string
  userMap: Record<string, string>
  onClick: () => void
  onRestore: () => void
  isMobile?: boolean
}) {
  const [hovered,        setHovered]        = useState(false)
  const [hoveredRestore, setHoveredRestore] = useState(false)
  const [hoveredView,    setHoveredView]    = useState(false)

  const priority     = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const isSelf       = task.created_by === userId
  const assignerName = isSelf ? null : (userMap[task.created_by] ?? 'member')

  const completionInfo = (() => {
    const base = task.last_update_at
    if (!base) return {
      completedLabel: 'Unknown',
      countdownLabel: 'Removal date unknown',
      warn: false,
    }
    const completedAt = new Date(base)
    const completedLabel = completedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    const removeAt = new Date(completedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    const daysLeft = Math.ceil((removeAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    let countdownLabel: string
    let warn = false
    if (daysLeft <= 0)      { countdownLabel = 'Eligible for removal'; warn = true }
    else if (daysLeft === 1){ countdownLabel = 'Deletes tomorrow';      warn = true }
    else if (daysLeft <= 7) { countdownLabel = `Deletes in ${daysLeft} days`; warn = true }
    else                    { countdownLabel = `Deletes in ${daysLeft} days`; warn = false }
    return { completedLabel, countdownLabel, warn }
  })()

  if (isMobile) {
    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
        style={{
          background: hovered ? colors.raised : colors.base,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '8px',
          opacity: 0.82,
          cursor: 'pointer',
          padding: '10px 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
          {task.is_urgent && <Star size={11} fill="#C49A28" color="#C49A28" style={{ marginTop: '2px', flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </div>
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            <button onClick={e => { e.stopPropagation(); onRestore() }}
              onMouseEnter={() => setHoveredRestore(true)} onMouseLeave={() => setHoveredRestore(false)}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '6px', background: hoveredRestore ? 'rgba(91,166,127,0.15)' : 'rgba(91,166,127,0.07)', border: `1px solid ${hoveredRestore ? 'rgba(91,166,127,0.45)' : 'rgba(91,166,127,0.25)'}`, cursor: 'pointer', outline: 'none', color: hoveredRestore ? '#3a9e6d' : '#4CAF7D', fontSize: '11px', fontWeight: 600 }}>
              <RotateCcw size={11} />
            </button>
            <button onClick={e => { e.stopPropagation(); onClick() }}
              onMouseEnter={() => setHoveredView(true)} onMouseLeave={() => setHoveredView(false)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', background: hoveredView ? 'rgba(76,175,125,0.12)' : 'transparent', border: `1px solid ${hoveredView ? 'rgba(76,175,125,0.35)' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredView ? '#4CAF7D' : colors.muted }}>
              <ExternalLink size={12} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {!isSelf && assignerName && (
            <span style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', color: '#6B4FA0', background: 'rgba(155,111,212,0.10)', whiteSpace: 'nowrap' }}>{assignerName}</span>
          )}
          <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.7 }}>{priority.label}</span>
          <span style={{ fontSize: '10.5px', color: completionInfo.warn ? '#C07820' : colors.muted, whiteSpace: 'nowrap' }}>
            {completionInfo.completedLabel}
          </span>
        </div>
      </div>
    )
  }

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
          letterSpacing: '-0.01em',
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

      {/* Completion info — fixed 140px */}
      <div style={{
        flexShrink: 0, width: '140px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        gap: '2px', paddingLeft: '4px',
      }}>
        <span style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap' }}>
          <span style={{ opacity: 0.6 }}>Completed on: </span>{completionInfo.completedLabel}
        </span>
        <span style={{
          fontSize: '10.5px', fontWeight: 600, whiteSpace: 'nowrap',
          color: completionInfo.warn ? '#C07820' : colors.muted,
          opacity: completionInfo.warn ? 1 : 0.65,
        }}>
          {completionInfo.countdownLabel}
        </span>
      </div>

      {/* Actions: Restore + View */}
      <div style={{
        flexShrink: 0, width: '140px',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: '6px', paddingRight: '10px',
      }}>
        <button
          onClick={e => { e.stopPropagation(); onRestore() }}
          onMouseEnter={() => setHoveredRestore(true)}
          onMouseLeave={() => setHoveredRestore(false)}
          title="Restore to In Progress"
          style={{
            display: 'flex', alignItems: 'center', gap: '5px',
            padding: '4px 10px', borderRadius: '6px', height: '28px',
            background: hoveredRestore ? 'rgba(91,166,127,0.15)' : 'rgba(91,166,127,0.07)',
            border: `1px solid ${hoveredRestore ? 'rgba(91,166,127,0.45)' : 'rgba(91,166,127,0.25)'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredRestore ? '#3a9e6d' : '#4CAF7D',
            fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          <RotateCcw size={11} />
          Restore
        </button>
        <button
          onClick={e => { e.stopPropagation(); onClick() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="View task details"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '28px', height: '28px', borderRadius: '6px',
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
  const [isMobile,     setIsMobile]     = useState(false)

  const [search,           setSearch]           = useState('')
  const [filterPriority,   setFilterPriority]   = useState('')
  const [filterAssignedBy, setFilterAssignedBy] = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

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
    const res = await fetch('/api/restore-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id }),
    })
    if (!res.ok) { console.error('[restore] failed:', await res.text()); return }
    setAllTasks(prev => prev.filter(t => t.id !== task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
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

        {/* Two-column: task list + info panel */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          {/* Task list */}
          <div style={{ flex: 1, minWidth: 0 }}>
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
                    isMobile={isMobile}
                  />
                ))}
                <div style={{ padding: '4px', fontSize: '11px', color: colors.muted }}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>

          {/* Right info panel — hidden on mobile */}
          {!isMobile && <InfoPanel />}
        </div>

      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={userId}
        />
      )}
    </>
  )
}
