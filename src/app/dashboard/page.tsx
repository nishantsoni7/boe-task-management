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
  const [previewList,        setPreviewList]        = useState<{ type: 'action' | 'blocked'; items: Task[] } | null>(null)
  const [escalationPreview,  setEscalationPreview]  = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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

      // Counts for bottom summary cards
      const [{ count: compCount }, { data: abmTasks }] = await Promise.all([
        supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assigned_to', session.user.id)
          .eq('status', 'completed'),
        supabase
          .from('tasks')
          .select('id, status')
          .eq('created_by', session.user.id)
          .neq('assigned_to', session.user.id),
      ])
      if (compCount != null) setMyCompletedCount(compCount)
      if (abmTasks) {
        const abm = abmTasks as { id: string; status: string }[]
        setAssignedByMeInProg(abm.filter(t => t.status !== 'completed').length)
        setAssignedByMeComp(abm.filter(t => t.status === 'completed').length)
      }

      if (profileData?.role === 'admin' || profileData?.role === 'manager') {
        const [{ data: tUsers }, { data: eTasks }, { count: bCount }] = await Promise.all([
          supabase.from('users').select('id, full_name').eq('is_active', true),
          profileData?.role === 'admin'
            ? supabase
                .from('tasks')
                .select(TASK_COLUMNS)
                .not('status', 'eq', 'completed')
            : Promise.resolve({ data: null }),
          supabase
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'blocked'),
        ])
        if (tUsers) setTeamUsers(tUsers as { id: string; full_name: string }[])
        if (eTasks) setEscalationTasks(eTasks as unknown as Task[])
        if (bCount != null) setBlockedCount(bCount)
      } else {
        // For non-admin, count their own blocked tasks
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

  const userMap = useMemo(
    () => Object.fromEntries(teamUsers.map(u => [u.id, u.full_name])),
    [teamUsers]
  )

  const now = new Date()
  const msPerDay = 24 * 60 * 60 * 1000

  const unacknowledged  = tasks.filter(t => !t.acknowledged_at)
  const allOverdueTasks = tasks.filter(t => isOverdue(t.due_date) && t.acknowledged_at)
  const actionRequired  = [...allOverdueTasks, ...unacknowledged]

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
      >
        {/* ── Top summary cards ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: isAdmin ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)',
          gap: '16px',
          marginBottom: '24px',
        }}>
          <SummaryCard
            onClick={() => setPreviewList({ type: 'action', items: actionRequired })}
            icon={<AlertIcon />}
            iconBg="rgba(234,136,33,0.12)"
            count={actionRequired.length}
            countColor="#D4893A"
            label="Action Required"
            sublabel="Tasks need your attention"
          />
          <SummaryCard
            onClick={() => setPreviewList({
              type: 'blocked',
              items: isAdmin
                ? escalationTasks.filter(t => t.status === 'blocked')
                : tasks.filter(t => t.status === 'blocked'),
            })}
            icon={<FlagIcon />}
            iconBg="rgba(220,53,53,0.10)"
            count={blockedCount}
            countColor="#C0392B"
            label="Blocked"
            sublabel="Tasks are blocked"
          />
          {isAdmin && (
            <SummaryCard
              onClick={() => setEscalationPreview(true)}
              icon={<TimerIcon />}
              iconBg="rgba(59,130,246,0.10)"
              count={adminEscalations.length}
              countColor="#2563EB"
              label="Escalations"
              sublabel="Require management attention"
            />
          )}
        </div>

        {/* ── Admin escalations table ── */}
        {isAdmin && (
          <div id="escalations" style={{
            background: '#fff',
            border: '1px solid #E5E7EB',
            borderRadius: '12px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            marginBottom: '24px',
            overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '18px 24px 14px',
              borderBottom: '1px solid #F3F4F6',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontWeight: 700, fontSize: '15px', color: '#111827', letterSpacing: '-0.01em' }}>
                    ESCALATIONS
                  </span>
                  <span style={{
                    background: '#EFF6FF', color: '#2563EB',
                    fontWeight: 700, fontSize: '13px',
                    borderRadius: '999px', padding: '1px 10px',
                  }}>
                    {adminEscalations.length}
                  </span>
                </div>
                <div style={{ fontSize: '13px', color: '#6B7280', marginTop: '3px' }}>
                  Tasks that need your immediate attention
                </div>
              </div>
              {adminEscalations.length > 5 && (
                <span style={{ fontSize: '13px', color: '#2563EB', fontWeight: 600, cursor: 'pointer' }}>
                  View all escalations →
                </span>
              )}
            </div>

            {adminEscalations.length === 0 ? (
              <div style={{ padding: '32px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: '14px' }}>
                No escalations right now
              </div>
            ) : (
              <>
                {/* Table header */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 180px 80px 100px',
                  padding: '10px 24px',
                  fontSize: '12px', fontWeight: 600,
                  color: '#9CA3AF', letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid #F3F4F6',
                }}>
                  <span>Task</span>
                  <span>Owner</span>
                  <span>Days</span>
                  <span>Reason</span>
                </div>

                {/* Table rows */}
                {adminEscalations.slice(0, 10).map(({ task, owner, days, reason }) => {
                  const daysColor = days >= 10 ? '#C0392B' : days >= 7 ? '#D4893A' : '#374151'
                  return (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => e.key === 'Enter' && setSelectedTask(task)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 180px 80px 100px',
                        alignItems: 'center',
                        padding: '14px 24px',
                        borderBottom: '1px solid #F9FAFB',
                        cursor: 'pointer',
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F9FAFB')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <div style={{
                        fontSize: '14px', fontWeight: 500, color: '#111827',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        paddingRight: '16px',
                      }}>
                        {task.title}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{
                          width: '28px', height: '28px', borderRadius: '50%',
                          background: '#E5E7EB',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '11px', fontWeight: 700, color: '#374151',
                          flexShrink: 0,
                        }}>
                          {owner.slice(0, 2).toUpperCase()}
                        </div>
                        <span style={{ fontSize: '13px', color: '#374151', fontWeight: 500 }}>
                          {owner}
                        </span>
                      </div>
                      <div style={{
                        fontSize: '14px', fontWeight: 700, color: daysColor,
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {days}d
                      </div>
                      <div>
                        <ReasonBadge reason={reason} />
                      </div>
                    </div>
                  )
                })}

                <div style={{ padding: '12px 24px', fontSize: '13px', color: '#9CA3AF', borderTop: '1px solid #F3F4F6' }}>
                  Showing {Math.min(adminEscalations.length, 10)} of {adminEscalations.length} escalation{adminEscalations.length !== 1 ? 's' : ''}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Bottom summary row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <QuickSummaryCard
            icon={<TaskListIcon />}
            title="MY TASKS"
            viewAllHref="/tasks/my"
            rows={[
              { label: 'In Progress', count: tasks.filter(t => t.status !== 'completed').length, color: '#2563EB', href: '/tasks/my' },
              { label: 'Completed',   count: myCompletedCount,                                    color: '#16A34A', href: '/tasks/my/completed' },
            ]}
          />
          <QuickSummaryCard
            icon={<AssignedIcon />}
            title="ASSIGNED BY ME"
            viewAllHref="/tasks/assigned-by-me"
            rows={[
              { label: 'In Progress', count: assignedByMeInProg, color: '#2563EB', href: '/tasks/assigned-by-me' },
              { label: 'Completed',   count: assignedByMeComp,   color: '#16A34A', href: '/tasks/assigned-by-me/completed' },
            ]}
          />
        </div>
      </DashboardLayout>

      {previewList && !selectedTask && (
        <TaskListDrawer
          title={previewList.type === 'action' ? 'Action Required' : 'Blocked Tasks'}
          items={previewList.items}
          onClose={() => setPreviewList(null)}
          onSelectTask={task => { setPreviewList(null); setSelectedTask(task) }}
        />
      )}

      {escalationPreview && !selectedTask && (
        <EscalationListDrawer
          items={adminEscalations}
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
        />
      )}
    </>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
    borderRadius: '12px',
    padding: '20px 22px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    textDecoration: 'none',
    cursor: isInteractive ? 'pointer' : 'default',
    transition: 'box-shadow 0.15s, border-color 0.15s',
  }
  const handleMouseEnter = isInteractive
    ? (e: React.MouseEvent<HTMLElement>) => {
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.10)'
        e.currentTarget.style.borderColor = '#D1D5DB'
      }
    : undefined
  const handleMouseLeave = isInteractive
    ? (e: React.MouseEvent<HTMLElement>) => {
        e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)'
        e.currentTarget.style.borderColor = '#E5E7EB'
      }
    : undefined

  const inner = (
    <>
      <div style={{
        width: '48px', height: '48px', borderRadius: '12px',
        background: iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '28px', fontWeight: 800, color: countColor, lineHeight: 1, letterSpacing: '-0.02em' }}>
          {count}
        </div>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827', marginTop: '3px' }}>
          {label}
        </div>
        <div style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '2px' }}>
          {sublabel}
        </div>
      </div>
      {isInteractive && <div style={{ color: '#D1D5DB', fontSize: '18px' }}>›</div>}
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
  onClose,
  onSelectTask,
}: {
  title: string
  items: Task[]
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
        width: '420px',
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
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
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
  onClose,
  onSelectTask,
}: {
  items: { task: Task; owner: string; days: number; reason: string }[]
  onClose: () => void
  onSelectTask: (task: Task) => void
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: '420px',
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
                <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', marginBottom: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
      fontSize: '12px', fontWeight: 600,
      color: s.color, background: s.bg,
      border: `1px solid ${s.border}`,
      borderRadius: '6px', padding: '3px 10px',
      whiteSpace: 'nowrap',
    }}>
      {reason}
    </span>
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
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
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
