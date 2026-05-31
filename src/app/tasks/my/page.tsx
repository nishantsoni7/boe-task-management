'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { CheckCircle2, ExternalLink } from 'lucide-react'

// ─── Data ─────────────────────────────────────────────────────────────────────
const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

const TODAY_STR = new Date().toISOString().slice(0, 10)
const NOW_MS    = Date.now()
const H48       = 48 * 60 * 60 * 1000

function isOverdue(task: Task) {
  return !!task.due_date && task.due_date < TODAY_STR && task.status !== 'completed'
}
function needsUpdate(task: Task) {
  if (task.status === 'completed') return false
  return NOW_MS - new Date(task.last_update_at ?? task.created_at).getTime() > H48
}
function isUnacknowledged(task: Task) {
  return !task.acknowledged_at && task.status !== 'completed'
}
function isNonCompletion(task: Task) {
  return isOverdue(task) && needsUpdate(task)
}
function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}
function formatRelative(d: string | null) {
  if (!d) return '—'
  const diffMs = NOW_MS - new Date(d).getTime()
  const diffH  = Math.floor(diffMs / 3600000)
  if (diffH < 1)  return 'Just now'
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}d ago`
}

// ─── Tab config ───────────────────────────────────────────────────────────────
type TabKey = 'all' | 'unacknowledged' | 'in_progress' | 'overdue' | 'needs_update' | 'non_completion' | 'completed'

const TABS: { key: TabKey; label: string; color: string }[] = [
  { key: 'all',            label: 'All',                  color: colors.secondary },
  { key: 'unacknowledged', label: 'Unacknowledged',       color: '#9B6FD4'        },
  { key: 'in_progress',    label: 'In Progress',          color: colors.blue      },
  { key: 'overdue',        label: 'Overdue',              color: colors.red       },
  { key: 'needs_update',   label: 'Pending Update (48h+)', color: colors.amber    },
  { key: 'non_completion', label: 'Non Completion Zone',  color: '#E05C2A'        },
  { key: 'completed',      label: 'Completed',            color: '#4CAF7D'        },
]

// ─── Priority pill config ─────────────────────────────────────────────────────
const PRIORITY_PILL: Record<string, { label: string; fg: string; bg: string }> = {
  high:   { label: 'High',   fg: '#C0392B', bg: 'rgba(192,57,43,0.09)'  },
  medium: { label: 'Medium', fg: '#D4831A', bg: 'rgba(212,131,26,0.09)' },
  low:    { label: 'Low',    fg: colors.muted, bg: 'rgba(0,0,0,0.04)'   },
}

const STATUS_LABEL: Record<string, string> = {
  pending:   'Pending',
  started:   'Started',
  working:   'Working',
  waiting:   'Waiting',
  blocked:   'Blocked',
  completed: 'Completed',
}
const STATUS_COLOR: Record<string, string> = {
  pending:   colors.muted,
  started:   colors.blue,
  working:   colors.blue,
  waiting:   colors.amber,
  blocked:   colors.red,
  completed: '#4CAF7D',
}

// ─── Focus Strip ──────────────────────────────────────────────────────────────
function buildFocusMessage(overdue: number, needsUpdate: number, nonCompletion: number): { text: string; color: string } {
  if (nonCompletion > 0)
    return { text: `${nonCompletion} task${nonCompletion > 1 ? 's' : ''} in the risk zone`, color: '#E05C2A' }
  if (overdue > 0)
    return { text: `${overdue} overdue task${overdue > 1 ? 's' : ''} need attention`, color: colors.red }
  if (needsUpdate > 0)
    return { text: `${needsUpdate} task${needsUpdate > 1 ? 's' : ''} need${needsUpdate === 1 ? 's' : ''} an update`, color: colors.amber }
  return { text: 'All tasks are on track', color: '#4CAF7D' }
}

function FocusStrip({
  unacknowledged, overdue, needsUpdateCount, nonCompletion, activeTab, onTabChange,
}: {
  unacknowledged: number
  overdue: number
  needsUpdateCount: number
  nonCompletion: number
  activeTab: TabKey
  onTabChange: (k: TabKey) => void
}) {
  const items: { label: string; count: number; color: string; tab: TabKey }[] = [
    { label: 'Unacknowledged',        count: unacknowledged,  color: '#9B6FD4',   tab: 'unacknowledged' },
    { label: 'Overdue',               count: overdue,          color: colors.red,  tab: 'overdue'        },
    { label: 'Pending Update (48h+)', count: needsUpdateCount, color: colors.amber, tab: 'needs_update'  },
    { label: 'Non Completion Zone',   count: nonCompletion,   color: '#E05C2A',   tab: 'non_completion' },
  ]

  const focus = buildFocusMessage(overdue, needsUpdateCount, nonCompletion)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      height: '42px', marginBottom: '10px',
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '8px',
      padding: '0 12px',
      flexShrink: 0,
    }}>
      {/* Today Focus — dynamic actionable message */}
      <div style={{ flexShrink: 0, marginRight: '2px', display: 'flex', alignItems: 'baseline', gap: '5px' }}>
        <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.muted }}>Today Focus:</span>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: focus.color }}>{focus.text}</span>
      </div>
      <div style={{ width: '1px', height: '22px', background: colors.border, flexShrink: 0 }} />

      {/* Metrics */}
      {items.map(item => {
        const isActive = activeTab === item.tab
        return (
          <button
            key={item.tab}
            onClick={() => onTabChange(item.tab)}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 9px', borderRadius: '6px',
              background: isActive ? `${item.color}12` : 'transparent',
              border: `1.5px solid ${isActive ? item.color : 'transparent'}`,
              cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
              flexShrink: 0,
            }}
          >
            <span style={{
              fontSize: '15px', fontWeight: 700, lineHeight: 1,
              color: item.count > 0 ? item.color : colors.muted,
            }}>
              {item.count}
            </span>
            <span style={{
              fontSize: '10px', fontWeight: 500, color: item.count > 0 ? item.color : colors.muted,
              whiteSpace: 'nowrap',
            }}>
              {item.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────
function TabBar({
  tabs, counts, activeTab, onChange,
}: {
  tabs: typeof TABS
  counts: Record<TabKey, number>
  activeTab: TabKey
  onChange: (k: TabKey) => void
}) {
  return (
    <div style={{
      display: 'flex', gap: '0',
      borderBottom: `1.5px solid ${colors.border}`,
      background: colors.raised,
      overflowX: 'auto',
      scrollbarWidth: 'none',
    }}>
      {tabs.map(tab => {
        const isActive = activeTab === tab.key
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            style={{
              padding: '9px 14px',
              display: 'flex', alignItems: 'center', gap: '5px',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: isActive ? `2px solid ${tab.color}` : '2px solid transparent',
              marginBottom: '-1.5px',
              fontSize: '11.5px', fontWeight: isActive ? 600 : 500,
              color: isActive ? tab.color : colors.secondary,
              transition: 'all 0.12s', outline: 'none',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {tab.label}
            <span style={{
              fontSize: '10px', fontWeight: 700,
              color: isActive ? tab.color : colors.muted,
              background: isActive ? `${tab.color}18` : 'rgba(0,0,0,0.05)',
              padding: '1px 5px', borderRadius: '10px', lineHeight: 1.4,
            }}>
              {counts[tab.key]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Mobile chip tab ──────────────────────────────────────────────────────────
function ChipTab({
  tab, count, isActive, onClick,
}: { tab: typeof TABS[number]; count: number; isActive: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '5px',
        padding: '5px 12px',
        background: isActive ? tab.color : colors.base,
        border: `1.5px solid ${isActive ? tab.color : colors.border}`,
        borderRadius: '20px', cursor: 'pointer', whiteSpace: 'nowrap',
        flexShrink: 0, outline: 'none', transition: 'all 0.15s',
      }}
    >
      <span style={{ fontSize: '12px', fontWeight: 600, color: isActive ? '#fff' : colors.secondary }}>
        {tab.label}
      </span>
      <span style={{ fontSize: '11px', fontWeight: 700, color: isActive ? 'rgba(255,255,255,0.85)' : colors.muted }}>
        {count}
      </span>
    </button>
  )
}

// ─── Table header ─────────────────────────────────────────────────────────────
function TableHeader() {
  const col = (label: string, width?: number, align: 'left' | 'right' | 'center' = 'left') => (
    <div style={{
      fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: colors.muted,
      width, flex: width ? undefined : 1,
      textAlign: align, padding: '0 6px', whiteSpace: 'nowrap',
    }}>
      {label}
    </div>
  )
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '6px 10px', borderBottom: `1px solid ${colors.border}`,
      background: colors.raised,
    }}>
      <div style={{ width: '28px', flexShrink: 0 }} />
      {col('Task')}
      {col('Due Date', 80, 'right')}
      {col('Priority', 70, 'center')}
      {col('Status', 74, 'center')}
      {col('Updated', 72, 'right')}
      {col('Actions', 60, 'center')}
    </div>
  )
}

// ─── Task row ─────────────────────────────────────────────────────────────────
function TaskRow({
  task, accentColor, onClick,
}: {
  task: Task
  accentColor: string
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const overdue = isOverdue(task)
  const pill    = PRIORITY_PILL[task.priority] ?? PRIORITY_PILL.low
  const statusLabel = STATUS_LABEL[task.status] ?? task.status
  const statusColor = STATUS_COLOR[task.status] ?? colors.muted

  return (
    <div
      role="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '7px 10px',
        borderBottom: `1px solid ${colors.border}`,
        cursor: 'default', minHeight: '36px',
        background: hovered ? colors.raised : colors.base,
        borderLeft: overdue
          ? `3px solid ${colors.red}66`
          : task.is_urgent
            ? '3px solid #C49A2888'
            : '3px solid transparent',
        transition: 'background 0.1s',
      }}
    >
      {/* Checkbox */}
      <div style={{ width: '28px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <input
          type="checkbox"
          style={{ width: '12px', height: '12px', cursor: 'pointer', flexShrink: 0, accentColor }}
          onClick={e => e.stopPropagation()}
          readOnly
        />
      </div>
      {/* Title */}
      <div style={{ flex: 1, minWidth: 0, padding: '0 6px' }}>
        <span style={{
          fontSize: '12.5px',
          fontWeight: task.is_urgent ? 650 : 500,
          letterSpacing: '-0.01em',
          color: overdue ? colors.red : colors.primary,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          display: 'block',
        }}>
          {task.is_urgent && (
            <span style={{ fontSize: '10px', marginRight: '5px', lineHeight: 1, verticalAlign: 'middle' }}>⭐</span>
          )}
          {task.title}
        </span>
      </div>
      {/* Due date */}
      <div style={{ width: '80px', textAlign: 'right', padding: '0 6px', flexShrink: 0 }}>
        <span style={{
          fontSize: '11.5px', fontWeight: overdue ? 600 : 400,
          color: overdue ? colors.red : colors.secondary,
        }}>
          {formatDate(task.due_date)}
        </span>
      </div>
      {/* Priority */}
      <div style={{ width: '70px', display: 'flex', justifyContent: 'center', padding: '0 4px', flexShrink: 0 }}>
        <span style={{
          fontSize: '10px', fontWeight: 600, color: pill.fg, background: pill.bg,
          padding: '2px 7px', borderRadius: '4px', whiteSpace: 'nowrap',
        }}>
          {pill.label}
        </span>
      </div>
      {/* Status */}
      <div style={{ width: '74px', display: 'flex', justifyContent: 'center', padding: '0 4px', flexShrink: 0 }}>
        <span style={{
          fontSize: '10px', fontWeight: 600, color: statusColor,
          background: `${statusColor}18`, padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap',
        }}>
          {statusLabel}
        </span>
      </div>
      {/* Updated */}
      <div style={{ width: '72px', textAlign: 'right', padding: '0 6px', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', color: colors.muted }}>
          {formatRelative(task.last_update_at ?? task.created_at)}
        </span>
      </div>
      {/* Actions */}
      <div style={{ width: '60px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        <button
          onClick={onClick}
          title="View task"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: '6px',
            background: hovered ? `${accentColor}14` : 'transparent',
            border: `1px solid ${hovered ? accentColor + '44' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hovered ? accentColor : colors.muted,
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: '6px' }}>
      <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '4px' }}>
        <CheckCircle2 size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>No {label} tasks</span>
      <span style={{ fontSize: '12px', color: colors.muted }}>You&apos;re all clear here.</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function MyTasksPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [allTasks,     setAllTasks]     = useState<Task[]>([])
  const [loading,      setLoading]      = useState(true)
  const [activeTab,    setActiveTab]    = useState<TabKey>('all')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [isMobile,     setIsMobile]     = useState(false)

  // Search + filter state
  const [search,         setSearch]         = useState('')
  const [filterStatus,   setFilterStatus]   = useState('')
  const [filterPriority, setFilterPriority] = useState('')

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

      const uid = session.user.id
      const [{ data: profileData }, { data: tasks }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, is_active, created_at').eq('id', uid).single(),
        supabase.from('tasks').select(TASK_COLUMNS).eq('assigned_to', uid).order('due_date', { ascending: true, nullsFirst: false }),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      setAllTasks((tasks ?? []) as unknown as Task[])
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const buckets = useMemo(() => {
    const sortImportantFirst = (arr: Task[]) =>
      [...arr].sort((a, b) => (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0))

    const all            = sortImportantFirst(allTasks)
    const unacknowledged = sortImportantFirst(allTasks.filter(isUnacknowledged))
    const in_progress    = sortImportantFirst(allTasks.filter(t =>
      !isOverdue(t) && t.status !== 'completed' && ['started', 'working', 'pending'].includes(t.status)
    ))
    const overdue        = sortImportantFirst(allTasks.filter(isOverdue))
    const needs_update   = sortImportantFirst(allTasks.filter(needsUpdate))
    const non_completion = sortImportantFirst(allTasks.filter(isNonCompletion))
    const completed      = allTasks.filter(t => t.status === 'completed')

    return { all, unacknowledged, in_progress, overdue, needs_update, non_completion, completed }
  }, [allTasks])

  const counts: Record<TabKey, number> = {
    all:            buckets.all.length,
    unacknowledged: buckets.unacknowledged.length,
    in_progress:    buckets.in_progress.length,
    overdue:        buckets.overdue.length,
    needs_update:   buckets.needs_update.length,
    non_completion: buckets.non_completion.length,
    completed:      buckets.completed.length,
  }

  const visibleTasks = useMemo(() => {
    let tasks = buckets[activeTab]
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      tasks = tasks.filter(t => t.title.toLowerCase().includes(q))
    }
    if (filterStatus)   tasks = tasks.filter(t => t.status === filterStatus)
    if (filterPriority) tasks = tasks.filter(t => t.priority === filterPriority)
    return tasks
  }, [buckets, activeTab, search, filterStatus, filterPriority])

  function handleTabChange(key: TabKey) {
    setActiveTab(key)
    setSelectedTask(null)
    setSearch('')
    setFilterStatus('')
    setFilterPriority('')
  }

  const activeTabColor = TABS.find(t => t.key === activeTab)?.color ?? colors.secondary

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout profile={profile} title="" onSignOut={handleLogout}>

        {/* ── Focus Strip (desktop) / Chip scroll (mobile) ── */}
        {isMobile ? (
          <div style={{
            display: 'flex', gap: '8px', overflowX: 'auto',
            paddingBottom: '4px', marginBottom: '10px',
            scrollbarWidth: 'none',
          }}>
            {TABS.map(tab => (
              <ChipTab
                key={tab.key}
                tab={tab}
                count={counts[tab.key]}
                isActive={activeTab === tab.key}
                onClick={() => handleTabChange(tab.key)}
              />
            ))}
          </div>
        ) : (
          <FocusStrip
            unacknowledged={counts.unacknowledged}
            overdue={counts.overdue}
            needsUpdateCount={counts.needs_update}
            nonCompletion={counts.non_completion}
            activeTab={activeTab}
            onTabChange={handleTabChange}
          />
        )}

        {/* ── Search + Filters ── */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search tasks…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, minWidth: '160px',
              padding: '6px 10px',
              background: colors.base, border: `1.5px solid ${colors.border}`,
              borderRadius: '7px', outline: 'none',
              fontSize: '12px', color: colors.primary,
            }}
          />
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            style={{
              padding: '6px 8px',
              background: colors.base, border: `1.5px solid ${colors.border}`,
              borderRadius: '7px', outline: 'none',
              fontSize: '12px', color: filterStatus ? colors.primary : colors.muted,
              cursor: 'pointer',
            }}
          >
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="started">Started</option>
            <option value="working">Working</option>
            <option value="waiting">Waiting</option>
            <option value="blocked">Blocked</option>
            <option value="completed">Completed</option>
          </select>
          <select
            value={filterPriority}
            onChange={e => setFilterPriority(e.target.value)}
            style={{
              padding: '6px 8px',
              background: colors.base, border: `1.5px solid ${colors.border}`,
              borderRadius: '7px', outline: 'none',
              fontSize: '12px', color: filterPriority ? colors.primary : colors.muted,
              cursor: 'pointer',
            }}
          >
            <option value="">All Priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {/* ── Task list ── */}
        <div style={{
          background: colors.base,
          border: `1.5px solid ${colors.border}`,
          borderRadius: '10px',
          overflow: 'hidden',
        }}>
          {!isMobile && (
            <TabBar
              tabs={TABS}
              counts={counts}
              activeTab={activeTab}
              onChange={handleTabChange}
            />
          )}

          {visibleTasks.length === 0 ? (
            <EmptyState label={TABS.find(t => t.key === activeTab)!.label} />
          ) : (
            <>
              <TableHeader />
              {visibleTasks.map(task => (
                <TaskRow
                  key={task.id}
                  task={task}
                  accentColor={activeTabColor}
                  onClick={() => {
                    if (isMobile) {
                      setSelectedTask(prev => prev?.id === task.id ? null : task)
                    } else {
                      router.push(`/tasks/${task.id}`)
                    }
                  }}
                />
              ))}
              <div style={{
                padding: '7px 18px', fontSize: '11px', color: colors.muted,
                borderTop: `1px solid ${colors.border}`, background: colors.raised,
              }}>
                {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
              </div>
            </>
          )}
        </div>
      </DashboardLayout>

      {isMobile && selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </>
  )
}
