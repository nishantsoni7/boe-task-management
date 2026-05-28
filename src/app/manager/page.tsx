'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { isOverdue, isUpdatedToday, isOldEnoughToFlag, escalationLevel, initials, timeAgo } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { KpiGrid, KpiCard } from '@/components/ui/KpiCard'
import { TaskCard } from '@/components/ui/TaskCard'
import { Avatar, LoadingScreen } from '@/components/ui/atoms'

type FilterKey = 'all' | 'no_update' | 'overdue' | 'escalated' | 'stale' | 'blocked'

export default function ManagerPage() {
  const [tasks,          setTasks]          = useState<Task[]>([])
  const [members,        setMembers]        = useState<UserProfile[]>([])
  const [loading,        setLoading]        = useState(true)
  const [filter,         setFilter]         = useState<FilterKey>('all')
  const [selectedMember, setSelectedMember] = useState<string>('all')
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: p } = await supabase
        .from('users').select('*').eq('id', user.id).single()
      if (p) {
        if (p.role !== 'admin' && p.role !== 'manager') {
          router.push('/dashboard'); return
        }
        setProfile(p)
      }
      await loadData()
      setLoading(false)
    }
    init()
  }, [])

  const loadData = async () => {
    // Members and tasks are independent — fetch in parallel
    const [{ data: memberData }, { data: taskData }] = await Promise.all([
      supabase
        .from('users')
        .select('id, full_name, team, role, email, phone, is_active, created_at')
        .eq('is_active', true)
        .order('full_name'),
      supabase
        .from('tasks')
        .select(`
          id, title, note, status, priority, type, is_urgent, is_stale,
          stale_day_count, due_date, last_update_at, acknowledged_at, created_at,
          assigned_to, created_by, delegated_by, blocker_reason, team,
          assignee:assigned_to ( full_name, team )
        `)
        .neq('status', 'completed')
        .order('created_at', { ascending: false }),
    ])

    if (memberData) setMembers(memberData)

    if (taskData) {
      const enriched: Task[] = (taskData as any[]).map(t => ({
        ...t,
        assignee_name: t.assignee?.full_name ?? 'Unknown',
        assignee_team: t.assignee?.team      ?? '',
      }))
      setTasks(enriched)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ── Derived lists ─────────────────────────────────────────────────────────
  const noUpdateToday  = tasks.filter(t =>
    isOldEnoughToFlag(t.created_at) && !isUpdatedToday(t.last_update_at)
  )

  // Overdue: any task past its deadline — mutually exclusive with silentTasks
  const overdueTasks = tasks.filter(t => isOverdue(t.due_date))

  // Silent 72h+: escalated by silence but NOT overdue — separate operational signal
  const silentTasks = tasks.filter(t => {
    if (isOverdue(t.due_date)) return false
    const level = escalationLevel(t.last_update_at, t.status, t.due_date)
    return level === 'danger' || level === 'caution'
  })

  const staleTasks   = tasks.filter(t => t.is_stale)
  const blockedTasks = tasks.filter(t => t.status === 'blocked')
  const urgentTasks  = tasks.filter(t => t.is_urgent)

  const filteredTasks = tasks.filter(t => {
    if (selectedMember !== 'all' && t.assigned_to !== selectedMember) return false
    if (filter === 'no_update') return isOldEnoughToFlag(t.created_at) && !isUpdatedToday(t.last_update_at)
    if (filter === 'overdue')   return isOverdue(t.due_date)
    if (filter === 'escalated') return !isOverdue(t.due_date) && (
      escalationLevel(t.last_update_at, t.status, t.due_date) === 'danger' ||
      escalationLevel(t.last_update_at, t.status, t.due_date) === 'caution'
    )
    if (filter === 'stale')     return t.is_stale
    if (filter === 'blocked')   return t.status === 'blocked'
    return true
  })

  const noUpdateMembers = [...new Map(
    noUpdateToday.map(t => [t.assigned_to, {
      id:    t.assigned_to,
      name:  t.assignee_name ?? 'Unknown',
      team:  t.assignee_team ?? '',
      count: noUpdateToday.filter(x => x.assigned_to === t.assigned_to).length,
    }])
  ).values()]

  if (loading) return <LoadingScreen />

  const filterTabs: { key: FilterKey; label: string }[] = [
    { key: 'all',       label: `All (${tasks.length})`               },
    { key: 'no_update', label: `No update (${noUpdateToday.length})` },
    { key: 'overdue',   label: `Overdue (${overdueTasks.length})`    },
    { key: 'escalated', label: `Silent 72h+ (${silentTasks.length})` },
    { key: 'stale',     label: `Stale (${staleTasks.length})`        },
    { key: 'blocked',   label: `Blocked (${blockedTasks.length})`    },
  ]

  return (
    <DashboardLayout
      profile={profile}
      title="Manager View"
      subtitle={`Team overview · ${members.length} members · Live`}
      actions={
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', color: colors.tertiary,
          }}>
            <span className="boe-pulse-dot" /> Live
          </div>
          <button
            onClick={loadData}
            className="boe-btn boe-btn-ghost"
            style={{ fontSize: '11px' }}
          >
            Refresh
          </button>
          <button
            onClick={() => router.push('/tasks/create')}
            className="boe-btn boe-btn-primary"
          >
            + Assign Task
          </button>
        </>
      }
      onSignOut={handleLogout}
    >
      {/* KPI row */}
      <KpiGrid>
        <KpiCard label="Overdue"          value={overdueTasks.length}   meta="Past deadline"       accent="red"   />
        <KpiCard label="No Update Today"  value={noUpdateToday.length}  meta="Members not updated" accent="amber" />
        <KpiCard label="Active Tasks"     value={tasks.length}          meta="Across all members"  accent="blue"  />
        <KpiCard label="Blocked"          value={blockedTasks.length}   meta="Hard stop"                         />
      </KpiGrid>

      {/* ── Asymmetric 340px + 1fr operational layout ── */}
      <div className="boe-manager-layout">

        {/* LEFT COL — accountability signals */}
        <div className="boe-manager-left">

          {/* Overdue panel */}
          <div className="boe-panel-card">
            <div className="boe-panel-card-header">
              <span style={{ color: colors.red, fontSize: '14px' }}>⚠</span>
              <span className="boe-panel-card-title" style={{ color: colors.red }}>
                Overdue
              </span>
              <span className="boe-panel-card-count" style={{ color: colors.red }}>
                {overdueTasks.length} task{overdueTasks.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="boe-panel-card-body" style={{
              padding: '10px',
              display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              {overdueTasks.length === 0 ? (
                <div style={{ padding: '8px', fontSize: '12px', color: colors.muted, textAlign: 'center' }}>
                  No overdue tasks
                </div>
              ) : overdueTasks.slice(0, 5).map(t => {
                const daysOver = t.due_date
                  ? Math.floor((Date.now() - new Date(t.due_date).getTime()) / 86_400_000)
                  : null
                return (
                  <div
                    key={t.id}
                    className="boe-escalation-card"
                    onClick={() => router.push(`/tasks/${t.id}`)}
                  >
                    <span style={{ fontSize: '14px', flexShrink: 0, lineHeight: 1 }}>🔴</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="boe-escalation-title">{t.title}</div>
                      <div className="boe-escalation-sub">
                        {t.assignee_name} · {t.assignee_team}
                        {daysOver !== null ? ` · ${daysOver}d overdue` : ''}
                      </div>
                    </div>
                    {daysOver !== null && (
                      <span className="boe-escalation-time">{daysOver}d</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Silent 72h+ panel */}
          <div className="boe-panel-card">
            <div className="boe-panel-card-header">
              <span style={{ color: colors.red, fontSize: '14px' }}>▲</span>
              <span className="boe-panel-card-title" style={{ color: colors.red }}>
                Silent 72h+
              </span>
              <span className="boe-panel-card-count" style={{ color: colors.red }}>
                {silentTasks.length} task{silentTasks.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="boe-panel-card-body" style={{
              padding: '10px',
              display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              {silentTasks.length === 0 ? (
                <div style={{ padding: '8px', fontSize: '12px', color: colors.muted, textAlign: 'center' }}>
                  No silent escalations
                </div>
              ) : silentTasks.slice(0, 5).map(t => {
                const h = t.last_update_at
                  ? Math.floor((Date.now() - new Date(t.last_update_at).getTime()) / 3_600_000)
                  : null
                return (
                  <div
                    key={t.id}
                    className="boe-escalation-card"
                    onClick={() => router.push(`/tasks/${t.id}`)}
                  >
                    <span style={{ fontSize: '14px', flexShrink: 0, lineHeight: 1 }}>🔴</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="boe-escalation-title">{t.title}</div>
                      <div className="boe-escalation-sub">
                        {t.assignee_name} · {t.assignee_team}
                        {h !== null ? ` · ${h}h silent` : ''}
                      </div>
                    </div>
                    {h !== null && (
                      <span className="boe-escalation-time">{h}h</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Blocked panel */}
          <div className="boe-panel-card">
            <div className="boe-panel-card-header">
              <span style={{ color: colors.amber, fontSize: '13px' }}>■</span>
              <span className="boe-panel-card-title" style={{ color: colors.amber }}>
                Blocked
              </span>
              <span className="boe-panel-card-count" style={{ color: colors.amber }}>
                {blockedTasks.length} task{blockedTasks.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="boe-panel-card-body">
              {blockedTasks.length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: '12px', color: colors.muted }}>
                  No blocked tasks
                </div>
              ) : blockedTasks.slice(0, 5).map(t => (
                <div
                  key={t.id}
                  className="boe-list-row"
                  onClick={() => router.push(`/tasks/${t.id}`)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '12px', fontWeight: 500, color: colors.primary,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '1px' }}>
                      {t.assignee_name}
                      {t.blocker_reason && ` · ↳ ${t.blocker_reason}`}
                    </div>
                  </div>
                  <span className="boe-badge boe-badge-blocked">blocked</span>
                </div>
              ))}
            </div>
          </div>

          {/* No Update Today panel */}
          <div className="boe-panel-card">
            <div className="boe-panel-card-header">
              <span style={{ color: colors.amber, fontSize: '13px' }}>●</span>
              <span className="boe-panel-card-title" style={{ color: colors.amber }}>
                No Update Today
              </span>
              <span className="boe-panel-card-count">
                {noUpdateMembers.length} member{noUpdateMembers.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="boe-panel-card-body">
              {noUpdateMembers.length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: '12px', color: colors.muted }}>
                  Everyone has updated today
                </div>
              ) : noUpdateMembers.map(m => {
                const latestTask = noUpdateToday.find(t => t.assigned_to === m.id)
                const h = latestTask?.last_update_at
                  ? Math.floor((Date.now() - new Date(latestTask.last_update_at).getTime()) / 3_600_000)
                  : null
                return (
                  <div key={m.id} className="boe-no-update-row">
                    <Avatar name={m.name} size={24} />
                    <span className="boe-no-update-name">{m.name}</span>
                    <span className="boe-no-update-tasks">
                      {m.count} task{m.count !== 1 ? 's' : ''}
                    </span>
                    {h !== null && (
                      <span className="boe-no-update-time">{h}h</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Stale Progress panel */}
          <div className="boe-panel-card">
            <div className="boe-panel-card-header">
              <span style={{ color: '#7B62E0', fontSize: '13px' }}>◆</span>
              <span className="boe-panel-card-title" style={{ color: '#7B62E0' }}>
                Stale Progress
              </span>
              <span className="boe-panel-card-count">
                {staleTasks.length} task{staleTasks.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="boe-panel-card-body">
              {staleTasks.length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: '12px', color: colors.muted }}>
                  No stale tasks
                </div>
              ) : staleTasks.slice(0, 5).map(t => (
                <div
                  key={t.id}
                  className="boe-list-row"
                  onClick={() => router.push(`/tasks/${t.id}`)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '12px', fontWeight: 500, color: colors.primary,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '1px' }}>
                      {t.assignee_name} · &ldquo;{t.status}&rdquo; for {t.stale_day_count ?? 0}d
                    </div>
                  </div>
                  <span className="boe-stale-badge">
                    {t.stale_day_count ?? 0}d stale
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* RIGHT COL — live task feed */}
        <div className="boe-manager-right">

          {/* Urgent panel */}
          <div className="boe-panel-card">
            <div className="boe-panel-card-header">
              <span style={{ color: colors.amber, fontSize: '13px' }}>!</span>
              <span className="boe-panel-card-title" style={{ color: colors.amber }}>Urgent</span>
              <span className="boe-panel-card-count">{urgentTasks.length}</span>
            </div>
            <div className="boe-panel-card-body">
              {urgentTasks.length === 0 ? (
                <div style={{ padding: '10px 14px', fontSize: '12px', color: colors.muted }}>
                  None
                </div>
              ) : urgentTasks.slice(0, 4).map(t => (
                <div
                  key={t.id}
                  className="boe-list-row"
                  onClick={() => router.push(`/tasks/${t.id}`)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '12px', fontWeight: 500, color: colors.primary,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '1px' }}>
                      {t.assignee_name}
                      {t.due_date && ` · ${new Date(t.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live feed panel — filter tabs + task list */}
          <div className="boe-panel-card" style={{ flex: 1 }}>
            <div className="boe-panel-card-header">
              <span className="boe-pulse-dot" />
              <span className="boe-panel-card-title">Live Task Feed</span>
              <span className="boe-panel-card-count">{filteredTasks.length} tasks</span>
            </div>

            {/* Filter tabs */}
            <div style={{
              display: 'flex', gap: '5px', overflowX: 'auto',
              padding: '8px 10px',
              borderBottom: '1px solid rgba(255,255,255,0.045)',
            }}>
              {filterTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setFilter(tab.key)}
                  className={`boe-filter-tab${filter === tab.key ? ' boe-filter-tab-active' : ''}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Member filter */}
            <div style={{
              padding: '8px 10px',
              borderBottom: '1px solid rgba(255,255,255,0.045)',
            }}>
              <select
                value={selectedMember}
                onChange={e => setSelectedMember(e.target.value)}
                className="boe-input"
                style={{ fontSize: '12px', padding: '6px 10px' }}
              >
                <option value="all">All team members</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.full_name} — {m.team}
                  </option>
                ))}
              </select>
            </div>

            {/* Task list */}
            <div className="boe-panel-card-body boe-panel-scroll">
              {filteredTasks.length === 0 ? (
                <div style={{
                  padding: '24px', textAlign: 'center',
                  fontSize: '13px', color: colors.muted,
                }}>
                  No tasks in this view
                </div>
              ) : (
                <div style={{
                  display: 'flex', flexDirection: 'column',
                  gap: '6px', padding: '8px',
                }}>
                  {filteredTasks.map(t => (
                    <TaskCard key={t.id} task={t} showAssignee showEscalation />
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

    </DashboardLayout>
  )
}