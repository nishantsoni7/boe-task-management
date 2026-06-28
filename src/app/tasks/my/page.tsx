'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { getTaskAging } from '@/lib/ui'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { useViewAs } from '@/hooks/useViewAs'
import { useRefresh } from '@/contexts/RefreshContext'
import { useProfile } from '@/hooks/queries/useProfile'
import { useMyTasks, useUserNames } from '@/hooks/queries/useMyTasks'
import {
  CheckCircle2, ExternalLink, Star, AlertCircle,
  LayoutList, UserCheck, Users, Search, Pencil, Trash2, Plus, Pin,
} from 'lucide-react'
import { useTopTasks } from '@/hooks/queries/useTopTasks'
import { useToast, Toast } from '@/components/ui/toast'


function localDateStr(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
// Normalize any due_date format (plain YYYY-MM-DD or full ISO timestamp) to local YYYY-MM-DD
function normalizeDueDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Already a plain date — return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  // Full ISO timestamp — convert to local calendar date
  const d = new Date(raw)
  if (isNaN(d.getTime())) return null
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
const TODAY_STR    = localDateStr(0)
const TOMORROW_STR = localDateStr(1)
const NOW_MS    = Date.now()
const H48       = 48 * 60 * 60 * 1000

function isOverdue(task: Task) {
  const d = normalizeDueDate(task.due_date)
  return !!d && d < TODAY_STR && task.status !== 'completed' && task.status !== 'cancelled'
}
function needsUpdate(task: Task) {
  if (task.status === 'completed' || task.status === 'cancelled') return false
  return NOW_MS - new Date(task.last_update_at ?? task.created_at).getTime() > H48
}
function isUnacknowledged(task: Task) {
  return !task.acknowledged_at && task.status !== 'completed' && task.status !== 'cancelled' && task.created_by !== task.assigned_to
}
function isNonCompletion(task: Task) {
  return isOverdue(task) && needsUpdate(task)
}
function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

// ─── Tab config ───────────────────────────────────────────────────────────────
type TabKey = 'action_required' | 'all' | 'important' | 'unacknowledged' | 'in_progress' | 'overdue' | 'needs_update' | 'non_completion' | 'completed'

const TAB_LABELS: Record<TabKey, string> = {
  action_required: 'Action Required',
  all:             'All Tasks',
  important:       'Important',
  unacknowledged:  'Unacknowledged',
  in_progress:     'In Progress',
  overdue:         'Overdue',
  needs_update:    'Needs Update',
  non_completion:  'Non-Completion',
  completed:       'Completed',
}
type TaskType = 'all' | 'self' | 'delegated'

// ─── Priority config ──────────────────────────────────────────────────────────
const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
  low:    { label: 'Low',  color: colors.muted },
}

// ─── Left sidebar tab ─────────────────────────────────────────────────────────
const TYPE_TABS: { key: TaskType; label: string; Icon: React.ElementType; accent: string }[] = [
  { key: 'all',       label: 'View All',   Icon: LayoutList, accent: '#5B7FA6' },
  { key: 'self',      label: 'Self Tasks', Icon: UserCheck,  accent: '#2E9E6B' },
  { key: 'delegated', label: 'Delegated',  Icon: Users,      accent: '#9B6FD4' },
]

// ─── Task card ────────────────────────────────────────────────────────────────
function TaskCard({
  task, accentColor, userId, userMap, onClick, onView, onEdit, onDelete, isMobile,
  isPinned, onPin, onUnpin,
}: {
  task: Task
  accentColor: string
  userId: string
  userMap: Record<string, string>
  onClick: () => void
  onView: () => void
  onEdit?: () => void
  onDelete?: () => void
  isMobile?: boolean
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
}) {
  const [hovered,     setHovered]     = useState(false)
  const [hoveredEdit, setHoveredEdit] = useState(false)
  const [hoveredDel,  setHoveredDel]  = useState(false)
  const [hoveredView, setHoveredView] = useState(false)
  const [hoveredPin,  setHoveredPin]  = useState(false)
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

  if (isMobile) {
    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
        style={{
          background: cardBackground,
          border: cardBorder,
          borderRadius: '8px',
          opacity: completed ? 0.6 : 1,
          cursor: 'pointer',
          padding: '10px 12px',
        }}
      >
        {/* Row 1: star + title + actions */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
          {task.is_urgent && <Star size={11} fill="#C49A28" color="#C49A28" style={{ marginTop: '2px', flexShrink: 0 }} />}
          <div style={{
            flex: 1, minWidth: 0,
            fontSize: '13px', fontWeight: task.is_urgent ? 600 : 500,
            color: titleColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            textDecoration: completed ? 'line-through' : 'none',
          }}>
            {task.title}
          </div>
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            {(onPin || onUnpin) && (
              <button
                onClick={e => { e.stopPropagation(); isPinned ? onUnpin?.() : onPin?.() }}
                title={isPinned ? 'Remove from Focus' : 'Add to Today\'s Focus'}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: isPinned ? 'rgba(196,154,40,0.10)' : 'transparent', border: `1px solid ${isPinned ? 'rgba(196,154,40,0.3)' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: isPinned ? '#C49A28' : colors.muted }}
              >
                <Pin size={13} />
              </button>
            )}
            {isSelf && (
              <>
                <button onClick={e => { e.stopPropagation(); onEdit?.() }} title="Edit"
                  onMouseEnter={() => setHoveredEdit(true)} onMouseLeave={() => setHoveredEdit(false)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: hoveredEdit ? 'rgba(91,127,166,0.10)' : 'transparent', border: `1px solid ${hoveredEdit ? 'rgba(91,127,166,0.30)' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredEdit ? '#5B7FA6' : colors.muted }}>
                  <Pencil size={13} />
                </button>
                <button onClick={e => { e.stopPropagation(); onDelete?.() }} title="Delete"
                  onMouseEnter={() => setHoveredDel(true)} onMouseLeave={() => setHoveredDel(false)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: hoveredDel ? `${colors.red}10` : 'transparent', border: `1px solid ${hoveredDel ? colors.red + '30' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredDel ? colors.red : colors.muted }}>
                  <Trash2 size={13} />
                </button>
              </>
            )}
            <button onClick={e => { e.stopPropagation(); onView() }} title="View full page"
              onMouseEnter={() => setHoveredView(true)} onMouseLeave={() => setHoveredView(false)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: hoveredView ? `${accentColor}14` : 'transparent', border: `1px solid ${hoveredView ? accentColor + '44' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredView ? accentColor : colors.muted }}>
              <ExternalLink size={13} />
            </button>
          </div>
        </div>
        {/* Row 2: meta badges */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {!isSelf && assignerName && (
            <span style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', color: '#6B4FA0', background: 'rgba(155,111,212,0.10)', whiteSpace: 'nowrap' }}>
              {assignerName}
            </span>
          )}
          <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color }}>{priority.label}</span>
          {dateStr && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10.5px', fontWeight: overdue ? 600 : 500, color: overdue ? colors.red : colors.secondary }}>
              {overdue && <AlertCircle size={9} />}{dateStr}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '28px minmax(300px, 1.4fr) minmax(110px, 0.75fr) minmax(90px, 0.6fr) minmax(80px, 0.5fr) minmax(95px, 0.6fr) minmax(110px, 0.45fr)',
        columnGap: '14px',
        alignItems: 'center',
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
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {task.is_urgent
          ? <Star size={11} fill="#C49A28" color="#C49A28" />
          : <div style={{ width: '11px' }} />
        }
      </div>

      {/* Title */}
      <div style={{ minWidth: 0, padding: '0 8px 0 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          fontSize: '13px',
          fontWeight: task.is_urgent ? 600 : 500,
          color: titleColor,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: completed ? 'line-through' : 'none',
          letterSpacing: '-0.01em',
        }}>
          {task.title}
        </span>
        {isPinned && (
          <span style={{ fontSize: '9px', fontWeight: 700, color: '#92710A', background: 'rgba(196,154,40,0.12)', borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', flexShrink: 0, letterSpacing: '0.02em' }}>
            Today&apos;s Focus
          </span>
        )}
      </div>

      {/* Assigned by */}
      <div style={{
        display: 'flex', alignItems: 'center',
        paddingLeft: '8px', paddingRight: '6px',
        overflow: 'hidden',
      }}>
        <span
          title={isSelf ? 'Self-assigned' : `Assigned by ${assignerName}`}
          style={{
            display: 'inline-block',
            maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: '10.5px', fontWeight: 600,
            padding: '1px 7px', borderRadius: '20px',
            ...(isSelf
              ? { color: colors.muted,  background: 'rgba(0,0,0,0.05)'       }
              : { color: '#6B4FA0',     background: 'rgba(155,111,212,0.10)' }
            ),
          }}
        >
          {isSelf ? 'Self' : assignerName}
        </span>
      </div>

      {/* Due Date */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {task.due_date ? (() => {
          const isToday = task.due_date === TODAY_STR
          const dueDateColor = isOverdue(task) ? colors.red : isToday ? '#E8A030' : colors.secondary
          return (
            <span style={{ fontSize: '11px', color: dueDateColor, whiteSpace: 'nowrap', fontWeight: isOverdue(task) || isToday ? 600 : 400 }}>
              {formatDate(task.due_date)}
            </span>
          )
        })() : (
          <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>No Due Date</span>
        )}
      </div>

      {/* Priority */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.85 }}>
          {priority.label}
        </span>
      </div>

      {/* Status */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span className={`boe-badge boe-badge-${task.status}`} style={{ fontSize: '10px', padding: '3px 9px', textTransform: 'capitalize', fontWeight: 600 }}>
          {task.status}
        </span>
      </div>

      {/* Actions */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '2px',
      }}>
        {/* Pin to Top 3 */}
        {(onPin || onUnpin) && (
          <button
            onClick={e => { e.stopPropagation(); isPinned ? onUnpin?.() : onPin?.() }}
            onMouseEnter={() => setHoveredPin(true)}
            onMouseLeave={() => setHoveredPin(false)}
            title={isPinned ? 'Remove from Focus' : 'Add to Today\'s Focus'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '26px', height: '26px', borderRadius: '6px',
              background: isPinned
                ? 'rgba(196,154,40,0.10)'
                : hoveredPin ? 'rgba(91,127,166,0.10)' : 'transparent',
              border: `1px solid ${isPinned ? 'rgba(196,154,40,0.3)' : hoveredPin ? 'rgba(91,127,166,0.30)' : 'transparent'}`,
              cursor: 'pointer', outline: 'none', transition: 'all 0.12s',
              color: isPinned ? '#C49A28' : hoveredPin ? '#5B7FA6' : colors.muted,
            }}
          >
            <Pin size={11} />
          </button>
        )}
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

// ─── Create Self Task modal ───────────────────────────────────────────────────
const PRIORITIES_MODAL = ['low', 'medium', 'high'] as const

function CreateSelfTaskModal({
  profile,
  onClose,
  onCreated,
}: {
  profile: UserProfile
  onClose: () => void
  onCreated: (task: Task) => void
}) {
  const [title,         setTitle]         = useState('')
  const [description,   setDescription]   = useState('')
  const [priority,      setPriority]      = useState('')
  const [dueDate,       setDueDate]       = useState('')
  const [isUrgent,      setIsUrgent]      = useState(false)
  const [titleDirty,    setTitleDirty]    = useState(false)
  const [dateDirty,     setDateDirty]     = useState(false)
  const [priorityDirty, setPriorityDirty] = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [saveError,     setSaveError]     = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const canSave = !saving && title.trim().length > 0 && dueDate !== '' && priority !== ''

  const handleSubmit = async () => {
    setTitleDirty(true)
    setDateDirty(true)
    setPriorityDirty(true)
    if (!title.trim() || !priority || !dueDate) return
    setSaving(true)
    setSaveError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSaving(false); return }

    const { data: existing } = await supabase
      .from('tasks').select('id, title')
      .eq('assigned_to', profile.id)
      .not('status', 'eq', 'completed')

    const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 3)
    const duplicate  = existing?.find((t: { title: string }) => {
      const matches = titleWords.filter(w => t.title.toLowerCase().includes(w))
      return matches.length >= 3
    })
    if (duplicate) {
      const ok = window.confirm(`A similar task may already exist:\n"${duplicate.title}"\n\nCreate anyway?`)
      if (!ok) { setSaving(false); return }
    }

    const now = new Date().toISOString()
    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title:           title.trim(),
        note:            description.trim() || null,
        priority,
        type:            'completion',
        is_urgent:       isUrgent,
        due_date:        dueDate || null,
        assigned_to:     profile.id,
        created_by:      session.user.id,
        team:            profile.team,
        status:          'working',
        acknowledged_at: now,
      })
      .select()
      .single()

    if (!error && task) {
      await supabase.from('task_activity_log').insert({
        task_id: task.id, actor_id: session.user.id,
        action: 'created', note: 'Task created for self',
      })
      onCreated(task as unknown as Task)
    } else {
      setSaveError('Failed to create task. Please try again.')
    }
    setSaving(false)
  }

  const PRIORITY_CFG = {
    low:    { bg: '#16a34a', border: 'rgba(22,163,74,0.4)',   text: '#16a34a' },
    medium: { bg: '#d97706', border: 'rgba(217,119,6,0.4)',   text: '#d97706' },
    high:   { bg: '#dc2626', border: 'rgba(220,38,38,0.4)',   text: '#dc2626' },
  } as const

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
          width: '100%', maxWidth: '460px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, marginBottom: '16px' }}>
          Create Self Task
        </div>

        {/* Title */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Task Name <span style={{ color: colors.red }}>*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={e => { setTitle(e.target.value); setTitleDirty(true) }}
            placeholder="e.g. Follow up — confirm fabric selection by Friday"
            className="boe-input"
            style={{ width: '100%', boxSizing: 'border-box' }}
            autoFocus
          />
          {titleDirty && !title.trim() && (
            <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Task name is required</p>
          )}
        </div>

        {/* Priority + Due Date */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
              Priority <span style={{ color: colors.red }}>*</span>
            </label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {PRIORITIES_MODAL.map(p => {
                const selected = priority === p
                const cfg = PRIORITY_CFG[p]
                return (
                  <button
                    key={p}
                    onClick={() => { setPriority(p); setPriorityDirty(true) }}
                    style={{
                      flex: 1, textAlign: 'center', textTransform: 'capitalize',
                      fontSize: '11px', fontWeight: selected ? 700 : 500,
                      padding: '5px 2px', borderRadius: '6px',
                      border: `1px solid ${selected ? cfg.bg : cfg.border}`,
                      background: selected ? cfg.bg : 'transparent',
                      color: selected ? '#fff' : cfg.text,
                      cursor: 'pointer', transition: 'all 0.12s',
                    }}
                  >
                    {p}
                  </button>
                )
              })}
            </div>
            {priorityDirty && !priority && (
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Required</p>
            )}
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
              Due Date <span style={{ color: colors.red }}>*</span>
            </label>
            <input
              type="date"
              value={dueDate}
              onChange={e => { setDueDate(e.target.value); setDateDirty(true) }}
              className="boe-input"
              style={{ colorScheme: 'light', width: '100%', boxSizing: 'border-box' }}
            />
            {dateDirty && !dueDate && (
              <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Required</p>
            )}
          </div>
        </div>

        {/* Description */}
        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Note <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Context or notes for this task…"
            rows={2}
            className="boe-input"
            style={{ resize: 'none', width: '100%', boxSizing: 'border-box' }}
          />
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
            {isUrgent ? 'Marked Important' : 'Mark Important'}
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

        {saveError && (
          <div style={{ fontSize: '12px', color: colors.red, marginBottom: '10px' }}>{saveError}</div>
        )}
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
            onClick={handleSubmit}
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
            {saving ? 'Creating…' : 'Create Task'}
          </button>
        </div>
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
  const [saving,    setSaving]    = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const canSave = !saving && title.trim().length > 0

  const handleSave = async () => {
    if (task.created_by !== userId) return
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
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
    if (!error && data) {
      onSaved(data as unknown as Task)
    } else if (error) {
      setSaveError('Failed to save changes. Please try again.')
    }
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

        {saveError && (
          <div style={{ fontSize: '12px', color: colors.red, marginBottom: '10px' }}>{saveError}</div>
        )}
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
  const [loggedInId,   setLoggedInId]   = useState<string>('')
  const [activeTab,    setActiveTab]    = useState<TabKey>('action_required')
  const [taskType,     setTaskType]     = useState<TaskType>('all')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [editingTask,      setEditingTask]      = useState<Task | null>(null)
  const [showCreateModal,  setShowCreateModal]  = useState(false)
  const [isMobile,         setIsMobile]         = useState(false)

  // Search + filter state
  const [search,           setSearch]           = useState('')
  const [filterStatus,     setFilterStatus]     = useState('')
  const [filterPriority,   setFilterPriority]   = useState('')
  const [filterAssignedBy, setFilterAssignedBy] = useState('')

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { viewAsUserId, viewAsProfile, exitViewMode } = useViewAs()
  const { refreshKey } = useRefresh()

  // Resolve the effective user ID — view-as overrides the logged-in user
  const userId = viewAsUserId ?? loggedInId

  // ── Query-backed data ─────────────────────────────────────────────────────
  const { data: profile = null }  = useProfile(loggedInId)
  const { data: allTasksRaw = [], isLoading: tasksLoading } = useMyTasks(userId || null)
  const { data: top3Data } = useTopTasks(userId || null)
  const { toast, show: showToast, dismiss: dismissToast } = useToast()

  // Allow manual task overrides (create / edit / delete) on top of cached data
  const [taskOverrides, setTaskOverrides] = useState<Task[] | null>(null)
  const allTasks = taskOverrides ?? allTasksRaw

  const creatorIds = useMemo(
    () => [...new Set(allTasksRaw.map(t => t.created_by))],
    [allTasksRaw]
  )
  const { data: userMap = {} } = useUserNames(creatorIds)

  // Invalidate task cache when refreshKey changes (e.g. after a task mutation elsewhere)
  useEffect(() => {
    if (!userId) return
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', userId] })
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset local overrides when fresh data arrives from the server
  useEffect(() => {
    setTaskOverrides(null)
  }, [allTasksRaw])

  // Prefetch task detail pages for the first 15 visible tasks
  useEffect(() => {
    if (allTasksRaw.length === 0) return
    allTasksRaw.slice(0, 15).forEach(t => router.prefetch(`/tasks/${t.id}`))
  }, [allTasksRaw]) // eslint-disable-line react-hooks/exhaustive-deps

  // Show cached tasks immediately; only block on first load when no cache exists
  const loading = !loggedInId && tasksLoading && allTasksRaw.length === 0

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Auth check — runs once on mount
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setLoggedInId(session.user.id)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Guard view-as against non-admins
  useEffect(() => {
    if (viewAsUserId && profile && profile.role !== 'admin') {
      exitViewMode()
      router.push('/dashboard')
    }
  }, [viewAsUserId, profile]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleTaskCreated = (task: Task) => {
    setTaskOverrides(prev => [task, ...(prev ?? allTasksRaw)])
    setShowCreateModal(false)
    // Invalidate so the cache refreshes in the background
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', userId] })
  }

  const handleEditSaved = (updated: Task) => {
    setTaskOverrides(prev => (prev ?? allTasksRaw).map(t => t.id === updated.id ? updated : t))
    setEditingTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', userId] })
  }

  const handleAddUpdate = async (note: string, newStatus: string, waitingOn?: { type: 'team_member' | 'external'; userId?: string; text?: string }) => {
    if (!selectedTask) return
    const now = new Date().toISOString()
    const statusChanged = newStatus !== selectedTask.status
    const trimmedNote = note.trim() || null

    if (statusChanged) {
      const needsBlockerReason = newStatus === 'blocked'
      const clearBlockerReason = selectedTask.status === 'blocked'
      const clearWaiting = selectedTask.status === 'waiting' && newStatus !== 'waiting'
      const taskUpdates: Record<string, unknown> = { status: newStatus, last_update_at: now }
      if (needsBlockerReason) taskUpdates.blocker_reason = trimmedNote
      else if (clearBlockerReason) taskUpdates.blocker_reason = null
      if (newStatus === 'waiting' && waitingOn) {
        taskUpdates.waiting_on_type    = waitingOn.type
        taskUpdates.waiting_on_user_id = waitingOn.type === 'team_member' ? (waitingOn.userId ?? null) : null
        taskUpdates.waiting_on_text    = waitingOn.type === 'external'    ? (waitingOn.text    ?? null) : null
      } else if (clearWaiting) {
        taskUpdates.waiting_on_type    = null
        taskUpdates.waiting_on_user_id = null
        taskUpdates.waiting_on_text    = null
      }
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

      const localPatch: Partial<Task> = { status: newStatus as Task['status'], last_update_at: now }
      if (needsBlockerReason) localPatch.blocker_reason = trimmedNote
      else if (clearBlockerReason) localPatch.blocker_reason = null
      if (newStatus === 'waiting' && waitingOn) {
        localPatch.waiting_on_type    = waitingOn.type
        localPatch.waiting_on_user_id = waitingOn.type === 'team_member' ? (waitingOn.userId ?? null) : null
        localPatch.waiting_on_text    = waitingOn.type === 'external'    ? (waitingOn.text    ?? null) : null
      } else if (clearWaiting) {
        localPatch.waiting_on_type    = null
        localPatch.waiting_on_user_id = null
        localPatch.waiting_on_text    = null
      }
      setSelectedTask(prev => prev ? { ...prev, ...localPatch } : prev)
      setTaskOverrides(prev => (prev ?? allTasksRaw).map(t => t.id === selectedTask.id ? { ...t, ...localPatch } : t))
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

      setTaskOverrides(prev => (prev ?? allTasksRaw).map(t =>
        t.id === selectedTask.id ? { ...t, last_update_at: now } : t
      ))
    }
  }

  const handleAcknowledge = async () => {
    if (!selectedTask) return
    if (selectedTask.assigned_to !== userId) return
    if (selectedTask.created_by === userId) return
    const now = new Date().toISOString()
    const oldStatus = selectedTask.status
    const { error } = await supabase.from('tasks').update({ acknowledged_at: now, status: 'working', last_update_at: now }).eq('id', selectedTask.id)
    if (error) {
      alert('Failed to acknowledge task. Please try again.')
      return
    }
    await supabase.from('task_activity_log').insert([
      { task_id: selectedTask.id, actor_id: userId, action: 'acknowledged', note: null },
      { task_id: selectedTask.id, actor_id: userId, action: 'status_changed', from_status: oldStatus, to_status: 'working', note: null },
    ])
    if (selectedTask.created_by && selectedTask.created_by !== userId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: selectedTask.id, taskTitle: selectedTask.title, createdBy: selectedTask.created_by, action: 'acknowledged', actorName: profile?.full_name }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[my-tasks/acknowledge] notification failed:', d))
      }).catch(err => console.error('[my-tasks/acknowledge] notification fetch error:', err))
    }
    const patch = { acknowledged_at: now, status: 'working' as const, last_update_at: now }
    setSelectedTask(prev => prev ? { ...prev, ...patch } : prev)
    setTaskOverrides(prev => (prev ?? allTasksRaw).map(t => t.id === selectedTask.id ? { ...t, ...patch } : t))
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', userId] })
  }

  const handleDelete = async (task: Task) => {
    if (task.created_by !== userId) {
      window.alert('You can only delete tasks you created.')
      return
    }
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
    setTaskOverrides(prev => (prev ?? allTasksRaw).filter(t => t.id !== task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', userId] })
  }

  const handlePin = async (task: Task) => {
    if (!userId || viewAsUserId) return
    if ((top3Data?.tasks?.length ?? 0) >= 3) {
      window.alert('You already have 3 tasks in Today\'s Focus. Remove one before adding another.')
      return
    }
    const nextOrder = (top3Data?.tasks?.length ?? 0) + 1
    const { error } = await supabase
      .from('user_top_tasks')
      .insert({ user_id: userId, task_id: task.id, display_order: nextOrder })
    if (error) {
      console.error('[handlePin] failed:', error.message, error)
      window.alert(`Failed to pin task: ${error.message}`)
      return
    }
    queryClient.invalidateQueries({ queryKey: ['top-tasks', userId] })
    showToast('Added to Today\'s Focus')
  }

  const handleUnpin = async (task: Task) => {
    if (!userId || viewAsUserId) return
    const { error } = await supabase
      .from('user_top_tasks')
      .delete()
      .eq('user_id', userId)
      .eq('task_id', task.id)
    if (error) {
      console.error('[handleUnpin] failed:', error.message, error)
      window.alert(`Failed to unpin task: ${error.message}`)
      return
    }
    queryClient.invalidateQueries({ queryKey: ['top-tasks', userId] })
    showToast('Removed from Today\'s Focus')
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

    // Action Required: only tasks that need the user's attention (excludes waiting, blocked, completed, cancelled)
    const action_required = sortImportantFirst(baseTasks.filter(t =>
      t.status === 'pending' || t.status === 'started' || t.status === 'working'
    ))
    // "All" shows active tasks only — completed/cancelled tasks are only visible in their respective tabs
    const all            = sortImportantFirst(baseTasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled'))
    const important      = sortImportantFirst(baseTasks.filter(t => t.is_urgent && t.status !== 'completed' && t.status !== 'cancelled'))
    const unacknowledged = sortImportantFirst(baseTasks.filter(isUnacknowledged))
    const in_progress    = sortImportantFirst(baseTasks.filter(t =>
      !isOverdue(t) && t.status !== 'completed' && ['started', 'working', 'pending'].includes(t.status)
    ))
    const overdue        = sortImportantFirst(baseTasks.filter(isOverdue))
    const needs_update   = sortImportantFirst(baseTasks.filter(needsUpdate))
    const non_completion = sortImportantFirst(baseTasks.filter(isNonCompletion))
    const completed      = baseTasks.filter(t => t.status === 'completed')

    return { action_required, all, important, unacknowledged, in_progress, overdue, needs_update, non_completion, completed }
  }, [baseTasks])

  const counts: Record<TabKey, number> = {
    action_required: buckets.action_required.length,
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

  const activeTabColor = colors.secondary

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="My Tasks"
        onSignOut={handleLogout}
        actions={!viewAsUserId && (
          <button
            onClick={() => setShowCreateModal(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', borderRadius: '8px', border: 'none',
              background: colors.primary, color: '#fff',
              fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              transition: 'opacity 0.12s', whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <Plus size={13} strokeWidth={2.5} />
            Create Self Task
          </button>
        )}
      >

        {/* ── Unified workspace card ── */}
        <div style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          borderRadius: '20px',
          border: `1px solid ${colors.border}`,
          background: '#fff',
          overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}>

          {/* ── Sidebar / pill tabs ── */}
          {(() => {
            const typeCounts: Record<TaskType, number> = {
              all:       allTasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length,
              self:      allTasks.filter(t => t.created_by === userId && t.status !== 'completed' && t.status !== 'cancelled').length,
              delegated: allTasks.filter(t => t.created_by !== userId && t.status !== 'completed' && t.status !== 'cancelled').length,
            }
            const handleTypeChange = (key: TaskType) => {
              setTaskType(key)
              setActiveTab('all')
              setSelectedTask(null)
              setSearch('')
              setFilterStatus('')
              setFilterPriority('')
              setFilterAssignedBy('')
            }

            if (isMobile) {
              return (
                <div style={{
                  display: 'flex', gap: '6px',
                  padding: '10px 12px',
                  borderBottom: `1px solid ${colors.border}`,
                }}>
                  {TYPE_TABS.map(item => {
                    const isActive = taskType === item.key
                    const { Icon } = item
                    return (
                      <button
                        key={item.key}
                        onClick={() => handleTypeChange(item.key)}
                        style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                          padding: '7px 6px',
                          background: isActive ? item.accent : 'transparent',
                          border: `1.5px solid ${isActive ? item.accent : colors.border}`,
                          borderRadius: '20px', cursor: 'pointer', outline: 'none',
                          transition: 'all 0.12s', minWidth: 0,
                        }}
                      >
                        <Icon size={12} color={isActive ? '#fff' : colors.muted} />
                        <span style={{ fontSize: '12px', fontWeight: 600, color: isActive ? '#fff' : colors.secondary, whiteSpace: 'nowrap' }}>
                          {item.label}
                        </span>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: isActive ? 'rgba(255,255,255,0.8)' : colors.muted }}>
                          {typeCounts[item.key]}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            }

            return (
              <div style={{
                width: '220px', flexShrink: 0,
                position: 'relative',
                background: 'rgba(248,250,252,0.6)',
              }}>
                {/* soft right divider — sits at z:0 so active tab (z:1) paints over it */}
                <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '1px', background: '#eef2f7', zIndex: 0 }} />
                <div style={{
                  fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em',
                  textTransform: 'uppercase', color: colors.muted,
                  padding: '14px 14px 8px',
                }}>
                  Task Type
                </div>
                {TYPE_TABS.map((item, i) => {
                  const isActive = taskType === item.key
                  const { Icon } = item
                  return (
                    <button
                      key={item.key}
                      onClick={() => handleTypeChange(item.key)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', padding: '9px 14px',
                        background: isActive ? '#fff' : 'transparent',
                        border: 'none',
                        borderBottom: i < TYPE_TABS.length - 1 ? '1px solid #eef2f7' : 'none',
                        borderLeft: `3px solid ${isActive ? item.accent : 'transparent'}`,
                        cursor: 'pointer', outline: 'none', transition: 'all 0.12s', textAlign: 'left',
                        ...(isActive ? { position: 'relative', zIndex: 1 } : {}),
                      }}
                    >
                      <span style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        fontSize: '12.5px', fontWeight: isActive ? 600 : 500,
                        color: isActive ? item.accent : colors.secondary,
                      }}>
                        <Icon size={13} style={{ opacity: isActive ? 1 : 0.55, flexShrink: 0 }} />
                        {item.label}
                      </span>
                      <span style={{
                        fontSize: '12px', fontWeight: 700,
                        color: typeCounts[item.key] > 0 ? item.accent : colors.muted,
                        background: isActive ? `${item.accent}18` : 'rgba(0,0,0,0.04)',
                        padding: '1px 8px', borderRadius: '10px',
                        minWidth: '24px', textAlign: 'center',
                      }}>
                        {typeCounts[item.key]}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })()}

          {/* ── Right: task list area ── */}
          <div style={{ flex: 1, minWidth: 0, background: '#fff' }}>

            {/* ── View tabs: Action Required / All Tasks ── */}
            {(() => {
              const VIEW_TABS: { key: TabKey; label: string; accent: string }[] = [
                { key: 'action_required', label: 'Action Required', accent: '#2E9E6B' },
                { key: 'all',             label: 'All Tasks',        accent: '#5B7FA6' },
              ]
              return (
                <div style={{
                  display: 'flex', gap: '0',
                  borderBottom: `1px solid ${colors.border}`,
                  padding: '0 24px',
                }}>
                  {VIEW_TABS.map(tab => {
                    const isActive = activeTab === tab.key
                    return (
                      <button
                        key={tab.key}
                        onClick={() => handleTabChange(tab.key)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '6px',
                          padding: '12px 4px', marginRight: '20px',
                          background: 'transparent', border: 'none',
                          borderBottom: `2px solid ${isActive ? tab.accent : 'transparent'}`,
                          cursor: 'pointer', outline: 'none',
                          fontSize: '12.5px', fontWeight: isActive ? 700 : 500,
                          color: isActive ? tab.accent : colors.secondary,
                          transition: 'color 0.12s, border-color 0.12s',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tab.label}
                        <span style={{
                          fontSize: '11px', fontWeight: 700,
                          padding: '1px 7px', borderRadius: '10px',
                          background: isActive ? `${tab.accent}18` : 'rgba(0,0,0,0.05)',
                          color: isActive ? tab.accent : colors.muted,
                          minWidth: '20px', textAlign: 'center',
                        }}>
                          {counts[tab.key]}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })()}

            {/* Search + filter toolbar */}
            <div style={{
              padding: '14px 24px 12px',
              display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center',
            }}>
              {/* Search */}
              <div style={{
                flex: '2 1 160px', display: 'flex', alignItems: 'center', gap: '6px',
                background: colors.raised, border: `1px solid ${colors.border}`,
                borderRadius: '6px', padding: '6px 10px',
              }}>
                <Search size={13} color={colors.muted} style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  placeholder="Find tasks…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    flex: 1, background: 'transparent', border: 'none',
                    outline: 'none', fontSize: '12px', color: colors.primary,
                    minWidth: 0,
                  }}
                />
              </div>
              {/* Assignees */}
              {taskType !== 'self' && assignerOptions.length > 0 && (
                <select
                  value={filterAssignedBy}
                  onChange={e => setFilterAssignedBy(e.target.value)}
                  style={{
                    flex: '1 1 120px', minWidth: '110px',
                    padding: '6px 10px',
                    background: colors.raised, border: `1px solid ${colors.border}`,
                    borderRadius: '6px', outline: 'none',
                    fontSize: '11.5px', color: filterAssignedBy ? colors.primary : colors.muted,
                    cursor: 'pointer',
                  }}
                >
                  <option value="">All Assignees</option>
                  {assignerOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.value === userId ? 'Self' : opt.label}
                    </option>
                  ))}
                </select>
              )}
              {/* Priority */}
              <select
                value={filterPriority}
                onChange={e => setFilterPriority(e.target.value)}
                style={{
                  flex: '1 1 100px', minWidth: '95px',
                  padding: '6px 10px',
                  background: colors.raised, border: `1px solid ${colors.border}`,
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

            {/* Table header — desktop only */}
            {!isMobile && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '28px minmax(300px, 1.4fr) minmax(110px, 0.75fr) minmax(90px, 0.6fr) minmax(80px, 0.5fr) minmax(95px, 0.6fr) minmax(110px, 0.45fr)',
        columnGap: '14px',
                alignItems: 'center',
                margin: '8px 24px 0',
                padding: '8px 0',
                borderRadius: '10px',
                background: 'rgba(248,250,252,0.85)',
                border: `1px solid ${colors.border}`,
                fontSize: '10px', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.07em',
                color: colors.muted,
              }}>
                <div />
                <div style={{ paddingRight: '8px' }}>Task</div>
                <div style={{ paddingLeft: '8px' }}>Assigned By</div>
                <div style={{ textAlign: 'center' }}>Due Date</div>
                <div style={{ textAlign: 'center' }}>Priority</div>
                <div style={{ textAlign: 'center' }}>Status</div>
                <div style={{ textAlign: 'center' }}>Action</div>
              </div>
            )}

            {/* Task cards */}
            {visibleTasks.length === 0 ? (
              <EmptyState label={TAB_LABELS[activeTab]} />
            ) : (
              <div style={{ padding: '10px 24px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {visibleTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    accentColor={activeTabColor}
                    userId={userId}
                    userMap={userMap}
                    onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                    onView={() => router.push(`/tasks/${task.id}`)}
                    onEdit={!viewAsUserId && task.created_by === userId ? () => setEditingTask(task) : undefined}
                    onDelete={!viewAsUserId && task.created_by === userId ? () => handleDelete(task) : undefined}
                    isMobile={isMobile}
                    isPinned={!!(top3Data?.pinnedIds?.has(task.id))}
                    onPin={
                      !viewAsUserId && !top3Data?.pinnedIds?.has(task.id) &&
                      task.status !== 'completed' && task.status !== 'cancelled'
                        ? () => handlePin(task) : undefined
                    }
                    onUnpin={
                      !viewAsUserId && top3Data?.pinnedIds?.has(task.id)
                        ? () => handleUnpin(task) : undefined
                    }
                  />
                ))}
                <div style={{ padding: '4px 4px', fontSize: '11px', color: colors.muted }}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>

        </div>
      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          onOpenFullPage={() => { setSelectedTask(null); router.push(`/tasks/${selectedTask.id}`) }}
          currentUserId={userId}
          onAcknowledge={viewAsUserId ? undefined : handleAcknowledge}
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

      {showCreateModal && profile && (
        <CreateSelfTaskModal
          profile={profile}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleTaskCreated}
        />
      )}
      <Toast toast={toast} onDismiss={dismissToast} />
    </>
  )
}
