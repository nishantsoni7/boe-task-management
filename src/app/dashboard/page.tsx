'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue } from '@/lib/ui'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

export default function DashboardPage() {
  const [profile,            setProfile]            = useState<UserProfile | null>(null)
  const [tasks,              setTasks]              = useState<Task[]>([])
  const [loading,            setLoading]            = useState(true)
  const [currentUserId,      setCurrentUserId]      = useState('')
  const [selectedTask,       setSelectedTask]       = useState<Task | null>(null)
  const [teamUsers,          setTeamUsers]          = useState<{ id: string; full_name: string }[]>([])
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
      setCurrentUserId(session.user.id)

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
          .not('status', 'eq', 'completed')
          .order('created_at', { ascending: false }),
      ])

      if (profileData) setProfile(profileData)
      if (taskData) setTasks(taskData as unknown as Task[])

      // Fetch names of task creators for "Assigned By" display on unacknowledged cards
      if (taskData) {
        const creatorIds = [...new Set(
          (taskData as { created_by: string; assigned_to: string }[])
            .filter(t => t.created_by !== session.user.id)
            .map(t => t.created_by)
        )]
        if (creatorIds.length > 0) {
          const { data: creators } = await supabase
            .from('users')
            .select('id, full_name')
            .in('id', creatorIds)
          if (creators) {
            const map: Record<string, string> = {}
            for (const u of creators as { id: string; full_name: string }[]) {
              map[u.id] = u.full_name
            }
            setAssignerNames(map)
          }
        }
      }

      // Counts + data for bottom summary cards and preview panels
      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)
      const monthStartISO = monthStart.toISOString()

      const [{ data: completedData }, { data: abmTasks }, { count: abmCompCount }] = await Promise.all([
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', session.user.id)
          .eq('status', 'completed')
          .gte('last_update_at', monthStartISO)
          .order('last_update_at', { ascending: false }),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('created_by', session.user.id)
          .neq('assigned_to', session.user.id)
          .not('status', 'eq', 'completed'),
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('created_by', session.user.id)
          .neq('assigned_to', session.user.id)
          .eq('status', 'completed')
          .gte('last_update_at', monthStartISO),
      ])
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

      if (profileData?.role === 'admin') {
        const [{ data: tUsers }, { data: eTasks }, { count: bCount }] = await Promise.all([
          supabase.from('users').select('id, full_name').eq('is_active', true),
          supabase
            .from('tasks')
            .select(TASK_COLUMNS)
            .not('status', 'eq', 'completed'),
          supabase
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'blocked'),
        ])
        if (tUsers) setTeamUsers(tUsers as { id: string; full_name: string }[])
        if (eTasks) setEscalationTasks(eTasks as unknown as Task[])
        if (bCount != null) setBlockedCount(bCount)
      } else if (profileData?.role === 'manager') {
        const { data: tUsers } = await supabase.from('users').select('id, full_name').eq('is_active', true)
        if (tUsers) setTeamUsers(tUsers as { id: string; full_name: string }[])
        // Use same scope as the preview drawer: only this manager's own blocked tasks
        const { count: bCount } = await supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', session.user.id)
          .eq('status', 'blocked')
        if (bCount != null) setBlockedCount(bCount)
      } else {
        // Normal user: count their own blocked tasks
        const { count: bCount } = await supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', session.user.id)
          .eq('status', 'blocked')
        if (bCount != null) setBlockedCount(bCount)
      }

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleAcknowledge = async () => {
    if (!selectedTask) return
    if (selectedTask.assigned_to !== currentUserId) return
    if (selectedTask.created_by === currentUserId) return
    const now = new Date().toISOString()
    const { error } = await supabase.from('tasks').update({ acknowledged_at: now }).eq('id', selectedTask.id)
    if (error) {
      alert('Failed to acknowledge task. Please try again.')
      return
    }
    await supabase.from('task_activity_log').insert({
      task_id: selectedTask.id, actor_id: currentUserId, action: 'acknowledged', note: null,
    })
    if (selectedTask.created_by && selectedTask.created_by !== currentUserId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: selectedTask.id, taskTitle: selectedTask.title, createdBy: selectedTask.created_by, title: 'Task acknowledged' }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[dashboard/acknowledge] notification failed:', d))
      }).catch(err => console.error('[dashboard/acknowledge] notification fetch error:', err))
    }
    const patch = { acknowledged_at: now }
    setSelectedTask(prev => prev ? { ...prev, ...patch } : prev)
    setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...patch } : t))
  }

  const userMap = useMemo(
    () => Object.fromEntries(teamUsers.map(u => [u.id, u.full_name])),
    [teamUsers]
  )

  const now = new Date()
  const msPerDay = 24 * 60 * 60 * 1000

  const unacknowledged  = tasks.filter(t => !t.acknowledged_at)
  // Tasks assigned to me by someone else that I haven't acknowledged yet
  const unacknowledgedForMe = tasks.filter(t => !t.acknowledged_at && t.created_by !== currentUserId)
  const mergedUserMap   = { ...assignerNames, ...userMap }
  const allOverdueTasks = tasks.filter(t => isOverdue(t.due_date) && t.acknowledged_at)
  const actionRequired  = [...allOverdueTasks, ...unacknowledgedForMe]

  const adminEscalations: { task: Task; owner: string; days: number; reason: string }[] = []
  if (profile?.role === 'admin') {
    for (const t of escalationTasks) {
      const ref  = new Date(t.last_update_at ?? t.created_at)
      const days = Math.floor((now.getTime() - ref.getTime()) / msPerDay)
      const owner = userMap[t.assigned_to] ?? t.assigned_to.slice(0, 8)
      if (t.status === 'blocked' && days > 5) {
        adminEscalations.push({ task: t, owner, days, reason: 'Blocked' })
      } else if (t.status === 'waiting' && days > 5) {
        adminEscalations.push({ task: t, owner, days, reason: 'Waiting' })
      } else if (['working', 'pending', 'started'].includes(t.status) && days > 7) {
        adminEscalations.push({ task: t, owner, days, reason: 'Stale' })
      }
    }
    adminEscalations.sort((a, b) => b.days - a.days)
  }

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

  const isAdmin = profile?.role === 'admin'

  const totalOverdue = tasks.filter(t => isOverdue(t.due_date)).length
  const waitingTasks = tasks.filter(t => t.status === 'waiting')
  const waitingCount = waitingTasks.length

  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const tomorrowStart = new Date(todayStart.getTime() + msPerDay)
  const weekEnd = new Date(todayStart.getTime() + 7 * msPerDay)

  const dueTodayTasks = tasks.filter(t => {
    if (!t.due_date) return false
    const d = new Date(t.due_date); d.setHours(0, 0, 0, 0)
    return d.getTime() === todayStart.getTime()
  })
  const dueThisWeekTasks = tasks.filter(t => {
    if (!t.due_date) return false
    const d = new Date(t.due_date)
    return d >= tomorrowStart && d < weekEnd
  })
  const activeProjectsTasks = tasks.filter(t => ['working', 'started', 'pending'].includes(t.status))

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Dashboard"
        subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        actions={
          <button onClick={() => router.push('/tasks/create')} className="boe-btn boe-btn-primary">
            + New Task
          </button>
        }
        onSignOut={handleLogout}
        taskCounts={{
          myInProgress: tasks.length,
          myCompleted: myCompletedCount,
          assignedByMeInProgress: assignedByMeInProg,
        }}
      >
        {/* ── Top summary cards — always 3 ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)',
          gap: '16px',
          marginBottom: '24px',
        }}>
          <SummaryCard
            onClick={() => setPreviewList({ title: 'Overdue Tasks', items: tasks.filter(t => isOverdue(t.due_date)) })}
            icon={<AlertIcon />}
            iconBg="rgba(220,53,53,0.10)"
            count={totalOverdue}
            countColor="#C0392B"
            label="Total Overdue Tasks"
            sublabel="Tasks past their due date"
          />
          <SummaryCard
            onClick={() => setPreviewList({ title: 'Unacknowledged Tasks', items: unacknowledgedForMe })}
            icon={<BellIcon />}
            iconBg="rgba(234,136,33,0.12)"
            count={unacknowledgedForMe.length}
            countColor="#D4893A"
            label="Total Unacknowledged Tasks"
            sublabel="Waiting for your acknowledgement"
          />
          <SummaryCard
            onClick={() => setPreviewList({
              title: 'Blocked Tasks',
              items: isAdmin
                ? escalationTasks.filter(t => t.status === 'blocked')
                : tasks.filter(t => t.status === 'blocked'),
            })}
            icon={<FlagIcon />}
            iconBg="rgba(59,130,246,0.10)"
            count={blockedCount}
            countColor="#2563EB"
            label="Blocked Tasks"
            sublabel="Tasks currently blocked"
          />
          <SummaryCard
            onClick={() => setPreviewList({ title: 'Waiting Tasks', items: waitingTasks })}
            icon={<HourglassIcon />}
            iconBg="rgba(146,64,14,0.10)"
            count={waitingCount}
            countColor="#92400E"
            label="Waiting Tasks"
            sublabel="Tasks waiting on someone"
          />
        </div>

        {/* ── Two-column: Unacknowledged | Escalations ── */}
        <div className={isAdmin ? 'boe-two-col-section' : undefined} style={{ marginBottom: '24px' }}>
          {/* Left: Unacknowledged Tasks */}
          <div style={{
            background: '#fff',
            border: '1px solid #E5E7EB',
            borderRadius: '12px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            overflow: 'hidden',
          }}>
            <div
              onClick={() => unacknowledgedForMe.length > 0 && setPreviewList({ title: 'Unacknowledged Tasks', items: unacknowledgedForMe })}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: isMobile ? '12px 14px 10px' : '14px 20px 12px',
                borderBottom: '1px solid #F3F4F6',
                cursor: unacknowledgedForMe.length > 0 ? 'pointer' : 'default',
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => { if (unacknowledgedForMe.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
              onMouseLeave={e => { e.currentTarget.style.background = '' }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
                    Unacknowledged Tasks
                  </span>
                  <span style={{
                    background: '#FEF2F2', color: '#B91C1C',
                    fontWeight: 700, fontSize: '11px',
                    borderRadius: '999px', padding: '1px 8px',
                  }}>
                    {unacknowledgedForMe.length}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
                  Please acknowledge your assigned tasks to keep things moving.
                </div>
              </div>
              {unacknowledgedForMe.length > 0 && (
                <span style={{ fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>View all →</span>
              )}
            </div>
            {unacknowledgedForMe.length === 0 ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
                No unacknowledged tasks.
              </div>
            ) : (
              <UnacknowledgedTasksSection
                tasks={unacknowledgedForMe}
                userMap={mergedUserMap}
                now={now}
                onPreview={task => setSelectedTask(task)}
                compact
              />
            )}
          </div>

          {/* Right: Escalations (admin only) */}
          {isAdmin && (
            <div id="escalations" style={{
              background: '#fff',
              border: '1px solid #E5E7EB',
              borderRadius: '12px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              overflow: 'hidden',
            }}>
              <div
                onClick={() => adminEscalations.length > 0 && setEscalationPreview(true)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: isMobile ? '12px 14px 10px' : '14px 20px 12px',
                  borderBottom: '1px solid #F3F4F6',
                  cursor: adminEscalations.length > 0 ? 'pointer' : 'default',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => { if (adminEscalations.length > 0) e.currentTarget.style.background = '#FAFAFA' }}
                onMouseLeave={e => { e.currentTarget.style.background = '' }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
                      Escalations
                    </span>
                    <span style={{
                      background: '#EFF6FF', color: '#2563EB',
                      fontWeight: 700, fontSize: '11px',
                      borderRadius: '999px', padding: '1px 8px',
                    }}>
                      {adminEscalations.length}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
                    Tasks that need your immediate attention.
                  </div>
                </div>
                {adminEscalations.length > 0 && (
                  <span style={{ fontSize: '12px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
                    View all →
                  </span>
                )}
              </div>

              {adminEscalations.length === 0 ? (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
                  No escalations right now.
                </div>
              ) : (
                adminEscalations.slice(0, 8).map(({ task, owner, days, reason }, idx) => {
                  const daysColor = days >= 10 ? '#C0392B' : days >= 7 ? '#D4893A' : '#374151'
                  const isLast = idx === Math.min(adminEscalations.length, 8) - 1
                  return (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => e.key === 'Enter' && setSelectedTask(task)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '10px 14px',
                        borderBottom: isLast ? 'none' : '1px solid #F3F4F6',
                        cursor: 'pointer',
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#FAFAFA')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      {/* Avatar */}
                      <div style={{
                        width: '28px', height: '28px', borderRadius: '50%',
                        background: '#E5E7EB',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '10px', fontWeight: 700, color: '#374151',
                        flexShrink: 0,
                      }}>
                        {owner.slice(0, 2).toUpperCase()}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: '13px', fontWeight: 600, color: '#111827',
                          lineHeight: 1.3, marginBottom: '3px',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {task.title}
                        </div>
                        <div style={{
                          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
                          gap: '3px', fontSize: '11px', color: '#9CA3AF',
                        }}>
                          <ReasonBadge reason={reason} />
                          <span>•</span>
                          <span style={{ color: '#6B7280' }}>{owner.split(' ')[0]}</span>
                          <span>•</span>
                          <span style={{ fontWeight: 600, color: daysColor }}>{days}d overdue</span>
                        </div>
                      </div>

                      {/* Chevron */}
                      <ChevronRightIcon />
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* ── Bottom summary bar ── */}
        <BottomSummaryBar
          isMobile={isMobile}
          items={[
            {
              icon: <CheckCircleIcon color="#16A34A" />,
              iconBg: 'rgba(22,163,74,0.10)',
              count: myCompletedCount,
              label: 'Tasks Completed',
              subtext: 'This month',
              onClick: () => setPreviewList({ title: 'Completed Tasks', items: completedTasksData }),
            },
            {
              icon: <CalendarIcon color="#D97706" />,
              iconBg: 'rgba(217,119,6,0.10)',
              count: dueTodayTasks.length,
              label: 'Due Today',
              subtext: 'Tasks due today',
              onClick: () => setPreviewList({ title: 'Due Today', items: dueTodayTasks }),
            },
            {
              icon: <CalendarWeekIcon color="#7C3AED" />,
              iconBg: 'rgba(124,58,237,0.10)',
              count: dueThisWeekTasks.length,
              label: 'Due This Week',
              subtext: 'Tasks due this week',
              onClick: () => setPreviewList({ title: 'Due This Week', items: dueThisWeekTasks }),
            },
            {
              icon: <TimerIcon />,
              iconBg: 'rgba(37,99,235,0.10)',
              count: activeProjectsTasks.length,
              label: 'Active Projects',
              subtext: 'In progress',
              onClick: () => setPreviewList({ title: 'Active Tasks', items: activeProjectsTasks }),
            },
          ]}
        />

        {/* ── Tip bar ── */}
        <TipBar />
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
        const isLate = (now.getTime() - new Date(task.created_at).getTime()) > msPerDay
        const isDueOverdue = task.due_date && new Date(task.due_date) < now
        const isOverdueRow = isLate || isDueOverdue
        const assignedByName = userMap[task.created_by] ?? '—'
        const dueDateStr = task.due_date
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
              display: 'flex',
              alignItems: 'center',
              borderBottom: isLast ? 'none' : '1px solid #F3F4F6',
              cursor: 'pointer',
              transition: 'background 0.12s',
              minHeight: '52px',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#FAFAFA')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            {/* Left accent — fixed height, centered */}
            <div style={{
              width: '3px',
              height: '38px',
              flexShrink: 0,
              background: isOverdueRow ? '#EF4444' : 'transparent',
              borderRadius: '2px',
              marginLeft: '1px',
            }} />

            {/* Icon */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              paddingLeft: '10px', flexShrink: 0,
            }}>
              <div style={{
                width: '26px', height: '26px', borderRadius: '50%',
                background: isOverdueRow ? '#FEF2F2' : '#F3F4F6',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke={isOverdueRow ? '#EF4444' : '#9CA3AF'}
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
            </div>

            {/* Main content */}
            <div style={{ flex: 1, minWidth: 0, padding: '10px 10px 10px 10px' }}>
              <div style={{
                fontSize: '13px', fontWeight: 600, color: '#111827',
                lineHeight: 1.3, marginBottom: '3px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {task.title}
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', flexWrap: 'wrap',
                gap: '3px', fontSize: '11px', color: '#9CA3AF',
              }}>
                <span style={{ color: '#6B7280' }}>{assignedByName.split(' ')[0]}</span>
                {dueDateStr && (
                  <>
                    <span>•</span>
                    <span style={{ color: isDueOverdue ? '#B91C1C' : '#6B7280' }}>{dueDateStr}</span>
                  </>
                )}
                <span>•</span>
                <span style={{
                  fontSize: '10px', fontWeight: 600,
                  color: isOverdueRow ? '#B91C1C' : '#92600A',
                  background: isOverdueRow ? '#FEF2F2' : '#FFFBEB',
                  borderRadius: '4px', padding: '0 5px',
                }}>
                  {isOverdueRow ? 'Overdue' : 'Pending'}
                </span>
              </div>
            </div>

            {/* Chevron */}
            <div style={{ paddingRight: '12px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
              <ChevronRightIcon />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SummaryCard({
  href,
  onClick,
  icon,
  iconBg,
  count,
  countColor,
  label,
  sublabel,
}: {
  href?: string
  onClick?: () => void
  icon: React.ReactNode
  iconBg: string
  count: number
  countColor: string
  label: string
  sublabel: string
}) {
  const isInteractive = !!(href || onClick)
  const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #E5E7EB',
    borderRadius: '10px',
    padding: '12px 16px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    textDecoration: 'none',
    cursor: isInteractive ? 'pointer' : 'default',
    transition: 'box-shadow 0.15s, border-color 0.15s',
  }
  const handleMouseEnter = isInteractive
    ? (e: React.MouseEvent<HTMLElement>) => {
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.09)'
        e.currentTarget.style.borderColor = '#D1D5DB'
      }
    : undefined
  const handleMouseLeave = isInteractive
    ? (e: React.MouseEvent<HTMLElement>) => {
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'
        e.currentTarget.style.borderColor = '#E5E7EB'
      }
    : undefined

  const inner = (
    <>
      <div style={{
        width: '38px', height: '38px', borderRadius: '10px',
        background: iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
          {label}
        </div>
        <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '2px' }}>
          {sublabel}
        </div>
      </div>
      <div style={{
        fontSize: '26px', fontWeight: 800, color: countColor,
        lineHeight: 1, letterSpacing: '-0.02em', flexShrink: 0,
      }}>
        {count}
      </div>
    </>
  )

  if (href) {
    return (
      <Link href={href} style={cardStyle} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        {inner}
      </Link>
    )
  }
  return (
    <div style={cardStyle} onClick={onClick} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {inner}
    </div>
  )
}

function QuickSummaryCard({
  icon,
  title,
  viewAllHref,
  rows,
}: {
  icon: React.ReactNode
  title: string
  viewAllHref: string
  rows: { label: string; count: number; color: string; href: string }[]
}) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: '12px',
      padding: '20px 22px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#6B7280' }}>{icon}</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#374151', letterSpacing: '0.05em' }}>
            {title}
          </span>
        </div>
        <Link href={viewAllHref} style={{ fontSize: '12px', color: '#2563EB', fontWeight: 600, textDecoration: 'none' }}>
          View all
        </Link>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {rows.map(row => (
          <Link key={row.label} href={row.href} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px',
            background: '#F9FAFB',
            borderRadius: '8px',
            border: '1px solid #F3F4F6',
            textDecoration: 'none',
            cursor: 'pointer',
            transition: 'background 0.12s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#F3F4F6')}
          onMouseLeave={e => (e.currentTarget.style.background = '#F9FAFB')}
          >
            <span style={{ fontSize: '14px', color: '#374151', fontWeight: 500 }}>{row.label}</span>
            <span style={{
              fontSize: '13px', fontWeight: 700,
              color: row.color,
              background: row.color === '#2563EB' ? '#EFF6FF' : '#F0FDF4',
              borderRadius: '6px',
              padding: '2px 10px',
              minWidth: '28px',
              textAlign: 'center',
            }}>
              {row.count}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}

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
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.25)',
          zIndex: 40,
        }}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: isMobile ? '100%' : '420px',
        background: '#fff',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px',
          borderBottom: '1px solid #F3F4F6',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>{title}</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '2px' }}>
              {items.length} task{items.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#6B7280', fontSize: '20px', lineHeight: 1,
              padding: '4px 8px', borderRadius: '6px',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {items.length === 0 ? (
            <div style={{
              padding: '48px 24px', textAlign: 'center',
              color: '#9CA3AF', fontSize: '14px',
            }}>
              No tasks here.
            </div>
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
                  style={{
                    padding: '14px 24px',
                    borderBottom: '1px solid #F9FAFB',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <div style={{
                    fontSize: '14px', fontWeight: 500, color: '#111827',
                    marginBottom: '6px',
                    lineHeight: 1.4,
                  }}>
                    {task.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <StatusChip status={task.status} />
                    {task.priority && <PriorityChip priority={task.priority} />}
                    {task.due_date && (
                      <span style={{
                        fontSize: '11px', fontWeight: 500,
                        color: isOverdueTask ? '#C0392B' : '#6B7280',
                      }}>
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
    <span style={{
      fontSize: '11px', fontWeight: 600,
      color: s.color, background: s.bg,
      borderRadius: '5px', padding: '2px 8px',
      textTransform: 'capitalize',
    }}>
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
    <span style={{
      fontSize: '11px', fontWeight: 600,
      color: s.color, background: s.bg,
      borderRadius: '5px', padding: '2px 8px',
      textTransform: 'capitalize',
    }}>
      {priority}
    </span>
  )
}

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
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>Escalations</div>
            <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '2px' }}>
              {items.length} task{items.length !== 1 ? 's' : ''} requiring attention
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: '20px', lineHeight: 1, padding: '4px 8px', borderRadius: '6px' }}
            aria-label="Close"
          >×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {items.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
              No escalations right now.
            </div>
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
                <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', marginBottom: '6px', lineHeight: 1.4 }}>
                  {task.title}
                </div>
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
  const styles: Record<string, { color: string; bg: string; border: string }> = {
    Blocked: { color: '#991B1B', bg: '#FEF2F2', border: '#FECACA' },
    Waiting: { color: '#92400E', bg: '#FFFBEB', border: '#FDE68A' },
    Stale:   { color: '#BE185D', bg: '#FDF2F8', border: '#FBCFE8' },
  }
  const s = styles[reason] ?? { color: '#374151', bg: '#F3F4F6', border: '#E5E7EB' }
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600,
      color: s.color, background: s.bg,
      borderRadius: '4px', padding: '1px 6px',
      whiteSpace: 'nowrap',
    }}>
      {reason}
    </span>
  )
}

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D4893A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D4893A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function HourglassIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#92400E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  )
}

function FlagIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#C0392B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  )
}

function TimerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  )
}

function CheckCircleIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

function CalendarIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function CalendarWeekIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="14" x2="16" y2="14" />
    </svg>
  )
}

type BottomSummaryItem = {
  icon: React.ReactNode
  iconBg: string
  count: number
  label: string
  subtext: string
  onClick: () => void
}

function BottomSummaryBar({ items, isMobile }: { items: BottomSummaryItem[]; isMobile?: boolean }) {
  if (isMobile) {
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '10px',
        marginBottom: '12px',
      }}>
        {items.map(item => (
          <div
            key={item.label}
            onClick={item.onClick}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && item.onClick()}
            style={{
              background: '#fff',
              border: '1px solid #E5E7EB',
              borderRadius: '10px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '12px 14px',
              cursor: 'pointer',
            }}
          >
            <div style={{
              width: '30px', height: '30px', borderRadius: '50%',
              background: item.iconBg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {item.icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.label}
              </div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#111827', lineHeight: 1, letterSpacing: '-0.02em' }}>
                {item.count}
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: '12px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      display: 'flex',
      alignItems: 'stretch',
      overflow: 'hidden',
      marginBottom: '12px',
    }}>
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          {i > 0 && (
            <div style={{ width: '1px', background: '#F3F4F6', flexShrink: 0, alignSelf: 'stretch' }} />
          )}
          <div
            onClick={item.onClick}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && item.onClick()}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '12px 16px',
              cursor: 'pointer',
              transition: 'background 0.12s',
              minWidth: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
            onMouseLeave={e => (e.currentTarget.style.background = '')}
          >
            <div style={{
              width: '30px', height: '30px', borderRadius: '50%',
              background: item.iconBg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {item.icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.label}
              </div>
              <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '1px' }}>
                {item.subtext}
              </div>
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#111827', lineHeight: 1, letterSpacing: '-0.02em', flexShrink: 0 }}>
              {item.count}
            </div>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function TipBar() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      background: '#EFF6FF',
      border: '1px solid #BFDBFE',
      borderRadius: '8px',
      padding: '10px 16px',
      marginBottom: '8px',
    }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span style={{ fontSize: '13px', color: '#1E40AF' }}>
        <strong>Tip:</strong> Acknowledge tasks to update status, add notes, or mark as completed.
      </span>
    </div>
  )
}

function TaskListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

function AssignedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
