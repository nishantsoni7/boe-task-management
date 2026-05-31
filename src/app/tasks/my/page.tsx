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
  LayoutList, UserCheck, Users, Search, Pencil, Trash2,
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
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
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
        {TABS.filter(t => t.key !== 'completed').map((item, i, arr) => {
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
                borderBottom: i < arr.length - 1 ? `1px solid ${colors.border}` : 'none',
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
  task, accentColor, userId, userMap, onClick, onView, onEdit, onDelete,
}: {
  task: Task
  accentColor: string
  userId: string
  userMap: Record<string, string>
  onClick: () => void
  onView: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const [hovered,     setHovered]     = useState(false)
  const [hoveredEdit, setHoveredEdit] = useState(false)
  const [hoveredDel,  setHoveredDel]  = useState(false)
  const [hoveredView, setHoveredView] = useState(false)
  const overdue    = isOverdue(task)
  const completed  = task.status === 'completed'
  const priority   = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const dateStr    = formatDate(task.due_date)
  const isSelf     = task.created_by === userId
  const assignerName = isSelf ? null : (userMap[task.created_by] ?? 'member')

  const isImportant = task.is_urgent && !completed

  const cardBackground = completed
    ? colors.base
    : isImportant
      ? (hovered ? 'rgba(196,154,40,0.08)' : 'rgba(196,154,40,0.04)')
      : (hovered ? colors.raised : colors.base)

  const cardBorder = isImportant
    ? `1.5px solid rgba(196,154,40,${hovered ? '0.40' : '0.20'})`
    : `1.5px solid ${colors.border}`

  const titleColor = completed ? colors.muted : colors.primary

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center',
        background: cardBackground,
        border: cardBorder,
        borderRadius: '8px',
        boxShadow: hovered
          ? '0 2px 8px rgba(0,0,0,0.09)'
          : isImportant
            ? '0 1px 4px rgba(196,154,40,0.08)'
            : '0 1px 3px rgba(0,0,0,0.04)',
        opacity: completed ? 0.5 : 1,
        transition: 'background 0.12s, box-shadow 0.12s, border-color 0.12s',
        minHeight: '48px',
        cursor: 'pointer',
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
      <div style={{ flex: 1, minWidth: 0, padding: '10px 8px 10px 0' }}>
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

      {/* Assigned by — fixed 140px */}
      <div style={{
        flexShrink: 0, width: '140px',
        display: 'flex', alignItems: 'center',
        paddingLeft: '8px', paddingRight: '6px',
        overflow: 'hidden',
      }}>
        <span
          title={isSelf ? 'Assigned by you' : `Assigned by ${assignerName}`}
          style={{
            display: 'inline-block',
            maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: '10.5px', fontWeight: 600,
            padding: '1px 7px', borderRadius: '20px',
            ...(isSelf
              ? { color: colors.muted,  background: 'rgba(0,0,0,0.05)'           }
              : { color: '#6B4FA0',     background: 'rgba(155,111,212,0.10)'     }
            ),
          }}
        >
          {isSelf ? 'By you' : assignerName}
        </span>
      </div>

      {/* Priority — fixed 52px */}
      <div style={{
        flexShrink: 0, width: '52px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.85 }}>
          {priority.label}
        </span>
      </div>

      {/* Due date — fixed 106px */}
      <div style={{
        flexShrink: 0, width: '106px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {dateStr ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '11px', fontWeight: overdue ? 600 : 500,
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
          <span style={{ fontSize: '11px', color: colors.muted }}>—</span>
        )}
      </div>

      {/* Actions */}
      <div style={{
        flexShrink: 0, width: '84px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '2px',
      }}>
        {isSelf ? (
          <>
            <button
              onClick={e => { e.stopPropagation(); onEdit?.() }}
              onMouseEnter={() => setHoveredEdit(true)}
              onMouseLeave={() => setHoveredEdit(false)}
              title="Edit task"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '26px', height: '26px', borderRadius: '6px',
                background: hoveredEdit ? 'rgba(91,127,166,0.10)' : 'transparent',
                border: `1px solid ${hoveredEdit ? 'rgba(91,127,166,0.30)' : 'transparent'}`,
                cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
                color: hoveredEdit ? '#5B7FA6' : colors.muted,
              }}
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); onDelete?.() }}
              onMouseEnter={() => setHoveredDel(true)}
              onMouseLeave={() => setHoveredDel(false)}
              title="Delete task"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '26px', height: '26px', borderRadius: '6px',
                background: hoveredDel ? `${colors.red}10` : 'transparent',
                border: `1px solid ${hoveredDel ? colors.red + '30' : 'transparent'}`,
                cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
                color: hoveredDel ? colors.red : colors.muted,
              }}
            >
              <Trash2 size={11} />
            </button>
          </>
        ) : (
          <>
            <div style={{ width: '26px', height: '26px', flexShrink: 0 }} />
            <div style={{ width: '26px', height: '26px', flexShrink: 0 }} />
          </>
        )}
        <button
          onClick={e => { e.stopPropagation(); onView() }}
          onMouseEnter={() => setHoveredView(true)}
          onMouseLeave={() => setHoveredView(false)}
          title="Open full page"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', borderRadius: '6px',
            background: hoveredView ? `${accentColor}14` : 'transparent',
            border: `1px solid ${hoveredView ? accentColor + '44' : 'transparent'}`,
            cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
            color: hoveredView ? accentColor : colors.muted,
          }}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Edit modal ───────────────────────────────────────────────────────────────
const PRIORITIES_EDIT = ['low', 'medium', 'high'] as const

function EditTaskModal({
  task, userId, onClose, onSaved,
}: {
  task: Task
  userId: string
  onClose: () => void
  onSaved: (updated: Task) => void
}) {
  const [title,    setTitle]    = useState(task.title)
  const [note,     setNote]     = useState(task.note ?? '')
  const [priority, setPriority] = useState(task.priority)
  const [dueDate,  setDueDate]  = useState((task.due_date ?? '').slice(0, 10))
  const [isUrgent, setIsUrgent] = useState(task.is_urgent ?? false)
  const [saving,   setSaving]   = useState(false)
  const supabase = useMemo(() => createClient(), [])

  const canSave = !saving && title.trim().length > 0

  const handleSave = async () => {
    if (task.created_by !== userId) return
    if (!canSave) return
    setSaving(true)
    const { data, error } = await supabase
      .from('tasks')
      .update({
        title:     title.trim(),
        note:      note.trim() || null,
        priority,
        due_date:  dueDate || null,
        is_urgent: isUrgent,
      })
      .eq('id', task.id)
      .eq('created_by', userId)
      .select()
      .single()
    if (!error && data) onSaved(data as unknown as Task)
    setSaving(false)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: colors.base, border: `1.5px solid ${colors.border}`,
          borderRadius: '12px', padding: '20px 20px 16px',
          width: '100%', maxWidth: '440px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, marginBottom: '16px' }}>
          Edit Task
        </div>

        {/* Title */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Task Name <span style={{ color: colors.red }}>*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="boe-input"
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        {/* Note */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Note <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            className="boe-input"
            style={{ resize: 'none', width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        {/* Priority + Due Date */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>Priority</label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {PRIORITIES_EDIT.map(p => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`boe-chip${priority === p ? ' boe-chip-selected' : ''}`}
                  style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize', fontSize: '10px', padding: '3px 0' }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>Due Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="boe-input"
              style={{ colorScheme: 'light', width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        </div>

        {/* Important toggle */}
        <div
          onClick={() => setIsUrgent(!isUrgent)}
          style={{
            marginBottom: '16px', padding: '8px 12px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderRadius: '8px',
            background: isUrgent ? 'rgba(196,154,40,0.06)' : colors.raised,
            border: `1px solid ${isUrgent ? 'rgba(196,154,40,0.3)' : colors.border}`,
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: isUrgent ? '#C49A28' : colors.primary }}>
            Mark Important
          </span>
          <div style={{
            width: '30px', height: '17px', borderRadius: '9px',
            background: isUrgent ? '#C49A28' : colors.float,
            position: 'relative', flexShrink: 0,
            transition: 'background 0.16s', border: `1px solid ${colors.border}`,
          }}>
            <div style={{
              position: 'absolute', top: '1.5px',
              left: isUrgent ? '12px' : '1.5px',
              width: '12px', height: '12px',
              borderRadius: '50%', background: '#fff',
              transition: 'left 0.16s',
            }} />
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 16px', borderRadius: '7px', border: `1px solid ${colors.border}`,
              background: 'transparent', cursor: 'pointer',
              fontSize: '12px', fontWeight: 600, color: colors.secondary,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{
              padding: '7px 18px', borderRadius: '7px', border: 'none',
              background: canSave ? colors.primary : colors.float,
              color: canSave ? '#fff' : colors.muted,
              cursor: canSave ? 'pointer' : 'not-allowed',
              fontSize: '12px', fontWeight: 600,
              transition: 'background 0.12s',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
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
  const [userMap,      setUserMap]      = useState<Record<string, string>>({})
  const [loading,      setLoading]      = useState(true)
  const [activeTab,    setActiveTab]    = useState<TabKey>('all')
  const [taskType,     setTaskType]     = useState<TaskType>('all')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [editingTask,  setEditingTask]  = useState<Task | null>(null)
  const [isMobile,     setIsMobile]     = useState(false)

  // Search + filter state
  const [search,           setSearch]           = useState('')
  const [filterStatus,     setFilterStatus]     = useState('')
  const [filterPriority,   setFilterPriority]   = useState('')
  const [filterAssignedBy, setFilterAssignedBy] = useState('')

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
      const [{ data: profileData }, { data: tasks }, { data: userData }] = await Promise.all([
        supabase.from('users').select('id, full_name, email, phone, role, team, is_active, created_at').eq('id', uid).single(),
        supabase.from('tasks').select(TASK_COLUMNS).eq('assigned_to', uid).order('due_date', { ascending: true, nullsFirst: false }),
        supabase.from('users').select('id, full_name'),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      setAllTasks((tasks ?? []) as unknown as Task[])
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

  const handleEditSaved = (updated: Task) => {
    setAllTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
    setEditingTask(null)
  }

  const handleAddUpdate = async (note: string, newStatus: string) => {
    if (!selectedTask) return
    const now = new Date().toISOString()
    const statusChanged = newStatus !== selectedTask.status
    const trimmedNote = note.trim() || null

    if (statusChanged) {
      const taskUpdates: Record<string, unknown> = { status: newStatus, last_update_at: now }
      const { error: taskErr } = await supabase
        .from('tasks').update(taskUpdates).eq('id', selectedTask.id)
      if (taskErr) {
        console.error('[addUpdate] tasks update failed:', taskErr.message)
        throw taskErr
      }

      const { error: logErr } = await supabase
        .from('task_activity_log')
        .insert({
          task_id:     selectedTask.id,
          actor_id:    userId,
          action:      'status_changed',
          from_status: selectedTask.status,
          to_status:   newStatus,
          note:        trimmedNote,
        })
      if (logErr) {
        console.error('[addUpdate] activity log insert failed:', logErr.message)
        throw logErr
      }

      setSelectedTask(prev => prev ? { ...prev, status: newStatus as any, last_update_at: now } : prev)
      setAllTasks(prev => prev.map(t =>
        t.id === selectedTask.id ? { ...t, status: newStatus as any, last_update_at: now } : t
      ))
    } else if (trimmedNote) {
      const { error: taskErr } = await supabase
        .from('tasks').update({ last_update_at: now }).eq('id', selectedTask.id)
      if (taskErr) {
        console.error('[addUpdate] tasks update failed:', taskErr.message)
        throw taskErr
      }

      const { error: logErr } = await supabase
        .from('task_activity_log')
        .insert({
          task_id:     selectedTask.id,
          actor_id:    userId,
          action:      'status_changed',
          from_status: selectedTask.status,
          to_status:   selectedTask.status,
          note:        trimmedNote,
        })
      if (logErr) {
        console.error('[addUpdate] activity log insert failed:', logErr.message)
        throw logErr
      }

      setAllTasks(prev => prev.map(t =>
        t.id === selectedTask.id ? { ...t, last_update_at: now } : t
      ))
    }
  }

  const handleDelete = async (task: Task) => {
    if (task.created_by !== userId) return
    const ok = window.confirm('Delete this task? This cannot be undone.')
    if (!ok) return
    const { data: deleted, error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', task.id)
      .select('id')
    if (error) {
      console.error('[delete] Supabase error:', error.message, error)
      return
    }
    if (!deleted || deleted.length === 0) {
      console.warn('[delete] No rows deleted — RLS or policy blocked deletion for task', task.id)
      return
    }
    setAllTasks(prev => prev.filter(t => t.id !== task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
  }

  const baseTasks = useMemo(() => {
    if (taskType === 'self')      return allTasks.filter(t => t.created_by === userId)
    if (taskType === 'delegated') return allTasks.filter(t => t.created_by !== userId)
    return allTasks
  }, [allTasks, taskType, userId])

  const assignerOptions = useMemo(() => {
    const ids = [...new Set(baseTasks.map(t => t.created_by))]
    const others = ids
      .filter(id => id !== userId)
      .map(id => ({ value: id, label: userMap[id] ?? 'Unknown' }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return taskType === 'all'
      ? [{ value: userId, label: 'You' }, ...others]
      : others
  }, [baseTasks, taskType, userId, userMap])

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
    if (filterAssignedBy) tasks = tasks.filter(t => t.created_by === filterAssignedBy)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      tasks = tasks.filter(t => t.title.toLowerCase().includes(q))
    }
    if (filterStatus)   tasks = tasks.filter(t => t.status === filterStatus)
    if (filterPriority) tasks = tasks.filter(t => t.priority === filterPriority)
    return tasks
  }, [buckets, activeTab, search, filterStatus, filterPriority, filterAssignedBy])

  function handleTabChange(key: TabKey) {
    setActiveTab(key)
    setSelectedTask(null)
    setSearch('')
    setFilterStatus('')
    setFilterPriority('')
    // Note: intentionally NOT resetting filterAssignedBy here — tab changes stay within same task type
  }

  const activeTabColor = TABS.find(t => t.key === activeTab)?.color ?? colors.secondary

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout profile={profile} title="My Tasks" onSignOut={handleLogout}>

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
                {TABS.filter(t => t.key !== 'completed').map(tab => (
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

            {/* Task-type filter cards */}
            {(() => {
              const TYPE_CARDS: { key: TaskType; label: string; Icon: React.ElementType; accent: string }[] = [
                { key: 'all',       label: 'View All',   Icon: LayoutList, accent: '#5B7FA6' },
                { key: 'self',      label: 'Self Tasks', Icon: UserCheck,  accent: '#2E9E6B' },
                { key: 'delegated', label: 'Delegated',  Icon: Users,      accent: '#9B6FD4' },
              ]
              const typeCounts: Record<TaskType, number> = {
                all:       allTasks.filter(t => t.status !== 'completed').length,
                self:      allTasks.filter(t => t.created_by === userId && t.status !== 'completed').length,
                delegated: allTasks.filter(t => t.created_by !== userId && t.status !== 'completed').length,
              }
              return (
                <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                  {TYPE_CARDS.map(item => {
                    const isActive = taskType === item.key
                    const { Icon } = item
                    return (
                      <button
                        key={item.key}
                        onClick={() => { setTaskType(item.key); setActiveTab('all'); setSelectedTask(null); setSearch(''); setFilterStatus(''); setFilterPriority(''); setFilterAssignedBy('') }}
                        style={{
                          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                          padding: '9px 12px',
                          background: isActive ? colors.base : colors.raised,
                          border: `1.5px solid ${isActive ? item.accent + '70' : colors.border}`,
                          borderTop: isActive ? `2.5px solid ${item.accent}` : `1.5px solid ${colors.border}`,
                          borderRadius: '8px',
                          boxShadow: isActive ? `0 2px 6px ${item.accent}18` : 'none',
                          cursor: 'pointer', outline: 'none', transition: 'all 0.12s', textAlign: 'left',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
                          <Icon size={13} color={isActive ? item.accent : colors.muted} />
                          <span style={{
                            fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            color: isActive ? item.accent : colors.muted,
                          }}>
                            {item.label}
                          </span>
                        </div>
                        <span style={{
                          fontSize: '18px', fontWeight: 700,
                          color: isActive ? colors.primary : colors.muted,
                          lineHeight: 1,
                        }}>
                          {typeCounts[item.key]}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })()}

            {/* Search + filter toolbar */}
            <div style={{
              background: colors.raised,
              border: `1.5px solid ${colors.border}`,
              borderRadius: '8px',
              padding: '8px 10px',
              marginBottom: '10px',
              display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
            }}>
              <Search size={13} color={colors.muted} style={{ flexShrink: 0 }} />
              <input
                type="text"
                placeholder="Find tasks…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  flex: 1, minWidth: '140px', padding: '4px 6px',
                  background: 'transparent', border: 'none',
                  outline: 'none',
                  fontSize: '12px', color: colors.primary,
                }}
              />
              {taskType !== 'self' && assignerOptions.length > 0 && (
                <select
                  value={filterAssignedBy}
                  onChange={e => setFilterAssignedBy(e.target.value)}
                  style={{
                    padding: '4px 10px',
                    minWidth: '130px',
                    background: colors.base, border: `1px solid ${colors.border}`,
                    borderRadius: '6px', outline: 'none',
                    fontSize: '11.5px', color: filterAssignedBy ? colors.primary : colors.muted,
                    cursor: 'pointer',
                  }}
                >
                  <option value="">All Assigners</option>
                  {assignerOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              )}
              <select
                value={filterPriority}
                onChange={e => setFilterPriority(e.target.value)}
                style={{
                  padding: '4px 10px',
                  minWidth: '110px',
                  background: colors.base, border: `1px solid ${colors.border}`,
                  borderRadius: '6px', outline: 'none',
                  fontSize: '11.5px', color: filterPriority ? colors.primary : colors.muted,
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {visibleTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    accentColor={activeTabColor}
                    userId={userId}
                    userMap={userMap}
                    onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                    onView={() => router.push(`/tasks/${task.id}`)}
                    onEdit={task.created_by === userId ? () => setEditingTask(task) : undefined}
                    onDelete={task.created_by === userId ? () => handleDelete(task) : undefined}
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

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={userId}
          onAddUpdate={handleAddUpdate}
        />
      )}

      {editingTask && (
        <EditTaskModal
          task={editingTask}
          userId={userId}
          onClose={() => setEditingTask(null)}
          onSaved={handleEditSaved}
        />
      )}
    </>
  )
}
