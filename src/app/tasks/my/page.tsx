'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import {
  AlertTriangle,
  Users,
  RefreshCw,
  TimerReset,
  ShieldAlert,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react'
import {
  statusBadgeClass,
  formatShortDate,
  timeAgo,
} from '@/lib/ui'

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
function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

// ─── Section config ───────────────────────────────────────────────────────────
type TabKey = 'overdue' | 'waiting' | 'active' | 'needs_update' | 'non_completion'

const TABS: {
  key: TabKey; label: string; shortLabel: string
  Icon: LucideIcon; description: string
}[] = [
  { key: 'overdue',        label: 'Overdue',             shortLabel: 'Overdue',     Icon: AlertTriangle, description: 'Needs attention'  },
  { key: 'waiting',        label: 'Waiting For Others',  shortLabel: 'Waiting',     Icon: Users,         description: 'Delegated tasks'  },
  { key: 'active',         label: 'My Active Work',      shortLabel: 'Active',      Icon: RefreshCw,     description: 'In progress'      },
  { key: 'needs_update',   label: 'Needs Update (48h+)', shortLabel: '48h+',        Icon: TimerReset,    description: 'Awaiting update'  },
  { key: 'non_completion', label: 'Non Completion Zone', shortLabel: 'Non-Compl.',  Icon: ShieldAlert,   description: 'Escalated tasks'  },
]

const TAB_COLORS: Record<TabKey, string> = {
  overdue:        colors.red,
  waiting:        colors.amber,
  active:         colors.blue,
  needs_update:   '#9B6FD4',
  non_completion: colors.secondary,
}

// ─── Priority pill config ─────────────────────────────────────────────────────
const PRIORITY_PILL: Record<string, { label: string; fg: string; bg: string }> = {
  high:   { label: 'High',   fg: '#C0392B', bg: 'rgba(192,57,43,0.09)'  },
  medium: { label: 'Medium', fg: '#D4831A', bg: 'rgba(212,131,26,0.09)' },
  low:    { label: 'Low',    fg: colors.muted, bg: 'rgba(0,0,0,0.04)'   },
}

// ─── Desktop summary card ─────────────────────────────────────────────────────
function SummaryCard({
  tab, count, isActive, onClick,
}: { tab: typeof TABS[number]; count: number; isActive: boolean; onClick: () => void }) {
  const accent = TAB_COLORS[tab.key]
  const { Icon } = tab
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, minWidth: '130px',
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '9px 12px',
        background: isActive ? `${accent}0E` : colors.base,
        border: isActive ? `2px solid ${accent}` : `1.5px solid ${colors.border}`,
        borderRadius: '9px', cursor: 'pointer', textAlign: 'left',
        transition: 'all 0.15s', outline: 'none',
        boxShadow: isActive
          ? `0 0 0 3px ${accent}18, 0 1px 4px rgba(0,0,0,0.06)`
          : '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      <span style={{
        width: '30px', height: '30px', borderRadius: '7px',
        background: isActive ? `${accent}22` : `${accent}14`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, transition: 'background 0.15s',
      }}>
        <Icon size={14} color={accent} strokeWidth={2} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', marginBottom: '1px' }}>
          <span style={{
            fontSize: '16px', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em',
            color: isActive ? accent : colors.primary, transition: 'color 0.15s',
          }}>
            {count}
          </span>
          <span style={{
            fontSize: '10px', fontWeight: 500, letterSpacing: '0.01em',
            color: isActive ? accent : colors.secondary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            transition: 'color 0.15s',
          }}>
            {tab.label}
          </span>
        </div>
        <div style={{ fontSize: '10px', color: colors.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {tab.description}
        </div>
      </span>
    </button>
  )
}

// ─── Mobile chip tab ──────────────────────────────────────────────────────────
function ChipTab({
  tab, count, isActive, onClick,
}: { tab: typeof TABS[number]; count: number; isActive: boolean; onClick: () => void }) {
  const accent = TAB_COLORS[tab.key]
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '5px',
        padding: '5px 12px',
        background: isActive ? accent : colors.base,
        border: `1.5px solid ${isActive ? accent : colors.border}`,
        borderRadius: '20px', cursor: 'pointer', whiteSpace: 'nowrap',
        flexShrink: 0, outline: 'none', transition: 'all 0.15s',
      }}
    >
      <span style={{
        fontSize: '12px', fontWeight: 600,
        color: isActive ? '#fff' : colors.secondary,
      }}>
        {tab.shortLabel}
      </span>
      <span style={{
        fontSize: '11px', fontWeight: 700,
        color: isActive ? 'rgba(255,255,255,0.85)' : colors.muted,
      }}>
        {count}
      </span>
    </button>
  )
}

// ─── Table header ─────────────────────────────────────────────────────────────
function TableHeader() {
  const col = (label: string, width?: number, align: 'left' | 'right' | 'center' = 'left') => (
    <div style={{
      fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: colors.muted,
      width, flex: width ? undefined : 1,
      textAlign: align, padding: '0 8px', whiteSpace: 'nowrap',
    }}>
      {label}
    </div>
  )
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '7px 12px', borderBottom: `1px solid ${colors.border}`,
      background: colors.raised,
    }}>
      <div style={{ width: '12px', flexShrink: 0 }} />
      {col('Task')}
      {col('Priority', 72, 'center')}
      {col('Due Date', 84, 'right')}
      <div style={{ width: '20px', flexShrink: 0 }} />
    </div>
  )
}

// ─── Task row ─────────────────────────────────────────────────────────────────
function TaskRow({
  task, isSelected, accentColor, onClick,
}: { task: Task; isSelected: boolean; accentColor: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  const overdue = isOverdue(task)
  const pill    = PRIORITY_PILL[task.priority] ?? PRIORITY_PILL.low

  return (
    <div
      role="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 12px',
        borderBottom: `1px solid ${colors.border}`,
        cursor: 'pointer', minHeight: '44px',
        background: isSelected ? `${accentColor}0A` : hovered ? colors.raised : colors.base,
        borderLeft: isSelected
          ? `3px solid ${accentColor}`
          : overdue ? `3px solid ${colors.red}44` : '3px solid transparent',
        transition: 'background 0.1s',
      }}
    >
      {/* Important star */}
      <div style={{ width: '12px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {task.is_urgent && (
          <span style={{ fontSize: '9px', lineHeight: 1, color: '#C49A28' }}>⭐</span>
        )}
      </div>
      {/* Title + badges */}
      <div style={{ flex: 1, minWidth: 0, padding: '0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          fontSize: '13px', fontWeight: isSelected ? 600 : 500, letterSpacing: '-0.01em',
          color: overdue ? colors.red : colors.primary,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {task.title}
        </span>
        {task.status === 'blocked' && (
          <span style={{ fontSize: '10px', fontWeight: 600, flexShrink: 0, color: colors.red, background: 'rgba(217,79,79,0.1)', padding: '1px 6px', borderRadius: '4px' }}>
            Blocked
          </span>
        )}
        {task.status === 'waiting' && (
          <span style={{ fontSize: '10px', fontWeight: 600, flexShrink: 0, color: colors.amber, background: 'rgba(232,160,48,0.1)', padding: '1px 6px', borderRadius: '4px' }}>
            Waiting
          </span>
        )}
        {task.type === 'daily_update' && (
          <span style={{ fontSize: '10px', fontWeight: 500, flexShrink: 0, color: colors.muted, background: 'rgba(0,0,0,0.05)', padding: '1px 6px', borderRadius: '4px' }}>
            Daily
          </span>
        )}
      </div>
      {/* Priority */}
      <div style={{ width: '72px', display: 'flex', justifyContent: 'center', padding: '0 4px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: pill.fg, background: pill.bg, padding: '2px 8px', borderRadius: '5px', whiteSpace: 'nowrap' }}>
          {pill.label}
        </span>
      </div>
      {/* Due date */}
      <div style={{ width: '84px', textAlign: 'right', padding: '0 4px' }}>
        <span style={{ fontSize: '12px', fontWeight: overdue ? 600 : 400, color: overdue ? colors.red : colors.secondary, letterSpacing: '-0.01em' }}>
          {formatDate(task.due_date)}
        </span>
      </div>
      {/* Arrow */}
      <div style={{ width: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: '15px', color: colors.muted, opacity: hovered || isSelected ? 0.7 : 0.25, transition: 'opacity 0.1s' }}>›</span>
      </div>
    </div>
  )
}

// ─── Inline preview panel (desktop) ──────────────────────────────────────────
function InlinePreview({ task, onClose }: { task: Task; onClose: () => void }) {
  const router  = useRouter()
  const overdue = isOverdue(task)
  const pill    = PRIORITY_PILL[task.priority] ?? PRIORITY_PILL.low

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: '8px', padding: '7px 0', borderBottom: `1px solid ${colors.border}` }}>
      <span style={{ fontSize: '11px', color: colors.muted, width: '100px', flexShrink: 0, paddingTop: '1px' }}>{label}</span>
      <span style={{ fontSize: '12px', color: colors.primary, flex: 1 }}>{value}</span>
    </div>
  )

  return (
    <div style={{
      width: '340px', flexShrink: 0,
      background: colors.base,
      border: `1.5px solid ${colors.border}`,
      borderRadius: '10px',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      position: 'sticky', top: '16px',
      alignSelf: 'flex-start',
      maxHeight: 'calc(100vh - 120px)',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.raised,
        display: 'flex', alignItems: 'flex-start', gap: '10px',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '13px', fontWeight: 600, color: overdue ? colors.red : colors.primary,
            lineHeight: 1.35, letterSpacing: '-0.01em',
            marginBottom: '6px',
          }}>
            {task.title}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={statusBadgeClass(task.status)} />
            {task.is_urgent && (
              <span style={{ fontSize: '10px', fontWeight: 600, color: '#C49A28', background: 'rgba(196,154,40,0.1)', padding: '1px 7px', borderRadius: '4px' }}>
                ⭐ Important
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '18px', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
          title="Close preview"
        >
          ×
        </button>
      </div>

      {/* Detail rows */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
        {row('Priority',
          <span style={{ fontSize: '11px', fontWeight: 600, color: pill.fg, background: pill.bg, padding: '2px 8px', borderRadius: '4px' }}>
            {pill.label}
          </span>
        )}
        {row('Due Date',
          <span style={{ color: overdue ? colors.red : colors.primary, fontWeight: overdue ? 600 : 400 }}>
            {task.due_date ? formatShortDate(task.due_date) : '—'}
            {overdue && <span style={{ fontSize: '10px', color: colors.red, marginLeft: '5px' }}>Overdue</span>}
          </span>
        )}
        {row('Type', task.type === 'daily_update' ? 'Daily Update' : 'Task')}
        {row('Team', task.team || '—')}
        {task.last_update_at && row('Last Update', timeAgo(task.last_update_at))}
        {task.blocker_reason && row('Blocker',
          <span style={{ color: colors.red }}>{task.blocker_reason}</span>
        )}
        {task.note && (
          <div style={{ padding: '10px 0', borderBottom: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '4px' }}>Note</div>
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {task.note}
            </div>
          </div>
        )}
        <div style={{ height: '12px' }} />
      </div>

      {/* Footer CTA */}
      <div style={{
        padding: '12px 16px',
        borderTop: `1px solid ${colors.border}`,
        background: colors.raised,
      }}>
        <button
          onClick={() => router.push(`/tasks/${task.id}`)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            padding: '8px 16px',
            background: colors.base,
            border: `1.5px solid ${colors.borderSoft}`,
            borderRadius: '7px', cursor: 'pointer',
            fontSize: '12px', fontWeight: 600, color: colors.secondary,
            transition: 'all 0.12s',
          }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.borderColor = colors.blue
            ;(e.currentTarget as HTMLButtonElement).style.color = colors.blue
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.borderColor = colors.borderSoft
            ;(e.currentTarget as HTMLButtonElement).style.color = colors.secondary
          }}
        >
          Open Full Details
          <ExternalLink size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

// ─── Preview placeholder ─────────────────────────────────────────────────────
function PreviewPlaceholder() {
  return (
    <div style={{
      width: '340px', flexShrink: 0,
      background: colors.base,
      border: `1.5px dashed ${colors.border}`,
      borderRadius: '10px',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: '6px',
      padding: '40px 24px',
      position: 'sticky', top: '16px',
      alignSelf: 'flex-start',
      minHeight: '220px',
    }}>
      <span style={{
        width: '36px', height: '36px', borderRadius: '50%',
        background: colors.raised,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: '6px',
      }}>
        <ExternalLink size={15} color={colors.muted} strokeWidth={1.5} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>
        Select a task to preview
      </span>
      <span style={{ fontSize: '11px', color: colors.muted, textAlign: 'center', lineHeight: 1.5 }}>
        Task details will appear here.
      </span>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '52px 24px', gap: '6px' }}>
      <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '4px' }}>
        <RefreshCw size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>No {label} tasks</span>
      <span style={{ fontSize: '12px', color: colors.muted }}>You&apos;re all clear here.</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function MyTasksPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [myTasks,      setMyTasks]      = useState<Task[]>([])
  const [waitingTasks, setWaitingTasks] = useState<Task[]>([])
  const [loading,      setLoading]      = useState(true)
  const [activeTab,    setActiveTab]    = useState<TabKey>('overdue')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [isMobile,     setIsMobile]     = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // Responsive detection — runs only on client
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
      const [{ data: profileData }, { data: mine }, { data: delegated }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, is_active, created_at').eq('id', uid).single(),
        supabase.from('tasks').select(TASK_COLUMNS).eq('assigned_to', uid).not('status', 'eq', 'completed').order('due_date', { ascending: true, nullsFirst: false }),
        supabase.from('tasks').select(TASK_COLUMNS).eq('created_by', uid).neq('assigned_to', uid).not('status', 'eq', 'completed').order('due_date', { ascending: true, nullsFirst: false }),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      if (mine)        setMyTasks(mine as unknown as Task[])
      if (delegated)   setWaitingTasks(delegated as unknown as Task[])
      setLoading(false)
    }
    init()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const buckets = useMemo(() => {
    const overdue:        Task[] = []
    const active:         Task[] = []
    const needs_update:   Task[] = []
    const non_completion: Task[] = []

    for (const t of myTasks) {
      if (isOverdue(t))                                    { overdue.push(t);        continue }
      if (t.status === 'blocked')                          { non_completion.push(t); continue }
      if (needsUpdate(t))                                  { needs_update.push(t);   continue }
      if (['started','working','pending','waiting'].includes(t.status)) { active.push(t) }
    }
    const sortImportantFirst = (arr: Task[]) =>
      [...arr].sort((a, b) => (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0))

    return {
      overdue:        sortImportantFirst(overdue),
      waiting:        sortImportantFirst(waitingTasks),
      active:         sortImportantFirst(active),
      needs_update:   sortImportantFirst(needs_update),
      non_completion: sortImportantFirst(non_completion),
    }
  }, [myTasks, waitingTasks])

  const counts: Record<TabKey, number> = {
    overdue:        buckets.overdue.length,
    waiting:        buckets.waiting.length,
    active:         buckets.active.length,
    needs_update:   buckets.needs_update.length,
    non_completion: buckets.non_completion.length,
  }

  const activeSection = TABS.find(t => t.key === activeTab)!
  const visibleTasks  = buckets[activeTab]
  const accentColor   = TAB_COLORS[activeTab]

  function handleTabChange(key: TabKey) {
    setActiveTab(key)
    setSelectedTask(null)
  }

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="My Tasks"
        subtitle="Today's work overview"
        actions={
          <button onClick={() => router.push('/tasks/create')} className="boe-btn boe-btn-primary">
            + New Task
          </button>
        }
        onSignOut={handleLogout}
      >
        {/* ── Section switcher: cards on desktop, chips on mobile ── */}
        {isMobile ? (
          // Mobile: horizontally scrollable chip tabs
          <div style={{
            display: 'flex', gap: '8px', overflowX: 'auto',
            paddingBottom: '4px', marginBottom: '14px',
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
          // Desktop: summary cards row
          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
            {TABS.map(tab => (
              <SummaryCard
                key={tab.key}
                tab={tab}
                count={counts[tab.key]}
                isActive={activeTab === tab.key}
                onClick={() => handleTabChange(tab.key)}
              />
            ))}
          </div>
        )}

        {/* ── Main content area ─────────────────────────────────── */}
        <div style={{
          display: 'flex',
          gap: '16px',
          alignItems: 'flex-start',
        }}>
          {/* Task list panel */}
          <div style={{
            flex: 1, minWidth: 0,
            background: colors.base,
            border: `1.5px solid ${colors.border}`,
            borderRadius: '10px',
            overflow: 'hidden',
          }}>
            {visibleTasks.length === 0 ? (
              <EmptyState label={activeSection.label} />
            ) : (
              <>
                <TableHeader />
                {visibleTasks.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    isSelected={selectedTask?.id === task.id}
                    accentColor={accentColor}
                    onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                  />
                ))}
                <div style={{
                  padding: '9px 20px', fontSize: '11px', color: colors.muted,
                  borderTop: `1px solid ${colors.border}`, background: colors.raised,
                }}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
              </>
            )}
          </div>

          {/* Desktop: always-visible right column */}
          {!isMobile && (
            selectedTask
              ? <InlinePreview task={selectedTask} onClose={() => setSelectedTask(null)} />
              : <PreviewPlaceholder />
          )}
        </div>
      </DashboardLayout>

      {/* Mobile: use existing slide-in panel */}
      {isMobile && selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </>
  )
}
