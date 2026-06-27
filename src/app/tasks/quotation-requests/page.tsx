'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { useProfile } from '@/hooks/queries/useProfile'
import { useUserNames } from '@/hooks/queries/useMyTasks'
import { ExternalLink, Plus, Building2, Phone, MapPin, User } from 'lucide-react'

const QTN_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type', 'task_type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
  'customer_name', 'contact_number', 'company_name', 'city_project',
].join(', ')

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }

function PriorityBadge({ priority }: { priority: string }) {
  const cfg = priority === 'high'
    ? { color: '#B45309', bg: '#FFFBEB' }
    : priority === 'low'
      ? { color: '#6B7280', bg: '#F3F4F6' }
      : { color: '#374151', bg: '#F3F4F6' }
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600,
      color: cfg.color, background: cfg.bg,
      borderRadius: '4px', padding: '1px 6px',
      textTransform: 'capitalize', flexShrink: 0,
    }}>{priority}</span>
  )
}

function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

function statusBadgeStyle(status: string): React.CSSProperties {
  return {
    display: 'inline-block',
    fontSize: '10px', fontWeight: 600, padding: '2px 8px',
    borderRadius: '20px', textTransform: 'capitalize' as const,
  }
}

function RequestCard({
  task, userMap, userId, onClick, onView,
}: {
  task: Task
  userMap: Record<string, string>
  userId: string
  onClick: () => void
  onView: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [hoveredView, setHoveredView] = useState(false)
  const isMyRequest = task.created_by === userId
  const assigneeName = userMap[task.assigned_to] ?? 'Unassigned'
  const creatorName  = userMap[task.created_by]  ?? 'You'

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1.8fr) minmax(120px, 1fr) minmax(100px, 0.8fr) minmax(90px, 0.7fr) minmax(90px, 0.6fr) 40px',
        columnGap: '12px',
        alignItems: 'center',
        background: hovered ? colors.raised : colors.base,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '8px',
        minHeight: '52px',
        cursor: 'pointer',
        padding: '0 4px',
        transition: 'background 0.12s',
        boxShadow: hovered ? '0 2px 8px rgba(0,0,0,0.07)' : '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {/* Customer + priority */}
      <div style={{ minWidth: 0, padding: '10px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '2px' }}>
          <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', color: '#6B4FA0', background: 'rgba(155,111,212,0.10)', border: '1px solid rgba(155,111,212,0.20)', letterSpacing: '0.04em', flexShrink: 0 }}>QTN</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.customer_name ?? task.title}
          </span>
          <PriorityBadge priority={task.priority} />
        </div>
        {task.company_name && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Building2 size={10} color={colors.muted} />
            <span style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {task.company_name}
            </span>
          </div>
        )}
      </div>

      {/* Contact + city */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        {task.contact_number && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
            <Phone size={10} color={colors.muted} />
            <span style={{ fontSize: '11px', color: colors.secondary }}>{task.contact_number}</span>
          </div>
        )}
        {task.city_project && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <MapPin size={10} color={colors.muted} />
            <span style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.city_project}</span>
          </div>
        )}
        {!task.contact_number && !task.city_project && (
          <span style={{ fontSize: '11px', color: colors.muted }}>—</span>
        )}
      </div>

      {/* Requirement snippet */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <span style={{ fontSize: '11px', color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
          {task.note ? task.note.slice(0, 55) + (task.note.length > 55 ? '…' : '') : '—'}
        </span>
      </div>

      {/* Assigned to / Requested by */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <User size={10} color={colors.muted} />
          <span style={{ fontSize: '11px', color: colors.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isMyRequest ? assigneeName : creatorName}
          </span>
        </div>
        <span style={{ fontSize: '10px', color: colors.muted }}>{isMyRequest ? 'Assigned to' : 'From'}</span>
      </div>

      {/* Status + date */}
      <div style={{ minWidth: 0, padding: '0 4px' }}>
        <div style={{ marginBottom: '3px' }}>
          <span className={`boe-badge boe-badge-${task.status}`} style={{ fontSize: '9px', padding: '2px 7px', textTransform: 'capitalize', fontWeight: 600 }}>
            {task.status}
          </span>
        </div>
        <span style={{ fontSize: '10px', color: colors.muted }}>
          {formatDate(task.created_at) ?? ''}
        </span>
      </div>

      {/* View button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <button
          onClick={e => { e.stopPropagation(); onView() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="Open full page"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: '6px',
            background: hoveredView ? 'rgba(155,111,212,0.10)' : 'transparent',
            border: `1px solid ${hoveredView ? 'rgba(155,111,212,0.30)' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredView ? '#6B4FA0' : colors.muted,
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  )
}

export default function QuotationRequestsPage() {
  const [loggedInId,   setLoggedInId]   = useState('')
  const [tasks,        setTasks]        = useState<Task[]>([])
  const [loading,      setLoading]      = useState(true)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [statusFilter, setStatusFilter] = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const { data: profile = null } = useProfile(loggedInId)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setLoggedInId(session.user.id)

      const { data } = await supabase
        .from('tasks')
        .select(QTN_COLUMNS)
        .eq('task_type', 'quotation_request')
        .or(`assigned_to.eq.${session.user.id},created_by.eq.${session.user.id}`)
        .order('created_at', { ascending: false })

      setTasks((data ?? []) as unknown as Task[])
      setLoading(false)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const allUserIds = useMemo(
    () => [...new Set(tasks.flatMap(t => [t.assigned_to, t.created_by]))],
    [tasks]
  )
  const { data: userMap = {} } = useUserNames(allUserIds)

  const visibleTasks = useMemo(() => {
    const filtered = statusFilter ? tasks.filter(t => t.status === statusFilter) : tasks
    return [...filtered].sort((a, b) => {
      const pDiff = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      if (pDiff !== 0) return pDiff
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [tasks, statusFilter])

  const openCount   = tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length
  const closedCount = tasks.filter(t => t.status === 'completed' || t.status === 'cancelled').length

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Quotation Requests"
        subtitle="Customer quotation and inquiry requests"
        onSignOut={handleLogout}
        actions={
          <button
            onClick={() => router.push('/tasks/quotation-requests/new')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', borderRadius: '8px', border: 'none',
              background: '#6B4FA0', color: '#fff',
              fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              transition: 'opacity 0.12s', whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <Plus size={13} strokeWidth={2.5} />
            New Request
          </button>
        }
      >
        {/* Summary chips */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {[
            { label: 'Open', count: openCount,   accent: '#6B4FA0' },
            { label: 'Closed', count: closedCount, accent: colors.muted },
          ].map(chip => (
            <div key={chip.label} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 14px', borderRadius: '20px',
              background: colors.base, border: `1.5px solid ${colors.border}`,
            }}>
              <span style={{ fontSize: '16px', fontWeight: 700, color: chip.count > 0 ? chip.accent : colors.muted }}>{chip.count}</span>
              <span style={{ fontSize: '12px', color: colors.secondary }}>{chip.label}</span>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{
              padding: '6px 10px', borderRadius: '6px',
              background: colors.raised, border: `1px solid ${colors.border}`,
              fontSize: '12px', color: statusFilter ? colors.primary : colors.muted,
              outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="working">Working</option>
            <option value="completed">Completed</option>
            <option value="waiting">Waiting</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <span style={{ fontSize: '11px', color: colors.muted, marginLeft: '4px' }}>
            {visibleTasks.length} request{visibleTasks.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: '12px', overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(180px, 1.8fr) minmax(120px, 1fr) minmax(100px, 0.8fr) minmax(90px, 0.7fr) minmax(90px, 0.6fr) 40px',
            columnGap: '12px',
            padding: '8px 4px',
            background: 'rgba(248,250,252,0.9)',
            borderBottom: `1px solid ${colors.border}`,
            fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em', color: colors.muted,
          }}>
            <div style={{ paddingLeft: '6px' }}>Customer</div>
            <div style={{ paddingLeft: '4px' }}>Contact / City</div>
            <div style={{ paddingLeft: '4px' }}>Requirement</div>
            <div style={{ paddingLeft: '4px' }}>Assigned / From</div>
            <div style={{ paddingLeft: '4px' }}>Status</div>
            <div />
          </div>

          {/* Rows */}
          {visibleTasks.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center' }}>
              <p style={{ fontSize: '13px', color: colors.secondary, fontWeight: 500 }}>No quotation requests yet</p>
              <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
                Use the New Request button to submit a quotation request.
              </p>
            </div>
          ) : (
            <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {visibleTasks.map(task => (
                <RequestCard
                  key={task.id}
                  task={task}
                  userMap={userMap}
                  userId={loggedInId}
                  onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                  onView={() => router.push(`/tasks/${task.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={loggedInId}
        />
      )}
    </>
  )
}
