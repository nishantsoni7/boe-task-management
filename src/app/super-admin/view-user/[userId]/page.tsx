'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue, getAssignedByDisplay } from '@/lib/ui'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { ArrowLeft } from 'lucide-react'

const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

export default function ViewUserPage() {
  const params   = useParams()
  const userId   = params.userId as string
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [adminProfile,        setAdminProfile]        = useState<UserProfile | null>(null)
  const [targetProfile,       setTargetProfile]       = useState<UserProfile | null>(null)
  const [tasks,               setTasks]               = useState<Task[]>([])
  const [loading,             setLoading]             = useState(true)
  const [selectedTask,        setSelectedTask]        = useState<Task | null>(null)
  const [teamUsers,           setTeamUsers]           = useState<{ id: string; full_name: string }[]>([])
  const [escalationTasks,     setEscalationTasks]     = useState<Task[]>([])
  const [myCompletedCount,    setMyCompletedCount]    = useState(0)
  const [assignedByMeInProg,  setAssignedByMeInProg]  = useState(0)
  const [blockedCount,        setBlockedCount]        = useState(0)
  const [previewList,         setPreviewList]         = useState<{ title: string; items: Task[] } | null>(null)
  const [assignerNames,       setAssignerNames]       = useState<Record<string, string>>({})
  const [completedTasksData,  setCompletedTasksData]  = useState<Task[]>([])
  const [assignedByMeTasksAll, setAssignedByMeTasksAll] = useState<Task[]>([])
  const [isMobile,            setIsMobile]            = useState(false)

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

      // Verify caller is admin
      const { data: callerProfile } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (callerProfile?.role !== 'admin') { router.push('/dashboard'); return }
      setAdminProfile(callerProfile as UserProfile)

      // Fetch target user's profile
      const { data: tProfile } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', userId)
        .single()

      if (!tProfile) { router.push('/super-admin'); return }
      setTargetProfile(tProfile as UserProfile)

      // Fetch tasks as if we were that user
      const [{ data: taskData }] = await Promise.all([
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', userId)
          .not('status', 'eq', 'completed')
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false }),
      ])

      if (taskData) setTasks(taskData as unknown as Task[])

      // Assigner names for unacknowledged cards
      if (taskData) {
        const creatorIds = [...new Set(
          (taskData as { created_by: string; assigned_to: string }[])
            .filter(t => t.created_by !== userId)
            .map(t => t.created_by)
        )]
        if (creatorIds.length > 0) {
          const { data: creators } = await supabase
            .from('users')
            .select('id, full_name')
            .in('id', creatorIds)
          if (creators) {
            const map: Record<string, string> = {}
            for (const u of creators as { id: string; full_name: string }[]) map[u.id] = u.full_name
            setAssignerNames(map)
          }
        }
      }

      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)
      const monthStartISO = monthStart.toISOString()

      const [{ data: completedData }, { data: abmTasks }, { count: bCount }] = await Promise.all([
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('assigned_to', userId)
          .eq('status', 'completed')
          .gte('last_update_at', monthStartISO)
          .order('last_update_at', { ascending: false }),
        supabase
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('created_by', userId)
          .neq('assigned_to', userId)
          .not('status', 'eq', 'completed')
          .neq('status', 'cancelled'),
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', userId)
          .eq('status', 'blocked'),
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
      }
      if (bCount != null) setBlockedCount(bCount)

      // Team users for userMap
      const { data: tUsers } = await supabase.from('users').select('id, full_name').eq('is_active', true)
      if (tUsers) setTeamUsers(tUsers as { id: string; full_name: string }[])

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const userMap = useMemo(
    () => Object.fromEntries(teamUsers.map(u => [u.id, u.full_name])),
    [teamUsers]
  )
  const mergedUserMap = { ...assignerNames, ...userMap }

  const now       = new Date()
  const msPerDay  = 24 * 60 * 60 * 1000

  const unacknowledgedForMe = tasks.filter(t => !t.acknowledged_at && t.created_by !== userId)
  const allOverdueTasks     = tasks.filter(t => isOverdue(t.due_date, t.status) && t.acknowledged_at)
  const totalOverdue        = tasks.filter(t => isOverdue(t.due_date, t.status)).length
  const waitingTasks        = tasks.filter(t => t.status === 'waiting')

  const todayStart    = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const tomorrowStart = new Date(todayStart.getTime() + msPerDay)
  const weekEnd       = new Date(todayStart.getTime() + 7 * msPerDay)

  const dueTodayTasks    = tasks.filter(t => { if (!t.due_date) return false; const d = new Date(t.due_date); d.setHours(0,0,0,0); return d.getTime() === todayStart.getTime() })
  const dueThisWeekTasks = tasks.filter(t => { if (!t.due_date) return false; const d = new Date(t.due_date); return d >= tomorrowStart && d < weekEnd })
  const activeProjectsTasks = tasks.filter(t => ['working', 'started', 'pending'].includes(t.status))

  useEffect(() => {
    if (!selectedTask) return
    const inTasks = tasks.find(t => t.id === selectedTask.id)
    if (inTasks) { if (inTasks !== selectedTask) setSelectedTask(inTasks); return }
    setSelectedTask(null)
  }, [tasks, selectedTask])

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={adminProfile}
        title={`Dashboard: ${targetProfile?.full_name ?? ''}`}
        subtitle="Admin View Mode — read only"
        onSignOut={handleLogout}
      >
        {/* Admin view banner */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px',
          padding: '10px 16px',
          background: '#FFF7ED',
          border: '1px solid #FED7AA',
          borderRadius: '8px',
          marginBottom: '20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#92400E' }}>
              Admin View Mode: Viewing dashboard as <strong>{targetProfile?.full_name}</strong>
            </span>
            <span style={{ fontSize: '11px', color: '#B45309', background: '#FEF3C7', borderRadius: '4px', padding: '1px 7px', fontWeight: 600 }}>
              Read Only
            </span>
          </div>
          <button
            onClick={() => router.push('/super-admin')}
            className="boe-btn boe-btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px' }}
          >
            <ArrowLeft size={13} />
            Back to Super Admin
          </button>
        </div>

        {/* Summary cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)',
          gap: '16px',
          marginBottom: '24px',
        }}>
          <ViewSummaryCard
            onClick={() => setPreviewList({ title: 'Overdue Tasks', items: tasks.filter(t => isOverdue(t.due_date, t.status)) })}
            icon={<AlertIcon />} iconBg="rgba(220,53,53,0.10)"
            count={totalOverdue} countColor="#C0392B"
            label="Total Overdue Tasks" sublabel="Tasks past their due date"
          />
          <ViewSummaryCard
            onClick={() => setPreviewList({ title: 'Unacknowledged Tasks', items: unacknowledgedForMe })}
            icon={<BellIcon />} iconBg="rgba(234,136,33,0.12)"
            count={unacknowledgedForMe.length} countColor="#D4893A"
            label="Total Unacknowledged Tasks" sublabel="Waiting for acknowledgement"
          />
          <ViewSummaryCard
            onClick={() => setPreviewList({ title: 'Blocked Tasks', items: tasks.filter(t => t.status === 'blocked') })}
            icon={<FlagIcon />} iconBg="rgba(59,130,246,0.10)"
            count={blockedCount} countColor="#2563EB"
            label="Blocked Tasks" sublabel="Tasks currently blocked"
          />
          <ViewSummaryCard
            onClick={() => setPreviewList({ title: 'Waiting Tasks', items: waitingTasks })}
            icon={<HourglassIcon />} iconBg="rgba(146,64,14,0.10)"
            count={waitingTasks.length} countColor="#92400E"
            label="Waiting Tasks" sublabel="Tasks waiting on someone"
          />
        </div>

        {/* Unacknowledged tasks section */}
        <div style={{
          background: '#fff', border: '1px solid #E5E7EB',
          borderRadius: '12px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          overflow: 'hidden', marginBottom: '24px',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: isMobile ? '12px 14px 10px' : '14px 20px 12px',
            borderBottom: '1px solid #F3F4F6',
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 700, fontSize: '14px', color: '#111827', letterSpacing: '-0.01em' }}>
                  Unacknowledged Tasks
                </span>
                <span style={{ background: '#FEF2F2', color: '#B91C1C', fontWeight: 700, fontSize: '11px', borderRadius: '999px', padding: '1px 8px' }}>
                  {unacknowledgedForMe.length}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
                Tasks assigned to this member pending acknowledgement.
              </div>
            </div>
          </div>
          {unacknowledgedForMe.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
              No unacknowledged tasks.
            </div>
          ) : (
            unacknowledgedForMe.slice(0, 5).map((task, idx) => {
              const isLate = (now.getTime() - new Date(task.created_at).getTime()) > msPerDay
              const isDueOverdue = task.due_date && new Date(task.due_date) < now
              const isOverdueRow = isLate || isDueOverdue
              const assignedByName = getAssignedByDisplay(task, mergedUserMap)
              const isLast = idx === Math.min(unacknowledgedForMe.length, 5) - 1
              return (
                <div
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && setSelectedTask(task)}
                  style={{ display: 'flex', alignItems: 'center', borderBottom: isLast ? 'none' : '1px solid #F3F4F6', cursor: 'pointer', minHeight: '52px', transition: 'background 0.12s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#FAFAFA')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <div style={{ width: '3px', height: '38px', flexShrink: 0, background: isOverdueRow ? '#EF4444' : 'transparent', borderRadius: '2px', marginLeft: '1px' }} />
                  <div style={{ flex: 1, minWidth: 0, padding: '10px 14px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', lineHeight: 1.3, marginBottom: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {task.title}
                    </div>
                    <div style={{ fontSize: '11px', color: '#9CA3AF' }}>
                      From {assignedByName.split(' ')[0]}
                      {task.due_date && <span style={{ color: isDueOverdue ? '#B91C1C' : '#6B7280' }}> · Due {new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '12px', flexShrink: 0 }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              )
            })
          )}
        </div>

        {/* Bottom summary bar */}
        <div style={{
          background: '#fff', border: '1px solid #E5E7EB', borderRadius: '12px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'stretch',
          overflow: 'hidden', marginBottom: '12px',
        }}>
          {[
            { label: 'Tasks Completed', subtext: 'This month', count: myCompletedCount, items: completedTasksData },
            { label: 'Due Today', subtext: 'Tasks due today', count: dueTodayTasks.length, items: dueTodayTasks },
            { label: 'Due This Week', subtext: 'Tasks due this week', count: dueThisWeekTasks.length, items: dueThisWeekTasks },
            { label: 'Active Projects', subtext: 'In progress', count: activeProjectsTasks.length, items: activeProjectsTasks },
          ].map((item, i) => (
            <React.Fragment key={item.label}>
              {i > 0 && <div style={{ width: '1px', background: '#F3F4F6', flexShrink: 0 }} />}
              <div
                onClick={() => setPreviewList({ title: item.label, items: item.items })}
                role="button" tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && setPreviewList({ title: item.label, items: item.items })}
                style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', cursor: 'pointer', transition: 'background 0.12s', minWidth: 0 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</div>
                  <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '1px' }}>{item.subtext}</div>
                </div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#111827', lineHeight: 1, letterSpacing: '-0.02em', flexShrink: 0 }}>{item.count}</div>
              </div>
            </React.Fragment>
          ))}
        </div>
      </DashboardLayout>

      {/* Task list preview drawer */}
      {previewList && !selectedTask && (
        <div>
          <div onClick={() => setPreviewList(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: isMobile ? '100%' : '420px',
            background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
            zIndex: 50, display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '15px', color: '#111827' }}>{previewList.title}</div>
                <div style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '2px' }}>{previewList.items.length} task{previewList.items.length !== 1 ? 's' : ''}</div>
              </div>
              <button onClick={() => setPreviewList(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: '20px', padding: '4px 8px' }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {previewList.items.length === 0 ? (
                <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>No tasks here.</div>
              ) : previewList.items.map(task => {
                const isOverdueTask = task.due_date && new Date(task.due_date) < new Date()
                return (
                  <div
                    key={task.id}
                    onClick={() => { setPreviewList(null); setSelectedTask(task) }}
                    role="button" tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && (setPreviewList(null), setSelectedTask(task))}
                    style={{ padding: '14px 24px', borderBottom: '1px solid #F9FAFB', cursor: 'pointer', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', marginBottom: '6px', lineHeight: 1.4 }}>{task.title}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#374151', background: '#F3F4F6', borderRadius: '5px', padding: '2px 8px', textTransform: 'capitalize' }}>{task.status}</span>
                      {task.due_date && (
                        <span style={{ fontSize: '11px', fontWeight: 500, color: isOverdueTask ? '#C0392B' : '#6B7280' }}>
                          Due {new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Task detail panel — read-only: onAcknowledge not passed */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          currentUserId={userId}
        />
      )}
    </>
  )
}

// ── Icon helpers ──────────────────────────────────────────────────────────────

function ViewSummaryCard({ onClick, icon, iconBg, count, countColor, label, sublabel }: {
  onClick: () => void; icon: React.ReactNode; iconBg: string
  count: number; countColor: string; label: string; sublabel: string
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px',
        padding: '12px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        display: 'flex', alignItems: 'center', gap: '12px',
        cursor: 'pointer', transition: 'box-shadow 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.09)'; e.currentTarget.style.borderColor = '#D1D5DB' }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'; e.currentTarget.style.borderColor = '#E5E7EB' }}
    >
      <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: '11px', color: '#9CA3AF', marginTop: '2px' }}>{sublabel}</div>
      </div>
      <div style={{ fontSize: '26px', fontWeight: 800, color: countColor, lineHeight: 1, letterSpacing: '-0.02em', flexShrink: 0 }}>{count}</div>
    </div>
  )
}

function AlertIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D4893A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
}
function BellIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D4893A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
}
function FlagIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#C0392B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>
}
function HourglassIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#92400E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" /></svg>
}
