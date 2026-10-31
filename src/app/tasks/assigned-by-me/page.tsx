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
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useActiveUsers, useAllUserNames } from '@/hooks/queries/useMyTasks'
import { useAssignedByMe, assignedByMeKey } from '@/hooks/queries/useAssignedByMe'
import { useTeamResponse, TEAM_RESPONSE_KEY } from '@/hooks/queries/useTeamResponse'
import { ApproveTaskDialog } from '@/components/tasks/ApproveTaskDialog'
import { CancelTaskModal } from '@/components/tasks/CancelTaskModal'
import { TaskRowMenu, type TaskRowMenuItem } from '@/components/tasks/TaskRowMenu'
import { TeamResponseBar } from '@/components/tasks/TeamResponseBar'
import { Toast, takeFlashToast, useToast } from '@/components/ui/toast'
import {
  Ban, Check, CheckCircle2, ClipboardCheck, ExternalLink, Star,
  Search, Pencil, Trash2, Paperclip, X,
} from 'lucide-react'
import { prepareFiles, getExt, getFileTypeLabel, filterAcceptedFiles, ACCEPTED_ATTACHMENT_TYPES } from '@/lib/attachment-utils'
import { useDragAndPaste } from '@/hooks/useDragAndPaste'
import { useListUrlState, useUrlSearchInput, usePruneUnknownValue } from '@/hooks/useListUrlState'
import { useListScrollRestore } from '@/hooks/useListScrollRestore'
import { useCurrentReturnPath } from '@/hooks/useCurrentReturnPath'
import { taskDetailHref } from '@/lib/tasks/taskReturnPath'
import { enumParam, idParam, optionParam, textParam } from '@/lib/listState'
import { canonicalAttachmentRef } from '@/lib/tasks/attachmentStorage'
import { accruesAssigneeOverdue } from '@/lib/tasks/reviewTransitions'
import { canApproveTask, canCancelFromList } from '@/lib/tasks/taskDetailAccess'
import { approveTaskFromList, cancelTaskFromList, type ListActionResult } from '@/lib/tasks/taskListActions'
import styles from './assignedByMe.module.css'

// ─── Data ─────────────────────────────────────────────────────────────────────
// The column list moved to useAssignedByMe, beside the query that uses it.

const TODAY_STR = new Date().toISOString().slice(0, 10)
const NOW_MS    = Date.now()
const H48       = 48 * 60 * 60 * 1000

function isOverdue(task: Task) {
  // Once the assignee submits for approval, responsibility has moved to the
  // reviewer — the task is no longer overdue against the assignee, even
  // though it is still open and still shows in the For Approval tab below.
  return !!task.due_date && task.due_date < TODAY_STR && accruesAssigneeOverdue(task.status)
}
function needsUpdate(task: Task) {
  if (task.status === 'completed' || task.status === 'cancelled') return false
  return NOW_MS - new Date(task.last_update_at ?? task.created_at).getTime() > H48
}
function isUnacknowledged(task: Task) {
  return !task.acknowledged_at && task.status !== 'completed' && task.status !== 'cancelled' && task.created_by !== task.assigned_to
}
/** The year appears only when it is not this one. */
function formatDueDate(d: string | null): string | null {
  if (!d) return null
  const sameYear = d.slice(0, 4) === TODAY_STR.slice(0, 4)
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) })
}
function daysLate(dueDate: string): number {
  return Math.round((Date.parse(TODAY_STR) - Date.parse(dueDate.slice(0, 10))) / 86_400_000)
}
function formatLastUpdate(iso: string): string {
  const hours = Math.floor((NOW_MS - new Date(iso).getTime()) / 3_600_000)
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours} ${hours === 1 ? 'hr' : 'hrs'} ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'Yesterday' : `${days} days ago`
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
  { key: 'for_approval',   label: 'For Approval',    color: '#805B0D'        },
  { key: 'unacknowledged', label: 'Unacknowledged',  color: '#335A86'        },
  { key: 'overdue',        label: 'Overdue',         color: colors.red       },
  { key: 'needs_update',   label: 'Pending Update',  color: colors.amber     },
]

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  high:   { label: 'High', color: '#A12438'    },
  medium: { label: 'Med',  color: '#805B0D'    },
  low:    { label: 'Low',  color: colors.muted },
}

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

// ─── Task row ─────────────────────────────────────────────────────────────────
function TaskCard({
  task, userMap, assigneeInactive, onClick, onView, onEdit, onDelete, onApprove, onCancel, isMobile,
}: {
  task: Task
  userMap: Record<string, string>
  assigneeInactive: boolean
  onClick: () => void
  onView: () => void
  onEdit?: () => void
  onDelete?: () => void
  /** Present only when this reader may approve this task now. */
  onApprove?: () => void
  /** Present only when this reader may cancel this task. */
  onCancel?: () => void
  isMobile?: boolean
}) {
  const overdue      = isOverdue(task)
  const dueToday     = task.due_date === TODAY_STR && accruesAssigneeOverdue(task.status)
  const priority     = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.low
  const dateStr      = formatDueDate(task.due_date)
  const late         = overdue ? daysLate(task.due_date as string) : 0
  const assigneeName = userMap[task.assigned_to ?? ''] ?? 'Unknown'

  // The one status on this list that is waiting on the reader. Read from the
  // stored value; nothing here writes or reinterprets it.
  const isForApproval = task.status === 'pending_approval'

  const menuItems: TaskRowMenuItem[] = [
    { key: 'open', text: 'Open full page', Icon: ExternalLink, run: onView },
    ...(onEdit ? [{ key: 'edit', text: 'Edit', Icon: Pencil, run: onEdit }] : []),
    ...(onCancel ? [{ key: 'cancel', text: 'Cancel task', Icon: Ban, run: onCancel }] : []),
    // Delete removes the task for good; Cancel keeps it and can be restored.
    ...(onDelete ? [{ key: 'delete', text: 'Delete', Icon: Trash2, run: onDelete, danger: true }] : []),
  ]
  const menuLabel = `More actions for ${task.title}`

  if (isMobile) {
    // No tint on an approval card: it is the full width of a phone screen, so the
    // stripe alone is already unmissable and a tint would only muddy it.
    return (
      <div
        onClick={onClick}
        style={{
          background: task.is_urgent ? 'rgba(183,137,42,0.10)' : colors.base,
          border: `1px solid ${task.is_urgent ? 'rgba(183,137,42,0.45)' : colors.border}`,
          borderRadius: '12px',
          boxShadow: isForApproval ? `inset 3px 0 0 ${colors.blue}` : undefined,
          cursor: 'pointer',
          padding: '8px 2px 10px 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {task.is_urgent && <Star size={12} fill="#B7892A" color="#B7892A" style={{ flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0, fontSize: '15px', fontWeight: task.is_urgent ? 600 : 500, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </div>
          <TaskRowMenu label={menuLabel} items={menuItems} size={44} />
        </div>
        <div style={{ display: 'flex', gap: '4px 10px', flexWrap: 'wrap', alignItems: 'center', paddingRight: '10px', fontSize: '13px', color: colors.secondary }}>
          <span>{assigneeName}</span>
          <span style={{ fontWeight: 600, color: priority.color }}>{priority.label}</span>
          {dateStr && (
            <span style={{ fontWeight: overdue ? 600 : 500, color: overdue ? colors.red : colors.secondary }}>
              {overdue ? `${late} ${late === 1 ? 'day' : 'days'} late` : dateStr}
            </span>
          )}
          {/* The phone card names no status, with one exception: "this one is
              waiting on you" is the only status here that asks for something. */}
          {isForApproval && (
            <span
              className={`${statusBadgeClass(task.status)} boe-badge-approval-review`}
              style={{ fontSize: '12px', textTransform: 'capitalize' }}
            >
              <ClipboardCheck size={10} strokeWidth={2.4} style={{ flexShrink: 0 }} />
              {taskStatusLabel(task.status, 'creator')}
            </span>
          )}
        </div>
        {onApprove && (
          <div className={styles.cardActions} onClick={e => e.stopPropagation()}>
            <button type="button" className="boe-btn boe-btn-primary" onClick={onApprove}>
              <Check size={14} strokeWidth={2.6} aria-hidden="true" />
              Approve
            </button>
            {onCancel && (
              <button type="button" className="boe-btn boe-btn-secondary" onClick={onCancel}>Cancel task</button>
            )}
          </div>
        )}
      </div>
    )
  }

  // Never `boe-badge-approval-review` for anything but the approval status: it
  // is what makes that one badge stand out from the rest of the column.
  const aging = getTaskAging(task)
  const updateClass = aging?.severity === 'danger'
    ? styles.updateDanger
    : aging ? styles.updateWarning : ''

  return (
    <div
      onClick={onClick}
      className={[
        styles.row,
        isForApproval ? styles.approval : task.is_urgent ? styles.important : '',
      ].join(' ')}
    >
      <div className={styles.star}>
        {task.is_urgent && <Star size={12} fill="#B7892A" color="#B7892A" aria-label="Important" />}
      </div>

      <div className={styles.title} title={task.title}>{task.title}</div>

      <div className={styles.who} title={`Assigned to ${assigneeName}`}>
        <span className={styles.whoName}>{assigneeName}</span>
        {assigneeInactive && <span className={styles.inactive}>Inactive</span>}
      </div>

      <div className={`${styles.priority} ${styles.colPriority}`} style={{ color: priority.color }}>
        {priority.label}
      </div>

      <div>
        <span
          className={`${statusBadgeClass(task.status)}${isForApproval ? ' boe-badge-approval-review' : ''}`}
          style={{ fontSize: '12px', textTransform: 'capitalize' }}
        >
          {isForApproval && <ClipboardCheck size={10} strokeWidth={2.4} style={{ flexShrink: 0 }} />}
          {taskStatusLabel(task.status, 'creator')}
        </span>
      </div>

      <div className={styles.due}>
        <span className={overdue ? styles.dueLate : undefined}>{dateStr ?? 'No due date'}</span>
        {overdue && <span className={`${styles.dueLate} ${styles.dueNote}`}> · {late} {late === 1 ? 'day' : 'days'} late</span>}
        {dueToday && <span className={`${styles.dueToday} ${styles.dueNote}`}> · Today</span>}
      </div>

      <div className={`${styles.update} ${styles.colUpdate} ${updateClass}`} title={aging?.message}>
        {formatLastUpdate(task.last_update_at ?? task.created_at)}
      </div>

      <div className={styles.actions} onClick={e => e.stopPropagation()}>
        {onApprove && (
          <button type="button" className={`boe-btn boe-btn-primary ${styles.rowButton}`} onClick={onApprove}>
            <Check size={14} strokeWidth={2.6} aria-hidden="true" />
            Approve
          </button>
        )}
        {onApprove && onCancel && (
          <button type="button" className={`boe-btn boe-btn-secondary ${styles.rowButton} ${styles.cancelInline}`} onClick={onCancel}>
            Cancel task
          </button>
        )}
        <TaskRowMenu label={menuLabel} items={menuItems} size={32} />
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
  allUsers: { id: string; full_name: string; team: string | null }[]
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

  const canSave = !saving
    && title.trim().length > 0 && assigneeId !== '' && dueDate !== '' && priority !== ''

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

    // No assignee notification: a new task is announced by the assignee's
    // acknowledgment section. See src/lib/notifications/taskNotificationPolicy.ts.
    const { error: logErr } = await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: session.user.id,
      action: 'created', note: isSelf ? 'Task created for self' : 'Task created and assigned',
    })
    if (logErr) console.error('[assigned-by-me] activity log insert failed:', logErr.message)

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
    if (attachUploadFailed) onError('Task created, but some attachments failed to upload.')

    onCreated(task as unknown as Task)
  }

  const PRIORITY_CFG = {
    low:    { bg: '#276247', border: 'rgba(39,98,71,0.4)',  text: '#276247' },
    medium: { bg: '#C48A1A', border: 'rgba(196,138,26,0.4)',  text: '#805B0D' },
    high:   { bg: '#B42332', border: 'rgba(180,35,50,0.4)', text: '#B42332' },
  } as const

  const LABEL_STYLE: React.CSSProperties = {
    fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
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
            <p style={{ fontSize: '12px', color: colors.red, marginTop: '4px' }}>Task name is required</p>
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
            <p style={{ fontSize: '12px', color: colors.red, marginTop: '4px' }}>Assignee is required</p>
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
                      fontSize: '12px', fontWeight: selected ? 700 : 500,
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
              <p style={{ fontSize: '12px', color: colors.red, marginTop: '4px' }}>Required</p>
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
              <p style={{ fontSize: '12px', color: colors.red, marginTop: '4px' }}>Required</p>
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
                  <span style={{ fontSize: '12px', color: colors.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: '12px', color: colors.muted, flexShrink: 0 }}>{(f.size / 1024).toFixed(0)} KB</span>
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
                width: '100%', padding: '7px 0', borderRadius: '8px',
                border: `1.5px dashed ${attachDropActive ? colors.brand : colors.border}`,
                background: attachDropActive ? colors.brandTint : colors.raised,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <Paperclip size={12} color={colors.secondary} strokeWidth={1.8} />
              <span style={{ fontSize: '12px', color: colors.secondary }}>Add files</span>
              <span style={{ fontSize: '12px', color: colors.muted }}>— 10 MB total</span>
            </button>
            {attachDropActive && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
                fontSize: '12px', fontWeight: 600, color: colors.brand,
                background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
              }}>
                Drop files to attach
              </div>
            )}
          </div>
          <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
            Drop files here, paste copied files into the description, or browse
          </p>
          {attachError && <p style={{ fontSize: '12px', color: colors.red, marginTop: '4px' }}>{attachError}</p>}
        </div>

        {/* Important toggle */}
        <div
          onClick={() => setIsUrgent(!isUrgent)}
          style={{
            marginBottom: '16px', padding: '8px 12px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderRadius: '8px',
            background: isUrgent ? 'rgba(183,137,42,0.06)' : colors.raised,
            border: `1px solid ${isUrgent ? 'rgba(183,137,42,0.3)' : colors.border}`,
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: isUrgent ? '#805B0D' : colors.primary }}>
            {isUrgent ? 'Marked Important' : 'Mark Important'}
          </span>
          <div style={{
            width: '30px', height: '17px', borderRadius: '8px',
            background: isUrgent ? '#B7892A' : colors.float,
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
              padding: '7px 16px', borderRadius: '8px', border: `1px solid ${colors.border}`,
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
              padding: '7px 18px', borderRadius: '8px', border: 'none',
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
          <label style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Task Name <span style={{ color: colors.red }}>*</span>
          </label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} className="boe-input" style={{ width: '100%', boxSizing: 'border-box' }} />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>
            Note <span style={{ color: colors.muted, fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="boe-input" style={{ resize: 'none', width: '100%', boxSizing: 'border-box' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>Priority</label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {PRIORITIES_EDIT.map(p => (
                <button key={p} onClick={() => setPriority(p)} className={`boe-chip${priority === p ? ' boe-chip-selected' : ''}`} style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize', fontSize: '12px', padding: '3px 0' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted, display: 'block', marginBottom: '5px' }}>Due Date</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="boe-input" style={{ colorScheme: 'light', width: '100%', boxSizing: 'border-box' }} />
          </div>
        </div>

        <div
          onClick={() => setIsUrgent(!isUrgent)}
          style={{
            marginBottom: '16px', padding: '8px 12px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderRadius: '8px',
            background: isUrgent ? 'rgba(183,137,42,0.06)' : colors.raised,
            border: `1px solid ${isUrgent ? 'rgba(183,137,42,0.3)' : colors.border}`,
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: isUrgent ? '#805B0D' : colors.primary }}>Mark Important</span>
          <div style={{ width: '30px', height: '17px', borderRadius: '8px', background: isUrgent ? '#B7892A' : colors.float, position: 'relative', flexShrink: 0, transition: 'background 0.16s', border: `1px solid ${colors.border}` }}>
            <div style={{ position: 'absolute', top: '1.5px', left: isUrgent ? '12px' : '1.5px', width: '12px', height: '12px', borderRadius: '50%', background: '#fff', transition: 'left 0.16s' }} />
          </div>
        </div>

        {saveError && (
          <div style={{ fontSize: '12px', color: colors.red, marginBottom: '10px' }}>{saveError}</div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: '8px', border: `1px solid ${colors.border}`, background: 'transparent', cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: colors.secondary }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave} style={{ padding: '7px 18px', borderRadius: '8px', border: 'none', background: canSave ? colors.primary : colors.float, color: canSave ? '#fff' : colors.muted, cursor: canSave ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 600, transition: 'background 0.12s' }}>
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
      <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#E4DED7', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '4px' }}>
        <CheckCircle2 size={14} color={colors.muted} />
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: colors.secondary }}>No {label} tasks</span>
      <span style={{ fontSize: '12px', color: colors.muted }}>You&apos;re all clear here.</span>
    </div>
  )
}

// ─── First-load placeholder ───────────────────────────────────────────────────
// Rows-shaped, at the real card height and gap, so nothing shifts when the data
// lands. It exists because the only other honest option while the first query
// is in flight is a blank area — and the DISHONEST option, which is what this
// page drew the moment its full-screen loader was removed, is the empty state
// below: "No overdue tasks. You're all clear here."
function TaskListSkeleton({ isMobile, rows = 6 }: { isMobile?: boolean; rows?: number }) {
  return (
    <div
      style={isMobile
        ? { display: 'flex', flexDirection: 'column', gap: '8px' }
        : { background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '12px', overflow: 'hidden' }}
      role="status"
      aria-busy="true"
      aria-label="Loading tasks"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{
            ...(isMobile
              ? { border: `1px solid ${colors.border}`, borderRadius: '12px' }
              : { borderBottom: i === rows - 1 ? 'none' : `1px solid ${colors.border}` }),
            background: colors.base,
            minHeight: isMobile ? '62px' : '50px',
            display: 'flex', alignItems: 'center', gap: '14px',
            padding: isMobile ? '10px 12px' : '0 14px',
          }}
        >
          <span style={{ display: 'block', width: '11px', height: '11px', borderRadius: '50%', background: '#E4DED7', flexShrink: 0 }} />
          <span style={{ display: 'block', flex: 1, maxWidth: '340px', height: '11px', borderRadius: '6px', background: '#E4DED7' }} />
          {!isMobile && (
            <>
              <span style={{ display: 'block', width: '76px', height: '11px', borderRadius: '6px', background: '#E4DED7' }} />
              <span style={{ display: 'block', width: '58px', height: '11px', borderRadius: '6px', background: '#E4DED7' }} />
              <span style={{ display: 'block', width: '64px', height: '11px', borderRadius: '6px', background: '#E4DED7' }} />
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function AssignedByMeContent() {
  // Delegate, edit and delete show their result at once and let the cache
  // correct behind them — the same override the /tasks/my list keeps, for the
  // same reason: a round trip should not stand between the click and the row.
  const [taskOverrides,     setTaskOverrides]     = useState<Task[] | null>(null)
  const [selectedTask,      setSelectedTask]      = useState<Task | null>(null)
  const [editingTask,       setEditingTask]       = useState<Task | null>(null)
  const [showDelegateModal, setShowDelegateModal] = useState(false)
  const [delegateError,     setDelegateError]     = useState<string | null>(null)
  const [isMobile,          setIsMobile]          = useState(false)
  // Approve and Cancel from a row. One flag for both: only one dialog is ever open.
  const [approvingTask,     setApprovingTask]     = useState<Task | null>(null)
  const [cancellingTask,    setCancellingTask]    = useState<Task | null>(null)
  const [rowActionBusy,     setRowActionBusy]     = useState(false)
  const rowActionBusyRef = useRef(false)
  const { toast, show: showToast, dismiss: dismissToast } = useToast()

  // Tab + filters read from and write to the URL; the search box keeps a local
  // value so typing is not one navigation per keystroke.
  const { state, setState } = useListUrlState(LIST_PARAMS)
  const activeTab      = state.tab
  const filterAssignee = state.assignee
  const filterPriority = state.priority
  const search         = state.q
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(search, next => setState({ q: next }))

  useListScrollRestore()
  // This exact view, handed to Task Detail so Submit for Approval returns here.
  const returnTo = useCurrentReturnPath()

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { viewAsUserId, exitViewMode } = useViewAs()

  // ── Identity ──────────────────────────────────────────────────────────────
  //
  // WHAT THIS REPLACES, AND WHY EVERY ARRIVAL HERE WENT BLANK.
  //
  // This page resolved its own user: a mount-time effect awaited
  // `supabase.auth.getSession()`, and only then could it ask for any task. The
  // whole page sat behind `if (loading) return <LoadingScreen />` until that
  // hop and the reads after it had finished — so a Back press from a task did
  // not return to this list, it rebuilt it from nothing, module shell and all.
  //
  // useSignedInUserId is the shared resolution the module shell above this page
  // has already done on the same navigation: the id comes from the stored
  // session with no request, so it is known on the FIRST render and the task
  // query starts immediately instead of second in a chain.
  //
  // Identity here is for query keys and for what is drawn. The reads run
  // against PostgREST with the user's own JWT, so row access is decided by RLS
  // on the server, not by this value.
  const { data: loggedInId, isPending: idPending } = useSignedInUserId()
  const authReady = !idPending
  const { data: profile = null } = useProfile(loggedInId)
  const { data: allUsers = [] } = useActiveUsers()

  // View-as overrides the logged-in user, exactly as it did before.
  const userId = viewAsUserId ?? loggedInId ?? ''

  // `isPending` — not `isLoading`. A query still waiting on its `enabled` gate
  // reports `isLoading: false` (nothing is fetching yet) while `isPending`
  // stays true (there is no data yet), so reading `isLoading` would draw the
  // empty state before the server had been asked anything.
  const { data: allTasksRaw = [], isPending: tasksPending } = useAssignedByMe(userId || null)
  const allTasks = taskOverrides ?? allTasksRaw
  const tasksResolved = !tasksPending

  // The SAME unfiltered name lookup this page always used — the drawer resolves
  // assignees, creators, whoever a task is waiting on and activity actors from
  // it, and any of them may since have been deactivated — but read through a
  // cache instead of re-issued on every arrival. See useAllUserNames.
  const { data: userMap = {} } = useAllUserNames()

  // View As reads under the signed-in admin's RLS, so the bar would describe the
  // admin's rows rather than the viewed person's. It simply does not run.
  const { data: team, isError: teamFailed } = useTeamResponse(viewAsUserId ? null : loggedInId)
  const inactiveIds = useMemo(() => new Set(team?.inactive.map(p => p.userId)), [team])

  // The person who may act on a row. View As is read-only, so nobody there.
  const actorId = viewAsUserId ? null : (loggedInId ?? null)

  // A notice from Task Detail, which has just approved or cancelled and sent the
  // person here: its own toast would have disappeared with it.
  useEffect(() => {
    const flash = takeFlashToast()
    if (flash) showToast(flash.message, flash.variant)
  }, [showToast])

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

  // Fresh rows from the server replace any local override. Written through a
  // named function for the same reason /tasks/my does: a bare setState in an
  // effect body is a cascading render the lint rule rightly objects to.
  useEffect(() => {
    const resetOverrides = () => { setTaskOverrides(null) }
    resetOverrides()
  }, [allTasksRaw])

  // Signed out — to /login. Waits for `authReady`: an unresolved context reports
  // a null user, which is not the same answer as "there is no session".
  useEffect(() => {
    if (authReady && !loggedInId) router.push('/login')
  }, [authReady, loggedInId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Warm the detail route for the rows in view — AT THE URL THAT WILL ACTUALLY
  // BE OPENED. It warmed `/tasks/<id>` while every row navigates to
  // `/tasks/<id>?returnTo=…`, and Next keys its route cache on pathname AND
  // search, so not one of those fifteen requests could ever be used. Same
  // count, same cost, now spent on the thing that is asked for. `returnTo` is
  // deliberately not a dependency — see the matching note on /tasks/my.
  //
  // Each href is warmed once per arrival: `allTasksRaw` changes identity on
  // every refetch, and the effect used to re-request the same batch each time.
  const warmedHrefs = useRef(new Set<string>())
  useEffect(() => {
    if (allTasksRaw.length === 0) return
    allTasksRaw.slice(0, 15).forEach(t => {
      const href = taskDetailHref(t.id, returnTo)
      if (warmedHrefs.current.has(href)) return
      warmedHrefs.current.add(href)
      router.prefetch(href)
    })
  }, [allTasksRaw]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleTaskDelegated = (task: Task) => {
    setTaskOverrides(prev => [task, ...(prev ?? allTasksRaw)])
    setShowDelegateModal(false)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })
    queryClient.invalidateQueries({ queryKey: assignedByMeKey(userId) })
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
  }

  const handleEditSaved = (updated: Task) => {
    setTaskOverrides(prev => (prev ?? allTasksRaw).map(t => t.id === updated.id ? updated : t))
    setEditingTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', updated.assigned_to] })
    queryClient.invalidateQueries({ queryKey: assignedByMeKey(userId) })
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
    setTaskOverrides(prev => (prev ?? allTasksRaw).filter(t => t.id !== task.id))
    if (selectedTask?.id === task.id) setSelectedTask(null)
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })
    queryClient.invalidateQueries({ queryKey: assignedByMeKey(userId) })
    queryClient.invalidateQueries({ queryKey: ['top-tasks'] })
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
  }

  // Every list that shows this task, after a row has closed it or may have.
  const refreshAfterRowAction = (task: Task) => {
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', task.assigned_to] })
    queryClient.invalidateQueries({ queryKey: assignedByMeKey(userId) })
    queryClient.invalidateQueries({ queryKey: ['top-tasks'] })
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
    queryClient.invalidateQueries({ queryKey: TEAM_RESPONSE_KEY })
  }

  const runRowAction = async (
    task: Task,
    send: (actor: string) => Promise<ListActionResult>,
    doneMessage: string,
  ) => {
    if (!actorId || rowActionBusyRef.current) return
    rowActionBusyRef.current = true
    setRowActionBusy(true)
    try {
      const result = await send(actorId)
      setApprovingTask(null)
      setCancellingTask(null)
      if (result.kind === 'done') {
        setTaskOverrides(prev => (prev ?? allTasksRaw).filter(t => t.id !== task.id))
        if (selectedTask?.id === task.id) setSelectedTask(null)
        refreshAfterRowAction(task)
        showToast(doneMessage)
        return
      }
      if (result.refresh) refreshAfterRowAction(task)
      window.alert(result.message)
    } finally {
      rowActionBusyRef.current = false
      setRowActionBusy(false)
    }
  }

  const confirmApprove = () => {
    if (!approvingTask) return
    const task = approvingTask
    void runRowAction(task, actor => approveTaskFromList(supabase, task, actor), 'Task approved and completed.')
  }

  const confirmCancel = (reason: string) => {
    if (!cancellingTask) return
    const task = cancellingTask
    void runRowAction(task, actor => cancelTaskFromList(supabase, task, actor, reason, profile?.full_name), 'Task cancelled.')
  }

  const buckets = useMemo(() => {
    // Work waiting on the reader first, then what they marked important.
    const rank = (t: Task) => (t.status === 'pending_approval' ? 0 : t.is_urgent ? 1 : 2)
    const sort = (arr: Task[]) => [...arr].sort((a, b) => rank(a) - rank(b))
    return {
      all:            sort(allTasks),
      // Work handed back for this person to accept. `overdue` will not also
      // contain it — once submitted for approval it is no longer overdue
      // responsibility against the assignee (see accruesAssigneeOverdue).
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
  usePruneUnknownValue(tasksResolved, filterAssignee, assigneeIds, () => setState({ assignee: '' }))

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

  const renderTask = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      userMap={userMap}
      assigneeInactive={inactiveIds.has(task.assigned_to ?? '')}
      onClick={() => setSelectedTask(prev => prev?.id === task.id ? null : task)}
      onView={() => router.push(taskDetailHref(task.id, returnTo))}
      onEdit={() => setEditingTask(task)}
      onDelete={() => handleDelete(task)}
      onApprove={actorId && canApproveTask(task, actorId) ? () => setApprovingTask(task) : undefined}
      onCancel={actorId && canCancelFromList(task, actorId) ? () => setCancellingTask(task) : undefined}
      isMobile={isMobile}
    />
  )

  // NOTE: no early `return <LoadingScreen />`. Blanking the page hid the tabs,
  // the filters and the whole module shell behind it until the first read came
  // back — on every arrival, including a Back press that had the rows cached.
  // The chrome now renders straight away and only the rows area waits.

  return (
    <>
      <DashboardLayout
        profile={profile}
        title="Assigned By Me"
        onSignOut={handleLogout}
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
                          fontSize: '12px', fontWeight: 700,
                          padding: '1px 7px', borderRadius: '8px',
                          background: standOut ? `${item.color}18` : 'rgba(0,0,0,0.05)',
                          color: standOut ? item.color : colors.secondary,
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
            <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Search */}
              <div style={{
                flex: '2 1 160px', display: 'flex', alignItems: 'center', gap: '6px',
                background: colors.base, border: `1px solid ${colors.borderInput}`,
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
                  style={{ flex: '1 1 120px', minWidth: '110px', padding: '6px 10px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '12px', color: filterAssignee ? colors.primary : colors.muted, cursor: 'pointer' }}
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
                style={{ flex: '1 1 100px', minWidth: '95px', padding: '6px 10px', background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '6px', outline: 'none', fontSize: '12px', color: filterPriority ? colors.primary : colors.muted, cursor: 'pointer' }}
              >
                <option value="">All Priority</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            {/* Docked to the window's edge from 1132px; narrower, one line above the list. */}
            {!viewAsUserId && (
              <TeamResponseBar
                team={team}
                failed={teamFailed}
                selectedId={filterAssignee}
                onSelect={id => setState({ assignee: id })}
              />
            )}

            {/* Task rows */}
            {!tasksResolved ? (
              <TaskListSkeleton isMobile={isMobile} />
            ) : visibleTasks.length === 0 ? (
              <EmptyState label={TABS.find(t => t.key === activeTab)!.label} />
            ) : (
              <>
                {isMobile ? (
                  <div className={styles.cards}>{visibleTasks.map(renderTask)}</div>
                ) : (
                  <div className={styles.list}>
                    <div className={styles.headRow}>
                      <div />
                      <div>Task</div>
                      <div>Assigned to</div>
                      <div className={styles.colPriority}>Priority</div>
                      <div>Status</div>
                      <div>Due</div>
                      <div className={styles.colUpdate}>Last update</div>
                      <div />
                    </div>
                    {visibleTasks.map(renderTask)}
                  </div>
                )}
                <div className={styles.count}>
                  {visibleTasks.length} task{visibleTasks.length !== 1 ? 's' : ''}
                </div>
              </>
            )}

        </div>
      </DashboardLayout>

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          userMap={userMap}
          onClose={() => setSelectedTask(null)}
          fullPageHref={taskDetailHref(selectedTask.id, returnTo)}
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

      {approvingTask && (
        <ApproveTaskDialog
          title={approvingTask.title}
          assigneeName={userMap[approvingTask.assigned_to ?? ''] ?? 'the assignee'}
          busy={rowActionBusy}
          onClose={() => setApprovingTask(null)}
          onConfirm={confirmApprove}
        />
      )}

      {cancellingTask && (
        <CancelTaskModal
          busy={rowActionBusy}
          onClose={() => { if (!rowActionBusy) setCancellingTask(null) }}
          onConfirm={confirmCancel}
        />
      )}

      <Toast toast={toast} onDismiss={dismissToast} />

      {delegateError && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 1100,
          padding: '10px 16px',
          borderRadius: '8px',
          background: colors.redTint,
          border: `1px solid rgba(180,35,50,0.3)`,
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
