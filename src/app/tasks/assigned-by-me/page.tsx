'use client'

import React, { useEffect, useState, useMemo, useRef, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { Task, UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { getTaskAging, statusBadgeClass, taskStatusLabel } from '@/lib/ui'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { TaskDetailPanel } from '@/components/ui/TaskDetailPanel'
import { useViewAs } from '@/hooks/useViewAs'
import { useProfile } from '@/hooks/queries/useProfile'
import { useActiveUsers } from '@/hooks/queries/useMyTasks'
import {
  CheckCircle2, ClipboardCheck, ExternalLink, Star, AlertCircle,
  Search, Pencil, Trash2, Plus, Paperclip, X,
} from 'lucide-react'
import { prepareFiles, getExt, getFileTypeLabel, filterAcceptedFiles, ACCEPTED_ATTACHMENT_TYPES } from '@/lib/attachment-utils'
import { useDragAndPaste } from '@/hooks/useDragAndPaste'
import { useListUrlState, useUrlSearchInput, usePruneUnknownValue } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { enumParam, idParam, optionParam, textParam } from '@/lib/listState'
import { canonicalAttachmentRef } from '@/lib/tasks/attachmentStorage'

// ─── Data ─────────────────────────────────────────────────────────────────────
const TASK_COLUMNS = [
  'id', 'title', 'note', 'status', 'priority', 'type',
  'is_urgent', 'due_date', 'acknowledged_at',
  'created_at', 'last_update_at', 'blocker_reason',
  'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
  'assigned_to', 'created_by', 'delegated_by', 'team',
].join(', ')

const TODAY_STR = new Date().toISOString().slice(0, 10)
const NOW_MS    = Date.now()
const H48       = 48 * 60 * 60 * 1000

function isOverdue(task: Task) {
  return !!task.due_date && task.due_date < TODAY_STR && task.status !== 'completed' && task.status !== 'cancelled'
}
function needsUpdate(task: Task) {
  if (task.status === 'completed' || task.status === 'cancelled') return false
  return NOW_MS - new Date(task.last_update_at ?? task.created_at).getTime() > H48
}
function isUnacknowledged(task: Task) {
  return !task.acknowledged_at && task.status !== 'completed' && task.status !== 'cancelled' && task.created_by !== task.assigned_to
}
function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

// ─── Tab config ───────────────────────────────────────────────────────────────
type TabKey = 'all' | 'for_approval' | 'unacknowledged' | 'overdue' | 'needs_update'

// `for_approval` sits immediately after All because it is the only tab holding
// work that is waiting on THIS person rather than on someone else. Every other
// tab is a way of looking at what the team owes; this one is the queue.
//
// A key dropped from this list stops being a valid `?tab=` value, because
// TAB_KEYS below is derived from it and enumParam falls unknown values back to
// `all`. Nothing else needs to know a tab was removed.
const TABS: { key: TabKey; label: string; color: string }[] = [
  { key: 'all',            label: 'All',             color: colors.secondary },
  { key: 'for_approval',   label: 'For Approval',    color: '#A57F14'        },
  { key: 'unacknowledged', label: 'Unacknowledged',  color: '#9B6FD4'        },
  { key: 'overdue',        label: 'Overdue',         color: colors.red       },
  { key: 'needs_update',   label: 'Pending Update',  color: colors.amber     },
]

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#B06035'    },
  medium: { label: 'Med',  color: '#C07820'    },
  low:    { label: 'Low',  color: colors.muted },
}

// ─── Desktop column widths ────────────────────────────────────────────────────
// One definition, read by both the header and the row, so a header can never
// drift out of alignment with the cells beneath it.
//
// These were fixed pixels (130/56/90/100/100/84 plus a 28px star gutter) with
// Task on `flex: 1`. That meant Task swallowed every pixel a wider screen
// added: 48% of the row at 1440px, 64% at 1920px, while Status stayed at 90px.
// Proportional widths hold Task near 42-43% at any width and give the largest
// share of what it gives back to Status.
//
// Each carries a px floor. Below roughly 1000px the floors add up to more than
// their percentages, and the surplus is taken from Task — which is the
// intended order: the description truncates a word earlier rather than Status
// or the action icons being squeezed.
const STAR_GUTTER = '28px'
const COL = {
  assignee: { width: '10.5%', min: '96px'  },
  priority: { width: '7%',    min: '52px'  },
  status:   { width: '13.5%', min: '104px' },
  created:  { width: '8.5%',  min: '82px'  },
  due:      { width: '8.5%',  min: '88px'  },
  actions:  { width: '7.5%',  min: '84px'  },
} as const

// ─── URL-backed list state ────────────────────────────────────────────────────
// Tab, assignee, priority and search live in the query string, so Back from a
// task detail lands on exactly the list the user left and a filtered view can be
// shared or reloaded. No pagination on this page — it loads the user's open
// delegated tasks in one query.
const PRIORITY_KEYS = ['high', 'medium', 'low'] as const
const TAB_KEYS = TABS.map(t => t.key)

const LIST_PARAMS = {
  tab:      enumParam(TAB_KEYS, 'all' as TabKey),
  assignee: idParam(),
  priority: optionParam(PRIORITY_KEYS),
  q:        textParam(),
}

// ─── Task card ────────────────────────────────────────────────────────────────
function TaskCard({
  task, accentColor, userMap, onClick, onView, onEdit, onDelete, isMobile,
}: {
  task: Task
  accentColor: string
  userMap: Record<string, string>
  onClick: () => void
  onView: () => void
  onEdit?: () => void
  onDelete?: () => void
  isMobile?: boolean
}) {
  const [hovered,     setHovered]     = useState(false)
  const [hoveredEdit, setHoveredEdit] = useState(false)
  const [hoveredDel,  setHoveredDel]  = useState(false)
  const [hoveredView, setHoveredView] = useState(false)

  const overdue   = isOverdue(task)
  const priority  = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const dateStr   = formatDate(task.due_date)
  const assigneeName = userMap[task.assigned_to ?? ''] ?? 'member'

  const isImportant = task.is_urgent

  // The one status on this list that is waiting on the reader. Read from the
  // stored value; nothing here writes or reinterprets it.
  const isForApproval = task.status === 'pending_approval'

  const cardBackground = isImportant
    ? (hovered ? 'rgba(196,154,40,0.08)' : 'rgba(196,154,40,0.04)')
    : (hovered ? colors.raised : colors.base)

  const cardBorder = isImportant
    ? `1.5px solid rgba(196,154,40,${hovered ? '0.40' : '0.20'})`
    : `1.5px solid ${colors.border}`

  // ── Desktop row only ──
  // An approval row is tinted only when it is not ALREADY tinted as important;
  // stacking the two would leave the reader unable to tell which signal they
  // are looking at, and would quietly restyle every important row.
  const desktopBackground = (isForApproval && !isImportant)
    ? (hovered ? 'rgba(232,160,48,0.07)' : 'rgba(232,160,48,0.035)')
    : cardBackground

  const elevation = hovered
    ? '0 2px 8px rgba(0,0,0,0.09)'
    : isImportant
      ? '0 1px 4px rgba(196,154,40,0.08)'
      : '0 1px 3px rgba(0,0,0,0.04)'

  // The 3px accent is an INSET shadow, not a thicker left border: it paints
  // inside the existing 1.5px border box, so an approval row's content starts
  // at exactly the same x as every other row's. Elevation is preserved, so
  // hover still lifts the card.
  const desktopShadow = isForApproval
    ? `inset 3px 0 0 ${colors.amber}, ${elevation}`
    : elevation

  // Same accent for the mobile card, by the same means and for the same reason.
  // The mobile card carries no elevation shadow of its own, so this is the only
  // entry — and `undefined` leaves a non-approval card exactly as it was.
  // No background tint here: the card is the full width of a phone screen, so
  // the stripe alone is already unmissable and a tint would only muddy it.
  const mobileShadow = isForApproval ? `inset 3px 0 0 ${colors.amber}` : undefined

  if (isMobile) {
    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
        style={{ background: cardBackground, border: cardBorder, borderRadius: '8px', boxShadow: mobileShadow, cursor: 'pointer', padding: '10px 12px' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
          {task.is_urgent && <Star size={11} fill="#C49A28" color="#C49A28" style={{ marginTop: '2px', flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: task.is_urgent ? 600 : 500, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </div>
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            <button onClick={e => { e.stopPropagation(); onEdit?.() }}
              onMouseEnter={() => setHoveredEdit(true)} onMouseLeave={() => setHoveredEdit(false)}
              title="Edit" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: hoveredEdit ? 'rgba(91,127,166,0.10)' : 'transparent', border: `1px solid ${hoveredEdit ? 'rgba(91,127,166,0.30)' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredEdit ? '#5B7FA6' : colors.muted }}>
              <Pencil size={13} />
            </button>
            <button onClick={e => { e.stopPropagation(); onDelete?.() }}
              onMouseEnter={() => setHoveredDel(true)} onMouseLeave={() => setHoveredDel(false)}
              title="Delete" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: hoveredDel ? `${colors.red}10` : 'transparent', border: `1px solid ${hoveredDel ? colors.red + '30' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredDel ? colors.red : colors.muted }}>
              <Trash2 size={13} />
            </button>
            <button onClick={e => { e.stopPropagation(); onView() }}
              onMouseEnter={() => setHoveredView(true)} onMouseLeave={() => setHoveredView(false)}
              title="View" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', borderRadius: '6px', background: hoveredView ? `${accentColor}14` : 'transparent', border: `1px solid ${hoveredView ? accentColor + '44' : 'transparent'}`, cursor: 'pointer', outline: 'none', color: hoveredView ? accentColor : colors.muted }}>
              <ExternalLink size={13} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px', color: '#2E7D6B', background: 'rgba(46,158,107,0.10)', whiteSpace: 'nowrap' }}>{assigneeName}</span>
          {/* The mobile card names no status — with one exception, because
              "this one is waiting on you" is the only status on this screen
              that asks the reader for something. */}
          {isForApproval && (
            <span
              className={`${statusBadgeClass(task.status)} boe-badge-approval-review`}
              style={{ fontSize: '9px', textTransform: 'capitalize' }}
            >
              <ClipboardCheck size={10} strokeWidth={2.4} style={{ flexShrink: 0 }} />
              {taskStatusLabel(task.status, 'creator')}
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
        display: 'flex', alignItems: 'center',
        background: desktopBackground,
        border: cardBorder,
        borderRadius: '8px',
        boxShadow: desktopShadow,
        transition: 'background 0.12s, box-shadow 0.12s, border-color 0.12s',
        minHeight: '48px',
        cursor: 'pointer',
      }}
    >
      {/* Star indicator — also the gutter the 3px approval accent paints into */}
      <div style={{ width: STAR_GUTTER, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {task.is_urgent
          ? <Star size={11} fill="#C49A28" color="#C49A28" />
          : <div style={{ width: '11px' }} />
        }
      </div>

      {/* Title + note */}
      <div style={{ flex: 1, minWidth: 0, padding: '10px 8px 10px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
          <span style={{
            fontSize: '13px', fontWeight: task.is_urgent ? 600 : 500,
            color: colors.primary,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}>
            {task.title}
          </span>
        </div>
        {task.note && (
          <div style={{
            fontSize: '11px', color: colors.muted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px',
          }}>
            {task.note}
          </div>
        )}
        {(() => {
          const aging = getTaskAging(task)
          if (!aging) return null
          const color = aging.severity === 'danger' ? '#D94F4F' : '#E8A030'
          return (
            <span style={{
              display: 'inline-block', marginTop: '3px',
              fontSize: '10px', fontWeight: 700,
              color, background: `${color}12`,
              border: `1px solid ${color}30`,
              padding: '1px 6px', borderRadius: '4px',
            }}>
              {aging.label}
            </span>
          )
        })()}
      </div>

      {/* Assigned To — 10.5% (min 96px) */}
      <div style={{
        flexShrink: 0, width: COL.assignee.width, minWidth: COL.assignee.min,
        display: 'flex', alignItems: 'center',
        paddingLeft: '8px', paddingRight: '6px', overflow: 'hidden',
      }}>
        <span
          title={`Assigned to ${assigneeName}`}
          style={{
            display: 'inline-block', maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: '10.5px', fontWeight: 600, padding: '1px 7px', borderRadius: '20px',
            color: '#2E7D6B', background: 'rgba(46,158,107,0.10)',
          }}
        >
          {assigneeName}
        </span>
      </div>

      {/* Priority — 7% (min 52px) */}
      <div style={{ flexShrink: 0, width: COL.priority.width, minWidth: COL.priority.min, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: '10px', fontWeight: 600, color: priority.color, opacity: 0.85 }}>
          {priority.label}
        </span>
      </div>

      {/* Status — 13.5% (min 104px). The widest of the recovered space goes
          here: "For Approval" plus its icon needs room to sit uncramped. */}
      <div style={{ flexShrink: 0, width: COL.status.width, minWidth: COL.status.min, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span
          className={`${statusBadgeClass(task.status)}${isForApproval ? ' boe-badge-approval-review' : ''}`}
          style={{ fontSize: '9px', textTransform: 'capitalize' }}
        >
          {isForApproval && <ClipboardCheck size={10} strokeWidth={2.4} style={{ flexShrink: 0 }} />}
          {taskStatusLabel(task.status, 'creator')}
        </span>
      </div>

      {/* Created On — 8.5% (min 82px) */}
      <div style={{ flexShrink: 0, width: COL.created.width, minWidth: COL.created.min, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: '11px', color: colors.secondary, whiteSpace: 'nowrap' }}>
          {formatDate(task.created_at) ?? '—'}
        </span>
      </div>

      {/* Due Date — 8.5% (min 88px) */}
      <div style={{ flexShrink: 0, width: COL.due.width, minWidth: COL.due.min, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: '11px', color: colors.secondary, whiteSpace: 'nowrap' }}>
          {formatDate(task.due_date) ?? 'No due date'}
        </span>
      </div>

      {/* Actions — 7.5%, floored at 84px so the three 26px buttons are never clipped */}
      <div style={{ flexShrink: 0, width: COL.actions.width, minWidth: COL.actions.min, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
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

// ─── Delegate Task modal ──────────────────────────────────────────────────────
const PRIORITIES_DELEGATE = ['low', 'medium', 'high'] as const

function DelegateTaskModal({
  profile,
  allUsers,
  onClose,
  onCreated,
  onError,
}: {
  profile: UserProfile
  allUsers: UserProfile[]
  onClose: () => void
  onCreated: (task: Task) => void
  onError: (msg: string) => void
}) {
  const [title,         setTitle]         = useState('')
  const [description,   setDescription]   = useState('')
  const [priority,      setPriority]      = useState('')
  const [dueDate,       setDueDate]       = useState('')
  const [assigneeId,    setAssigneeId]    = useState('')
  const [isUrgent,      setIsUrgent]      = useState(false)
  const [titleDirty,    setTitleDirty]    = useState(false)
  const [dateDirty,     setDateDirty]     = useState(false)
  const [priorityDirty, setPriorityDirty] = useState(false)
  const [assigneeDirty, setAssigneeDirty] = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [saveError,     setSaveError]     = useState<string | null>(null)
  const [attachFiles,   setAttachFiles]   = useState<File[]>([])
  const [attachError,   setAttachError]   = useState<string | null>(null)
  const attachInputRef = useRef<HTMLInputElement>(null)
  const supabase = useMemo(() => createClient(), [])

  const canSave = !saving && title.trim().length > 0 && assigneeId !== '' && dueDate !== '' && priority !== ''

  // Shared entry point for browse, drag-and-drop, and paste — keeps validation/behavior
  // identical no matter how a file gets into the upload flow.
  const addFiles = async (incoming: File[]) => {
    if (incoming.length === 0) return
    const { accepted, rejectedNames } = filterAcceptedFiles(incoming)
    const rejectMsg = rejectedNames.length > 0 ? `Unsupported file type: ${rejectedNames.join(', ')}` : null
    if (accepted.length === 0) { setAttachError(rejectMsg); return }
    const merged = [...attachFiles, ...accepted]
    const { ready, error } = await prepareFiles(merged)
    setAttachError(error ?? rejectMsg)
    if (!error) setAttachFiles(ready)
  }

  const handleAttachChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    await addFiles(selected)
    if (attachInputRef.current) attachInputRef.current.value = ''
  }

  const { dropActive: attachDropActive, onDragOver, onDragEnter, onDragLeave, onDrop, onPaste } = useDragAndPaste(addFiles)

  const handleSubmit = async () => {
    setTitleDirty(true)
    setDateDirty(true)
    setPriorityDirty(true)
    setAssigneeDirty(true)
    if (!title.trim() || !assigneeId || !priority || !dueDate) return
    setSaving(true)
    setSaveError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSaving(false); return }

    const { data: existing } = await supabase
      .from('tasks').select('id, title')
      .eq('assigned_to', assigneeId)
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

    const isSelf = assigneeId === session.user.id
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
        assigned_to:     assigneeId,
        created_by:      session.user.id,
        team:            profile.team,
        status:          isSelf ? 'working' : 'pending',
        acknowledged_at: isSelf ? now : null,
      })
      .select()
      .single()

    if (error || !task) {
      setSaveError(error?.message ?? 'Failed to create task. Please try again.')
      setSaving(false)
      return
    }

    await Promise.all([
      supabase.from('task_activity_log').insert({
        task_id: task.id, actor_id: session.user.id,
        action: 'created', note: isSelf ? 'Task created for self' : 'Task created and assigned',
      }),
      supabase.from('notifications').insert({
        user_id:      assigneeId,
        task_id:      task.id,
        type:         'task_assigned',
        title:        'New task assigned to you',
        body:         title.trim(),
        is_push_sent: true,
      }),
    ])

    // Upload attachments and link to the new task
    let attachUploadFailed = false
    if (attachFiles.length) {
      const { ready, error: prepErr } = await prepareFiles(attachFiles)
      if (prepErr) {
        setAttachError(prepErr)
        attachUploadFailed = true
      } else {
        let anyFailed = false
        for (const file of ready) {
          const ext  = getExt(file.name)
          const path = `tasks/${task.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
          const { error: upErr } = await supabase.storage
            .from('task-attachments')
            .upload(path, file, { upsert: false })
          if (upErr) { console.error('[attach upload]', upErr); anyFailed = true; continue }
          await supabase.from('task_attachments').insert({
            task_id:    task.id,
            url:        canonicalAttachmentRef(path),
            storage_path: path,
            file_name:  file.name,
            file_type:  getFileTypeLabel(file.name),
            created_by: session.user.id,
          })
        }
        if (anyFailed) attachUploadFailed = true
      }
    }

    // onCreated closes the modal and adds the task to the list.
    // If uploads partially failed, surface the error at the page level after close.
    onCreated(task as unknown as Task)
    if (attachUploadFailed) onError('Task created, but some attachments failed to upload.')
  }

  const PRIORITY_CFG = {
    low:    { bg: '#16a34a', border: 'rgba(22,163,74,0.4)',  text: '#16a34a' },
    medium: { bg: '#d97706', border: 'rgba(217,119,6,0.4)',  text: '#d97706' },
    high:   { bg: '#dc2626', border: 'rgba(220,38,38,0.4)', text: '#dc2626' },
  } as const

  const LABEL_STYLE: React.CSSProperties = {
    fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px',
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
          width: '100%', maxWidth: '480px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, marginBottom: '16px' }}>
          Delegate Task
        </div>

        {/* Title */}
        <div style={{ marginBottom: '12px' }}>
          <label style={LABEL_STYLE}>Task Name <span style={{ color: colors.red }}>*</span></label>
          <input
            type="text"
            value={title}
            onChange={e => { setTitle(e.target.value); setTitleDirty(true) }}
            placeholder="e.g. Follow up — Leela Hotel — confirm fabric selection by Friday"
            className="boe-input"
            style={{ width: '100%', boxSizing: 'border-box' }}
            autoFocus
          />
          {titleDirty && !title.trim() && (
            <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Task name is required</p>
          )}
        </div>

        {/* Assign To */}
        <div style={{ marginBottom: '12px' }}>
          <label style={LABEL_STYLE}>Assign To <span style={{ color: colors.red }}>*</span></label>
          <select
            value={assigneeId}
            onChange={e => { setAssigneeId(e.target.value); setAssigneeDirty(true) }}
            className="boe-input"
            style={{ width: '100%', boxSizing: 'border-box' }}
          >
            <option value="">Select team member</option>
            {allUsers.filter(u => u.id !== profile.id).map(u => (
              <option key={u.id} value={u.id}>{u.full_name} — {u.team}</option>
            ))}
          </select>
          {assigneeDirty && !assigneeId && (
            <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>Assignee is required</p>
          )}
        </div>

        {/* Priority + Due Date */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
          <div>
            <label style={LABEL_STYLE}>Priority <span style={{ color: colors.red }}>*</span></label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {PRIORITIES_DELEGATE.map(p => {
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
            <label style={LABEL_STYLE}>Due Date <span style={{ color: colors.red }}>*</span></label>
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
          <label style={LABEL_STYLE}>Description <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            onPaste={onPaste}
            placeholder="Context or instructions for the assignee…"
            rows={2}
            className="boe-input"
            style={{ resize: 'none', width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        {/* Attachments */}
        <div style={{ marginBottom: '12px' }}>
          <label style={LABEL_STYLE}>Attachments <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span></label>
          <input
            ref={attachInputRef}
            type="file"
            multiple
            onChange={handleAttachChange}
            style={{ display: 'none' }}
            accept={ACCEPTED_ATTACHMENT_TYPES.join(',')}
          />
          {attachFiles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
              {attachFiles.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderRadius: '6px', background: colors.raised, border: `1px solid ${colors.border}` }}>
                  <Paperclip size={11} color={colors.secondary} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', color: colors.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: '10px', color: colors.muted, flexShrink: 0 }}>{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    onClick={() => { setAttachFiles(prev => prev.filter((_, j) => j !== i)); setAttachError(null) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                  >
                    <X size={11} color={colors.muted} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            style={{ position: 'relative' }}
            onDragOver={onDragOver}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <button
              onClick={() => attachInputRef.current?.click()}
              style={{
                width: '100%', padding: '7px 0', borderRadius: '7px',
                border: `1.5px dashed ${attachDropActive ? colors.blue : colors.border}`,
                background: attachDropActive ? colors.blueTint : colors.raised,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <Paperclip size={12} color={colors.secondary} strokeWidth={1.8} />
              <span style={{ fontSize: '11px', color: colors.secondary }}>Add files</span>
              <span style={{ fontSize: '10px', color: colors.muted }}>— 10 MB total</span>
            </button>
            {attachDropActive && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
                fontSize: '11px', fontWeight: 600, color: colors.blue,
                background: 'rgba(255,255,255,0.6)', borderRadius: '7px',
              }}>
                Drop files to attach
              </div>
            )}
          </div>
          <p style={{ fontSize: '10px', color: colors.muted, marginTop: '4px' }}>
            Drop files here, paste copied files into the description, or browse
          </p>
          {attachError && <p style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>{attachError}</p>}
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
            {saving ? 'Creating…' : 'Create & Assign'}
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
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
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

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Task Name <span style={{ color: colors.red }}>*</span>
          </label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} className="boe-input" style={{ width: '100%', boxSizing: 'border-box' }} />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Note <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="boe-input" style={{ resize: 'none', width: '100%', boxSizing: 'border-box' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>Priority</label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {PRIORITIES_EDIT.map(p => (
                <button key={p} onClick={() => setPriority(p)} className={`boe-chip${priority === p ? ' boe-chip-selected' : ''}`} style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize', fontSize: '10px', padding: '3px 0' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>Due Date</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="boe-input" style={{ colorScheme: 'light', width: '100%', boxSizing: 'border-box' }} />
          </div>
        </div>

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
          <span style={{ fontSize: '12px', fontWeight: 600, color: isUrgent ? '#C49A28' : colors.primary }}>Mark Important</span>
          <div style={{ width: '30px', height: '17px', borderRadius: '9px', background: isUrgent ? '#C49A28' : colors.float, position: 'relative', flexShrink: 0, transition: 'background 0.16s', border: `1px solid ${colors.border}` }}>
            <div style={{ position: 'absolute', top: '1.5px', left: isUrgent ? '12px' : '1.5px', width: '12px', height: '12px', borderRadius: '50%', background: '#fff', transition: 'left 0.16s' }} />
          </div>
        </div>

        {saveError && (
          <div style={{ fontSize: '12px', color: colors.red, marginBottom: '10px' }}>{saveError}</div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: '7px', border: `1px solid ${colors.border}`, background: 'transparent', cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: colors.secondary }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave} style={{ padding: '7px 18px', borderRadius: '7px', border: 'none', background: canSave ? colors.primary : colors.float, color: canSave ? '#fff' : colors.muted, cursor: canSave ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 600, transition: 'background 0.12s' }}>
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
function AssignedByMeContent() {
  const [loggedInId,        setLoggedInId]        = useState<string>('')
  const [allTasks,          setAllTasks]          = useState<Task[]>([])
  const [userId,            setUserId]            = useState<string>('')
  const [userMap,           setUserMap]           = useState<Record<string, string>>({})
  const [loading,           setLoading]           = useState(true)
  const [selectedTask,      setSelectedTask]      = useState<Task | null>(null)
  const [editingTask,       setEditingTask]       = useState<Task | null>(null)
  const [showDelegateModal, setShowDelegateModal] = useState(false)
  const [delegateError,     setDelegateError]     = useState<string | null>(null)
  const [isMobile,          setIsMobile]          = useState(false)

  // Tab + filters read from and write to the URL; the search box keeps a local
  // value so typing is not one navigation per keystroke.
  const { state, setState } = useListUrlState(LIST_PARAMS)
  const activeTab      = state.tab
  const filterAssignee = state.assignee
  const filterPriority = state.priority
  const search         = state.q
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(search, next => setState({ q: next }))

  useListScrollRestore()

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { viewAsUserId, exitViewMode } = useViewAs()

  // Cached queries — profile and active users shared across pages
  const { data: profile = null } = useProfile(loggedInId)
  const { data: activeUsersData = [] } = useActiveUsers()
  const allUsers = activeUsersData as UserProfile[]

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Guard view-as against non-admins once profile resolves
  useEffect(() => {
    if (viewAsUserId && profile && profile.role !== 'admin') {
      exitViewMode()
      router.push('/dashboard')
    }
  }, [viewAsUserId, profile]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const lid = session.user.id
      setLoggedInId(lid)
      const uid = viewAsUserId ?? lid
      setUserId(uid)

      // Profile and active users are now cached by hooks — only fetch tasks + user map here
      const [{ data: tasks }, { data: userData }] = await Promise.all([
        supabase.from('tasks').select(TASK_COLUMNS)
          .eq('created_by', uid)
          .not('assigned_to', 'is', null)
          .neq('assigned_to', uid)
          .neq('status', 'completed')
          .neq('status', 'cancelled')
          .order('due_date', { ascending: true, nullsFirst: false }),
        supabase.from('users').select('id, full_name'),
      ])

      const taskList = (tasks ?? []) as unknown as Task[]
      setAllTasks(taskList)
      if (userData) {
        const map: Record<string, string> = {}
        for (const u of userData) map[u.id] = u.full_name
        setUserMap(map)
      }
      setLoading(false)
      // Prefetch task detail pages for the first 15 tasks
      taskList.slice(0, 15).forEach(t => router.prefetch(`/tasks/${t.id}`))
    }
    init()
  }, [viewAsUserId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleTaskDelegated = (task: Task) => {
    setAllTasks(prev => [task, ...prev])
    setShowDelegateModal(false)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
  }

  const handleEditSaved = (updated: Task) => {
    setAllTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
    setEditingTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', updated.assigned_to] })
    queryClient.invalidateQueries({ queryKey: ['top-tasks'] })
  }

  const handleDelete = async (task: Task) => {
    if (task.created_by !== userId) {
      window.alert('You can only delete tasks you created.')
      return
    }
    const ok = window.confirm('Delete this task? This cannot be undone.')
    if (!ok) return
    const { data: deleted, error } = await supabase.from('tasks').delete().eq('id', task.id).select('id')
    if (error) { console.error('[delete] Supabase error:', error.message); return }
    if (!deleted || deleted.length === 0) { console.warn('[delete] No rows deleted'); return }
    setAllTasks(prev => prev.filter(t => t.id !== task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })
    queryClient.invalidateQueries({ queryKey: ['top-tasks'] })
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
  }

  const buckets = useMemo(() => {
    const sort = (arr: Task[]) => [...arr].sort((a, b) => (b.is_urgent ? 1 : 0) - (a.is_urgent ? 1 : 0))
    return {
      all:            sort(allTasks),
      // Work handed back for this person to accept. `overdue` may still contain
      // it, because it is not completed and a missed due date is still a missed
      // due date.
      for_approval:   sort(allTasks.filter(t => t.status === 'pending_approval')),
      unacknowledged: sort(allTasks.filter(isUnacknowledged)),
      overdue:        sort(allTasks.filter(isOverdue)),
      needs_update:   sort(allTasks.filter(needsUpdate)),
    }
  }, [allTasks])

  const counts: Record<TabKey, number> = {
    all:            buckets.all.length,
    for_approval:   buckets.for_approval.length,
    unacknowledged: buckets.unacknowledged.length,
    overdue:        buckets.overdue.length,
    needs_update:   buckets.needs_update.length,
  }

  const assigneeOptions = useMemo(() => {
    const ids = [...new Set(allTasks.map(t => t.assigned_to).filter(Boolean))]
    return (ids as string[]).map(id => ({ value: id, label: userMap[id] ?? 'Unknown' }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [allTasks, userMap])

  // A URL naming someone who no longer appears here — left the company, or has
  // no open delegated tasks left — would otherwise show an empty list with the
  // dropdown reading "All Assignees". Drop the filter instead, once the tasks
  // have actually loaded.
  const assigneeIds = useMemo(() => assigneeOptions.map(o => o.value), [assigneeOptions])
  usePruneUnknownValue(!loading, filterAssignee, assigneeIds, () => setState({ assignee: '' }))

  const visibleTasks = useMemo(() => {
    let tasks = buckets[activeTab]
    if (filterAssignee) tasks = tasks.filter(t => t.assigned_to === filterAssignee)
    if (filterPriority) tasks = tasks.filter(t => t.priority === filterPriority)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      tasks = tasks.filter(t => t.title.toLowerCase().includes(q))
    }
    return tasks
  }, [buckets, activeTab, filterAssignee, filterPriority, search])

  // Switching tab clears search and priority (unchanged behaviour) but keeps the
  // assignee — one navigation, so Back still leaves the previous tab's URL.
  const handleTabChange = (key: TabKey) => {
    setSelectedTask(null)
    // The box is cleared alongside the URL so a keystroke still inside the
    // debounce window cannot re-apply itself after the switch.
    setSearchInput('')
    setState({ tab: key, priority: '', q: '' })
  }

  const activeTabColor = TABS.find(t => t.key === activeTab)?.color ?? colors.secondary

  if (loading) return <LoadingScreen />

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Assigned By Me"
        onSignOut={handleLogout}
        actions={!viewAsUserId && (
          <button
            onClick={() => setShowDelegateModal(true)}
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
            Delegate Task
          </button>
        )}
      >

        <div style={{ minWidth: 0 }}>

            {/* View tabs — relocated from the former right sidebar */}
            {/* The 20px that used to hang off each tab as `marginRight` is now
                the row's `gap`, so the strip ends at the last tab instead of
                trailing an empty gap. Widths stay content-sized and the row
                still scrolls sideways on a narrow screen. */}
            <div style={{
              display: 'flex', gap: '20px',
              borderBottom: `1px solid ${colors.border}`,
              marginBottom: '12px', overflowX: 'auto',
            }}>
              {TABS.map(item => {
                const isActive = activeTab === item.key
                return (
                  <button
                    key={item.key}
                    onClick={() => handleTabChange(item.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '10px 4px',
                      background: 'transparent', border: 'none',
                      borderBottom: `2px solid ${isActive ? item.color : 'transparent'}`,
                      cursor: 'pointer', outline: 'none',
                      fontSize: '12.5px', fontWeight: isActive ? 700 : 500,
                      color: isActive ? item.color : colors.secondary,
                      transition: 'color 0.12s, border-color 0.12s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.label}
                    {/* For Approval keeps its gold count even when the tab is
                        not selected, but only while it is non-zero: the one
                        tab holding work that is waiting on the reader should
                        not look like the ones that are not. */}
                    {(() => {
                      const standOut =
                        isActive || (item.key === 'for_approval' && counts[item.key] > 0)
                      return (
                        <span style={{
                          fontSize: '11px', fontWeight: 700,
                          padding: '1px 7px', borderRadius: '10px',
                          background: standOut ? `${item.color}18` : 'rgba(0,0,0,0.05)',
                          color: standOut ? item.color : colors.muted,
                          minWidth: '20px', textAlign: 'center',
                        }}>
                          {counts[item.key]}
                        </span>
                      )
                    })()}
                  </button>
                )
              })}
            </div>

            {/* Search + filter toolbar */}
            <div style={{
              background: colors.raised, border: `1.5px solid ${colors.border}`,
              borderRadius: '8px', padding: '8px 10px', marginBottom: '10px',
              display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center',
            }}>
              {/* Search */}
              <div style={{
                flex: '2 1 160px', display: 'flex', alignItems: 'center', gap: '6px',
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: '6px', padding: '6px 10px',
              }}>
                <Search size={13} color={colors.muted} style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  placeholder="Find tasks…"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onBlur={flushSearch}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary, minWidth: 0 }}
                />
              </div>
              {/* Assignee filter */}
              {assigneeOptions.length > 0 && (
                <select
                  value={filterAssignee}
                  onChange={e => setState({ assignee: e.target.value })}
                  style={{ flex: '1 1 120px', minWidth: '110px', padding: '6px 10px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '11.5px', color: filterAssignee ? colors.primary : colors.muted, cursor: 'pointer' }}
                >
                  <option value="">All Assignees</option>
                  {assigneeOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              )}
              {/* Priority filter */}
              <select
                value={filterPriority}
                onChange={e => setState({ priority: e.target.value as typeof filterPriority })}
                style={{ flex: '1 1 100px', minWidth: '95px', padding: '6px 10px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '11.5px', color: filterPriority ? colors.primary : colors.muted, cursor: 'pointer' }}
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
                display: 'flex', alignItems: 'center',
                padding: '5px 0 5px 0', marginBottom: '4px',
                fontSize: '10px', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.07em',
                color: colors.muted,
              }}>
                <div style={{ width: STAR_GUTTER, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, paddingRight: '8px' }}>Task</div>
                <div style={{ flexShrink: 0, width: COL.assignee.width, minWidth: COL.assignee.min, paddingLeft: '8px' }}>Assigned To</div>
                <div style={{ flexShrink: 0, width: COL.priority.width, minWidth: COL.priority.min, textAlign: 'center' }}>Priority</div>
                <div style={{ flexShrink: 0, width: COL.status.width,   minWidth: COL.status.min,   textAlign: 'center' }}>Status</div>
                <div style={{ flexShrink: 0, width: COL.created.width,  minWidth: COL.created.min,  textAlign: 'center' }}>Created On</div>
                <div style={{ flexShrink: 0, width: COL.due.width,      minWidth: COL.due.min,      textAlign: 'center' }}>Due Date</div>
                <div style={{ flexShrink: 0, width: COL.actions.width,  minWidth: COL.actions.min,  textAlign: 'center' }}>Action</div>
              </div>
            )}

            {/* Task cards */}
            {visibleTasks.length === 0 ? (
              <EmptyState label={TABS.find(t => t.key === activeTab)!.label} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {visibleTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    accentColor={activeTabColor}
                    userMap={userMap}
                    onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
                    onView={() => router.push(`/tasks/${task.id}`)}
                    onEdit={() => setEditingTask(task)}
                    onDelete={() => handleDelete(task)}
                    isMobile={isMobile}
                  />
                ))}
                <div style={{ padding: '4px 4px', fontSize: '11px', color: colors.muted }}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
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
          currentUserId={userId}
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

      {delegateError && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 1100,
          padding: '10px 16px',
          borderRadius: '8px',
          background: colors.redTint,
          border: `1px solid rgba(217,79,79,0.3)`,
          display: 'flex', alignItems: 'center', gap: '12px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          whiteSpace: 'nowrap',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 500, color: colors.red }}>{delegateError}</span>
          <button
            onClick={() => setDelegateError(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: '16px', lineHeight: 1, padding: '0 2px' }}
          >×</button>
        </div>
      )}

      {showDelegateModal && profile && (
        <DelegateTaskModal
          profile={profile}
          allUsers={allUsers}
          onClose={() => setShowDelegateModal(false)}
          onCreated={handleTaskDelegated}
          onError={setDelegateError}
        />
      )}
    </>
  )
}

// Reading the list state from the URL opts this tree into client-side
// rendering, which needs a Suspense boundary.
export default function AssignedByMePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AssignedByMeContent />
    </Suspense>
  )
}
