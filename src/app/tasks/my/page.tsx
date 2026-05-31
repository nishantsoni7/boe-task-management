'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import {
  CheckCircle2, ExternalLink, Star, AlertCircle,
  List, Bell, PlayCircle, Clock, RefreshCcw, ShieldAlert, CheckCircle,
} from 'lucide-react'

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
function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

// ─── Tab config ───────────────────────────────────────────────────────────────
type TabKey = 'all' | 'important' | 'unacknowledged' | 'in_progress' | 'overdue' | 'needs_update' | 'non_completion' | 'completed'
type TaskType = 'all' | 'self' | 'delegated'

const TABS: { key: TabKey; label: string; color: string; Icon: React.ElementType }[] = [
  { key: 'all',            label: 'All',             color: colors.secondary, Icon: List         },
  { key: 'important',      label: 'Important',       color: '#C49A28',        Icon: Star         },
  { key: 'unacknowledged', label: 'Unacknowledged',  color: '#9B6FD4',        Icon: Bell         },
  { key: 'in_progress',    label: 'In Progress',     color: colors.blue,      Icon: PlayCircle   },
  { key: 'overdue',        label: 'Overdue',         color: colors.red,       Icon: Clock        },
  { key: 'needs_update',   label: 'Pending Update',  color: colors.amber,     Icon: RefreshCcw   },
  { key: 'non_completion', label: 'Non Completion',  color: '#E05C2A',        Icon: ShieldAlert  },
  { key: 'completed',      label: 'Completed',       color: '#4CAF7D',        Icon: CheckCircle  },
]

// ─── Priority config ──────────────────────────────────────────────────────────
const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#C0392B'    },
  medium: { label: 'Med',  color: '#D4831A'    },
  low:    { label: 'Low',  color: colors.muted },
}

// ─── Focus message ────────────────────────────────────────────────────────────
function buildFocusMessage(overdue: number, needsUpd: number, nonCompletion: number) {
  if (nonCompletion > 0)
    return { text: `${nonCompletion} task${nonCompletion > 1 ? 's' : ''} in the risk zone`, color: '#E05C2A' }
  if (overdue > 0)
    return { text: `${overdue} overdue task${overdue > 1 ? 's' : ''} need attention`, color: colors.red }
  if (needsUpd > 0)
    return { text: `${needsUpd} task${needsUpd > 1 ? 's' : ''} need${needsUpd === 1 ? 's' : ''} an update`, color: colors.amber }
  return { text: 'All tasks are on track', color: '#4CAF7D' }
}

// ─── Right panel ─────────────────────────────────────────────────────────────
function RightPanel({
  counts, activeTab, onTabChange,
}: {
  counts: Record<TabKey, number>
  activeTab: TabKey
  onTabChange: (k: TabKey) => void
}) {
  const focus = buildFocusMessage(counts.overdue, counts.needs_update, counts.non_completion)

  return (
    <div style={{ flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>

      {/* Today Focus */}
      <div style={{
        background: colors.base, border: `1.5px solid ${colors.border}`,
        borderRadius: '10px', padding: '14px 16px',
      }}>
        <div style={{
          fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: colors.muted, marginBottom: '6px',
        }}>
          Today&rsquo;s Focus
        </div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: focus.color, lineHeight: 1.45 }}>
          {focus.text}
        </div>
      </div>

      {/* All views — replaces tab bar */}
      <div style={{
        background: colors.base, border: `1.5px solid ${colors.border}`,
        borderRadius: '10px', overflow: 'hidden',
      }}>
        <div style={{
          fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em',
          textTransform: 'uppercase', color: colors.muted,
          padding: '10px 16px 6px',
        }}>
          Views
        </div>
        {TABS.map((item, i) => {
          const isActive = activeTab === item.key
          const { Icon } = item
          return (
            <button
              key={item.key}
              onClick={() => onTabChange(item.key)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', padding: '8px 14px',
                background: isActive ? `${item.color}0d` : 'transparent',
                border: 'none',
                borderBottom: i < TABS.length - 1 ? `1px solid ${colors.border}` : 'none',
                borderLeft: `3px solid ${isActive ? item.color : 'transparent'}`,
                cursor: 'pointer', outline: 'none', transition: 'all 0.1s', textAlign: 'left',
              }}
            >
              <span style={{
                display: 'flex', alignItems: 'center', gap: '7px',
                fontSize: '12px', fontWeight: isActive ? 600 : 500,
                color: isActive ? item.color : counts[item.key] > 0 ? colors.secondary : colors.muted,
              }}>
                <Icon size={12} style={{ opacity: isActive ? 1 : 0.55, flexShrink: 0 }} />
                {item.label}
              </span>
              <span style={{
                fontSize: '12px', fontWeight: 700,
                color: counts[item.key] > 0 ? item.color : colors.muted,
                background: isActive ? `${item.color}18` : 'rgba(0,0,0,0.04)',
                padding: '1px 7px', borderRadius: '10px', minWidth: '22px', textAlign: 'center',
              }}>
                {counts[item.key]}
              </span>
            </button>
          )
        })}
      </div>

      {/* Guidance */}
      <div style={{
        background: colors.raised, border: `1.5px solid ${colors.border}`,
        borderRadius: '10px', padding: '12px 16px',
        fontSize: '11.5px', color: colors.muted, lineHeight: 1.6,
      }}>
        Clear overdue and unacknowledged tasks first. Keep updates timely to avoid the non-completion zone.
      </div>

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

// ─── Task card ────────────────────────────────────────────────────────────────
function TaskCard({
  task, accentColor, onClick,
}: {
  task: Task
  accentColor: string
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const overdue   = isOverdue(task)
  const completed = task.status === 'completed'
  const priority  = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const dateStr   = formatDate(task.due_date)

  const leftBarColor = overdue
    ? colors.red
    : task.is_urgent
      ? '#C49A28'
      : 'transparent'

  const titleColor = completed
    ? colors.muted
    : overdue
      ? colors.red
      : colors.primary

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        background: hovered ? colors.raised : colors.base,
        border: `1.5px solid ${hovered ? accentColor + '55' : colors.border}`,
        borderLeft: `3px solid ${leftBarColor}`,
        borderRadius: '8px',
        boxShadow: hovered
          ? '0 3px 10px rgba(0,0,0,0.10)'
          : '0 1px 3px rgba(0,0,0,0.05)',
        opacity: completed ? 0.5 : 1,
        transition: 'background 0.1s, box-shadow 0.12s, border-color 0.12s',
        minHeight: '44px',
        cursor: 'default',
      }}
    >
      {/* Star indicator */}
      <div style={{
        width: '28px', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {task.is_urgent
          ? <Star size={11} fill="#C49A28" color="#C49A28" />
          : <div style={{ width: '11px' }} />
        }
      </div>

      {/* Title + note */}
      <div style={{ flex: 1, minWidth: 0, padding: '7px 8px 7px 0' }}>
        <div style={{
          fontSize: '13px',
          fontWeight: task.is_urgent ? 600 : 500,
          color: titleColor,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: completed ? 'line-through' : 'none',
          letterSpacing: '-0.01em',
        }}>
          {task.title}
        </div>
        {task.note && (
          <div style={{
            fontSize: '11px', color: colors.muted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginTop: '2px',
          }}>
            {task.note}
          </div>
        )}
      </div>

      {/* Due date */}
      <div style={{ flexShrink: 0, padding: '0 10px 0 4px' }}>
        {dateStr ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '11.5px', fontWeight: overdue ? 600 : 500,
            color: overdue ? colors.red : colors.secondary,
            background: overdue ? `${colors.red}0e` : 'transparent',
            border: `1px solid ${overdue ? colors.red + '30' : 'transparent'}`,
            padding: '2px 6px', borderRadius: '4px',
            whiteSpace: 'nowrap',
          }}>
            {overdue && <AlertCircle size={9} />}
            {dateStr}
          </span>
        ) : (
          <span style={{ fontSize: '11px', color: colors.muted, padding: '0 6px' }}>—</span>
        )}
      </div>

      {/* Priority */}
      <div style={{ flexShrink: 0, width: '44px', textAlign: 'center', padding: '0 8px' }}>
        <span style={{
          fontSize: '10px', fontWeight: 600,
          color: priority.color, opacity: 0.8,
        }}>
          {priority.label}
        </span>
      </div>

      {/* Open button */}
      <div style={{ flexShrink: 0, paddingRight: '12px', paddingLeft: '6px' }}>
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
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '48px 24px', gap: '6px',
    }}>
      <span style={{
        width: '32px', height: '32px', borderRadius: '50%',
        background: 'rgba(0,0,0,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: '4px',
      }}>
        <CheckCircle2 size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>
        No {label} tasks
      </span>
      <span style={{ fontSize: '12px', color: colors.muted }}>
        You&apos;re all clear here.
      </span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function MyTasksPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [allTasks,     setAllTasks]     = useState<Task[]>([])
  const [userId,       setUserId]       = useState<string>('')
  const [loading,      setLoading]      = useState(true)
  const [activeTab,    setActiveTab]    = useState<TabKey>('all')
  const [taskType,     setTaskType]     = useState<TaskType>('all')
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
      setUserId(uid)
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

  const baseTasks = useMemo(() => {
    if (taskType === 'self')      return allTasks.filter(t => t.created_by === userId)
    if (taskType === 'delegated') return allTasks.filter(t => t.created_by !== userId)
    return allTasks
  }, [allTasks, taskType, userId])

  const buckets = useMemo(() => {
    const sortImportantFirst = (arr: Task[]) =>
      [...arr].sort((a, b) => (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0))

    // "All" shows active tasks only — completed tasks are only visible in the Completed tab
    const all            = sortImportantFirst(baseTasks.filter(t => t.status !== 'completed'))
    const important      = sortImportantFirst(baseTasks.filter(t => t.is_urgent && t.status !== 'completed'))
    const unacknowledged = sortImportantFirst(baseTasks.filter(isUnacknowledged))
    const in_progress    = sortImportantFirst(baseTasks.filter(t =>
      !isOverdue(t) && t.status !== 'completed' && ['started', 'working', 'pending'].includes(t.status)
    ))
    const overdue        = sortImportantFirst(baseTasks.filter(isOverdue))
    const needs_update   = sortImportantFirst(baseTasks.filter(needsUpdate))
    const non_completion = sortImportantFirst(baseTasks.filter(isNonCompletion))
    const completed      = baseTasks.filter(t => t.status === 'completed')

    return { all, important, unacknowledged, in_progress, overdue, needs_update, non_completion, completed }
  }, [baseTasks])

  const counts: Record<TabKey, number> = {
    all:            buckets.all.length,
    important:      buckets.important.length,
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

        {/* ── Two-column workspace ── */}
        <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>

          {/* ── Left: task list ── */}
          <div style={{ flex: 7, minWidth: 0 }}>

            {/* Mobile: horizontal chip tab scroll */}
            {isMobile && (
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
            )}

            {/* Page title + task-type filter cards */}
            <div style={{ marginBottom: '14px' }}>
              <div style={{
                fontSize: '15px', fontWeight: 700, color: colors.primary,
                letterSpacing: '-0.02em', marginBottom: '10px',
              }}>
                My Tasks
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(
                  [
                    { key: 'all' as TaskType,       label: 'View All',   count: allTasks.length                                        },
                    { key: 'self' as TaskType,      label: 'Self Tasks', count: allTasks.filter(t => t.created_by === userId).length   },
                    { key: 'delegated' as TaskType, label: 'Delegated',  count: allTasks.filter(t => t.created_by !== userId).length   },
                  ]
                ).map(item => {
                  const isActive = taskType === item.key
                  return (
                    <button
                      key={item.key}
                      onClick={() => { setTaskType(item.key); setActiveTab('all'); setSelectedTask(null); setSearch(''); setFilterStatus(''); setFilterPriority('') }}
                      style={{
                        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                        padding: '9px 13px',
                        background: isActive ? colors.base : colors.raised,
                        border: `1.5px solid ${isActive ? colors.secondary + '80' : colors.border}`,
                        borderRadius: '8px',
                        boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                        cursor: 'pointer', outline: 'none', transition: 'all 0.12s', textAlign: 'left',
                      }}
                    >
                      <span style={{
                        fontSize: '16px', fontWeight: 700,
                        color: isActive ? colors.primary : colors.muted,
                        lineHeight: 1.2,
                      }}>
                        {item.count}
                      </span>
                      <span style={{
                        fontSize: '11px', fontWeight: isActive ? 600 : 500,
                        color: isActive ? colors.secondary : colors.muted,
                        marginTop: '2px',
                      }}>
                        {item.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Search + filters */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Search tasks…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  flex: 1, minWidth: '160px', padding: '6px 10px',
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

            {/* Task cards */}
            {visibleTasks.length === 0 ? (
              <EmptyState label={TABS.find(t => t.key === activeTab)!.label} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {visibleTasks.map(task => (
                  <TaskCard
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
                  padding: '4px 4px', fontSize: '11px', color: colors.muted,
                }}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>

          {/* ── Right: summary panel (desktop only) ── */}
          {!isMobile && (
            <RightPanel
              counts={counts}
              activeTab={activeTab}
              onTabChange={handleTabChange}
            />
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
