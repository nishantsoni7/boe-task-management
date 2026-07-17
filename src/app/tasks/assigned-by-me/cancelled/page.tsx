'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { useViewAs } from '@/hooks/useViewAs'
import { ExternalLink, Star, Search, Ban } from 'lucide-react'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'cancelled_by', 'cancelled_at', 'cancellation_reason',
].join(', ')

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
  low:    { label: 'Low',  color: colors.muted },
}

function InfoPanel() {
  return (
    <div style={{
      width: '220px', flexShrink: 0,
      background: 'rgba(120,113,108,0.04)',
      border: '1.5px solid rgba(120,113,108,0.18)',
      borderRadius: '10px', padding: '16px 14px',
      display: 'flex', flexDirection: 'column', gap: '14px', alignSelf: 'flex-start',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <Ban size={14} color="#78716C" />
        <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>About Cancelled</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {[
          'Tasks you delegated that were cancelled before completion.',
          'Open the task detail to restore a cancelled task back to active work.',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <span style={{ marginTop: '3px', flexShrink: 0, width: '5px', height: '5px', borderRadius: '50%', background: 'rgba(120,113,108,0.4)', display: 'inline-block' }} />
            <span style={{ fontSize: '11.5px', color: colors.secondary, lineHeight: '1.5' }}>{text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CancelledTaskCard({
  task, userMap, onClick, isMobile,
}: {
  task: Task
  userMap: Record<string, string>
  onClick: () => void
  isMobile?: boolean
}) {
  const [hovered,     setHovered]     = useState(false)
  const [hoveredView, setHoveredView] = useState(false)

  const priority     = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const assigneeName = userMap[task.assigned_to ?? ''] ?? 'member'

  const cancelledLabel = task.cancelled_at
    ? new Date(task.cancelled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : (task.last_update_at
      ? new Date(task.last_update_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'Unknown')

  if (isMobile) {
    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
        style={{ background: hovered ? colors.raised : colors.base, border: `1.5px solid ${colors.border}`, borderRadius: '8px', opacity: 0.82, cursor: 'pointer', padding: '10px 12px' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
          {task.is_urgent && <Star size={11} fill="#C49A28" color="#C49A28" style={{ marginTop: '2px', flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          <button
            onClick={e => { e.stopPropagation(); onClick() }}
            onMouseEnter={() => setHoveredView(true)}
            onMouseLeave={() => setHoveredView(false)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', background: hoveredView ? 'rgba(120,113,108,0.12)' : 'transparent', border: `1px solid ${hoveredView ? 'rgba(120,113,108,0.35)' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredView ? '#78716C' : colors.muted, flexShrink: 0 }}
          >
            <ExternalLink size={12} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', color: '#2E7D6B', background: 'rgba(46,158,107,0.10)', whiteSpace: 'nowrap' }}>{assigneeName}</span>
          <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.7 }}>{priority.label}</span>
          <span style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap' }}>{cancelledLabel}</span>
          {task.cancellation_reason && (
            <span style={{ fontSize: '10.5px', color: '#78716C', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
              {task.cancellation_reason}
            </span>
          )}
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
        opacity: 0.72, transition: 'background 0.12s, box-shadow 0.12s',
        minHeight: '48px', cursor: 'pointer',
      }}
    >
      {/* Star */}
      <div style={{ width: '28px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {task.is_urgent ? <Star size={11} fill="#C49A28" color="#C49A28" /> : <div style={{ width: '11px' }} />}
      </div>

      {/* Title + reason */}
      <div style={{ flex: 1, minWidth: 0, padding: '10px 8px 10px 0' }}>
        <div style={{ fontSize: '13px', fontWeight: 500, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
          {task.title}
        </div>
        {task.cancellation_reason && (
          <div style={{ fontSize: '11px', color: '#78716C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px', fontStyle: 'italic' }}>
            {task.cancellation_reason}
          </div>
        )}
      </div>

      {/* Assigned to — fixed 140px */}
      <div style={{ flexShrink: 0, width: '140px', display: 'flex', alignItems: 'center', paddingLeft: '8px', paddingRight: '6px', overflow: 'hidden' }}>
        <span
          title={`Assigned to ${assigneeName}`}
          style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', color: '#2E7D6B', background: 'rgba(46,158,107,0.10)' }}
        >
          {assigneeName}
        </span>
      </div>

      {/* Priority — fixed 52px */}
      <div style={{ flexShrink: 0, width: '52px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.6 }}>{priority.label}</span>
      </div>

      {/* Cancelled on — fixed 140px */}
      <div style={{ flexShrink: 0, width: '140px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px', paddingLeft: '4px' }}>
        <span style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap' }}>
          <span style={{ opacity: 0.6 }}>Cancelled: </span>{cancelledLabel}
        </span>
      </div>

      {/* View button — fixed 80px */}
      <div style={{ flexShrink: 0, width: '80px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '10px' }}>
        <button
          onClick={e => { e.stopPropagation(); onClick() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="View task details"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '28px', height: '28px', borderRadius: '6px',
            background: hoveredView ? 'rgba(120,113,108,0.12)' : 'transparent',
            border: `1px solid ${hoveredView ? 'rgba(120,113,108,0.35)' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredView ? '#78716C' : colors.muted,
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: '6px' }}>
      <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '4px' }}>
        <Ban size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>No cancelled delegated tasks</span>
      <span style={{ fontSize: '12px', color: colors.muted }}>Cancelled tasks you assigned will appear here.</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AssignedByMeCancelledPage() {
  const { viewAsUserId } = useViewAs()
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [allTasks,     setAllTasks]     = useState<Task[]>([])
  const [userId,       setUserId]       = useState<string>('')
  const [userMap,      setUserMap]      = useState<Record<string, string>>({})
  const [loading,      setLoading]      = useState(true)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [isMobile,     setIsMobile]     = useState(false)

  const [search,         setSearch]         = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')

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

      const loggedInId = session.user.id
      const uid = viewAsUserId ?? loggedInId
      setUserId(uid)

      const [{ data: profileData }, { data: tasks }, { data: userData }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, is_active, created_at').eq('id', uid).single(),
        supabase.from('tasks').select(TASK_COLUMNS)
          .eq('created_by', uid)
          .not('assigned_to', 'is', null)
          .neq('assigned_to', uid)
          .eq('status', 'cancelled')
          .order('cancelled_at', { ascending: false, nullsFirst: false }),
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
  }, [viewAsUserId, router, supabase])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const assigneeOptions = useMemo(() => {
    const ids = [...new Set(allTasks.map(t => t.assigned_to).filter(Boolean))]
    return (ids as string[]).map(id => ({ value: id, label: userMap[id] ?? 'Unknown' }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [allTasks, userMap])

  const visibleTasks = useMemo(() => {
    let tasks = allTasks
    if (filterAssignee) tasks = tasks.filter(t => t.assigned_to === filterAssignee)
    if (filterPriority) tasks = tasks.filter(t => t.priority === filterPriority)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.cancellation_reason ?? '').toLowerCase().includes(q)
      )
    }
    return tasks
  }, [allTasks, filterAssignee, filterPriority, search])

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout profile={profile} title="Assigned By Me" onSignOut={handleLogout}>

        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#78716C' }}>Cancelled Tasks</div>
          <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
            {allTasks.length} delegated task{allTasks.length !== 1 ? 's' : ''} cancelled
          </div>
        </div>

        {/* Search + filter toolbar */}
        <div style={{
          background: colors.raised, border: `1.5px solid ${colors.border}`,
          borderRadius: '8px', padding: '8px 10px', marginBottom: '10px',
          display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
        }}>
          <Search size={13} color={colors.muted} style={{ flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Find tasks…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: '140px', padding: '4px 6px', background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary }}
          />
          {assigneeOptions.length > 1 && (
            <select
              value={filterAssignee}
              onChange={e => setFilterAssignee(e.target.value)}
              style={{ padding: '4px 10px', minWidth: '130px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '11.5px', color: filterAssignee ? colors.primary : colors.muted, cursor: 'pointer' }}
            >
              <option value="">All Assignees</option>
              {assigneeOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
          <select
            value={filterPriority}
            onChange={e => setFilterPriority(e.target.value)}
            style={{ padding: '4px 10px', minWidth: '110px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '11.5px', color: filterPriority ? colors.primary : colors.muted, cursor: 'pointer' }}
          >
            <option value="">All Priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {/* Two-column: task list + info panel */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {visibleTasks.length === 0 ? (
              <EmptyState />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {visibleTasks.map(task => (
                  <CancelledTaskCard
                    key={task.id}
                    task={task}
                    userMap={userMap}
                    onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                    isMobile={isMobile}
                  />
                ))}
                <div style={{ padding: '4px', fontSize: '11px', color: colors.muted }}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>
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
