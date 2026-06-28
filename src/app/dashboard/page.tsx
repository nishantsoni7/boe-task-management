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

  const overdueTasks   = tasks.filter(t => isOverdue(t.due_date, t.status))
  const waitingTasks   = tasks.filter(t => t.status === 'waiting')
  const isAdmin        = (viewAsProfile ?? profile)?.role === 'admin'

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
        {/* ── Today's Focus — full-width hero panel ── */}
        <TodaysFocusPanel
          tasks={top3Tasks}
          onSelectTask={setSelectedTask}
          isMobile={isMobile}
          onGoToMyTasks={() => router.push('/tasks/my')}
          userMap={mergedUserMap}
        />

        {/* ── Lower two-column ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
          gap: '16px',
          marginBottom: '16px',
        }}>
          <UnacknowledgedPanel
            tasks={unacknowledgedForMe}
            userMap={mergedUserMap}
            now={now}
            isMobile={isMobile}
            onPreview={task => setSelectedTask(task)}
            onViewAll={() => setPreviewList({ title: 'Unacknowledged Tasks', items: unacknowledgedForMe })}
          />
          {isAdmin ? (
            <QuotationPanel
              tasks={quotationTasks}
              userMap={mergedUserMap}
              isMobile={isMobile}
              onOpen={task => router.push(`/tasks/${task.id}`)}
              onViewAll={() => router.push('/tasks/quotation-requests')}
            />
          ) : (
            <OverdueTasksPanel
              tasks={overdueTasks}
              userMap={mergedUserMap}
              now={now}
              isMobile={isMobile}
              onSelectTask={task => setSelectedTask(task)}
              onViewAll={() => setPreviewList({ title: 'Overdue Tasks', items: overdueTasks })}
            />
          )}
        </div>

        {/* ── Status rail — bottom ── */}
        <OperationalStatusPanel
          overdueTasks={overdueTasks}
          waitingTasks={waitingTasks}
          dueTodayTasks={dueTodayTasks}
          onShowList={setPreviewList}
          isMobile={isMobile}
        />
      </DashboardLayout>

      {previewList && !selectedTask && (
        <TaskListDrawer
          title={previewList.title}
          items={previewList.items}
          isMobile={isMobile}
          userMap={mergedUserMap}
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

function ChevronRightIcon({ color = '#9CA3AF' }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35, flexShrink: 0 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ── Today's Focus panel ───────────────────────────────────────────────────────

function TodaysFocusPanel({
  tasks,
  onSelectTask,
  isMobile,
  onGoToMyTasks,
  userMap,
}: {
  tasks: Task[]
  onSelectTask: (task: Task) => void
  isMobile: boolean
  onGoToMyTasks: () => void
  userMap: Record<string, string>
}) {
  return (
    <div style={{
      background: '#F8F7F5',
      border: '1px solid rgba(0,0,0,0.06)',
      borderRadius: '16px',
      padding: isMobile ? '12px 14px' : '14px 24px 10px',
      marginBottom: '20px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: tasks.length === 0 ? '14px' : '10px',
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: isMobile ? '17px' : '19px', color: '#0F172A', letterSpacing: '-0.03em', lineHeight: 1 }}>
            Top 3 Focus
          </div>
          <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '3px', letterSpacing: '0.01em' }}>
            {tasks.length === 0
              ? 'Pin up to three tasks to keep in focus.'
              : `${tasks.length} of 3 slots active`}
          </div>
        </div>
        <button
          onClick={onGoToMyTasks}
          style={{
            fontSize: '11px', fontWeight: 500, color: '#9CA3AF',
            background: 'transparent', border: 'none',
            padding: '4px 0', cursor: 'pointer',
            letterSpacing: '0.01em', transition: 'color 0.12s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#374151' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF' }}
        >
          My Tasks →
        </button>
      </div>

      {/* 3-column card grid — always rendered, all 3 slots */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
        gap: isMobile ? '8px' : '10px',
      }}>
        {[0, 1, 2].map(idx => {
          const task = tasks[idx]

          /* ── Empty slot ── */
          if (!task) {
            return (
              <div
                key={`empty-${idx}`}
                onClick={onGoToMyTasks}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && onGoToMyTasks()}
                style={{
                  background: 'rgba(255,255,255,0.5)',
                  border: '1px dashed #D4D4D4',
                  borderRadius: '12px',
                  padding: isMobile ? '12px 14px' : '13px 16px',
                  display: 'flex', flexDirection: 'column',
                  minHeight: isMobile ? 'auto' : '130px',
                  cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.82)'
                  e.currentTarget.style.borderColor = '#B0B0B0'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.5)'
                  e.currentTarget.style.borderColor = '#D4D4D4'
                }}
              >
                {/* Slot number */}
                <div style={{ fontSize: '12px', color: '#C4C9D4', marginBottom: '4px', lineHeight: 1 }}>
                  {['①','②','③'][idx]}
                </div>
                <div style={{ fontSize: '13px', fontWeight: 500, color: '#A8B2BF', marginBottom: '2px', lineHeight: 1.4 }}>
                  Focus slot available
                </div>
                <div style={{ fontSize: '12px', color: '#C4C9D4', lineHeight: 1.3 }}>
                  Open My Tasks to add one.
                </div>
              </div>
            )
          }

          /* ── Filled slot ── */
          const now = new Date()
          const dueDate = task.due_date ? new Date(task.due_date) : null
          const isUrgentDate = dueDate
            ? (dueDate.toDateString() === now.toDateString() || dueDate < now)
            : false
          const dueDateStr = dueDate
            ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            : null
          const priorityLabel = task.priority
            ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1)
            : null
          const priorityLower = task.priority?.toLowerCase() ?? ''
          const statusLabel = task.status
            ? task.status.charAt(0).toUpperCase() + task.status.slice(1)
            : null
          const assignerDisplay = getAssignedByDisplay(task, userMap)
          const isSelf = assignerDisplay === 'Self'

          // Subtle priority colour — text only, no background change
          const priorityColor = priorityLower === 'high'
            ? '#C0432B'
            : priorityLower === 'medium'
              ? '#92700A'
              : '#7B8494'

          return (
            <div
              key={task.id}
              onClick={() => onSelectTask(task)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
              style={{
                background: '#ffffff',
                borderTop: '1px solid rgba(0,0,0,0.06)',
                borderRight: '1px solid rgba(0,0,0,0.06)',
                borderBottom: '1px solid rgba(0,0,0,0.06)',
                borderLeft: '3px solid #B8ACA0',
                borderRadius: '12px',
                padding: isMobile ? '12px 14px' : '13px 16px',
                display: 'flex', flexDirection: 'column',
                minHeight: isMobile ? 'auto' : '130px',
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                transition: 'box-shadow 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 3px 10px rgba(0,0,0,0.08)' }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)' }}
            >
              {/* Zone 1 — slot number */}
              <div style={{ fontSize: '12px', color: '#B0BAC8', marginBottom: '4px', lineHeight: 1 }}>
                {['①','②','③'][idx]}
              </div>

              {/* Zone 2 — title + source (grows to push zone 3 to bottom) */}
              <div style={{ flex: 1, marginBottom: '6px' }}>
                <div style={{
                  fontSize: isMobile ? '13px' : '14px',
                  fontWeight: 700,
                  color: '#0F172A',
                  lineHeight: 1.4,
                  letterSpacing: '-0.01em',
                  marginBottom: '2px',
                }}>
                  {task.title}
                </div>
                <div style={{ fontSize: '12px', color: '#8A94A6', lineHeight: 1.3 }}>
                  {isSelf
                    ? 'Self Task'
                    : <span>Delegated by <span style={{ color: '#6B7280', fontWeight: 500 }}>{assignerDisplay}</span></span>
                  }
                </div>
              </div>

              {/* Zone 3 — chips + date + chevron, anchored to bottom */}
              <div>
                {/* Priority + status chips */}
                {(priorityLabel || statusLabel) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px', flexWrap: 'wrap' }}>
                    {priorityLabel && (
                      <span style={{
                        fontSize: '10.5px',
                        color: priorityColor,
                        background: '#F8F9FB',
                        border: '1px solid #E6E8EC',
                        borderRadius: '999px',
                        padding: '2px 7px',
                        lineHeight: 1.5,
                        fontWeight: 500,
                      }}>
                        {priorityLabel}
                      </span>
                    )}
                    {statusLabel && (
                      <span style={{
                        fontSize: '10.5px',
                        color: '#7B8494',
                        background: '#F8F9FB',
                        border: '1px solid #E6E8EC',
                        borderRadius: '999px',
                        padding: '2px 7px',
                        lineHeight: 1.5,
                      }}>
                        {statusLabel}
                      </span>
                    )}
                  </div>
                )}
                {/* Due date + chevron */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  {dueDateStr
                    ? <span style={{
                        fontSize: '11px',
                        fontWeight: isUrgentDate ? 600 : 500,
                        color: isUrgentDate ? '#C0392B' : '#9CA3AF',
                      }}>{`Due ${dueDateStr}`}</span>
                    : <span />
                  }
                  <ChevronRightIcon />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Operational status strip ──────────────────────────────────────────────────

function OperationalStatusPanel({
  overdueTasks,
  waitingTasks,
  dueTodayTasks,
  onShowList,
  isMobile,
}: {
  overdueTasks: Task[]
  waitingTasks: Task[]
  dueTodayTasks: Task[]
  onShowList: (list: { title: string; items: Task[] }) => void
  isMobile: boolean
}) {
  const items = [
    { label: 'Overdue',   sub: 'Needs attention',  count: overdueTasks.length,  items: overdueTasks,  title: 'Overdue Tasks', countColor: '#C0392B' },
    { label: 'Waiting',   sub: 'Pending action',   count: waitingTasks.length,  items: waitingTasks,  title: 'Waiting Tasks', countColor: '#92400E' },
    { label: 'Due Today', sub: 'Finish today',      count: dueTodayTasks.length, items: dueTodayTasks, title: 'Due Today',      countColor: '#374151' },
  ]
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E7E9EE',
      borderRadius: '12px',
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
      marginBottom: '24px',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      {items.map((item, idx) => {
        const isInteractive = item.count > 0
        const isLast = idx === items.length - 1
        return (
          <div
            key={item.label}
            onClick={() => isInteractive && onShowList({ title: item.title, items: item.items })}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderRight: !isMobile && !isLast ? '1px solid rgba(0,0,0,0.05)' : 'none',
              borderBottom: isMobile && !isLast ? '1px solid rgba(0,0,0,0.05)' : 'none',
              padding: '15px 22px',
              cursor: isInteractive ? 'pointer' : 'default',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { if (isInteractive) e.currentTarget.style.background = '#FAFAFA' }}
            onMouseLeave={e => { e.currentTarget.style.background = '' }}
          >
            <div>
              <div style={{ fontSize: '11px', fontWeight: 500, color: '#9CA3AF', letterSpacing: '0.01em', lineHeight: 1 }}>
                {item.label}
              </div>
              <div style={{ fontSize: '10.5px', color: '#C4C9D4', marginTop: '4px', lineHeight: 1 }}>
                {item.sub}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                fontSize: '20px', fontWeight: 700,
                color: item.count > 0 ? item.countColor : '#D1D5DB',
                letterSpacing: '-0.03em',
              }}>
                {item.count}
              </span>
              {isInteractive && <ChevronRightIcon color="#C4C9D4" />}
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
      border: '1px solid #E7E9EE',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div
        onClick={() => tasks.length > 0 && onViewAll()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isMobile ? '14px 16px' : '16px 20px',
          borderBottom: '1px solid #F0F1F4',
          cursor: tasks.length > 0 ? 'pointer' : 'default',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (tasks.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
        onMouseLeave={e => { e.currentTarget.style.background = '' }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span style={{ fontWeight: 600, fontSize: '15px', color: '#6B7280', letterSpacing: '-0.015em', lineHeight: 1 }}>
              Needs Acknowledgement
            </span>
            {tasks.length > 0 && (
              <span style={{ background: '#F3F4F6', color: '#6B7280', fontWeight: 500, fontSize: '11px', borderRadius: '5px', padding: '1px 6px', lineHeight: 1.6 }}>
                {tasks.length}
              </span>
            )}
          </div>
        </div>
        {tasks.length > 0 && (
          <span style={{ fontSize: '11px', color: '#C4C9D4', whiteSpace: 'nowrap', flexShrink: 0 }}>View all →</span>
        )}
      </div>

      {tasks.length === 0 ? (
        <div style={{ padding: '36px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '5px' }}>All clear</div>
          <div style={{ fontSize: '12px', color: '#C4C9D4' }}>No tasks waiting for acknowledgement</div>
        </div>
      ) : (
        <UnacknowledgedTasksSection tasks={tasks} userMap={userMap} now={now} onPreview={onPreview} compact />
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
      border: '1px solid #E7E9EE',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div
        onClick={() => tasks.length > 0 && onViewAll()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isMobile ? '14px 16px' : '16px 20px',
          borderBottom: '1px solid #F0F1F4',
          cursor: tasks.length > 0 ? 'pointer' : 'default',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (tasks.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
        onMouseLeave={e => { e.currentTarget.style.background = '' }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span style={{ fontWeight: 600, fontSize: '15px', color: '#6B7280', letterSpacing: '-0.015em', lineHeight: 1 }}>
              Quotation Requests
            </span>
            {tasks.length > 0 && (
              <span style={{ background: '#F3F4F6', color: '#6B7280', fontWeight: 500, fontSize: '11px', borderRadius: '5px', padding: '1px 6px', lineHeight: 1.6 }}>
                {tasks.length}
              </span>
            )}
          </div>
        </div>
        {tasks.length > 0 && (
          <span style={{ fontSize: '11px', color: '#C4C9D4', whiteSpace: 'nowrap', flexShrink: 0 }}>View all →</span>
        )}
      </div>

      {tasks.length === 0 ? (
        <div style={{ padding: '36px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '5px' }}>No active requests</div>
          <div style={{ fontSize: '12px', color: '#C4C9D4' }}>Quotation requests will appear here</div>
        </div>
      ) : (
        <QuotationRequestsSection tasks={tasks} userMap={userMap} onOpen={onOpen} />
      )}
    </div>
  )
}

// ── Overdue Tasks panel (non-admin) ──────────────────────────────────────────

function OverdueTasksPanel({
  tasks,
  userMap,
  now,
  isMobile,
  onSelectTask,
  onViewAll,
}: {
  tasks: Task[]
  userMap: Record<string, string>
  now: Date
  isMobile: boolean
  onSelectTask: (task: Task) => void
  onViewAll: () => void
}) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E7E9EE',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div
        onClick={() => tasks.length > 0 && onViewAll()}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isMobile ? '14px 16px' : '16px 20px',
          borderBottom: '1px solid #F0F1F4',
          cursor: tasks.length > 0 ? 'pointer' : 'default',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (tasks.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
        onMouseLeave={e => { e.currentTarget.style.background = '' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          <span style={{ fontWeight: 600, fontSize: '15px', color: '#6B7280', letterSpacing: '-0.015em', lineHeight: 1 }}>
            Overdue Tasks
          </span>
          {tasks.length > 0 && (
            <span style={{ background: '#FEF2F2', color: '#C0392B', fontWeight: 500, fontSize: '11px', borderRadius: '5px', padding: '1px 6px', lineHeight: 1.6 }}>
              {tasks.length}
            </span>
          )}
        </div>
        {tasks.length > 0 && (
          <span style={{ fontSize: '11px', color: '#C4C9D4', whiteSpace: 'nowrap', flexShrink: 0 }}>View all →</span>
        )}
      </div>

      {tasks.length === 0 ? (
        <div style={{ padding: '36px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '5px' }}>All caught up</div>
          <div style={{ fontSize: '12px', color: '#C4C9D4' }}>No overdue tasks</div>
        </div>
      ) : (
        <UnacknowledgedTasksSection tasks={tasks} userMap={userMap} now={now} onPreview={onSelectTask} compact />
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
  const now          = new Date()
  const todayStart   = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart.getTime() - 86400000)
  const tomorrowStart  = new Date(todayStart.getTime() + 86400000)

  return (
    <div>
      {tasks.slice(0, 8).map((task, idx) => {
        const isLast        = idx === Math.min(tasks.length, 8) - 1
        const requesterName = userMap[task.created_by] ?? 'Unknown'
        const dueDate       = task.due_date ? new Date(task.due_date) : null
        const isToday       = dueDate ? dueDate.toDateString() === now.toDateString() : false
        const isDueOverdue  = dueDate ? dueDate < todayStart && !isToday : false
        const isTomorrow    = dueDate ? dueDate >= tomorrowStart && dueDate < new Date(tomorrowStart.getTime() + 86400000) : false
        const dueDateStr    = dueDate ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null

        // Date/created text — no priority dot in quotation rows (distinct from acknowledgement)
        let dateText: string | null = null
        let dateColor = '#6B7280'
        if (dueDate) {
          if (isDueOverdue)    { dateText = `Overdue · ${dueDateStr}`; dateColor = '#C0392B' }
          else if (isToday)    { dateText = 'Due today';               dateColor = '#D97706' }
          else if (isTomorrow) { dateText = 'Due tomorrow';            dateColor = '#6B7280' }
          else                 { dateText = `Due ${dueDateStr}`;       dateColor = '#6B7280' }
        } else {
          const created = new Date(task.created_at)
          if (created >= todayStart)        { dateText = 'Created today';     dateColor = '#9CA3AF' }
          else if (created >= yesterdayStart) { dateText = 'Created yesterday'; dateColor = '#9CA3AF' }
        }

        return (
          <div
            key={task.id}
            onClick={() => onOpen(task)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onOpen(task)}
            style={{
              display: 'flex', alignItems: 'stretch',
              borderBottom: isLast ? 'none' : '1px solid #F0F1F4',
              cursor: 'pointer',
              transition: 'background 0.12s',
              minHeight: '76px',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
            onMouseLeave={e => { e.currentTarget.style.background = '' }}
          >
            {/* LEFT — client name + date */}
            <div style={{
              flex: 1, minWidth: 0,
              display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '14px 16px 14px 20px',
            }}>
              <div style={{
                fontSize: '16px', fontWeight: 600, color: '#111827',
                letterSpacing: '-0.015em', lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: '5px',
              }}>
                {task.customer_name ?? task.title}
              </div>
              {dateText && (
                <div style={{ fontSize: '13px', fontWeight: 400, color: dateColor, lineHeight: 1 }}>
                  {dateText}
                </div>
              )}
            </div>

            {/* RIGHT — requested by column */}
            <div style={{
              width: '112px', flexShrink: 0,
              borderLeft: '1px solid #F5F7FA',
              display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '0 14px 0 18px',
            }}>
              <div style={{
                fontSize: '10px', fontWeight: 500, color: '#9CA3AF',
                letterSpacing: '0.06em', textTransform: 'uppercase',
                lineHeight: 1, marginBottom: '6px',
              }}>
                Requested by
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827', lineHeight: 1 }}>
                  {requesterName.split(' ')[0]}
                </span>
                <ChevronRightIcon />
              </div>
            </div>
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
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)

  return (
    <div style={compact ? {} : { marginBottom: '24px' }}>
      {tasks.map((task, idx) => {
        const dueDate      = task.due_date ? new Date(task.due_date) : null
        const isToday      = dueDate ? dueDate.toDateString() === now.toDateString() : false
        const isDueOverdue = dueDate ? dueDate < todayStart && !isToday : false
        const dueDateStr   = dueDate ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null

        let dateText: string | null = null
        let dateColor = '#6B7280'
        if (dueDate) {
          if (isDueOverdue) { dateText = `Overdue · ${dueDateStr}`; dateColor = '#C0392B' }
          else if (isToday) { dateText = 'Due today';               dateColor = '#D97706' }
          else              { dateText = `Due ${dueDateStr}`;        dateColor = '#6B7280' }
        }

        const priorityLower = task.priority?.toLowerCase() ?? ''
        const priorityLabel = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : null
        const dotColor      = priorityLower === 'high' ? '#D97706' : priorityLower === 'medium' ? '#B45309' : '#9CA3AF'

        const assignedByName = getAssignedByDisplay(task, userMap)
        const isLast = idx === tasks.length - 1

        return (
          <div
            key={task.id}
            onClick={() => onPreview(task)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onPreview(task)}
            style={{
              display: 'flex', alignItems: 'stretch',
              borderBottom: isLast ? 'none' : '1px solid #F0F1F4',
              cursor: 'pointer',
              transition: 'background 0.12s',
              minHeight: '76px',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
            onMouseLeave={e => { e.currentTarget.style.background = '' }}
          >
            {/* LEFT — task title + metadata */}
            <div style={{
              flex: 1, minWidth: 0,
              display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '14px 16px 14px 20px',
            }}>
              <div style={{
                fontSize: '16px', fontWeight: 600, color: '#111827',
                letterSpacing: '-0.015em', lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: '5px',
              }}>
                {task.title}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: '13px', fontWeight: 400, color: '#6B7280', lineHeight: 1 }}>
                {priorityLabel && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: dateText ? '6px' : 0 }}>
                    <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                    {priorityLabel}
                  </span>
                )}
                {priorityLabel && dateText && (
                  <span style={{ color: '#D1D5DB', marginRight: '6px' }}>·</span>
                )}
                {dateText && <span style={{ color: dateColor }}>{dateText}</span>}
              </div>
            </div>

            {/* RIGHT — ownership column with border divider */}
            <div style={{
              width: '112px', flexShrink: 0,
              borderLeft: '1px solid #F5F7FA',
              display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '0 14px 0 18px',
            }}>
              <div style={{
                fontSize: '10px', fontWeight: 500, color: '#9CA3AF',
                letterSpacing: '0.06em', textTransform: 'uppercase',
                lineHeight: 1, marginBottom: '6px',
              }}>
                Assigned by
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827', lineHeight: 1 }}>
                  {assignedByName === 'Self' ? 'You' : assignedByName.split(' ')[0]}
                </span>
                <ChevronRightIcon />
              </div>
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
  userMap,
}: {
  title: string
  items: Task[]
  isMobile?: boolean
  onClose: () => void
  onSelectTask: (task: Task) => void
  userMap: Record<string, string>
}) {
  const isOverdueDrawer = title === 'Overdue Tasks'
  const isWaitingDrawer = title === 'Waiting Tasks'
  const now = new Date()
  const msPerDay = 24 * 60 * 60 * 1000

  const subtitle = isOverdueDrawer
    ? `${items.length} task${items.length !== 1 ? 's' : ''} need your attention`
    : isWaitingDrawer
      ? `${items.length} task${items.length !== 1 ? 's' : ''} waiting on action`
      : `${items.length} task${items.length !== 1 ? 's' : ''}`

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: isMobile ? '100%' : '420px',
        background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        zIndex: 50, display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '16px', color: '#111827', letterSpacing: '-0.01em', lineHeight: 1 }}>
              {title}
            </div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '6px' }}>
              {subtitle}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: '22px', lineHeight: 1, padding: '0 0 0 12px', flexShrink: 0 }}
            aria-label="Close"
          >×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {items.length === 0 ? (
            <div style={{ padding: '52px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 500, color: '#374151', marginBottom: '6px' }}>All clear</div>
              <div style={{ fontSize: '13px', color: '#C4C9D4' }}>No tasks here right now.</div>
            </div>
          ) : (
            items.map((task, idx) => {
              const isLast    = idx === items.length - 1
              const dueDate   = task.due_date ? new Date(task.due_date) : null
              const daysOver  = dueDate ? Math.floor((now.getTime() - dueDate.getTime()) / msPerDay) : 0
              const dueDateStr = dueDate ? dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null
              const assignedBy = getAssignedByDisplay(task, userMap)

              let dateLabel = ''
              let dateColor = '#6B7280'
              if (isOverdueDrawer && dueDate && daysOver > 0) {
                dateLabel = daysOver === 1 ? 'Overdue by 1 day' : `Overdue by ${daysOver} days`
                dateColor = '#C0392B'
              } else if (dueDateStr) {
                dateLabel = `Due ${dueDateStr}`
                dateColor = '#6B7280'
              }

              return (
                <div
                  key={task.id}
                  onClick={() => onSelectTask(task)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && onSelectTask(task)}
                  style={{
                    display: 'flex', alignItems: 'stretch',
                    borderBottom: isLast ? 'none' : '1px solid #F4F5F7',
                    cursor: 'pointer',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#F9FAFB' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '' }}
                >
                  {/* Left accent strip — overdue drawer only */}
                  {isOverdueDrawer && (
                    <div style={{ width: '3px', flexShrink: 0, background: '#EF4444' }} />
                  )}

                  {/* Card content */}
                  <div style={{ flex: 1, minWidth: 0, padding: '18px 16px 18px 20px' }}>
                    {/* Title */}
                    <div style={{
                      fontSize: '15px', fontWeight: 600, color: '#111827',
                      letterSpacing: '-0.01em', lineHeight: 1.35,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      marginBottom: '8px',
                    }}>
                      {task.title}
                    </div>

                    {/* Assigned by */}
                    {assignedBy && assignedBy !== 'Self' && (
                      <div style={{ marginBottom: '10px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 500, color: '#C4C9D4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>
                          Assigned by
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                          {assignedBy}
                        </div>
                      </div>
                    )}

                    {/* Status + Priority chips */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: dateLabel ? '8px' : 0, flexWrap: 'wrap' }}>
                      <StatusChip status={task.status} />
                      {task.priority && <PriorityChip priority={task.priority} />}
                    </div>

                    {/* Date label */}
                    {dateLabel && (
                      <div style={{ fontSize: '12px', fontWeight: 500, color: dateColor }}>
                        {dateLabel}
                      </div>
                    )}
                  </div>

                  {/* Chevron */}
                  <div style={{ display: 'flex', alignItems: 'center', paddingRight: '16px', flexShrink: 0 }}>
                    <ChevronRightIcon />
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
