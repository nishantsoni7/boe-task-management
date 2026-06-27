'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
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
          <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', color: '#DC1F2E', background: 'rgba(220,31,46,0.08)', border: '1px solid rgba(220,31,46,0.18)', letterSpacing: '0.04em', flexShrink: 0 }}>QTN</span>
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
            color: hoveredView ? '#DC1F2E' : colors.muted,
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
  const [viewTab, setViewTab] = useState<'pending' | 'closed'>('pending')

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

  const pendingCount = tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length
  const closedCount  = tasks.filter(t => t.status === 'completed').length

  const visibleTasks = useMemo(() => {
    const filtered = viewTab === 'closed'
      ? tasks.filter(t => t.status === 'completed')
      : tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled')
    return [...filtered].sort((a, b) => {
      const pDiff = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      if (pDiff !== 0) return pDiff
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [tasks, viewTab])

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
              background: '#DC1F2E', color: '#fff',
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
        {/* Prominent Pending / Closed toggle */}
        <div style={{ display: 'flex', gap: '0', marginBottom: '18px', borderRadius: '10px', overflow: 'hidden', border: '1.5px solid #E5E7EB', width: 'fit-content', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
          {([
            { key: 'pending', label: 'Pending Quotations', count: pendingCount },
            { key: 'closed',  label: 'Closed Quotations',  count: closedCount  },
          ] as const).map((tab, i) => {
            const active = viewTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setViewTab(tab.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '9px 20px',
                  background: active ? '#DC1F2E' : '#F9FAFB',
                  color: active ? '#fff' : '#374151',
                  fontSize: '13px', fontWeight: 700,
                  border: 'none',
                  borderLeft: i > 0 ? '1.5px solid #E5E7EB' : 'none',
                  cursor: 'pointer', transition: 'all 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                {tab.label}
                <span style={{
                  fontSize: '11px', fontWeight: 700,
                  padding: '1px 7px', borderRadius: '20px',
                  background: active ? 'rgba(255,255,255,0.22)' : '#E5E7EB',
                  color: active ? '#fff' : '#6B7280',
                }}>
                  {tab.count}
                </span>
              </button>
            )
          })}
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
            <div style={{ paddingLeft: '4px' }}>Contact</div>
            <div style={{ paddingLeft: '4px' }}>Notes</div>
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
                  onClick={() => router.push(`/tasks/${task.id}`)}
                  onView={() => router.push(`/tasks/${task.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </DashboardLayout>

    </>
  )
}
