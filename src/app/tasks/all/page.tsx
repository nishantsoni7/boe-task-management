'use client'

import { useEffect, useState, useMemo, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Task, TaskStatus, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { statusBadgeClass } from '@/lib/ui'
import { useListUrlState } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { enumListParam, idParam, pageParam } from '@/lib/listState'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { accruesAssigneeOverdue } from '@/lib/tasks/reviewTransitions'

const TASK_COLUMNS = [
  'id', 'title', 'status', 'priority', 'is_urgent',
  'due_date', 'assigned_to', 'created_by',
].join(', ')

const TODAY_STR = new Date().toISOString().slice(0, 10)
const PAGE_SIZE  = 50

// ─── URL-backed list state ────────────────────────────────────────────────────
// The two filters already arrived by deep link; the page number joins them, so
// paging to 3, opening a task and pressing Back returns to page 3 rather than
// page 1.
const TASK_STATUSES = [
  'pending', 'started', 'working', 'waiting', 'blocked', 'pending_approval', 'completed', 'cancelled',
] as const satisfies readonly TaskStatus[]

const LIST_PARAMS = {
  assignedTo: idParam(),
  status:     enumListParam(TASK_STATUSES),
  page:       pageParam(),
}

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
  const [total,    setTotal]    = useState(0)
  const [unfilteredTotal, setUnfilteredTotal] = useState(0)
  const [userMap,  setUserMap]  = useState<Record<string, string>>({})
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])

  const { state, setState } = useListUrlState(LIST_PARAMS, { pageKey: 'page' })
  const page = state.page

  useListScrollRestore()

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const filterAssignedTo  = state.assignedTo
  const filterStatuses    = state.status
  const filterStatusesKey = filterStatuses.join(',')
  const hasFilter         = !!filterAssignedTo || filterStatuses.length > 0

  // Auth + role guard + user directory — runs once
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!profileData) { router.push('/login'); return }

      const p = profileData as UserProfile
      if (p.role !== 'admin' && p.role !== 'manager') {
        router.push('/tasks/my')
        return
      }

      const { data: userData } = await supabase.from('users').select('id, full_name')
      if (userData) {
        const map: Record<string, string> = {}
        for (const u of userData) map[u.id] = u.full_name
        setUserMap(map)
      }
      setProfile(p)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the current page of tasks whenever the admin/manager is confirmed,
  // the page changes, or the (server-applied) filters change.
  useEffect(() => {
    if (!profile) return
    const loadTasks = async () => {
      setFetching(true)
      const from = (page - 1) * PAGE_SIZE
      const to   = from + PAGE_SIZE - 1

      let query = supabase
        .from('tasks')
        .select(TASK_COLUMNS, { count: 'exact' })
        .order('is_urgent', { ascending: false })
        .order('due_date', { ascending: true, nullsFirst: false })
      if (filterAssignedTo)          query = query.eq('assigned_to', filterAssignedTo)
      if (filterStatuses.length > 0) query = query.in('status', filterStatuses)

      const { data: taskData, count } = await query.range(from, to)
      setTasks((taskData ?? []) as unknown as Task[])
      setTotal(count ?? 0)

      // Only needed for the "(filtered from N)" footer note when a filter is active
      if (hasFilter) {
        const { count: allCount } = await supabase
          .from('tasks').select('id', { count: 'exact', head: true })
        setUnfilteredTotal(allCount ?? 0)
      }

      setFetching(false)
      setLoading(false)
    }
    loadTasks()
  }, [profile, page, filterAssignedTo, filterStatusesKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const filterContext = useMemo(() => {
    if (!hasFilter) return null
    const name = filterAssignedTo ? (userMap[filterAssignedTo] ?? 'Member') : null
    const statusLabel = filterStatuses.length > 0 ? filterStatuses.join(', ') : null
    const parts = [name ? `Assigned to: ${name}` : null, statusLabel ? `Status: ${statusLabel}` : null].filter(Boolean)
    return parts.join(' · ')
  }, [hasFilter, filterAssignedTo, filterStatusesKey, userMap]) // eslint-disable-line react-hooks/exhaustive-deps

  // A page number past the end of the result set — hand-typed, or left behind
  // when the list shrank — settles on the last real page instead of showing an
  // empty table under "Page 12 of 3".
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => {
    if (loading || fetching) return
    if (page > lastPage) setState({ page: lastPage })
  }, [loading, fetching, page, lastPage, setState])

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="View All Tasks"
      subtitle={filterContext ?? `${total} total task${total !== 1 ? 's' : ''}`}
      onSignOut={handleLogout}
      actions={hasFilter ? (
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
          <Link href="/tasks/all" style={{ fontSize: 11, color: '#8C94A6', textDecoration: 'none', fontWeight: 500 }}>
            Clear filter ✕
          </Link>
        </div>
      )}
      {isMobile ? (
        /* ── Mobile: card list ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {tasks.length === 0 ? (
            <div style={{
              background: colors.base, border: `1.5px solid ${colors.border}`,
              borderRadius: '10px', padding: '52px 24px',
              textAlign: 'center', color: colors.muted, fontSize: '13px',
            }}>
              No tasks found.
            </div>
          ) : tasks.map(task => {
            const overdue = !!task.due_date && task.due_date < TODAY_STR && accruesAssigneeOverdue(task.status)
            const pill    = PRIORITY_PILL[task.priority] ?? PRIORITY_PILL.low
            return (
              <div
                key={task.id}
                role="button"
                onClick={() => router.push(`/tasks/${task.id}`)}
                style={{
                  background: colors.base,
                  border: `1.5px solid ${overdue ? colors.red + '44' : colors.border}`,
                  borderRadius: '10px',
                  padding: '12px 14px',
                  cursor: 'pointer',
                }}
              >
                {/* Row 1: title */}
                <div style={{
                  fontSize: '13px', fontWeight: 500,
                  color: overdue ? colors.red : colors.primary,
                  marginBottom: '8px', lineHeight: 1.4,
                  display: 'flex', alignItems: 'flex-start', gap: '5px',
                }}>
                  {task.is_urgent && <span style={{ color: '#C49A28', flexShrink: 0 }}>⭐</span>}
                  {task.title}
                </div>
                {/* Row 2: meta */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  <span className={statusBadgeClass(task.status)} style={{ fontSize: '10px' }} />
                  <span style={{ fontSize: '10.5px', fontWeight: 600, color: pill.fg, background: pill.bg, padding: '1px 7px', borderRadius: '5px' }}>
                    {pill.label}
                  </span>
                  {task.due_date && (
                    <span style={{ fontSize: '11px', fontWeight: overdue ? 600 : 400, color: overdue ? colors.red : colors.secondary }}>
                      {formatDate(task.due_date)}
                    </span>
                  )}
                </div>
                {/* Row 3: assignee + creator */}
                <div style={{ display: 'flex', gap: '10px', marginTop: '6px', flexWrap: 'wrap' }}>
                  {task.assigned_to && userMap[task.assigned_to] && (
                    <span style={{ fontSize: '11px', color: colors.muted }}>
                      To: <span style={{ color: colors.secondary, fontWeight: 500 }}>{userMap[task.assigned_to]}</span>
                    </span>
                  )}
                  {task.created_by && userMap[task.created_by] && task.created_by !== task.assigned_to && (
                    <span style={{ fontSize: '11px', color: colors.muted }}>
                      By: <span style={{ color: colors.secondary, fontWeight: 500 }}>{userMap[task.created_by]}</span>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          <div style={{ padding: '4px 2px', fontSize: '11px', color: colors.muted }}>
            {total} task{total !== 1 ? 's' : ''}{filterContext ? ` (filtered from ${unfilteredTotal})` : ''}
          </div>
        </div>
      ) : (
        /* ── Desktop: original table ── */
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

          {tasks.length === 0 ? (
            <div style={{ padding: '52px 24px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
              No tasks found.
            </div>
          ) : (
            tasks.map(task => {
              const overdue = !!task.due_date && task.due_date < TODAY_STR && accruesAssigneeOverdue(task.status)
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
            {total} task{total !== 1 ? 's' : ''}{filterContext ? ` (filtered from ${unfilteredTotal})` : ''}
          </div>
        </div>
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end', fontSize: '13px', marginTop: '12px' }}>
          <button
            onClick={() => setState({ page: page - 1 })}
            disabled={page <= 1 || fetching}
            style={{
              padding: '6px 14px', borderRadius: '7px', fontSize: '13px',
              border: `1px solid ${colors.border}`, background: colors.base,
              color: page <= 1 ? colors.muted : colors.primary,
              cursor: page <= 1 ? 'not-allowed' : 'pointer',
            }}
          >
            Previous
          </button>
          <span style={{ color: colors.muted }}>
            Page {page} of {Math.ceil(total / PAGE_SIZE)}
          </span>
          <button
            onClick={() => setState({ page: page + 1 })}
            disabled={page >= Math.ceil(total / PAGE_SIZE) || fetching}
            style={{
              padding: '6px 14px', borderRadius: '7px', fontSize: '13px',
              border: `1px solid ${colors.border}`, background: colors.base,
              color: page >= Math.ceil(total / PAGE_SIZE) ? colors.muted : colors.primary,
              cursor: page >= Math.ceil(total / PAGE_SIZE) ? 'not-allowed' : 'pointer',
            }}
          >
            Next
          </button>
        </div>
      )}
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
