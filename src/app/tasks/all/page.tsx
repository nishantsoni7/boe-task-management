'use client'

import { useEffect, useState, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { statusBadgeClass } from '@/lib/ui'

const TASK_COLUMNS = [
  'id', 'title', 'status', 'priority', 'is_urgent',
  'due_date', 'assigned_to', 'created_by',
].join(', ')

const TODAY_STR = new Date().toISOString().slice(0, 10)

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

const PRIORITY_PILL: Record<string, { label: string; fg: string; bg: string }> = {
  high:   { label: 'High',   fg: '#C0392B', bg: 'rgba(192,57,43,0.09)'  },
  medium: { label: 'Medium', fg: '#D4831A', bg: 'rgba(212,131,26,0.09)' },
  low:    { label: 'Low',    fg: colors.muted, bg: 'rgba(0,0,0,0.04)'   },
}

function col(label: string, width?: number, align: 'left' | 'right' | 'center' = 'left') {
  return (
    <div style={{
      fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: colors.muted,
      width, flex: width ? undefined : 1,
      textAlign: align, padding: '0 8px', whiteSpace: 'nowrap',
    }}>
      {label}
    </div>
  )
}

function ViewAllTasksContent() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [tasks,    setTasks]    = useState<Task[]>([])
  const [userMap,  setUserMap]  = useState<Record<string, string>>({})
  const [loading,  setLoading]  = useState(true)
  const router      = useRouter()
  const searchParams = useSearchParams()
  const supabase    = useMemo(() => createClient(), [])

  const filterAssignedTo = searchParams.get('assignedTo') ?? null
  const filterStatuses   = useMemo(() => {
    const s = searchParams.get('status')
    return s ? s.split(',').map(v => v.trim()).filter(Boolean) : null
  }, [searchParams])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('users').select('*').eq('id', session.user.id).single()
      if (!profileData) { router.push('/login'); return }

      const p = profileData as UserProfile
      if (p.role !== 'admin' && p.role !== 'manager') {
        router.push('/tasks/my')
        return
      }
      setProfile(p)

      const [{ data: taskData }, { data: userData }] = await Promise.all([
        supabase.from('tasks').select(TASK_COLUMNS).order('due_date', { ascending: true, nullsFirst: false }),
        supabase.from('users').select('id, full_name'),
      ])

      if (taskData) {
        const sorted = (taskData as unknown as Task[])
          .sort((a, b) => (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0))
        setTasks(sorted)
      }
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

  const filteredTasks = useMemo(() => {
    let result = tasks
    if (filterAssignedTo) result = result.filter(t => t.assigned_to === filterAssignedTo)
    if (filterStatuses)   result = result.filter(t => filterStatuses.includes(t.status))
    return result
  }, [tasks, filterAssignedTo, filterStatuses])

  const filterContext = useMemo(() => {
    if (!filterAssignedTo && !filterStatuses) return null
    const name = filterAssignedTo ? (userMap[filterAssignedTo] ?? 'Member') : null
    const statusLabel = filterStatuses ? filterStatuses.join(', ') : null
    const parts = [name ? `Assigned to: ${name}` : null, statusLabel ? `Status: ${statusLabel}` : null].filter(Boolean)
    return parts.join(' · ')
  }, [filterAssignedTo, filterStatuses, userMap])

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="View All Tasks"
      subtitle={filterContext ?? `${tasks.length} total task${tasks.length !== 1 ? 's' : ''}`}
      onSignOut={handleLogout}
      actions={filterAssignedTo || filterStatuses ? (
        <a href="/performance/team" style={{
          fontSize: 12, fontWeight: 600, color: '#8C94A6', textDecoration: 'none',
          border: '1px solid #EEF0F4', padding: '6px 14px', borderRadius: 7,
        }}>← Team Performance</a>
      ) : undefined}
    >
      {filterContext && (
        <div style={{
          background: '#5585E808', border: '1px solid #5585E820', borderRadius: 8,
          padding: '9px 14px', marginBottom: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <span style={{ fontSize: 12, color: '#5585E8', fontWeight: 500 }}>
            Filtered — {filterContext}
          </span>
          <a href="/tasks/all" style={{ fontSize: 11, color: '#8C94A6', textDecoration: 'none', fontWeight: 500 }}>
            Clear filter ✕
          </a>
        </div>
      )}
      <div style={{
        background: colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        {/* Table header */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '7px 12px', borderBottom: `1px solid ${colors.border}`,
          background: colors.raised,
        }}>
          {col('Task Name')}
          {col('Assigned To', 130)}
          {col('Created By', 130)}
          {col('Status', 90, 'center')}
          {col('Priority', 72, 'center')}
          {col('Due Date', 88, 'right')}
        </div>

        {filteredTasks.length === 0 ? (
          <div style={{ padding: '52px 24px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No tasks found.
          </div>
        ) : (
          filteredTasks.map(task => {
            const overdue = !!task.due_date && task.due_date < TODAY_STR && task.status !== 'completed'
            const pill    = PRIORITY_PILL[task.priority] ?? PRIORITY_PILL.low
            return (
              <div
                key={task.id}
                role="button"
                onClick={() => router.push(`/tasks/${task.id}`)}
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '10px 12px',
                  borderBottom: `1px solid ${colors.border}`,
                  cursor: 'pointer', minHeight: '44px',
                  borderLeft: overdue ? `3px solid ${colors.red}44` : '3px solid transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = colors.raised}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = ''}
              >
                {/* Task name */}
                <div style={{ flex: 1, minWidth: 0, padding: '0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {task.is_urgent && (
                    <span style={{ fontSize: '11px', color: '#C49A28', flexShrink: 0 }}>⭐</span>
                  )}
                  <span style={{
                    fontSize: '13px', fontWeight: 500,
                    color: overdue ? colors.red : colors.primary,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    display: 'block',
                  }}>
                    {task.title}
                  </span>
                </div>
                {/* Assigned to */}
                <div style={{ width: '130px', padding: '0 8px' }}>
                  <span style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
                    {userMap[task.assigned_to] ?? '—'}
                  </span>
                </div>
                {/* Created by */}
                <div style={{ width: '130px', padding: '0 8px' }}>
                  <span style={{ fontSize: '12px', color: colors.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
                    {userMap[task.created_by] ?? '—'}
                  </span>
                </div>
                {/* Status */}
                <div style={{ width: '90px', display: 'flex', justifyContent: 'center', padding: '0 4px' }}>
                  <span className={statusBadgeClass(task.status)} />
                </div>
                {/* Priority */}
                <div style={{ width: '72px', display: 'flex', justifyContent: 'center', padding: '0 4px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: pill.fg, background: pill.bg, padding: '2px 8px', borderRadius: '5px', whiteSpace: 'nowrap' }}>
                    {pill.label}
                  </span>
                </div>
                {/* Due date */}
                <div style={{ width: '88px', textAlign: 'right', padding: '0 8px' }}>
                  <span style={{ fontSize: '12px', fontWeight: overdue ? 600 : 400, color: overdue ? colors.red : colors.secondary }}>
                    {formatDate(task.due_date)}
                  </span>
                </div>
              </div>
            )
          })
        )}

        <div style={{
          padding: '9px 20px', fontSize: '11px', color: colors.muted,
          borderTop: `1px solid ${colors.border}`, background: colors.raised,
        }}>
          {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}{filterContext ? ` (filtered from ${tasks.length})` : ''}
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function ViewAllTasksPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ViewAllTasksContent />
    </Suspense>
  )
}
