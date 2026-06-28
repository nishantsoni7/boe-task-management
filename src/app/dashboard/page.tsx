'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue, getAssignedByDisplay, isValidUUID } from '@/lib/ui'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { useViewAs } from '@/hooks/useViewAs'
import { useProfile } from '@/hooks/queries/useProfile'
import { useActiveUsers } from '@/hooks/queries/useMyTasks'
import { useTopTasks } from '@/hooks/queries/useTopTasks'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'task_type', 'customer_name', 'contact_number', 'company_name', 'city_project',
].join(', ')

export default function DashboardPage() {
  const [loggedInId,         setLoggedInId]         = useState('')
  const [tasks,              setTasks]              = useState<Task[]>([])
  const [loading,            setLoading]            = useState(true)
  const [currentUserId,      setCurrentUserId]      = useState('')
  const [selectedTask,       setSelectedTask]       = useState<Task | null>(null)
  const [escalationTasks,    setEscalationTasks]    = useState<Task[]>([])
  const [myCompletedCount,   setMyCompletedCount]   = useState(0)
  const [assignedByMeInProg, setAssignedByMeInProg] = useState(0)
  const [assignedByMeComp,   setAssignedByMeComp]   = useState(0)
  const [blockedCount,       setBlockedCount]       = useState(0)
  const [previewList,        setPreviewList]        = useState<{ title: string; items: Task[] } | null>(null)
  const [escalationPreview,  setEscalationPreview]  = useState(false)
  const [assignerNames,      setAssignerNames]      = useState<Record<string, string>>({})
  const [completedTasksData, setCompletedTasksData] = useState<Task[]>([])
  const [assignedByMeTasksAll, setAssignedByMeTasksAll] = useState<Task[]>([])
  const [isMobile,           setIsMobile]           = useState(false)

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { viewAsUserId, viewAsProfile, exitViewMode } = useViewAs()

  // ── Cached queries ────────────────────────────────────────────────────────
  const { data: profile = null } = useProfile(loggedInId)
  // Active users cached across pages — admin/manager roles need this for team view
  const { data: activeUsers = [] } = useActiveUsers()
  const teamUsers = activeUsers
  const { data: top3Data } = useTopTasks(loggedInId || null)
  const top3Tasks = top3Data?.tasks ?? []

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

      const lid = session.user.id
      setLoggedInId(lid)
      const uid = viewAsUserId ?? lid
      if (!isValidUUID(uid)) { setLoading(false); return }
      setCurrentUserId(uid)

      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)
      const monthStartISO = monthStart.toISOString()

      // Batch 1: task queries in parallel (profile is now handled by useProfile hook)
      const [
        { data: taskData },
        { data: completedData },
        { data: abmTasks },
        { count: abmCompCount },
      ] = await Promise.all([
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', uid)
          .not('status', 'eq', 'completed')
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false }),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', uid)
          .eq('status', 'completed')
          .gte('last_update_at', monthStartISO)
          .order('last_update_at', { ascending: false }),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('created_by', uid)
          .neq('assigned_to', uid)
          .not('status', 'eq', 'completed'),
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('created_by', uid)
          .neq('assigned_to', uid)
          .eq('status', 'completed')
          .gte('last_update_at', monthStartISO),
      ])

      if (taskData) setTasks(taskData as unknown as Task[])
      if (completedData) {
        const completed = completedData as unknown as Task[]
        setMyCompletedCount(completed.length)
        setCompletedTasksData(completed)
      }
      if (abmTasks) {
        const abm = abmTasks as unknown as Task[]
        setAssignedByMeInProg(abm.length)
        setAssignedByMeTasksAll(abm)
        setAssignedByMeComp(abmCompCount ?? 0)
      }

      // Batch 2: role-specific queries + creator names — all in parallel
      const creatorIds = [...new Set(
        (taskData as { created_by: string; assigned_to: string }[] ?? [])
          .filter(t => t.created_by !== uid)
          .map(t => t.created_by)
      )]

      const batch2: Promise<unknown>[] = []

      if (creatorIds.length > 0) {
        batch2.push(
          supabase.from('users').select('id, full_name').in('id', creatorIds).then(({ data: creators }: { data: { id: string; full_name: string }[] | null }) => {
            if (creators) {
              const map: Record<string, string> = {}
              for (const u of creators) map[u.id] = u.full_name
              setAssignerNames(map)
            }
          })
        )
      }

      type CountResult = { count: number | null }

      const viewedRole = viewAsProfile?.role ?? profile?.role
      if (viewedRole === 'admin') {
        batch2.push(
          supabase.from('tasks').select(TASK_COLUMNS).not('status', 'eq', 'completed').then(({ data: eTasks }: { data: unknown[] | null }) => {
            if (eTasks) {
              const all = eTasks as unknown as Task[]
              setEscalationTasks(all)
              setBlockedCount(all.filter(t => t.status === 'blocked').length)
            }
          }),
        )
      } else {
        batch2.push(
          supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('assigned_to', uid).eq('status', 'blocked').then(({ count: bCount }: CountResult) => {
            if (bCount != null) setBlockedCount(bCount)
          }),
        )
      }

      await Promise.all(batch2)
      setLoading(false)
      router.prefetch('/tasks/my')
      router.prefetch('/notifications')
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAsUserId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Guard view-as against non-admins
  useEffect(() => {
    if (viewAsUserId && profile && profile.role !== 'admin') {
      exitViewMode()
      router.push('/dashboard')
    }
  }, [viewAsUserId, profile]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleAcknowledge = async () => {
    if (!selectedTask) return
    if (selectedTask.assigned_to !== currentUserId) return
    if (selectedTask.created_by === currentUserId) return
    const now = new Date().toISOString()
    const oldStatus = selectedTask.status
    const { error } = await supabase.from('tasks').update({ acknowledged_at: now, status: 'working', last_update_at: now }).eq('id', selectedTask.id)
    if (error) {
      alert('Failed to acknowledge task. Please try again.')
      return
    }
    await supabase.from('task_activity_log').insert([
      { task_id: selectedTask.id, actor_id: currentUserId, action: 'acknowledged', note: null },
      { task_id: selectedTask.id, actor_id: currentUserId, action: 'status_changed', from_status: oldStatus, to_status: 'working', note: null },
    ])
    if (selectedTask.created_by && selectedTask.created_by !== currentUserId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: selectedTask.id, taskTitle: selectedTask.title, createdBy: selectedTask.created_by, action: 'acknowledged', actorName: profile?.full_name }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[dashboard/acknowledge] notification failed:', d))
      }).catch(err => console.error('[dashboard/acknowledge] notification fetch error:', err))
    }
    const patch = { acknowledged_at: now, status: 'working' as const, last_update_at: now }
    setSelectedTask(prev => prev ? { ...prev, ...patch } : prev)
    setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...patch } : t))
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', currentUserId] })
    queryClient.invalidateQueries({ queryKey: ['top-tasks', loggedInId] })
  }

  const userMap = useMemo(
    () => Object.fromEntries(teamUsers.map(u => [u.id, u.full_name])),
    [teamUsers]
  )

  const now = new Date()
  const msPerDay = 24 * 60 * 60 * 1000

  const unacknowledgedForMe = tasks.filter(t => !t.acknowledged_at && t.created_by !== currentUserId && t.task_type !== 'quotation_request')
  const quotationTasks = tasks.filter(t => t.task_type === 'quotation_request')
  const mergedUserMap   = { ...assignerNames, ...userMap }

  const adminEscalations = useMemo(() => {
    if ((viewAsProfile ?? profile)?.role !== 'admin') return []
    const result: { task: Task; owner: string; days: number; reason: string }[] = []
    const nowMs = Date.now()
    const ms = 24 * 60 * 60 * 1000
    for (const t of escalationTasks) {
      const ref  = new Date(t.last_update_at ?? t.created_at)
      const days = Math.floor((nowMs - ref.getTime()) / ms)
      const owner = userMap[t.assigned_to] ?? t.assigned_to.slice(0, 8)
      if (t.status === 'blocked' && days > 5) {
        result.push({ task: t, owner, days, reason: 'Blocked' })
      } else if (t.status === 'waiting' && days > 5) {
        result.push({ task: t, owner, days, reason: 'Waiting' })
      } else if (['working', 'pending', 'started'].includes(t.status) && days > 7) {
        result.push({ task: t, owner, days, reason: 'Stale' })
      }
    }
    result.sort((a, b) => b.days - a.days)
    return result
  }, [escalationTasks, userMap, profile, viewAsProfile])

  useEffect(() => {
    if (!selectedTask) return
    const inTasks = tasks.find(t => t.id === selectedTask.id)
    if (inTasks) {
      if (inTasks !== selectedTask) setSelectedTask(inTasks)
      return
    }
    const inEscalations = escalationTasks.find(t => t.id === selectedTask.id)
    if (!inEscalations) setSelectedTask(null)
  }, [tasks, escalationTasks, selectedTask])

  if (loading) return <LoadingScreen />

  const totalOverdue   = tasks.filter(t => isOverdue(t.due_date, t.status)).length
  const waitingTasks   = tasks.filter(t => t.status === 'waiting')

  const todayStart     = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const tomorrowStart  = new Date(todayStart.getTime() + msPerDay)
  const dueTodayTasks  = tasks.filter(t => {
    if (!t.due_date) return false
    const d = new Date(t.due_date); d.setHours(0, 0, 0, 0)
    return d.getTime() === todayStart.getTime()
  })

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Dashboard"
        subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        actions={
          !viewAsUserId
            ? <button onClick={() => router.push('/tasks/create')} className="boe-btn boe-btn-primary">+ New Task</button>
            : undefined
        }
        onSignOut={handleLogout}
      >
        {/* ── 2×2 operational grid ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
          gap: '16px',
          marginBottom: '24px',
        }}>

          {/* Top-left: Top 3 Focus Tasks */}
          <Top3Panel
            tasks={top3Tasks}
            onSelectTask={setSelectedTask}
            isMobile={isMobile}
          />

          {/* Top-right: Operational Status */}
          <OperationalStatusPanel
            overdueTasks={tasks.filter(t => isOverdue(t.due_date, t.status))}
            waitingTasks={waitingTasks}
            dueTodayTasks={dueTodayTasks}
            onShowList={setPreviewList}
          />

          {/* Bottom-left: Unacknowledged Tasks */}
          <UnacknowledgedPanel
            tasks={unacknowledgedForMe}
            userMap={mergedUserMap}
            now={now}
            isMobile={isMobile}
            onPreview={task => setSelectedTask(task)}
            onViewAll={() => setPreviewList({ title: 'Unacknowledged Tasks', items: unacknowledgedForMe })}
          />

          {/* Bottom-right: Quotation Requests */}
          <QuotationPanel
            tasks={quotationTasks}
            userMap={mergedUserMap}
            isMobile={isMobile}
            onOpen={task => router.push(`/tasks/${task.id}`)}
            onViewAll={() => router.push('/tasks/quotation-requests')}
          />

        </div>
      </DashboardLayout>

      {previewList && !selectedTask && (
        <TaskListDrawer
          title={previewList.title}
          items={previewList.items}
          isMobile={isMobile}
          onClose={() => setPreviewList(null)}
          onSelectTask={task => { setPreviewList(null); setSelectedTask(task) }}
        />
      )}

      {escalationPreview && !selectedTask && (
        <EscalationListDrawer
          items={adminEscalations}
          isMobile={isMobile}
          onClose={() => setEscalationPreview(false)}
          onSelectTask={task => { setEscalationPreview(false); setSelectedTask(task) }}
        />
      )}

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={currentUserId}
          onAcknowledge={
            !viewAsUserId &&
            !selectedTask.acknowledged_at &&
            selectedTask.assigned_to === currentUserId &&
            selectedTask.created_by !== currentUserId &&
            selectedTask.status !== 'completed'
              ? handleAcknowledge
              : undefined
          }
        />
      )}
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ── Top 3 Focus Tasks panel ───────────────────────────────────────────────────

function Top3Panel({
  tasks,
  onSelectTask,
  isMobile,
}: {
  tasks: Task[]
  onSelectTask: (task: Task) => void
  isMobile: boolean
}) {
  const isEmpty = tasks.length === 0
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: '12px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: isMobile ? '12px 14px 10px' : '14px 20px 12px',
        borderBottom: '1px solid #F3F4F6',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
              Top 3 Focus Tasks
            </span>
            {tasks.length > 0 && (
              <span style={{ background: '#EFF6FF', color: '#1D4ED8', fontWeight: 700, fontSize: '11px', borderRadius: '999px', padding: '1px 8px' }}>
                {tasks.length}
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
            Your personal focus list for today
          </div>
        </div>
      </div>
      {isEmpty ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
          No focus tasks pinned. Go to My Tasks to pin up to 3.
        </div>
      ) : (
        tasks.map((task, idx) => {
          const isLast       = idx === tasks.length - 1
          const isOverdueTask = task.due_date && new Date(task.due_date) < new Date()
          const dueDateStr   = task.due_date
            ? new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            : null
          const priorityCfg = (
            task.priority === 'high'   ? { color: '#B45309', bg: '#FFFBEB' } :
            task.priority === 'low'    ? { color: '#6B7280', bg: '#F3F4F6' } :
                                         { color: '#92400E', bg: '#FFFBEB' }
          )
          return (
            <div
              key={task.id}
              onClick={() => onSelectTask(task)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '12px 16px',
                borderBottom: isLast ? 'none' : '1px solid #F3F4F6',
                cursor: 'pointer', transition: 'background 0.12s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              {/* Order number */}
              <div style={{
                width: '22px', height: '22px', borderRadius: '50%',
                background: '#F3F4F6',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#6B7280', flexShrink: 0,
              }}>
                {idx + 1}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px', fontWeight: 600, color: '#111827',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  marginBottom: '3px',
                }}>
                  {task.title}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 600,
                    color: priorityCfg.color, background: priorityCfg.bg,
                    borderRadius: '4px', padding: '1px 6px', textTransform: 'capitalize',
                  }}>
                    {task.priority}
                  </span>
                  <span className={`boe-badge boe-badge-${task.status}`} style={{ fontSize: '10px', padding: '1px 7px', textTransform: 'capitalize', fontWeight: 600 }}>
                    {task.status}
                  </span>
                  {dueDateStr && (
                    <span style={{ fontSize: '11px', color: isOverdueTask ? '#C0392B' : '#6B7280', fontWeight: isOverdueTask ? 600 : 400 }}>
                      {dueDateStr}
                    </span>
                  )}
                </div>
              </div>

              <ChevronRightIcon />
            </div>
          )
        })
      )}
    </div>
  )
}

// ── Operational Status panel (Overdue / Waiting / Due Today) ──────────────────

function OperationalStatusPanel({
  overdueTasks,
  waitingTasks,
  dueTodayTasks,
  onShowList,
}: {
  overdueTasks: Task[]
  waitingTasks: Task[]
  dueTodayTasks: Task[]
  onShowList: (list: { title: string; items: Task[] }) => void
}) {
  const rows = [
    { label: 'Overdue',   count: overdueTasks.length,   countColor: '#C0392B', countBg: '#FEF2F2', items: overdueTasks,   title: 'Overdue Tasks'  },
    { label: 'Waiting',   count: waitingTasks.length,   countColor: '#92400E', countBg: '#FFFBEB', items: waitingTasks,   title: 'Waiting Tasks'  },
    { label: 'Due Today', count: dueTodayTasks.length,  countColor: '#1D4ED8', countBg: '#EFF6FF', items: dueTodayTasks,  title: 'Due Today'      },
  ]
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: '12px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #F3F4F6' }}>
        <div style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
          Task Status
        </div>
        <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
          Priority signals for today
        </div>
      </div>
      {rows.map((row, idx) => {
        const isLast        = idx === rows.length - 1
        const isInteractive = row.count > 0
        return (
          <div
            key={row.label}
            onClick={() => isInteractive && onShowList({ title: row.title, items: row.items })}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '15px 20px',
              borderBottom: isLast ? 'none' : '1px solid #F3F4F6',
              cursor: isInteractive ? 'pointer' : 'default',
              transition: 'background 0.12s',
            }}
            onMouseEnter={e => { if (isInteractive) e.currentTarget.style.background = '#FAFAFA' }}
            onMouseLeave={e => { e.currentTarget.style.background = '' }}
          >
            <span style={{ fontSize: '13px', fontWeight: 500, color: '#374151' }}>
              {row.label}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontSize: '16px', fontWeight: 800,
                color: row.count > 0 ? row.countColor : '#9CA3AF',
                background: row.count > 0 ? row.countBg : 'transparent',
                borderRadius: '6px', padding: '2px 12px',
                minWidth: '36px', textAlign: 'center',
              }}>
                {row.count}
              </span>
              {isInteractive && <ChevronRightIcon />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Unacknowledged Tasks panel ────────────────────────────────────────────────

function UnacknowledgedPanel({
  tasks,
  userMap,
  now,
  isMobile,
  onPreview,
  onViewAll,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  now: Date
  isMobile: boolean
  onPreview: (task: Task) => void
  onViewAll: () => void
}) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: '12px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      overflow: 'hidden',
    }}>
      <div
        onClick={() => tasks.length > 0 && onViewAll()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isMobile ? '12px 14px 10px' : '14px 20px 12px',
          borderBottom: '1px solid #F3F4F6',
          cursor: tasks.length > 0 ? 'pointer' : 'default',
          transition: 'background 0.12s',
        }}
        onMouseEnter={e => { if (tasks.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
        onMouseLeave={e => { e.currentTarget.style.background = '' }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
              Unacknowledged Tasks
            </span>
            <span style={{ background: '#FEF2F2', color: '#B91C1C', fontWeight: 700, fontSize: '11px', borderRadius: '999px', padding: '1px 8px' }}>
              {tasks.length}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
            Please acknowledge your assigned tasks to keep things moving.
          </div>
        </div>
        {tasks.length > 0 && (
          <span style={{ fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>View all →</span>
        )}
      </div>
      {tasks.length === 0 ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
          No unacknowledged tasks.
        </div>
      ) : (
        <UnacknowledgedTasksSection
          tasks={tasks}
          userMap={userMap}
          now={now}
          onPreview={onPreview}
          compact
        />
      )}
    </div>
  )
}

// ── Quotation Requests panel ──────────────────────────────────────────────────

function QuotationPanel({
  tasks,
  userMap,
  isMobile,
  onOpen,
  onViewAll,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  isMobile: boolean
  onOpen: (task: Task) => void
  onViewAll: () => void
}) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: '12px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      overflow: 'hidden',
    }}>
      <div
        onClick={() => tasks.length > 0 && onViewAll()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isMobile ? '12px 14px 10px' : '14px 20px 12px',
          borderBottom: '1px solid #F3F4F6',
          cursor: tasks.length > 0 ? 'pointer' : 'default',
          transition: 'background 0.12s',
        }}
        onMouseEnter={e => { if (tasks.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
        onMouseLeave={e => { e.currentTarget.style.background = '' }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
              Quotation Requests
            </span>
            <span style={{ background: '#F0FDF4', color: '#15803D', fontWeight: 700, fontSize: '11px', borderRadius: '999px', padding: '1px 8px' }}>
              {tasks.length}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
            Active quotation requests assigned to you.
          </div>
        </div>
        {tasks.length > 0 && (
          <span style={{ fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>View all →</span>
        )}
      </div>
      {tasks.length === 0 ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
          No active quotation requests.
        </div>
      ) : (
        <QuotationRequestsSection
          tasks={tasks}
          userMap={userMap}
          onOpen={onOpen}
        />
      )}
    </div>
  )
}

// ── QuotationRequestsSection ──────────────────────────────────────────────────

function QuotationRequestsSection({
  tasks,
  userMap,
  onOpen,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  onOpen: (task: Task) => void
}) {
  return (
    <div>
      {tasks.slice(0, 8).map((task, idx) => {
        const isLast        = idx === Math.min(tasks.length, 8) - 1
        const requesterName = userMap[task.created_by] ?? 'Unknown'
        const createdDateStr = new Date(task.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
        const priorityCfg   = task.priority === 'high'
          ? { color: '#B45309', bg: '#FFFBEB' }
          : task.priority === 'low'
            ? { color: '#6B7280', bg: '#F3F4F6' }
            : { color: '#92400E', bg: '#FFFBEB' }

        return (
          <div
            key={task.id}
            onClick={() => onOpen(task)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onOpen(task)}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '11px 16px',
              borderBottom: isLast ? 'none' : '1px solid #F3F4F6',
              cursor: 'pointer', transition: 'background 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            <div style={{
              width: '30px', height: '30px', borderRadius: '50%',
              background: '#F0FDF4',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#15803D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.customer_name ?? task.title}
                </span>
                <span style={{ fontSize: '10px', fontWeight: 600, flexShrink: 0, color: priorityCfg.color, background: priorityCfg.bg, borderRadius: '4px', padding: '1px 6px', textTransform: 'capitalize' }}>
                  {task.priority}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                {task.contact_number ? <span style={{ color: '#6B7280' }}>{task.contact_number} · </span> : null}
                <span>{createdDateStr}</span>
              </div>
            </div>
            <div style={{ flexShrink: 0, textAlign: 'right' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#6B4FA0' }}>
                {requesterName.split(' ')[0]}
              </div>
              <div style={{ fontSize: '10px', color: '#9CA3AF', marginTop: '1px' }}>Requested by</div>
            </div>
            <ChevronRightIcon />
          </div>
        )
      })}
    </div>
  )
}

// ── UnacknowledgedTasksSection ────────────────────────────────────────────────

function UnacknowledgedTasksSection({
  tasks,
  userMap,
  now,
  onPreview,
  compact,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  now: Date
  onPreview: (task: Task) => void
  compact?: boolean
}) {
  const msPerDay = 24 * 60 * 60 * 1000
  return (
    <div style={compact ? {} : { marginBottom: '24px' }}>
      {tasks.map((task, idx) => {
        const isLate       = (now.getTime() - new Date(task.created_at).getTime()) > msPerDay
        const isDueOverdue = task.due_date && new Date(task.due_date) < now
        const isOverdueRow = isLate || isDueOverdue
        const assignedByName = getAssignedByDisplay(task, userMap)
        const dueDateStr   = task.due_date
          ? new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
          : null
        const isLast = idx === tasks.length - 1

        return (
          <div
            key={task.id}
            onClick={() => onPreview(task)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onPreview(task)}
            style={{
              display: 'flex', alignItems: 'center',
              borderBottom: isLast ? 'none' : '1px solid #F3F4F6',
              cursor: 'pointer', transition: 'background 0.12s',
              minHeight: '52px',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#FAFAFA')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            <div style={{ width: '3px', height: '38px', flexShrink: 0, background: isOverdueRow ? '#EF4444' : 'transparent', borderRadius: '2px', marginLeft: '1px' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: '10px', flexShrink: 0 }}>
              <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: isOverdueRow ? '#FEF2F2' : '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isOverdueRow ? '#EF4444' : '#9CA3AF'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, padding: '10px 10px 10px 10px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', lineHeight: 1.3, marginBottom: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {task.title}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '3px', fontSize: '11px', color: '#9CA3AF' }}>
                <span style={{ color: '#6B7280' }}>{assignedByName.split(' ')[0]}</span>
                {dueDateStr && (
                  <>
                    <span>•</span>
                    <span style={{ color: isDueOverdue ? '#B91C1C' : '#6B7280' }}>{dueDateStr}</span>
                  </>
                )}
                <span>•</span>
                <span style={{ fontSize: '10px', fontWeight: 600, color: isOverdueRow ? '#B91C1C' : '#92600A', background: isOverdueRow ? '#FEF2F2' : '#FFFBEB', borderRadius: '4px', padding: '0 5px' }}>
                  {isOverdueRow ? 'Overdue' : 'Pending'}
                </span>
              </div>
            </div>
            <div style={{ paddingRight: '12px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
              <ChevronRightIcon />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── TaskListDrawer ────────────────────────────────────────────────────────────

function TaskListDrawer({
  title,
  items,
  isMobile,
  onClose,
  onSelectTask,
}: {
  title: string
  items: Task[]
  isMobile?: boolean
  onClose: () => void
  onSelectTask: (task: Task) => void
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: isMobile ? '100%' : '420px',
        background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        zIndex: 50, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>{title}</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '2px' }}>
              {items.length} task{items.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: '20px', lineHeight: 1, padding: '4px 8px', borderRadius: '6px' }} aria-label="Close">×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {items.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>No tasks here.</div>
          ) : (
            items.map(task => {
              const isOverdueTask = task.due_date && new Date(task.due_date) < new Date()
              return (
                <div
                  key={task.id}
                  onClick={() => onSelectTask(task)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
                  style={{ padding: '14px 24px', borderBottom: '1px solid #F9FAFB', cursor: 'pointer', transition: 'background 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', marginBottom: '6px', lineHeight: 1.4 }}>
                    {task.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <StatusChip status={task.status} />
                    {task.priority && <PriorityChip priority={task.priority} />}
                    {task.due_date && (
                      <span style={{ fontSize: '11px', fontWeight: 500, color: isOverdueTask ? '#C0392B' : '#6B7280' }}>
                        Due {new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    pending:   { color: '#6B7280', bg: '#F3F4F6' },
    started:   { color: '#7C3AED', bg: '#F5F3FF' },
    working:   { color: '#1D4ED8', bg: '#EFF6FF' },
    waiting:   { color: '#92400E', bg: '#FFFBEB' },
    blocked:   { color: '#991B1B', bg: '#FEF2F2' },
    completed: { color: '#166534', bg: '#F0FDF4' },
  }
  const s = map[status] ?? { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, color: s.color, background: s.bg, borderRadius: '5px', padding: '2px 8px', textTransform: 'capitalize' }}>
      {status}
    </span>
  )
}

function PriorityChip({ priority }: { priority: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    high:   { color: '#991B1B', bg: '#FEF2F2' },
    medium: { color: '#92400E', bg: '#FFFBEB' },
    low:    { color: '#374151', bg: '#F3F4F6' },
  }
  const s = map[priority] ?? { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, color: s.color, background: s.bg, borderRadius: '5px', padding: '2px 8px', textTransform: 'capitalize' }}>
      {priority}
    </span>
  )
}

// ── EscalationListDrawer ──────────────────────────────────────────────────────

function EscalationListDrawer({
  items,
  isMobile,
  onClose,
  onSelectTask,
}: {
  items: { task: Task; owner: string; days: number; reason: string }[]
  isMobile?: boolean
  onClose: () => void
  onSelectTask: (task: Task) => void
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: isMobile ? '100%' : '420px',
        background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        zIndex: 50, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>Escalations</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '2px' }}>{items.length} task{items.length !== 1 ? 's' : ''} requiring attention</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: '20px', lineHeight: 1, padding: '4px 8px', borderRadius: '6px' }} aria-label="Close">×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {items.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>No escalations right now.</div>
          ) : items.map(({ task, owner, days, reason }) => {
            const daysColor = days >= 10 ? '#C0392B' : days >= 7 ? '#D4893A' : '#374151'
            return (
              <div
                key={task.id}
                onClick={() => onSelectTask(task)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
                style={{ padding: '14px 24px', borderBottom: '1px solid #F9FAFB', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              >
                <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', marginBottom: '6px', lineHeight: 1.4 }}>{task.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700, color: '#374151' }}>
                      {owner.slice(0, 2).toUpperCase()}
                    </div>
                    <span style={{ fontSize: '12px', color: '#374151' }}>{owner}</span>
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: daysColor }}>{days}d</span>
                  <ReasonBadge reason={reason} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function ReasonBadge({ reason }: { reason: string }) {
  const styles: Record<string, { color: string; bg: string }> = {
    Blocked: { color: '#991B1B', bg: '#FEF2F2' },
    Waiting: { color: '#92400E', bg: '#FFFBEB' },
    Stale:   { color: '#BE185D', bg: '#FDF2F8' },
  }
  const s = styles[reason] ?? { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{ fontSize: '10px', fontWeight: 600, color: s.color, background: s.bg, borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap' }}>
      {reason}
    </span>
  )
}
