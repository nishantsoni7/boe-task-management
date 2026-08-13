'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { Task, LogEntry, TaskStatus, UserProfile, TaskAttachment } from '@/lib/types'
import {
  isOverdue, formatFullDate, formatDateTime, formatActivityTimestamp,
  formatLogAction, timeAgo, getTaskAging, taskStatusLabel,
} from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { AttachmentPreviewModal } from '@/components/ui/AttachmentPreviewModal'
import { MultilineText } from '@/components/ui/MultilineText'
import { CopyAssignModal } from '@/components/tasks/CopyAssignModal'
import { useToast, Toast } from '@/components/ui/toast'
import { getFileTypeLabel, compressImageFile, filterAcceptedFiles, ACCEPTED_ATTACHMENT_TYPES, ATTACHMENT_UPLOAD_CONCURRENCY } from '@/lib/attachment-utils'
import {
  type PendingAttachment,
  attachmentRowsForSubmit, attachmentStatusLabel, createAttachmentQueue,
  failureSummary, submissionGate, submitButtonLabel,
} from '@/lib/tasks/commentAttachments'
import {
  canMarkComplete, canPostUpdate,
  canSubmitForApproval, canApproveTask, canReturnTask,
  RETURN_REASON_MAX_LENGTH,
} from '@/lib/tasks/taskDetailAccess'
import { CircleCheckBig, SendHorizontal, Undo2, UserCheck, UserRound } from 'lucide-react'
import { perfTrack } from '@/lib/perf'

// ─── Status config ─────────────────────────────────────────────────────────────

// The gold used for pending_approval is the "important" gold, not the amber of
// `waiting` — the two are adjacent states and must not read as one.
const APPROVAL_GOLD      = '#A57F14'
const APPROVAL_GOLD_TINT = 'rgba(196,154,40,0.10)'

const STATUS_COLORS: Record<string, string> = {
  pending:          colors.muted,
  started:          colors.secondary,
  working:          colors.blue,
  waiting:          colors.amber,
  blocked:          colors.red,
  pending_approval: APPROVAL_GOLD,
  completed:        colors.green,
  cancelled:        '#78716C',
}

const STATUS_TINTS: Record<string, string> = {
  pending:          colors.float,
  started:          colors.float,
  working:          colors.blueTint,
  waiting:          colors.amberTint,
  blocked:          colors.redTint,
  pending_approval: APPROVAL_GOLD_TINT,
  completed:        colors.greenTint,
  cancelled:        '#F5F5F4',
}

const CANCEL_REASONS = [
  'No longer required',
  'Duplicate task',
  'Created by mistake',
  'Requirement changed',
  'Completed outside system',
  'Other',
]

const PRIORITY_COLORS: Record<string, { fg: string; bg: string }> = {
  high:   { fg: colors.red,   bg: colors.redTint   },
  medium: { fg: colors.amber, bg: colors.amberTint },
  low:    { fg: colors.muted, bg: colors.float      },
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TaskDetailPage() {
  const [profile,         setProfile]         = useState<UserProfile | null>(null)
  const [task,            setTask]            = useState<Task | null>(null)
  const [log,             setLog]             = useState<LogEntry[]>([])
  const [creatorName,     setCreatorName]     = useState<string | null>(null)
  const [currentUserId,   setCurrentUserId]   = useState('')
  const [loading,         setLoading]         = useState(true)

  const [_selectedStatus,   setSelectedStatus]  = useState<string>('')
  const [waitingOnType,    setWaitingOnType]   = useState<'team_member' | 'external'>('team_member')
  const [waitingOnUserId,  setWaitingOnUserId] = useState('')
  const [waitingOnText,    setWaitingOnText]   = useState('')
  const [waitingOnError,   setWaitingOnError]  = useState(false)
  const [saving,           setSaving]          = useState(false)
  const [markingComplete,  setMarkingComplete] = useState(false)
  const [reopening,        setReopening]       = useState(false)
  // Duplicate-submission guards for the two mutations that had none. Each is a
  // ref (read synchronously, so a double-click is rejected in the same tick)
  // plus state (drives the disabled button). Both write permanent activity
  // rows and send notifications, so a duplicate run is not merely wasteful.
  const [acknowledging,    setAcknowledging]   = useState(false)
  const acknowledgingRef  = useRef(false)
  const [statusUpdating,   setStatusUpdating]  = useState(false)
  const statusUpdatingRef = useRef(false)
  const [cancelModalOpen,  setCancelModalOpen] = useState(false)
  const [cancelReason,     setCancelReason]    = useState('')
  const [cancelOtherText,  setCancelOtherText] = useState('')
  const [cancelling,       setCancelling]      = useState(false)
  const [modalOpen,        setModalOpen]       = useState(false)
  const [modalStatus,      setModalStatus]     = useState<string>('')
  const [teamMembers,      setTeamMembers]     = useState<{ id: string; full_name: string }[]>([])

  // Creator-approval workflow. One in-flight flag covers all three actions —
  // they are mutually exclusive on one task — with the usual ref/state pair, so
  // a double-click is refused in the same tick rather than after a re-render.
  const [reviewBusy,       setReviewBusy]      = useState<'submit' | 'approve' | 'return' | null>(null)
  const reviewBusyRef = useRef(false)
  const [returnModalOpen,  setReturnModalOpen] = useState(false)
  const [returnReason,     setReturnReason]    = useState('')
  const [returnReasonError, setReturnReasonError] = useState<string | null>(null)

  const [commentNote,        setCommentNote]        = useState('')
  const [commentSaving,      setCommentSaving]      = useState(false)
  const commentSavingRef = useRef(false)  // synchronous re-entry guard (double-click protection)
  const [commentUploadError, setCommentUploadError] = useState<string | null>(null)
  const [commentDropActive,  setCommentDropActive]  = useState(false)
  // True only while Send Update is blocked on bytes still moving, so the button
  // can say "Uploading attachment…" rather than implying the update is saving.
  const [commentWaitingUploads, setCommentWaitingUploads] = useState(false)

  // Files upload the moment they are picked, so the Send Update click no longer
  // carries the bytes. The queue (see createAttachmentQueue) is the authority on
  // what is attached; this state is its published mirror, for rendering only.
  const [commentAttachments, setCommentAttachments] = useState<PendingAttachment[]>([])

  const [editingActivityId,  setEditingActivityId]  = useState<string | null>(null)
  const [editActivityNote,   setEditActivityNote]   = useState('')
  const [savingActivityEdit, setSavingActivityEdit] = useState(false)
  const [deletingActivityId, setDeletingActivityId] = useState<string | null>(null)

  const [taskLevelAttachments, setTaskLevelAttachments] = useState<TaskAttachment[]>([])
  const [previewAttachment,    setPreviewAttachment]    = useState<{ url: string; fileName?: string } | null>(null)

  // Copy & Assign (admin-only). The modal owns its field state; the page owns the submit.
  const [copyModalOpen,  setCopyModalOpen]  = useState(false)
  const [copySubmitting, setCopySubmitting] = useState(false)
  const [copyError,      setCopyError]      = useState<string | null>(null)
  const [lastCopied,     setLastCopied]     = useState<{ id: string; name: string } | null>(null)
  const { toast, show: showToast, dismiss: dismissToast } = useToast()

  // The "View new task" chip is a convenience, not a banner — auto-clear it after a short while.
  useEffect(() => {
    if (!lastCopied) return
    const t = setTimeout(() => setLastCopied(null), 10000)
    return () => clearTimeout(t)
  }, [lastCopied])

  const [editingDueDate,      setEditingDueDate]      = useState(false)
  const [editingPriority,     setEditingPriority]     = useState(false)
  const [editDueDate,         setEditDueDate]         = useState('')
  const [editPriority,        setEditPriority]        = useState<'high' | 'medium' | 'low'>('medium')
  const [savingDueDate,       setSavingDueDate]       = useState(false)
  const [savingPriority,      setSavingPriority]      = useState(false)
  const [dueDateMsg,          setDueDateMsg]          = useState<{ ok: boolean; text: string } | null>(null)
  const [priorityMsg,         setPriorityMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  const [editingTitle,        setEditingTitle]        = useState(false)
  const [editTitle,           setEditTitle]           = useState('')
  const [savingTitle,         setSavingTitle]         = useState(false)
  const [editingDescription,  setEditingDescription]  = useState(false)
  const [editDescription,     setEditDescription]     = useState('')
  const [savingDescription,   setSavingDescription]   = useState(false)

  const router      = useRouter()
  const params      = useParams()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const taskId      = params.id as string

  // ── Background attachment uploads ───────────────────────────────────────────
  // One queue per task for the page's lifetime. Created here rather than per
  // click so its concurrency cap and prepare gate actually span every file the
  // user adds.
  const attachmentQueue = useMemo(() => createAttachmentQueue({
    taskId,
    compress:     compressImageFile,
    upload:       (path, file) =>
      supabase.storage.from('task-attachments').upload(path, file, { upsert: false }),
    publicUrl:    (path) =>
      supabase.storage.from('task-attachments').getPublicUrl(path).data.publicUrl,
    deleteObject: async (path) => {
      // Storage policy `auth_delete` lets the uploader remove their own object,
      // so this succeeds for whoever queued it. A failure only leaves an
      // unreferenced object — logged, never surfaced.
      const { error } = await supabase.storage.from('task-attachments').remove([path])
      if (error) console.error('[attachment cleanup] delete failed:', error.message)
    },
    onChange:     setCommentAttachments,
    concurrency:  ATTACHMENT_UPLOAD_CONCURRENCY,
    track:        () => perfTrack('task.attachment.upload'),
  }), [taskId, supabase])

  // After any task mutation, invalidate My Tasks + Today's Focus caches so navigating back shows fresh data
  const invalidateTaskCache = (assignedTo: string) => {
    queryClient.invalidateQueries({ queryKey: ['tasks', 'assigned-to', assignedTo] })
    queryClient.invalidateQueries({ queryKey: ['top-tasks'] })
  }


  useEffect(() => {
    const init = async () => {
      // Timings print to the console only with NEXT_PUBLIC_BOE_PERF_DEBUG=true;
      // otherwise every call here is a no-op. See src/lib/perf.ts.
      const perf = perfTrack('task.detail.load')
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCurrentUserId(user.id)
      perf.mark('auth')

      const taskId = params.id as string

      // Fetch task (with creator name embedded), profile, members, activity log,
      // and all attachments for this task — all in one parallel batch.
      const [
        { data: taskData },
        { data: profileData },
        { data: members },
        { data: activityLogData },
        { data: allAttachments },
      ] = await Promise.all([
        supabase.from('tasks').select('*, creator:created_by(full_name)').eq('id', taskId).single(),
        supabase.from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', user.id).single(),
        supabase.from('users').select('id, full_name').eq('is_active', true).order('full_name'),
        supabase.from('task_activity_log')
          .select('id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id, attachment_url, users:actor_id ( full_name )')
          .eq('task_id', taskId)
          .order('created_at', { ascending: false }),
        supabase.from('task_attachments')
          .select('*')
          .eq('task_id', taskId)
          .order('created_at', { ascending: true }),
      ])

      perf.mark('queries')

      if (members) setTeamMembers(members)
      if (profileData) setProfile(profileData as UserProfile)

      if (taskData) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const creatorName = (taskData as any).creator?.full_name ?? null
        if (creatorName) setCreatorName(creatorName)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { creator: _creator, ...taskFields } = taskData as any
        setTask(taskFields)
        setSelectedStatus(taskFields.status)
      }

      // Split attachments: task-level (no activity_log_id) vs per-log
      const attachsByLogId: Record<string, TaskAttachment[]> = {}
      const taskLevelAtts: TaskAttachment[] = []
      for (const att of (allAttachments ?? []) as TaskAttachment[]) {
        if (!att.activity_log_id) {
          taskLevelAtts.push(att)
        } else {
          if (!attachsByLogId[att.activity_log_id]) attachsByLogId[att.activity_log_id] = []
          attachsByLogId[att.activity_log_id].push(att)
        }
      }
      setTaskLevelAttachments(taskLevelAtts)

      if (activityLogData) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setLog((activityLogData as any[]).map(e => ({
          ...e,
          actor_name:     e.users?.full_name ?? null,
          old_val:        e.old_val ?? null,
          new_val:        e.new_val ?? null,
          attachment_url: e.attachment_url ?? null,
          attachments:    attachsByLogId[e.id] ?? [],
        })))
      }

      setLoading(false)
      perf.end()
    }
    init()
  }, [params.id, router, supabase])

  const loadLog = async (taskId: string) => {
    // Fetch activity log and all task attachments in parallel
    const [{ data }, { data: allAtts }] = await Promise.all([
      supabase
        .from('task_activity_log')
        .select('id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id, attachment_url, users:actor_id ( full_name )')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false }),
      supabase
        .from('task_attachments')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true }),
    ])
    if (!data) return

    const attachsByLogId: Record<string, TaskAttachment[]> = {}
    const taskLevelAtts: TaskAttachment[] = []
    for (const att of (allAtts ?? []) as TaskAttachment[]) {
      if (!att.activity_log_id) {
        taskLevelAtts.push(att)
      } else {
        if (!attachsByLogId[att.activity_log_id]) attachsByLogId[att.activity_log_id] = []
        attachsByLogId[att.activity_log_id].push(att)
      }
    }
    setTaskLevelAttachments(taskLevelAtts)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setLog((data as any[]).map(e => ({
      ...e,
      actor_name:     e.users?.full_name ?? null,
      attachment_url: e.attachment_url ?? null,
      attachments:    attachsByLogId[e.id] ?? [],
    })))
  }

  const acknowledge = async () => {
    if (!task) return
    if (task.assigned_to !== currentUserId) return
    if (task.created_by === currentUserId) return
    // Synchronous re-entry guard. Without it a double-click ran the whole
    // sequence twice and wrote a SECOND pair of acknowledged/status_changed
    // rows into the permanent activity history, plus a duplicate notification
    // to the creator. A ref is required rather than state: both clicks land
    // before React re-renders the button as disabled.
    if (acknowledgingRef.current) return
    acknowledgingRef.current = true
    setAcknowledging(true)
    try {
    const now = new Date().toISOString()
    const oldStatus = task.status
    const { error } = await supabase.from('tasks').update({
      acknowledged_at: now,
      status: 'working',
      last_update_at: now,
    }).eq('id', task.id)
    if (error) {
      alert('Failed to acknowledge task. Please try again.')
      return
    }
    await supabase.from('task_activity_log').insert([
      { task_id: task.id, actor_id: currentUserId, action: 'acknowledged', note: null },
      { task_id: task.id, actor_id: currentUserId, action: 'status_changed', from_status: oldStatus, to_status: 'working', note: null },
    ])
    if (task.created_by && task.created_by !== currentUserId) {
      fetch('/api/notify-status-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by, action: 'working', actorName: profile?.full_name }),
      }).then(res => {
        if (!res.ok) res.json().then(d => console.error('[acknowledge] notification failed:', d))
      }).catch(err => console.error('[acknowledge] notification fetch error:', err))
    }
    setTask({ ...task, acknowledged_at: now, status: 'working' as TaskStatus, last_update_at: now })
    setSelectedStatus('working')
    invalidateTaskCache(task.assigned_to)
    await loadLog(task.id)
    } finally {
      // Always released — no failure path may leave Acknowledge stuck disabled.
      acknowledgingRef.current = false
      setAcknowledging(false)
    }
  }

  const applyStatusChange = async (newStatus: string, reason: string | null, attachmentUrl?: string | null) => {
    if (!task) return
    // Same guard as acknowledge: a double-click here wrote two status_changed
    // rows and fired two notifications for one intended change.
    if (statusUpdatingRef.current) return
    statusUpdatingRef.current = true
    setStatusUpdating(true)
    const perf = perfTrack(newStatus === 'completed' ? 'task.complete' : 'task.status.update')
    try {
    const oldStatus = task.status
    const now = new Date().toISOString()
    const updates: Record<string, unknown> = { status: newStatus, last_update_at: now }
    if (newStatus === 'blocked')   updates.blocker_reason = reason
    if (oldStatus === 'blocked' && newStatus !== 'blocked') updates.blocker_reason = null
    if (oldStatus === 'waiting' && newStatus !== 'waiting') {
      updates.waiting_on_type    = null
      updates.waiting_on_user_id = null
      updates.waiting_on_text    = null
    }
    if (newStatus === 'completed') updates.completed_at = now

    const { error: taskErr } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (taskErr) {
      console.error('[applyStatusChange] tasks update failed:', taskErr.message)
      window.alert('Failed to update task status. Please try again.')
      return
    }
    perf.mark('update-task')
    // Read the inserted row back so the feed can be updated locally. The audit
    // record is still written before the user is told the change succeeded —
    // only the *display* refresh changes.
    const { data: logRow, error: logErr } = await supabase.from('task_activity_log').insert({
      task_id:        task.id,
      actor_id:       currentUserId,
      action:         'status_changed',
      from_status:    oldStatus,
      to_status:      newStatus,
      note:           reason ?? null,
      attachment_url: attachmentUrl ?? null,
    })
      .select('id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id, attachment_url')
      .single()
    if (logErr) console.error('[applyStatusChange] activity log insert failed:', logErr.message)
    {
      const recipient = currentUserId === task.created_by ? task.assigned_to : task.created_by
      if (recipient && recipient !== currentUserId) {
        fetch('/api/notify-status-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by, recipientId: recipient, action: newStatus, actorName: profile?.full_name }),
        }).then(res => {
          if (!res.ok) res.json().then(d => console.error('[applyStatusChange] notification failed:', d))
        }).catch(err => console.error('[applyStatusChange] notification fetch error:', err))
      }
    }
    const localPatch: Partial<Task> = { status: newStatus as TaskStatus, last_update_at: now }
    if (newStatus === 'blocked')   localPatch.blocker_reason = reason
    if (oldStatus === 'blocked' && newStatus !== 'blocked') localPatch.blocker_reason = null
    if (oldStatus === 'waiting' && newStatus !== 'waiting') {
      localPatch.waiting_on_type    = null
      localPatch.waiting_on_user_id = null
      localPatch.waiting_on_text    = null
    }
    setTask({ ...task, ...localPatch })
    setSelectedStatus(newStatus)
    invalidateTaskCache(task.assigned_to)
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
    perf.mark('insert-activity')
    // Prepend the row we just wrote instead of re-reading the entire activity
    // log plus every attachment of the task — two round trips that returned
    // data we already had. A status change never alters attachments, so nothing
    // else on screen goes stale. `loadLog` is the fallback if the read-back
    // failed, so the feed is never left missing an entry.
    if (logRow) {
      setLog(prev => [{
        ...(logRow as unknown as LogEntry),
        actor_name:     profile?.full_name,
        attachment_url: logRow.attachment_url ?? null,
        attachments:    [],
      }, ...prev])
    } else {
      await loadLog(task.id)
    }
    perf.mark('append-activity')
    if (newStatus === 'completed') {
      const dest = task.task_type === 'quotation_request' ? '/tasks/quotation-requests' : '/tasks/my'
      setTimeout(() => router.push(dest), 800)
    }
    } finally {
      statusUpdatingRef.current = false
      setStatusUpdating(false)
      perf.end()
    }
  }

  /**
   * Submit / Approve / Return, all through the one protected RPC.
   *
   * Nothing about who is acting, who gets told or what the task is called is
   * sent from here: `transition_task_review` reads every one of those from the
   * locked task row and takes the actor from auth.uid(). What comes back is the
   * updated task, which is merged into local state — no reload, and no
   * navigation, because none of the three actions moves the task off this page
   * for the person who performed it.
   */
  const runReviewAction = async (action: 'submit' | 'approve' | 'return', note?: string) => {
    if (!task) return false
    if (reviewBusyRef.current) return false
    reviewBusyRef.current = true
    setReviewBusy(action)
    // Timed under the existing actions rather than three new ones: approval IS
    // the completion of a delegated task, and submit/return are status moves.
    // The perf audit's vocabulary stays the size it was.
    const perf = perfTrack(action === 'approve' ? 'task.complete' : 'task.status.update')
    try {
      const { data, error } = await supabase.rpc('transition_task_review', {
        p_task_id: task.id,
        p_action:  action,
        p_note:    note ?? null,
      })
      if (error) {
        console.error(`[runReviewAction:${action}] rpc failed:`, error.message)
        // The RPC's messages are written to be read — "TASK_REVIEW_FORBIDDEN:
        // Only the task creator can approve this task" — so the part after the
        // code is shown rather than a generic failure line.
        const readable = error.message.includes(':')
          ? error.message.slice(error.message.indexOf(':') + 1).trim()
          : error.message
        window.alert(readable || 'Failed to update this task. Please try again.')
        return false
      }
      perf.mark('rpc')

      const result = (data ?? {}) as {
        status?: string
        completed_at?: string | null
        last_update_at?: string | null
        blocker_reason?: string | null
        waiting_on_type?: 'team_member' | 'external' | null
        waiting_on_user_id?: string | null
        waiting_on_text?: string | null
      }
      const nextStatus = (result.status ?? task.status) as TaskStatus
      setTask({
        ...task,
        status:             nextStatus,
        last_update_at:     result.last_update_at ?? task.last_update_at,
        blocker_reason:     result.blocker_reason ?? null,
        waiting_on_type:    result.waiting_on_type ?? null,
        waiting_on_user_id: result.waiting_on_user_id ?? null,
        waiting_on_text:    result.waiting_on_text ?? null,
      })
      setSelectedStatus(nextStatus)
      invalidateTaskCache(task.assigned_to)
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
      // The notification this wrote is addressed to the OTHER party, so there
      // is nothing of the actor's own to invalidate here.
      // The RPC wrote the activity row inside its own transaction, so it is
      // re-read rather than synthesized — the feed shows exactly what was
      // recorded, including the return reason.
      await loadLog(task.id)
      perf.mark('reload-log')
      return true
    } finally {
      reviewBusyRef.current = false
      setReviewBusy(null)
      perf.end()
    }
  }

  const submitForApproval = async () => {
    const ok = await runReviewAction('submit')
    if (ok) showToast(`Submitted to ${creatorName ?? 'the creator'} for review.`)
  }

  const approveTask = async () => {
    const confirmed = window.confirm(
      'Approve this task and mark it complete? This records the completion against the assignee.'
    )
    if (!confirmed) return
    const ok = await runReviewAction('approve')
    if (ok) showToast('Task approved and completed.')
  }

  const returnTask = async () => {
    const reason = returnReason.trim()
    if (!reason) {
      setReturnReasonError('Please say what needs to be corrected.')
      return
    }
    if (reason.length > RETURN_REASON_MAX_LENGTH) {
      setReturnReasonError(`Please keep this under ${RETURN_REASON_MAX_LENGTH} characters.`)
      return
    }
    const ok = await runReviewAction('return', reason)
    if (ok) {
      setReturnModalOpen(false)
      setReturnReason('')
      setReturnReasonError(null)
      showToast('Task returned to Working.')
    }
  }

  const handleReopen = async () => {
    if (!task) return
    const confirmed = window.confirm(
      'Reopen this task? It will be restored to its previous status and the assignee will be notified.'
    )
    if (!confirmed) return
    setReopening(true)
    const res = await fetch('/api/restore-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, actorName: profile?.full_name }),
    })
    if (!res.ok) {
      console.error('[handleReopen] failed:', await res.text())
      window.alert('Failed to reopen task. Please try again.')
      setReopening(false)
      return
    }
    const { restoredStatus } = await res.json()
    const restored = (restoredStatus ?? 'working') as TaskStatus
    setTask({ ...task, status: restored })
    setSelectedStatus(restored)
    invalidateTaskCache(task.assigned_to)
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
    await loadLog(task.id)
    setReopening(false)
  }

  const handleCancelTask = async () => {
    if (!task) return
    const finalReason = cancelReason === 'Other' ? cancelOtherText.trim() : cancelReason
    if (!finalReason) return
    setCancelling(true)
    const res = await fetch('/api/cancel-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, reason: finalReason, actorName: profile?.full_name }),
    })
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Unknown error' }))
      window.alert(`Failed to cancel task: ${error}`)
      setCancelling(false)
      return
    }
    const now = new Date().toISOString()
    setTask({
      ...task,
      status:              'cancelled' as TaskStatus,
      cancellation_reason: finalReason,
      cancelled_at:        now,
      cancelled_by:        currentUserId,
    })
    setSelectedStatus('cancelled')
    setCancelModalOpen(false)
    setCancelReason('')
    setCancelOtherText('')
    invalidateTaskCache(task.assigned_to)
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
    await loadLog(task.id)
    setCancelling(false)
    setTimeout(() => router.push('/tasks/cancelled'), 600)
  }

  // Shared entry point for browse, drag-and-drop, and paste — keeps validation/behavior identical
  // no matter how a file gets into the upload flow. Upload starts HERE, not at submit:
  // the queue begins moving bytes as soon as a file is accepted.
  const addCommentFiles = (incoming: File[]) => {
    if (incoming.length === 0) return
    const { accepted, rejectedNames } = filterAcceptedFiles(incoming)
    // The queue itself drops a file it already holds, so a repeated paste or a
    // drop carrying the same file twice cannot start two uploads for one file.
    attachmentQueue.add(accepted)
    setCommentUploadError(
      rejectedNames.length > 0 ? `Unsupported file type: ${rejectedNames.join(', ')}` : null,
    )
  }

  const removeCommentAttachment = (id: string) => {
    attachmentQueue.remove(id)
    setCommentUploadError(null)
  }

  const retryCommentAttachment = (id: string) => {
    attachmentQueue.retry(id)
    setCommentUploadError(null)
  }

  const handleCommentDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleCommentDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) setCommentDropActive(true)
  }

  const handleCommentDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setCommentDropActive(false)
  }

  const handleCommentDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setCommentDropActive(false)
    addCommentFiles(Array.from(e.dataTransfer.files ?? []))
  }

  const handleCommentPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    const pastedFiles: File[] = []
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile()
          if (file) pastedFiles.push(file)
        }
      }
    }
    if (pastedFiles.length === 0) return
    e.preventDefault() // don't let the browser also paste a filename/placeholder as text
    addCommentFiles(pastedFiles)
  }

  const saveComment = async () => {
    if (!task || commentSavingRef.current) return   // synchronous guard blocks double-submit
    const hasNote = !!commentNote.trim()

    const preGate = submissionGate(attachmentQueue.items(), hasNote)
    if (!preGate.ok) {
      // `empty` is a no-op (nothing typed, nothing attached); a failed upload
      // gets an explanation instead of a silent dead click.
      if (preGate.message) setCommentUploadError(preGate.message)
      return
    }

    commentSavingRef.current = true
    setCommentSaving(true)
    setCommentUploadError(null)

    // Phase names are static — no file names, note text, or ids are recorded.
    const perf = perfTrack('task.comment.add')
    try {
      // Wait only for bytes still in flight. Files that already finished are not
      // touched again, and a text-only update never enters this branch at all.
      if (attachmentQueue.hasPending()) {
        setCommentWaitingUploads(true)
        await attachmentQueue.settleAll()
        setCommentWaitingUploads(false)
      }
      perf.mark('await-uploads')

      // Re-check against the settled list: an upload may have failed while the
      // user was typing, and submitting would then drop a file silently.
      const readyAttachments = attachmentQueue.items()
      const gate = submissionGate(readyAttachments, hasNote)
      if (!gate.ok) {
        setCommentUploadError(gate.message)   // text + attachments preserved
        return
      }

      const now = new Date().toISOString()

      // Insert the comment and read back the full row, so we can append it to local state
      // instead of re-fetching the whole activity log.
      const { data: logRow, error: logErr } = await supabase
        .from('task_activity_log')
        .insert({
          task_id:        task.id,
          actor_id:       currentUserId,
          action:         'note_added',
          note:           commentNote.trim() || null,
          attachment_url: null, // multi-file goes into task_attachments
        })
        .select('id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id, attachment_url')
        .single()

      if (logErr || !logRow) {
        // Nothing was cleared — keep the typed text and selected files, surface an error.
        console.error('[saveComment] activity log insert failed:', logErr?.message)
        setCommentUploadError('Could not post your update. Please try again.')
        return
      }
      perf.mark('insert-comment')

      // The bytes are already in storage, so linking them to the new comment is
      // one bulk insert rather than a round trip per file. Row order matches the
      // order the user picked the files, which is the order they render in.
      //
      // Partial-failure note: if this insert fails the objects stay in storage
      // unreferenced. The comment itself is already recorded, so we surface the
      // failure and render only what is confirmed rather than rolling back a
      // permanent activity row.
      let newAttachments: TaskAttachment[] = []
      let uploadErrors: string[] = []
      const rows = attachmentRowsForSubmit(readyAttachments, {
        taskId:      task.id,
        activityLogId: logRow.id,
        userId:      currentUserId,
        fileTypeOf:  getFileTypeLabel,
      })
      if (rows.length > 0) {
        const { data: attRows, error: attErr } = await supabase
          .from('task_attachments')
          .insert(rows)
          .select('id, task_id, activity_log_id, url, file_name, file_type, created_by, created_at')
        if (attErr || !attRows) {
          console.error('[saveComment] attachment metadata insert failed:', attErr?.message)
          uploadErrors = ['Attachments could not be linked to this update.']
        } else {
          newAttachments = attRows as TaskAttachment[]
        }
      }
      perf.mark('link-attachments')

      // Append the confirmed comment to the activity feed (newest-first, so prepend).
      // Actor is the current user; timestamp comes from the DB row — no re-fetch needed.
      const newEntry: LogEntry = {
        ...(logRow as unknown as LogEntry),
        actor_name:     profile?.full_name,
        attachment_url: logRow.attachment_url ?? null,
        attachments:    newAttachments,
      }
      setLog(prev => [newEntry, ...prev])

      // The comment (the required record) is confirmed — clear the inputs once.
      // The objects are now referenced by task_attachments, so the queue is
      // dropped without deleting anything from storage.
      setCommentNote('')
      attachmentQueue.clear()
      setCommentUploadError(uploadErrors.length > 0 ? uploadErrors.join(' · ') : null)

      // Non-urgent side effects, off the interaction's critical path. Each is fire-and-forget
      // but fully caught, so a rejection can never surface as an unhandled promise rejection.
      setTask(t => (t ? { ...t, last_update_at: now } : t))
      void (async () => {
        // last_update_at only feeds staleness/ordering/freshness display — log on failure,
        // no user-facing error or retry, since the comment itself already succeeded.
        try {
          const { error } = await supabase.from('tasks').update({ last_update_at: now }).eq('id', task.id)
          if (error) console.error('[saveComment] last_update_at bump failed (freshness only):', error.message)
        } catch (e) {
          console.error('[saveComment] last_update_at bump threw (freshness only):', e)
        }
      })()

      const recipient = currentUserId === task.created_by ? task.assigned_to : task.created_by
      if (recipient && recipient !== currentUserId) {
        void (async () => {
          try {
            const res = await fetch('/api/notify-status-update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by, recipientId: recipient, action: 'comment_added', actorName: profile?.full_name }),
            })
            if (!res.ok) console.error('[saveComment] notification failed:', await res.text().catch(() => `status ${res.status}`))
          } catch (err) {
            console.error('[saveComment] notification fetch error:', err)
          }
        })()
      }
    } catch (err) {
      // Any thrown Supabase/upload/runtime error. Text + files are untouched (cleared only on
      // the success path above), so the user can retry without re-typing.
      console.error('[saveComment] unexpected error:', err)
      setCommentUploadError('Could not post your update. Please try again.')
    } finally {
      // Always release Send Update — no failure path leaves it disabled until remount.
      setCommentSaving(false)
      setCommentWaitingUploads(false)
      commentSavingRef.current = false
      perf.end()
    }
  }

  const saveDueDate = async () => {
    if (!task) return
    setSavingDueDate(true)
    setDueDateMsg(null)
    if (editDueDate === (task.due_date ?? '')) { setEditingDueDate(false); setSavingDueDate(false); return }
    const updates = { due_date: editDueDate || null }
    const { error } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (error) { setDueDateMsg({ ok: false, text: 'Failed to save.' }); setSavingDueDate(false); return }
    const { error: logErrDue } = await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId,
      action: 'due_date_changed', note: null,
      old_val: task.due_date ?? null, new_val: editDueDate || null,
    })
    if (logErrDue) console.error('[saveDueDate] activity log insert failed:', logErrDue.message)
    setTask({ ...task, ...updates as Partial<Task> })
    invalidateTaskCache(task.assigned_to)
    await loadLog(task.id)
    setEditingDueDate(false)
    setSavingDueDate(false)
  }

  const savePriority = async () => {
    if (!task) return
    setSavingPriority(true)
    setPriorityMsg(null)
    if (editPriority === task.priority) { setEditingPriority(false); setSavingPriority(false); return }
    const updates = { priority: editPriority }
    const { error } = await supabase.from('tasks').update(updates).eq('id', task.id)
    if (error) { setPriorityMsg({ ok: false, text: 'Failed to save.' }); setSavingPriority(false); return }
    const { error: logErrPri } = await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId,
      action: 'priority_changed', note: null,
      old_val: task.priority, new_val: editPriority,
    })
    if (logErrPri) console.error('[savePriority] activity log insert failed:', logErrPri.message)
    setTask({ ...task, ...updates as Partial<Task> })
    invalidateTaskCache(task.assigned_to)
    await loadLog(task.id)
    setEditingPriority(false)
    setSavingPriority(false)
  }

  const saveTitle = async () => {
    if (!task) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === task.title) { setEditingTitle(false); return }
    setSavingTitle(true)
    const { error } = await supabase.from('tasks').update({ title: trimmed }).eq('id', task.id)
    if (error) { alert('Failed to save title.'); setSavingTitle(false); return }
    const { error: logErrTitle } = await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId,
      action: 'title_changed', note: null,
      old_val: task.title, new_val: trimmed,
    })
    if (logErrTitle) console.error('[saveTitle] activity log insert failed:', logErrTitle.message)
    setTask({ ...task, title: trimmed })
    invalidateTaskCache(task.assigned_to)
    await loadLog(task.id)
    setEditingTitle(false)
    setSavingTitle(false)
  }

  const saveDescription = async () => {
    if (!task) return
    const trimmed = editDescription.trim()
    if (trimmed === (task.note ?? '')) { setEditingDescription(false); return }
    setSavingDescription(true)
    const { error } = await supabase.from('tasks').update({ note: trimmed || null }).eq('id', task.id)
    if (error) { alert('Failed to save description.'); setSavingDescription(false); return }
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId,
      action: 'note_added', note: 'Description updated.',
    })
    setTask({ ...task, note: trimmed || null })
    await loadLog(task.id)
    setEditingDescription(false)
    setSavingDescription(false)
  }

  const saveActivityEdit = async () => {
    if (!task || !editingActivityId) return
    setSavingActivityEdit(true)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`/api/activity-log/${editingActivityId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ note: editActivityNote.trim() || null }),
    })
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Unknown error' }))
      alert(`Failed to save edit: ${error}`)
      setSavingActivityEdit(false)
      return
    }
    // Update local state directly so the note reflects immediately
    setLog(prev => prev.map(e =>
      e.id === editingActivityId ? { ...e, note: editActivityNote.trim() || null } : e
    ))
    setEditingActivityId(null)
    setSavingActivityEdit(false)
  }

  const deleteActivity = async (entryId: string) => {
    if (!task) return
    if (!window.confirm('Delete this update? This cannot be undone.')) return
    setDeletingActivityId(entryId)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`/api/activity-log/${entryId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session?.access_token ?? ''}` },
    })
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Unknown error' }))
      alert(`Failed to delete update: ${error}`)
      setDeletingActivityId(null)
      return
    }
    // Remove entry from local state immediately
    setLog(prev => prev.filter(e => e.id !== entryId))
    setDeletingActivityId(null)
  }

  const openCopyModal = () => {
    setCopyError(null)
    setCopyModalOpen(true)
  }

  // Copy & Assign: the actual copy (create task + copy attachments + cross-reference +
  // notify, with rollback on failure) runs server-side in /api/tasks/[id]/copy, which also
  // enforces admin authorization. Here we just submit and reflect the result.
  const handleCopySubmit = async (args: { assigneeId: string; dueDate: string; priority: 'high' | 'medium' | 'low'; description: string }) => {
    if (!task || copySubmitting) return
    setCopySubmitting(true)
    setCopyError(null)

    const res = await fetch(`/api/tasks/${task.id}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).catch(() => null)

    if (!res || !res.ok) {
      const { error } = (await res?.json().catch(() => null)) ?? {}
      setCopyError(error ?? 'Could not copy the task. Please try again.')
      setCopySubmitting(false)
      return
    }

    const { taskId, assigneeName } = await res.json()
    const name = assigneeName ?? teamMembers.find(m => m.id === args.assigneeId)?.full_name ?? 'the assignee'
    setCopyModalOpen(false)
    setCopySubmitting(false)
    setLastCopied({ id: taskId, name })
    showToast(`Task assigned to ${name}`, 'success')
    await loadLog(task.id)   // show the new cross-reference entry on the source task
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <LoadingScreen />
  if (!task)   return <LoadingScreen message="Task not found" />

  const overdue      = isOverdue(task.due_date ?? null)
  const isAssignee   = task.assigned_to === currentUserId
  const isCreator    = task.created_by === currentUserId
  const isSelfTask   = isCreator && isAssignee
  const isDelegated  = !isAssignee && task.created_by === currentUserId
  const riskOverdue  = overdue && task.status !== 'completed'
  const assigneeName = isAssignee
    ? (profile?.full_name ?? 'You')
    : (teamMembers.find(m => m.id === task.assigned_to)?.full_name ?? task.assignee_name ?? 'Unknown')

  const isAdmin          = profile?.role === 'admin'
  const showCancelButton = (isCreator || isAdmin) && task.status !== 'completed' && task.status !== 'cancelled'
  const isUnacknowledged = isAssignee && !isSelfTask && !task.acknowledged_at && task.status !== 'cancelled' && task.task_type !== 'quotation_request'
  const isActiveTask     = task.status !== 'completed' && task.status !== 'cancelled'
  // The gates on who may close a task, kept where a test can reach them so no
  // screen edit can quietly widen one. The database re-derives every one of
  // them; these only decide what is drawn.
  const mayPostUpdate    = canPostUpdate(task, currentUserId)
  const mayMarkComplete  = canMarkComplete(task, currentUserId)
  const maySubmit        = canSubmitForApproval(task, currentUserId)
  const mayApprove       = canApproveTask(task, currentUserId)
  const mayReturn        = canReturnTask(task, currentUserId)
  const isPendingApproval = task.status === 'pending_approval'
  const reviewBusyAny    = reviewBusy !== null

  const relationLabel = isSelfTask  ? 'Self Assigned Task'
    : isAssignee                    ? 'Assigned To Me'
    : isDelegated                   ? 'Delegated Task'
    : 'Task'

  const relationColor = isSelfTask  ? colors.blue
    : isAssignee                    ? colors.green
    : isDelegated                   ? colors.amber
    : colors.muted

  const statusColor   = STATUS_COLORS[task.status] ?? colors.muted
  const statusTint    = STATUS_TINTS[task.status]  ?? colors.float
  const priorityStyle = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.low

  const STATUS_CARD_DEFAULTS: Record<string, string> = {
    working: 'Task is in progress',
    waiting: 'Task is waiting for input',
    blocked:  'Task is blocked',
  }
  // Newest status_changed entry drives the card; fall back to creation entry only
  // when no status change has happened yet (brand-new task).
  const latestStatusChange = log.find(e => e.action === 'status_changed') ?? null
  // task_copied is a neutral system event — never let it stand in as the status-card note.
  const createdEntry       = log.find(e => e.note && e.action !== 'task_copied') ?? null
  const latestNoteEntry    = latestStatusChange ?? createdEntry
  const currentStatusNote  = latestStatusChange
    ? (latestStatusChange.note ?? STATUS_CARD_DEFAULTS[task.status] ?? null)
    : (createdEntry?.note ?? null)
  const noteIsDuplicateOfBlocker =
    task.status === 'blocked' &&
    currentStatusNote !== null &&
    currentStatusNote === task.blocker_reason

  const aging = getTaskAging(task)
  const agingColor = aging ? (aging.severity === 'danger' ? colors.red : colors.amber) : colors.muted

  const isQuotation = task.task_type === 'quotation_request'
  const canCopyAssign = isAdmin && !isQuotation   // admin-only; the API enforces this too

  // Attachment count shown in the Copy & Assign modal (task-level rows + a distinct legacy URL)
  const copyAttachmentCount = taskLevelAttachments.length +
    (task.attachment_url && !taskLevelAttachments.some(a => a.url === task.attachment_url) ? 1 : 0)

  const quotationCompletedAt = isQuotation
    ? (log.find(e => e.action === 'status_changed' && e.to_status === 'completed')?.created_at ?? null)
    : null
  const qStatusColor = isQuotation
    ? (task.status === 'completed' ? colors.green : '#DC1F2E')
    : statusColor
  const qStatusTint = isQuotation
    ? (task.status === 'completed' ? colors.greenTint : '#FEF2F2')
    : statusTint
  const qStatusLabel = isQuotation
    ? (task.status === 'completed' ? 'Completed' : 'Open')
    : taskStatusLabel(task.status, isCreator && !isSelfTask ? 'creator' : isAssignee ? 'assignee' : 'other')

  // ── Task creation event ──────────────────────────────────────────────────
  // Every task written through the app records a real `created` activity row. Tasks
  // created before that behaviour existed have none, so their timeline would omit the
  // origin event. For those tasks only — never when a real `created` row is present —
  // synthesize a read-only creation entry from tasks.created_at, so creation shows
  // exactly once, works for old and new tasks, inserts no row, and sends no notification.
  const hasCreatedRow = log.some(e => e.action === 'created')
  const displayLog: LogEntry[] = hasCreatedRow
    ? log
    : [
        ...log,
        {
          id:             `synthetic-created-${task.id}`,
          action:         'created',
          note:           null,
          from_status:    null,
          to_status:      null,
          old_val:        null,
          new_val:        null,
          created_at:     task.created_at,
          actor_id:       task.created_by,
          actor_name:     creatorName ?? undefined,
          attachment_url: null,
          attachments:    [],
        },
      ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return (
    <DashboardLayout
      profile={profile}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              fontSize: '13px', fontWeight: 600,
              color: colors.muted,
              background: 'none', border: 'none',
              cursor: 'pointer', padding: '3px 8px',
              borderRadius: '6px',
              transition: 'background 0.15s',
              fontFamily: 'inherit',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = colors.float)}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            aria-label="Go back"
          >
            ← Back
          </button>
          <span>{isQuotation ? 'Quotation Details' : 'Task Details'}</span>
          <span style={{
            fontSize: '11px', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: isQuotation ? '#DC1F2E' : relationColor,
            background: isQuotation ? 'rgba(220,31,46,0.08)' : relationColor + '14',
            border: `1px solid ${isQuotation ? 'rgba(220,31,46,0.20)' : relationColor + '28'}`,
            padding: '3px 10px', borderRadius: '20px',
          }}>
            {isQuotation ? 'QUOTATION' : relationLabel}
          </span>
        </div>
      }
      onSignOut={handleLogout}
    >

      <div className="boe-task-2col">

        {/* ══ LEFT COLUMN ══════════════════════════════════════════════════ */}
        <div className="boe-task-left-col" style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>

            {/* ─ A. Task Summary Card ─ */}
            <div className="boe-card" style={{
              padding: '14px 22px',
              background: '#ffffff',
              borderLeft: isQuotation ? `1px solid ${colors.border}` : `3px solid ${relationColor}`,
            }}>
              {/* Task title */}
              <div style={{ marginBottom: '6px' }}>
                {editingTitle ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="boe-input"
                      style={{ fontSize: '15px', fontWeight: 700, width: '100%', boxSizing: 'border-box' }}
                      autoFocus
                    />
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={saveTitle}
                        disabled={savingTitle}
                        style={{ padding: '5px 12px', borderRadius: '6px', border: `1.5px solid ${colors.blue}`, background: colors.blue, color: '#ffffff', fontSize: '11.5px', fontWeight: 600, cursor: savingTitle ? 'not-allowed' : 'pointer', fontFamily: font.body, opacity: savingTitle ? 0.6 : 1 }}
                      >
                        {savingTitle ? '…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingTitle(false)}
                        disabled={savingTitle}
                        style={{ padding: '5px 10px', borderRadius: '6px', border: `1.5px solid ${colors.border}`, background: 'transparent', color: colors.tertiary, fontSize: '11.5px', fontWeight: 500, cursor: 'pointer', fontFamily: font.body }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                    {task.is_urgent && (
                      <span style={{ fontSize: '15px', lineHeight: '1.35', flexShrink: 0, marginTop: '1px' }} title="Starred">⭐</span>
                    )}
                    <h2 style={{
                      fontSize: '18px', fontWeight: 800,
                      color: colors.primary, lineHeight: 1.3,
                      letterSpacing: '-0.02em', margin: 0, flex: 1,
                    }}>
                      {task.title}
                    </h2>
                    {isQuotation && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        padding: '3px 10px', borderRadius: '20px',
                        background: priorityStyle.bg,
                        border: `1px solid ${priorityStyle.fg}30`,
                        fontSize: '11px', fontWeight: 700, color: priorityStyle.fg,
                        flexShrink: 0, marginTop: '3px',
                      }}>
                        {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                      </span>
                    )}
                    {!isQuotation && isCreator && task.status !== 'completed' && task.status !== 'cancelled' && (
                      <button
                        onClick={() => { setEditTitle(task.title); setEditingTitle(true); setEditingDescription(false) }}
                        style={{ fontSize: '10px', fontWeight: 600, color: colors.blue, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: font.body, textDecoration: 'underline', flexShrink: 0, marginTop: '3px' }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Assigned by / Requested by */}
              {isQuotation ? (
                creatorName && (
                  <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <UserRound size={15} color="#DC1F2E" />
                    <span style={{ fontSize: '13px', color: '#6B7280', fontWeight: 500 }}>Requested by:</span>
                    <span style={{ fontSize: '13px', color: '#DC1F2E', fontWeight: 700 }}>{creatorName}</span>
                  </div>
                )
              ) : (
                (isDelegated ? assigneeName : (isSelfTask ? true : creatorName)) && (
                  <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {isDelegated
                      ? <UserCheck size={15} color="#2563EB" />
                      : <UserRound size={15} color="#2563EB" />
                    }
                    <span style={{ fontSize: '13px', color: '#6B7280', fontWeight: 500 }}>
                      {isDelegated ? 'Assigned To:' : 'Assigned by:'}
                    </span>
                    <span style={{ fontSize: '13px', color: '#2563EB', fontWeight: 600 }}>
                      {isDelegated ? assigneeName : (isSelfTask ? 'Self' : creatorName)}
                    </span>
                  </div>
                )
              )}

              {/* Due date · Priority · Aging chips row — hidden for quotations */}
              {isQuotation ? (
                task.contact_number ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginTop: '6px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      padding: '4px 10px', borderRadius: '20px',
                      background: colors.float, border: `1px solid ${colors.border}`,
                    }}>
                      <span style={{ fontSize: '11.5px', color: colors.secondary, fontWeight: 500 }}>📞 {task.contact_number}</span>
                    </div>
                  </div>
                ) : null
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'flex-start', marginTop: '6px' }}>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '4px 10px', borderRadius: '20px',
                      background: riskOverdue ? colors.redTint : colors.float,
                      border: `1px solid ${riskOverdue ? colors.red + '40' : colors.border}`,
                    }}>
                      <span style={{ fontSize: '11.5px', color: riskOverdue ? colors.red : colors.secondary, fontWeight: 500 }}>
                        {task.due_date ? <>Due: <strong>{formatFullDate(task.due_date)}</strong>{riskOverdue && ' · Overdue'}</> : 'No due date'}
                      </span>
                      {isCreator && task.status !== 'completed' && task.status !== 'cancelled' && !editingDueDate && (
                        <button
                          onClick={() => { setEditDueDate(task.due_date ? task.due_date.slice(0, 10) : ''); setDueDateMsg(null); setEditingDueDate(true); setEditingPriority(false) }}
                          style={{ fontSize: '10px', fontWeight: 600, color: colors.blue, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: font.body, textDecoration: 'underline' }}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {editingDueDate && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <input
                          type="date"
                          value={editDueDate}
                          onChange={e => setEditDueDate(e.target.value)}
                          className="boe-input"
                          style={{ width: '150px', boxSizing: 'border-box' }}
                        />
                        <button
                          onClick={saveDueDate}
                          disabled={savingDueDate}
                          style={{ padding: '5px 12px', borderRadius: '6px', border: `1.5px solid ${colors.blue}`, background: colors.blue, color: '#ffffff', fontSize: '11.5px', fontWeight: 600, cursor: savingDueDate ? 'not-allowed' : 'pointer', fontFamily: font.body, opacity: savingDueDate ? 0.6 : 1 }}
                        >
                          {savingDueDate ? '…' : 'Save'}
                        </button>
                        <button
                          onClick={() => { setEditingDueDate(false); setDueDateMsg(null) }}
                          disabled={savingDueDate}
                          style={{ padding: '5px 10px', borderRadius: '6px', border: `1.5px solid ${colors.border}`, background: 'transparent', color: colors.tertiary, fontSize: '11.5px', fontWeight: 500, cursor: 'pointer', fontFamily: font.body }}
                        >
                          Cancel
                        </button>
                        {dueDateMsg && <span style={{ fontSize: '11px', color: dueDateMsg.ok ? colors.green : colors.red }}>{dueDateMsg.text}</span>}
                      </div>
                    )}
                  </div>

                  {/* Priority chip + inline edit */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '4px 10px', borderRadius: '20px',
                      background: priorityStyle.bg,
                      border: `1px solid ${priorityStyle.fg}30`,
                    }}>
                      <span style={{ fontSize: '11.5px', color: priorityStyle.fg, fontWeight: 600 }}>
                        Priority: {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                      </span>
                      {isCreator && task.status !== 'completed' && task.status !== 'cancelled' && !editingPriority && (
                        <button
                          onClick={() => { setEditPriority(task.priority); setPriorityMsg(null); setEditingPriority(true); setEditingDueDate(false) }}
                          style={{ fontSize: '10px', fontWeight: 600, color: colors.blue, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: font.body, textDecoration: 'underline' }}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {editingPriority && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        {(['high', 'medium', 'low'] as const).map(p => {
                          const ps = PRIORITY_COLORS[p]
                          const active = editPriority === p
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setEditPriority(p)}
                              style={{
                                padding: '5px 10px', borderRadius: '5px',
                                border: `1.5px solid ${active ? ps.fg : colors.border}`,
                                background: active ? ps.bg : 'transparent',
                                color: active ? ps.fg : colors.tertiary,
                                fontSize: '11.5px', fontWeight: active ? 600 : 400,
                                cursor: 'pointer', textTransform: 'capitalize',
                                fontFamily: font.body, transition: 'all 0.12s',
                              }}
                            >
                              {p}
                            </button>
                          )
                        })}
                        <button
                          onClick={savePriority}
                          disabled={savingPriority}
                          style={{ padding: '5px 12px', borderRadius: '6px', border: `1.5px solid ${colors.blue}`, background: colors.blue, color: '#ffffff', fontSize: '11.5px', fontWeight: 600, cursor: savingPriority ? 'not-allowed' : 'pointer', fontFamily: font.body, opacity: savingPriority ? 0.6 : 1 }}
                        >
                          {savingPriority ? '…' : 'Save'}
                        </button>
                        <button
                          onClick={() => { setEditingPriority(false); setPriorityMsg(null) }}
                          disabled={savingPriority}
                          style={{ padding: '5px 10px', borderRadius: '6px', border: `1.5px solid ${colors.border}`, background: 'transparent', color: colors.tertiary, fontSize: '11.5px', fontWeight: 500, cursor: 'pointer', fontFamily: font.body }}
                        >
                          Cancel
                        </button>
                        {priorityMsg && <span style={{ fontSize: '11px', color: priorityMsg.ok ? colors.green : colors.red }}>{priorityMsg.text}</span>}
                      </div>
                    )}
                  </div>

                  {/* Aging chip */}
                  {aging && task.status !== 'completed' && task.status !== 'cancelled' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        fontSize: '11px', fontWeight: 600,
                        color: agingColor,
                        background: `${agingColor}14`,
                        border: `1px solid ${agingColor}28`,
                        padding: '4px 10px', borderRadius: '20px',
                      }}>
                        {aging.label} · {aging.daysSinceUpdate}d
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Description */}
              {editingDescription ? (
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <textarea
                    value={editDescription}
                    onChange={e => setEditDescription(e.target.value)}
                    className="boe-input"
                    style={{ resize: 'vertical', minHeight: '90px', width: '100%', boxSizing: 'border-box', fontSize: '13px', lineHeight: 1.6 }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={saveDescription}
                      disabled={savingDescription}
                      style={{ padding: '5px 12px', borderRadius: '6px', border: `1.5px solid ${colors.blue}`, background: colors.blue, color: '#ffffff', fontSize: '11.5px', fontWeight: 600, cursor: savingDescription ? 'not-allowed' : 'pointer', fontFamily: font.body, opacity: savingDescription ? 0.6 : 1 }}
                    >
                      {savingDescription ? '…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingDescription(false)}
                      disabled={savingDescription}
                      style={{ padding: '5px 10px', borderRadius: '6px', border: `1.5px solid ${colors.border}`, background: 'transparent', color: colors.tertiary, fontSize: '11.5px', fontWeight: 500, cursor: 'pointer', fontFamily: font.body }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: '12px' }}>
                  {isQuotation && (
                    <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.muted, margin: '0 0 4px' }}>
                      Notes
                    </p>
                  )}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                    {task.note ? (
                      <MultilineText style={{
                        fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6, margin: 0, flex: 1,
                      }}>
                        {task.note}
                      </MultilineText>
                    ) : (
                      <p style={{ fontSize: '12px', color: colors.muted, margin: 0, flex: 1 }}>
                        {isQuotation ? 'No notes added.' : 'No description.'}
                      </p>
                    )}
                    {!isQuotation && isCreator && task.status !== 'completed' && task.status !== 'cancelled' && (
                      <button
                        onClick={() => { setEditDescription(task.note ?? ''); setEditingDescription(true); setEditingTitle(false) }}
                        style={{ fontSize: '10px', fontWeight: 600, color: colors.blue, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontFamily: font.body, textDecoration: 'underline', flexShrink: 0 }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Task attachments — legacy single + new multi-file */}
              {(task.attachment_url || taskLevelAttachments.length > 0) && (
                <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {isQuotation && (
                    <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.muted, margin: '0 0 2px' }}>
                      Attachments
                    </p>
                  )}
                  {/* Legacy single attachment_url */}
                  {task.attachment_url && !taskLevelAttachments.some(a => a.url === task.attachment_url) && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setPreviewAttachment({ url: task.attachment_url! })}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '5px',
                          fontSize: '11.5px', fontWeight: 500,
                          color: colors.blue, cursor: 'pointer',
                          padding: '4px 10px', borderRadius: '6px',
                          border: `1px solid ${colors.blue}28`,
                          background: colors.blueTint,
                        }}
                      >
                        📎 View Attachment
                      </button>
                      <span style={{
                        fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em',
                        textTransform: 'uppercase', color: colors.muted,
                        background: colors.float, border: `1px solid ${colors.border}`,
                        padding: '1px 7px', borderRadius: '20px',
                      }}>
                        {getFileTypeLabel(task.attachment_url)}
                      </span>
                    </div>
                  )}
                  {/* New multi-file task_attachments */}
                  {taskLevelAttachments.map(att => (
                    <div key={att.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setPreviewAttachment({ url: att.url, fileName: att.file_name ?? undefined })}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '5px',
                          fontSize: '11.5px', fontWeight: 500,
                          color: colors.blue, cursor: 'pointer',
                          padding: '4px 10px', borderRadius: '6px',
                          border: `1px solid ${colors.blue}28`,
                          background: colors.blueTint,
                        }}
                      >
                        📎 {att.file_name ?? 'Attachment'}
                      </button>
                      <span style={{
                        fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em',
                        textTransform: 'uppercase', color: colors.muted,
                        background: colors.float, border: `1px solid ${colors.border}`,
                        padding: '1px 7px', borderRadius: '20px',
                      }}>
                        {att.file_type ?? getFileTypeLabel(att.url)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Task actions inside summary card ─────────────────────── */}
              {/* Unacknowledged: only show acknowledge button (never for quotations) */}
              {!isQuotation && !task.acknowledged_at && isAssignee && task.created_by !== currentUserId && task.status !== 'cancelled' && (
                <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${colors.border}` }}>
                  <button
                    onClick={acknowledge}
                    disabled={acknowledging}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      padding: '9px 14px', borderRadius: '8px',
                      border: `1.5px solid ${colors.amber}50`,
                      background: colors.amberTint, color: colors.amber,
                      fontSize: '13px', fontWeight: 600,
                      cursor: acknowledging ? 'not-allowed' : 'pointer',
                      opacity: acknowledging ? 0.6 : 1,
                      fontFamily: font.body,
                    }}
                  >
                    {acknowledging ? 'Acknowledging…' : 'Tap to Acknowledge'}
                  </button>
                </div>
              )}

              {/* Active task action row: Mark Complete + Cancel + (admin) Copy & Assign.
                  One compact, aligned row on desktop; Mark Complete leads full-width on mobile. */}
              {isActiveTask && (isAssignee || showCancelButton || canCopyAssign) && (
                <div
                  className="boe-task-actions"
                  style={{
                    marginTop: '14px', paddingTop: '12px',
                    borderTop: `1px solid ${colors.border}`,
                    justifyContent: isQuotation ? 'center' : 'flex-start',
                  }}
                >
                  {mayMarkComplete && (
                    <button
                      className={isQuotation ? undefined : 'boe-task-action-primary'}
                      onClick={async () => {
                        const confirmed = window.confirm(
                          isQuotation
                            ? 'Mark this quotation as completed? The requester will be notified.'
                            : 'Are you sure this task is completed? This will move it out of active work.'
                        )
                        if (!confirmed) return
                        setMarkingComplete(true)
                        await applyStatusChange('completed', null)
                        setMarkingComplete(false)
                      }}
                      disabled={saving || markingComplete || statusUpdating}
                      style={{
                        ...(isQuotation ? { width: '240px' } : {}),
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                        padding: '9px 14px', borderRadius: '8px',
                        border: `1.5px solid ${colors.green}`,
                        background: colors.green, color: '#ffffff',
                        fontSize: '13px', fontWeight: 700,
                        cursor: saving || markingComplete || statusUpdating ? 'not-allowed' : 'pointer',
                        fontFamily: font.body,
                        opacity: saving || markingComplete || statusUpdating ? 0.6 : 1,
                        transition: 'all 0.15s',
                        boxShadow: `0 2px 6px ${colors.green}38`,
                      }}
                    >
                      <CircleCheckBig size={15} strokeWidth={2.4} style={{ flexShrink: 0 }} />
                      {markingComplete ? 'Marking…' : (isQuotation ? 'Mark Quotation Complete' : 'Mark Complete')}
                    </button>
                  )}

                  {/* Delegated ordinary task, assignee's side: the work is handed
                      to the person who asked for it rather than closed here. */}
                  {maySubmit && (
                    <button
                      className="boe-task-action-primary"
                      onClick={submitForApproval}
                      disabled={saving || reviewBusyAny || statusUpdating}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                        padding: '9px 14px', borderRadius: '8px',
                        border: `1.5px solid ${APPROVAL_GOLD}`,
                        background: APPROVAL_GOLD, color: '#ffffff',
                        fontSize: '13px', fontWeight: 700,
                        cursor: saving || reviewBusyAny || statusUpdating ? 'not-allowed' : 'pointer',
                        fontFamily: font.body,
                        opacity: saving || reviewBusyAny || statusUpdating ? 0.6 : 1,
                        transition: 'all 0.15s',
                        boxShadow: `0 2px 6px ${APPROVAL_GOLD}38`,
                      }}
                    >
                      <SendHorizontal size={15} strokeWidth={2.4} style={{ flexShrink: 0 }} />
                      {reviewBusy === 'submit' ? 'Submitting…' : 'Submit for Approval'}
                    </button>
                  )}

                  {/* Delegated ordinary task, creator's side: accept the work or
                      send it back. One decision, two buttons, no second page. */}
                  {mayApprove && (
                    <button
                      className="boe-task-action-primary"
                      onClick={approveTask}
                      disabled={reviewBusyAny}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                        padding: '9px 14px', borderRadius: '8px',
                        border: `1.5px solid ${colors.green}`,
                        background: colors.green, color: '#ffffff',
                        fontSize: '13px', fontWeight: 700,
                        cursor: reviewBusyAny ? 'not-allowed' : 'pointer',
                        fontFamily: font.body,
                        opacity: reviewBusyAny ? 0.6 : 1,
                        transition: 'all 0.15s',
                        boxShadow: `0 2px 6px ${colors.green}38`,
                      }}
                    >
                      <CircleCheckBig size={15} strokeWidth={2.4} style={{ flexShrink: 0 }} />
                      {reviewBusy === 'approve' ? 'Approving…' : 'Approve & Complete'}
                    </button>
                  )}
                  {mayReturn && (
                    <button
                      className="boe-task-action-secondary"
                      onClick={() => { setReturnReason(''); setReturnReasonError(null); setReturnModalOpen(true) }}
                      disabled={reviewBusyAny}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                        padding: '9px 12px', borderRadius: '8px',
                        border: `1.5px solid ${APPROVAL_GOLD}55`,
                        background: '#ffffff', color: APPROVAL_GOLD,
                        fontSize: '12px', fontWeight: 600,
                        cursor: reviewBusyAny ? 'not-allowed' : 'pointer',
                        opacity: reviewBusyAny ? 0.6 : 1,
                        fontFamily: font.body,
                        whiteSpace: 'nowrap', transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = APPROVAL_GOLD_TINT }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#ffffff' }}
                    >
                      <Undo2 size={14} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                      Return to Working
                    </button>
                  )}

                  {showCancelButton && !isQuotation && !isUnacknowledged && (
                    <button
                      className="boe-task-action-secondary"
                      onClick={() => { setCancelReason(''); setCancelOtherText(''); setCancelModalOpen(true) }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                        padding: '9px 12px', borderRadius: '8px',
                        border: '1.5px solid #78716C40',
                        background: '#F5F5F4', color: '#78716C',
                        fontSize: '12px', fontWeight: 600,
                        cursor: 'pointer', fontFamily: font.body,
                        whiteSpace: 'nowrap', transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#E7E5E4' }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#F5F5F4' }}
                    >
                      🚫 Cancel
                    </button>
                  )}
                  {canCopyAssign && (
                    <button
                      className="boe-task-action-secondary"
                      onClick={openCopyModal}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                        padding: '9px 12px', borderRadius: '8px',
                        border: `1.5px solid ${colors.blue}55`,
                        background: '#ffffff', color: colors.blue,
                        fontSize: '12px', fontWeight: 600,
                        cursor: 'pointer', fontFamily: font.body,
                        whiteSpace: 'nowrap', transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = colors.blueTint }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#ffffff' }}
                    >
                      <UserCheck size={14} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                      Copy &amp; Assign
                    </button>
                  )}
                </div>
              )}

              {/* Completed: Reopen option */}
              {task.status === 'completed' && (isCreator || isAssignee) && (
                <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${colors.green}28` }}>
                  <button
                    onClick={handleReopen}
                    disabled={reopening}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      padding: '8px 14px', borderRadius: '8px',
                      border: `1.5px solid ${colors.amber}60`,
                      background: colors.amberTint, color: colors.amber,
                      fontSize: '12.5px', fontWeight: 600,
                      cursor: reopening ? 'not-allowed' : 'pointer',
                      fontFamily: font.body, opacity: reopening ? 0.6 : 1,
                    }}
                  >
                    {reopening ? 'Reopening…' : (isQuotation ? 'Reopen Quotation' : 'Reopen Task')}
                  </button>
                </div>
              )}

              {/* Cancelled: Restore option */}
              {task.status === 'cancelled' && (isCreator || isAdmin) && (
                <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #78716C20' }}>
                  <button
                    onClick={async () => {
                      const confirmed = window.confirm(
                        'Restore this task? It will be returned to its previous status and the assignee will be notified.'
                      )
                      if (!confirmed) return
                      setReopening(true)
                      const res = await fetch('/api/restore-task', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ taskId: task.id, actorName: profile?.full_name }),
                      })
                      if (!res.ok) {
                        window.alert('Failed to restore task. Please try again.')
                        setReopening(false)
                        return
                      }
                      const { restoredStatus } = await res.json()
                      const restored = (restoredStatus ?? 'working') as TaskStatus
                      setTask({ ...task, status: restored, cancelled_by: null, cancelled_at: null, cancellation_reason: null })
                      setSelectedStatus(restored)
                      invalidateTaskCache(task.assigned_to)
                      queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
                      await loadLog(task.id)
                      setReopening(false)
                    }}
                    disabled={reopening}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      padding: '8px 14px', borderRadius: '8px',
                      border: `1.5px solid ${colors.amber}60`,
                      background: colors.amberTint, color: colors.amber,
                      fontSize: '12.5px', fontWeight: 600,
                      cursor: reopening ? 'not-allowed' : 'pointer',
                      fontFamily: font.body, opacity: reopening ? 0.6 : 1,
                    }}
                  >
                    {reopening ? 'Restoring…' : 'Restore Task'}
                  </button>
                </div>
              )}

              {/* Admin: Copy & Assign for completed/cancelled tasks — active tasks show it inline
                  in the action row above, so this compact row only covers the closed states. */}
              {canCopyAssign && !isActiveTask && (
                <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${colors.border}`, display: 'flex' }}>
                  <button
                    onClick={openCopyModal}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                      padding: '8px 14px', borderRadius: '8px',
                      border: `1.5px solid ${colors.blue}55`,
                      background: '#ffffff', color: colors.blue,
                      fontSize: '12px', fontWeight: 600,
                      cursor: 'pointer', fontFamily: font.body,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = colors.blueTint }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#ffffff' }}
                  >
                    <UserCheck size={14} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                    Copy &amp; Assign
                  </button>
                </div>
              )}
            </div>

            {/* ─ B. Current Status Card ─ */}
            <div className="boe-card" style={{
              padding: '10px 16px',
              background: qStatusTint,
              borderLeft: `3px solid ${qStatusColor}`,
            }}>
              {/* Top row: label + badge left, Change Status button right */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: qStatusColor, flexShrink: 0,
                }}>
                  {isQuotation ? 'Quotation Status' : 'Current Status'}
                </span>
                <span style={{
                  fontSize: '13px', fontWeight: 700, letterSpacing: '0.01em',
                  color: '#ffffff',
                  padding: '4px 14px', borderRadius: '20px',
                  background: qStatusColor,
                  boxShadow: `0 1px 4px ${qStatusColor}40`,
                  flexShrink: 0,
                }}>
                  {qStatusLabel}
                </span>

                {/* Update Status is withdrawn while approval is pending: the
                    task's next move is the creator's, and an assignee quietly
                    parking it back in Waiting would strand the review. The
                    database refuses the same move (tasks_enforce_review_path). */}
                {!isQuotation && isAssignee && !isPendingApproval && task.status !== 'completed' && task.status !== 'cancelled' && !isUnacknowledged && (
                  <button
                    onClick={() => {
                      setModalStatus('')
                      setWaitingOnType('team_member')
                      setWaitingOnUserId('')
                      setWaitingOnText('')
                      setWaitingOnError(false)
                      setModalOpen(true)
                    }}
                    style={{
                      marginLeft: 'auto',
                      padding: '5px 13px', borderRadius: '7px',
                      border: `1.5px solid ${colors.border}`,
                      background: '#ffffff',
                      color: colors.secondary,
                      fontSize: '11.5px', fontWeight: 600,
                      cursor: 'pointer', fontFamily: font.body,
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = statusColor; e.currentTarget.style.color = statusColor }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.secondary }}
                  >
                    Update Status
                  </button>
                )}
              </div>

              {/* Quotation timeline: created + completed dates */}
              {isQuotation && (
                <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginTop: '6px' }}>
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: qStatusColor, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Requested</div>
                    <div style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary, marginTop: '2px' }}>
                      {formatDateTime(task.created_at)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: qStatusColor, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Completed</div>
                    <div style={{ fontSize: '12.5px', fontWeight: 600, color: quotationCompletedAt ? colors.green : colors.muted, marginTop: '2px' }}>
                      {quotationCompletedAt ? formatDateTime(quotationCompletedAt) : '—'}
                    </div>
                  </div>
                </div>
              )}

              {/* Waiting On (non-quotation) */}
              {!isQuotation && task.status === 'waiting' && task.waiting_on_type && (
                <p style={{ fontSize: '11.5px', color: colors.secondary, margin: '2px 0', lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 700, color: statusColor }}>Waiting for: </span>
                  {task.waiting_on_type === 'team_member'
                    ? (teamMembers.find(m => m.id === task.waiting_on_user_id)?.full_name ?? 'Team member')
                    : (task.waiting_on_text ?? '—')
                  }
                </p>
              )}

              {/* Blocker (non-quotation) */}
              {!isQuotation && task.status === 'blocked' && task.blocker_reason && (
                <MultilineText style={{ fontSize: '11.5px', color: colors.secondary, margin: '2px 0', lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 700, color: statusColor }}>Blocker: </span>
                  {task.blocker_reason}
                </MultilineText>
              )}

              {/* Latest note (non-quotation) */}
              {!isQuotation && !noteIsDuplicateOfBlocker && currentStatusNote && (
                <MultilineText style={{ fontSize: '11.5px', color: colors.secondary, lineHeight: 1.5, margin: '2px 0', fontWeight: 500 }}>
                  <span style={{ fontWeight: 700, color: statusColor }}>Reason: </span>
                  {currentStatusNote}
                </MultilineText>
              )}

              {!isQuotation && latestNoteEntry && (
                <p style={{ fontSize: '10px', color: statusColor, margin: '2px 0 0', fontWeight: 500 }}>
                  Updated by{latestNoteEntry.actor_name && <strong> {latestNoteEntry.actor_name}</strong>} · {timeAgo(latestNoteEntry.created_at)}
                </p>
              )}
            </div>

            {/* § Awaiting approval — the assignee's side of the handover.
                A small card, not a banner: the task is not in trouble, it is
                simply with someone else. */}
            {isPendingApproval && isAssignee && !isSelfTask && (
              <div className="boe-card" style={{
                padding: '12px 18px',
                background: APPROVAL_GOLD_TINT,
                borderLeft: `3px solid ${APPROVAL_GOLD}`,
              }}>
                <p style={{ fontSize: '12.5px', color: APPROVAL_GOLD, fontWeight: 700, margin: 0 }}>
                  Awaiting approval from {creatorName ?? 'the task creator'}
                </p>
                <p style={{ fontSize: '11.5px', color: colors.secondary, margin: '4px 0 0', lineHeight: 1.5 }}>
                  Submitted to {creatorName ?? 'the task creator'} for review. You can still post
                  updates here; you will be notified when it is approved or returned.
                </p>
              </div>
            )}

            {/* § Awaiting approval — the creator's side. The buttons live in the
                action row above; this only says what is being asked of them. */}
            {isPendingApproval && isCreator && !isSelfTask && (
              <div className="boe-card" style={{
                padding: '12px 18px',
                background: APPROVAL_GOLD_TINT,
                borderLeft: `3px solid ${APPROVAL_GOLD}`,
              }}>
                <p style={{ fontSize: '12.5px', color: APPROVAL_GOLD, fontWeight: 700, margin: 0 }}>
                  {assigneeName} submitted this task for your approval
                </p>
                <p style={{ fontSize: '11.5px', color: colors.secondary, margin: '4px 0 0', lineHeight: 1.5 }}>
                  Approve to complete it, or return it to Working with what needs correcting.
                </p>
              </div>
            )}

            {/* § Unacknowledged notice */}
            {isUnacknowledged && (
              <div className="boe-card" style={{
                padding: '12px 18px',
                background: colors.amberTint,
                borderLeft: `3px solid ${colors.amber}`,
              }}>
                <p style={{ fontSize: '12px', color: colors.amber, fontWeight: 600, margin: 0 }}>
                  ⚠️ Please acknowledge this task before updating it.
                </p>
              </div>
            )}

            {/* ─ C. Conversation ─ */}
            {mayPostUpdate && (
              <div className="boe-card" style={{
                padding: '16px 20px',
                display: 'flex', flexDirection: 'column', gap: '10px',
                background: '#ffffff',
              }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  letterSpacing: '0.09em', textTransform: 'uppercase',
                  color: colors.muted,
                }}>
                  Updates
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div
                    style={{ position: 'relative' }}
                    onDragOver={handleCommentDragOver}
                    onDragEnter={handleCommentDragEnter}
                    onDragLeave={handleCommentDragLeave}
                    onDrop={handleCommentDrop}
                  >
                    <textarea
                      value={commentNote}
                      onChange={e => setCommentNote(e.target.value)}
                      onPaste={handleCommentPaste}
                      placeholder={isQuotation ? 'Add an update...' : 'Add a comment or share details…'}
                      className="boe-input"
                      style={{
                        resize: 'none', height: '98px', paddingBottom: '36px',
                        width: '100%', boxSizing: 'border-box',
                        border: `1.5px dashed ${commentDropActive ? colors.blue : colors.border}`,
                        background: commentDropActive ? colors.blueTint : '#F0F2F5',
                        borderRadius: '8px',
                        fontSize: '12.5px', lineHeight: 1.5,
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    />
                    {commentDropActive && (
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none',
                        fontSize: '12px', fontWeight: 600, color: colors.blue,
                        background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
                      }}>
                        Drop files to attach
                      </div>
                    )}
                    <label
                      title="Add attachments"
                      style={{
                        position: 'absolute', bottom: '9px', right: '10px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: '28px', height: '28px', borderRadius: '50%',
                        background: commentAttachments.length > 0 ? colors.blueTint : '#ffffff',
                        border: `1.5px solid ${commentAttachments.length > 0 ? colors.blue + '55' : colors.border}`,
                        fontSize: '13px', cursor: 'pointer', userSelect: 'none',
                        transition: 'all 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                      }}
                    >
                      📎
                      <input
                        type="file"
                        multiple
                        accept={ACCEPTED_ATTACHMENT_TYPES.join(',')}
                        onChange={e => {
                          addCommentFiles(Array.from(e.target.files ?? []))
                          e.target.value = ''
                        }}
                        style={{ display: 'none' }}
                      />
                    </label>
                  </div>
                  <p style={{ fontSize: '10px', color: colors.muted, margin: 0 }}>
                    Drop files here, paste copied files, or browse
                  </p>
                  {/* Selected files list — each row shows its own upload state, because
                      uploading starts on selection rather than on submit. */}
                  {commentAttachments.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {commentAttachments.map(a => (
                        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '10.5px', color: colors.blue, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            📎 {a.fileName} <span style={{ color: colors.tertiary }}>({(a.size / 1024).toFixed(0)} KB)</span>
                          </span>
                          <span
                            role="status"
                            title={a.error ?? undefined}
                            style={{
                              fontSize: '10px', fontWeight: 600, flexShrink: 0,
                              color: a.status === 'failed' ? colors.red
                                   : a.status === 'uploaded' ? colors.green
                                   : colors.secondary,
                            }}
                          >
                            {a.status === 'uploaded' ? '✓ ' : ''}{attachmentStatusLabel(a)}
                          </span>
                          {a.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() => retryCommentAttachment(a.id)}
                              style={{
                                background: 'none', border: `1px solid ${colors.blue}`, borderRadius: '5px',
                                cursor: 'pointer', color: colors.blue, fontSize: '10px', fontWeight: 600,
                                padding: '1px 6px', flexShrink: 0, fontFamily: font.body,
                              }}
                            >
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => removeCommentAttachment(a.id)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: colors.tertiary, fontSize: '12px', padding: '0 2px', flexShrink: 0,
                            }}
                            aria-label={`Remove ${a.fileName}`}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {(commentUploadError ?? failureSummary(commentAttachments)) && (
                    <p style={{ fontSize: '10.5px', color: colors.red, margin: 0 }}>
                      {commentUploadError ?? failureSummary(commentAttachments)}
                    </p>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: '10px', color: colors.muted, flexShrink: 0 }}>{commentNote.length}/1000</span>
                    <button
                      onClick={saveComment}
                      // Blocked only by an in-flight submit or a failed upload —
                      // an upload still running is waited on, not a barrier.
                      disabled={commentSaving || commentAttachments.some(a => a.status === 'failed')}
                      title={commentAttachments.some(a => a.status === 'failed')
                        ? 'Retry or remove the failed attachment first'
                        : undefined}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '6px 18px', borderRadius: '7px',
                        border: `1.5px solid ${colors.blue}`,
                        background: colors.blue, color: '#ffffff',
                        fontSize: '12px', fontWeight: 600,
                        cursor: commentSaving ? 'not-allowed' : 'pointer',
                        fontFamily: font.body,
                        opacity: commentSaving ? 0.6 : 1, transition: 'all 0.15s',
                        boxShadow: '0 2px 6px rgba(85,133,232,0.25)',
                        flexShrink: 0,
                      }}
                    >
                      {submitButtonLabel({
                        saving: commentSaving,
                        waitingForUploads: commentWaitingUploads,
                        isQuotation,
                      })}
                    </button>
                  </div>
                </div>
              </div>
            )}


        </div>

        {/* ══ RIGHT COLUMN ════════════════════════════════════════════════ */}
        <div className="boe-task-right-col" style={{ minWidth: 0 }}>


          {/* Activity */}
          <div className="boe-card boe-activity-card" style={{
            padding: '0', display: 'flex', flexDirection: 'column',
            background: '#ffffff', border: '1px solid #E1E5EA',
            borderRadius: '10px', boxShadow: 'none',
          }}>
            {/* Header */}
            <div style={{
              padding: '12px 16px 11px',
              borderBottom: '1px solid #E9ECF1',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: '#20242D', letterSpacing: '-0.01em' }}>
                {isQuotation ? 'Quotation History' : 'Activity'}
              </span>
              {displayLog.length > 0 && (
                <span style={{
                  fontSize: '11px', fontWeight: 500, color: '#7C8595',
                  background: '#F4F6F8', border: '1px solid #E3E7EC',
                  padding: '2px 7px', borderRadius: '20px', letterSpacing: '0.02em', lineHeight: 1.4,
                }}>
                  {displayLog.length} {displayLog.length === 1 ? 'event' : 'events'}
                </span>
              )}
            </div>

            {displayLog.length === 0 ? (
              <div style={{ padding: '20px 16px' }}>
                <p style={{ fontSize: '11.5px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
                  No activity yet.
                </p>
              </div>
            ) : (
              <div className="boe-activity-scroll" style={{ overflowY: 'auto', maxHeight: '520px' }}>
                {(() => {
                  // Note edit/delete stays tied to the newest *real* entry; task_copied is a
                  // system event and must not steal edit/delete eligibility from a user's comment.
                  const newestEntry = log.find(e => e.action !== 'task_copied') ?? log[0]
                  const canEditDelete = (entry: LogEntry) =>
                    entry.action === 'note_added' &&
                    entry.id === newestEntry?.id &&
                    entry.actor_id === currentUserId

                  const isFieldChange = (action: string) =>
                    action === 'title_changed' || action === 'due_date_changed' ||
                    action === 'deadline_changed' || action === 'priority_changed'

                  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

                  // Complete-sentence heading for each activity entry, split into the actor
                  // name (styled slightly stronger) and the action text that follows it.
                  const getHeadingRest = (entry: LogEntry): string => {
                    const { action, from_status: f, to_status: t } = entry

                    if (isQuotation) {
                      if (action === 'created')        return 'submitted the quotation request'
                      if (action === 'note_added')      return 'commented'
                      if (action === 'status_changed') {
                        if (t === 'completed')          return 'marked the quotation completed'
                        if (f === 'completed')          return 'reopened the quotation'
                        if (f === 'cancelled')          return 'restored the quotation'
                        if (t === 'cancelled')          return 'cancelled the quotation'
                        return 'changed the status'
                      }
                      if (action === 'stale_flagged')  return 'flagged the quotation as stale'
                      if (action === 'escalated')      return 'escalated the quotation'
                      return formatLogAction(action, f, t).toLowerCase()
                    }

                    switch (action) {
                      case 'note_added':      return 'commented'
                      case 'status_changed':  return f && t && f === t
                        ? 'posted a progress update'
                        : 'changed the status'
                      case 'acknowledged':    return 'acknowledged the task'
                      case 'due_date_changed':
                      case 'deadline_changed': return 'changed the due date'
                      case 'priority_changed': return 'changed the priority'
                      case 'title_changed':   return 'changed the title'
                      case 'created':         return isSelfTask
                        ? 'created the task'
                        : `assigned the task to ${assigneeName}`
                      case 'delegated':       return 'delegated the task'
                      case 'escalated':       return 'escalated the task'
                      case 'stale_flagged':   return 'flagged the task as stale'
                      case 'task_copied':     return entry.note ?? 'copied this task'
                      default:                return action.replace(/_/g, ' ')
                    }
                  }

                  return displayLog.map((entry, i) => {
                    const dotColor =
                      entry.action === 'acknowledged'     ? colors.green
                      : entry.action === 'status_changed' && entry.to_status
                        ? (STATUS_COLORS[entry.to_status] ?? '#B8C0CC')
                      : '#B8C0CC'
                    const isComment   = entry.action === 'note_added'
                    const isEditing   = editingActivityId === entry.id
                    const isDeleting  = deletingActivityId === entry.id
                    const showActions = canEditDelete(entry)
                    const isDate      = entry.action === 'due_date_changed' || entry.action === 'deadline_changed'
                    const isStatus    = entry.action === 'status_changed' &&
                      !!entry.from_status && !!entry.to_status && entry.from_status !== entry.to_status
                    const showDiff    = isFieldChange(entry.action) || isStatus

                    const oldDisplay = isDate
                      ? (entry.old_val ? formatFullDate(entry.old_val) : 'No date')
                      : isStatus
                        ? capitalize(entry.from_status ?? '—')
                        : (entry.old_val ?? '—')
                    const newDisplay = isDate
                      ? (entry.new_val ? formatFullDate(entry.new_val) : 'Cleared')
                      : isStatus
                        ? capitalize(entry.to_status ?? '—')
                        : (entry.new_val ?? '—')

                    return (
                      <div
                        key={entry.id}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: '12px',
                          padding: '16px 20px',
                          borderBottom: i < displayLog.length - 1 ? '1px solid #E9ECF1' : 'none',
                        }}
                      >
                        {/* Dot */}
                        <div style={{ paddingTop: '5px', flexShrink: 0 }}>
                          <div style={{
                            width: '8px', height: '8px', borderRadius: '9999px',
                            background: dotColor,
                          }} />
                        </div>

                        {/* Main content */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {/* Heading row: activity sentence (left) + timestamp (top-right) */}
                          <div style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                            gap: '8px', flexWrap: 'wrap',
                          }}>
                            <p style={{
                              margin: 0, fontSize: '12.5px', fontWeight: 500,
                              lineHeight: 1.4, flex: '1 1 auto', minWidth: '140px',
                            }}>
                              {/* Self-created tasks follow the BOE "Self" convention (as in "Assigned By: Self")
                                  — never surface the creator's own name when creator and assignee are the same. */}
                              {entry.action === 'created' && isSelfTask && !isQuotation ? (
                                <>
                                  <span style={{ fontWeight: 400, color: colors.secondary }}>Task created by </span>
                                  <span style={{ fontWeight: 500, color: '#2F3440' }}>Self</span>
                                </>
                              ) : (
                                <>
                                  <span style={{ fontWeight: 500, color: '#2F3440' }}>{entry.actor_name ?? 'Someone'}</span>
                                  <span style={{ fontWeight: 400, color: colors.secondary }}> {getHeadingRest(entry)}</span>
                                </>
                              )}
                            </p>
                            <span style={{
                              fontSize: '12px', fontWeight: 400, color: '#98A1B2',
                              lineHeight: 1.4, whiteSpace: 'nowrap', flexShrink: 0, paddingTop: '1px',
                            }}>
                              {formatActivityTimestamp(entry.created_at)}
                            </span>
                          </div>

                          {isEditing ? (
                            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              <textarea
                                value={editActivityNote}
                                onChange={e => setEditActivityNote(e.target.value)}
                                className="boe-input"
                                style={{ resize: 'none', height: '64px', width: '100%', boxSizing: 'border-box', fontSize: '12px', lineHeight: 1.5 }}
                              />
                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button
                                  onClick={saveActivityEdit}
                                  disabled={savingActivityEdit}
                                  style={{
                                    padding: '4px 12px', borderRadius: '6px',
                                    border: `1.5px solid ${colors.blue}`,
                                    background: colors.blue, color: '#ffffff',
                                    fontSize: '11px', fontWeight: 600,
                                    cursor: savingActivityEdit ? 'not-allowed' : 'pointer',
                                    fontFamily: font.body, opacity: savingActivityEdit ? 0.6 : 1,
                                  }}
                                >
                                  {savingActivityEdit ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  onClick={() => setEditingActivityId(null)}
                                  disabled={savingActivityEdit}
                                  style={{
                                    padding: '4px 10px', borderRadius: '6px',
                                    border: `1.5px solid ${colors.border}`,
                                    background: 'transparent', color: colors.tertiary,
                                    fontSize: '11px', fontWeight: 500,
                                    cursor: 'pointer', fontFamily: font.body,
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {/* Diff pills: old → new */}
                              {showDiff && (
                                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                  <span style={{
                                    fontSize: '12.5px', fontWeight: 400, color: '#8B93A1',
                                    background: '#F4F5F7', border: '1px solid #E4E7EC',
                                    padding: '1.5px 7px', borderRadius: '4px',
                                    textDecoration: 'line-through',
                                    maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  }} title={oldDisplay}>
                                    {oldDisplay}
                                  </span>
                                  <span style={{ fontSize: '12.5px', fontWeight: 400, color: '#98A2B3', flexShrink: 0 }}>→</span>
                                  <span style={{
                                    fontSize: '12.5px', fontWeight: 500, color: '#344054',
                                    background: '#F8F9FB', border: '1px solid #DDE1E7',
                                    padding: '1.5px 7px', borderRadius: '4px',
                                    maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  }} title={newDisplay}>
                                    {newDisplay}
                                  </span>
                                </div>
                              )}

                              {/* Note text — comments read conversationally, system notes stay compact.
                                  task_copied carries its text in the heading, so skip it here. */}
                              {entry.note && entry.action !== 'task_copied' && (
                                <MultilineText style={{
                                  margin: isComment ? '6px 0 0' : '8px 0 0',
                                  color: isComment ? '#596273' : '#667085',
                                  fontSize: isComment ? '12.5px' : '11.5px',
                                  fontWeight: 400,
                                  lineHeight: isComment ? 1.55 : 1.5,
                                }}>
                                  {entry.note}
                                </MultilineText>
                              )}
                            </>
                          )}

                          {/* Attachments */}
                          {entry.attachment_url && !(entry.attachments ?? []).some((a: TaskAttachment) => a.url === entry.attachment_url) && (
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '6px', flexWrap: 'wrap' }}>
                              <button
                                onClick={() => setPreviewAttachment({ url: entry.attachment_url! })}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  fontSize: '10.5px', fontWeight: 500, color: colors.blue,
                                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                }}
                              >
                                📎 View Attachment
                              </button>
                              <span style={{
                                fontSize: '9.5px', fontWeight: 600, letterSpacing: '0.04em',
                                textTransform: 'uppercase', color: colors.muted,
                                background: colors.float, border: `1px solid ${colors.border}`,
                                padding: '1px 6px', borderRadius: '20px',
                              }}>
                                {getFileTypeLabel(entry.attachment_url)}
                              </span>
                            </div>
                          )}
                          {(entry.attachments ?? []).map((att: TaskAttachment) => (
                            <div key={att.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '6px', flexWrap: 'wrap' }}>
                              <button
                                onClick={() => setPreviewAttachment({ url: att.url, fileName: att.file_name ?? undefined })}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  fontSize: '10.5px', fontWeight: 500, color: colors.blue,
                                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                }}
                              >
                                📎 {att.file_name ?? 'Attachment'}
                              </button>
                              <span style={{
                                fontSize: '9.5px', fontWeight: 600, letterSpacing: '0.04em',
                                textTransform: 'uppercase', color: colors.muted,
                                background: colors.float, border: `1px solid ${colors.border}`,
                                padding: '1px 6px', borderRadius: '20px',
                              }}>
                                {att.file_type ?? getFileTypeLabel(att.url)}
                              </span>
                            </div>
                          ))}

                          {/* Edit / Delete — own newest comment only */}
                          {showActions && !isEditing && (
                            <div style={{ display: 'flex', gap: '12px', marginTop: '7px' }}>
                              <button
                                onClick={() => { setEditActivityNote(entry.note ?? ''); setEditingActivityId(entry.id) }}
                                className="boe-activity-action"
                                style={{
                                  fontSize: '12px', fontWeight: 500, color: colors.muted,
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  padding: '0', fontFamily: font.body, textDecoration: 'none',
                                }}
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => deleteActivity(entry.id)}
                                disabled={isDeleting}
                                className="boe-activity-action boe-activity-action-danger"
                                style={{
                                  fontSize: '12px', fontWeight: 500, color: colors.muted,
                                  background: 'none', border: 'none', cursor: isDeleting ? 'not-allowed' : 'pointer',
                                  padding: '0', fontFamily: font.body, textDecoration: 'none',
                                  opacity: isDeleting ? 0.5 : 1,
                                }}
                              >
                                {isDeleting ? '…' : 'Delete'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })
                })()}
              </div>
            )}
          </div>

        </div>{/* end right column */}

      </div>

      {/* ── Return to Working Modal ─────────────────────────────────────── */}
      {/* Same shell and same proportions as Change Status below — one field,
          because the only thing missing is what needs to be corrected. */}
      {returnModalOpen && (
        <div
          onClick={() => { if (!reviewBusyAny) setReturnModalOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#ffffff', borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
              width: '100%', maxWidth: '420px',
              padding: '24px',
              display: 'flex', flexDirection: 'column', gap: '14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Return task to Working</span>
              <button
                onClick={() => setReturnModalOpen(false)}
                disabled={reviewBusyAny}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: colors.muted, lineHeight: 1, padding: '2px 6px', borderRadius: '6px', fontFamily: font.body }}
              >
                ×
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                htmlFor="boe-return-reason"
                style={{
                  fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: returnReasonError ? colors.red : colors.muted,
                }}
              >
                What needs to be corrected? <span style={{ color: colors.red }}>*</span>
              </label>
              <textarea
                id="boe-return-reason"
                value={returnReason}
                onChange={e => { setReturnReason(e.target.value); setReturnReasonError(null) }}
                maxLength={RETURN_REASON_MAX_LENGTH}
                className="boe-input"
                style={{
                  resize: 'vertical', minHeight: '92px', width: '100%', boxSizing: 'border-box',
                  fontSize: '13px', lineHeight: 1.55,
                  borderColor: returnReasonError ? colors.red : undefined,
                }}
                placeholder="The assignee sees this on the task, so be specific."
                autoFocus
              />
              {returnReasonError && (
                <span style={{ fontSize: '11px', color: colors.red, fontWeight: 600 }}>{returnReasonError}</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setReturnModalOpen(false)}
                disabled={reviewBusyAny}
                style={{
                  padding: '9px 16px', borderRadius: '8px',
                  border: `1.5px solid ${colors.border}`,
                  background: 'transparent', color: colors.secondary,
                  fontSize: '13px', fontWeight: 600,
                  cursor: reviewBusyAny ? 'not-allowed' : 'pointer', fontFamily: font.body,
                }}
              >
                Cancel
              </button>
              <button
                onClick={returnTask}
                disabled={reviewBusyAny}
                style={{
                  padding: '9px 18px', borderRadius: '8px',
                  border: `1.5px solid ${APPROVAL_GOLD}`,
                  background: APPROVAL_GOLD, color: '#ffffff',
                  fontSize: '13px', fontWeight: 700,
                  cursor: reviewBusyAny ? 'not-allowed' : 'pointer', fontFamily: font.body,
                  opacity: reviewBusyAny ? 0.6 : 1,
                  boxShadow: `0 2px 6px ${APPROVAL_GOLD}38`,
                }}
              >
                {reviewBusy === 'return' ? 'Returning…' : 'Return Task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change Status Modal ─────────────────────────────────────────── */}
      {modalOpen && (
        <div
          onClick={() => setModalOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#ffffff', borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
              width: '100%', maxWidth: '420px',
              padding: '24px',
              display: 'flex', flexDirection: 'column', gap: '16px',
            }}
          >
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Change Status</span>
              <button
                onClick={() => setModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: colors.muted, lineHeight: 1, padding: '2px 6px', borderRadius: '6px', fontFamily: font.body }}
              >
                ×
              </button>
            </div>

            {/* Status options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {([
                { value: 'working', label: 'Resume Working', show: task.status === 'waiting' || task.status === 'blocked' },
                { value: 'waiting', label: 'Waiting',        show: true },
                { value: 'blocked', label: 'Blocked',        show: true },
              ] as { value: string; label: string; show: boolean }[])
                .filter(o => o.show && o.value !== task.status)
                .map(({ value: s, label }) => {
                  const active = modalStatus === s
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        setModalStatus(active ? '' : s)
                        setWaitingOnType('team_member')
                        setWaitingOnUserId('')
                        setWaitingOnText('')
                        setWaitingOnError(false)
                      }}
                      style={{
                        padding: '10px 14px', borderRadius: '8px', textAlign: 'left',
                        border: `1.5px solid ${active ? STATUS_COLORS[s] : colors.border}`,
                        background: active ? STATUS_TINTS[s] : colors.float,
                        color: active ? STATUS_COLORS[s] : colors.secondary,
                        fontSize: '13px', fontWeight: active ? 700 : 500,
                        cursor: 'pointer', transition: 'all 0.12s',
                        fontFamily: font.body,
                      }}
                    >
                      {label}
                    </button>
                  )
                })
              }
            </div>

            {/* Waiting-on sub-form */}
            {modalStatus === 'waiting' && (
              <div style={{
                padding: '12px', borderRadius: '8px',
                background: `${colors.amber}08`,
                border: `1.5px solid ${waitingOnError ? colors.red : colors.amber + '40'}`,
                display: 'flex', flexDirection: 'column', gap: '10px',
              }}>
                <p style={{
                  fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.07em', margin: 0,
                  color: waitingOnError ? colors.red : colors.amber,
                }}>
                  Waiting On <span style={{ color: colors.red }}>*</span>
                  {waitingOnError && <span> — required</span>}
                </p>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {(['team_member', 'external'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setWaitingOnType(t); setWaitingOnUserId(''); setWaitingOnText(''); setWaitingOnError(false) }}
                      style={{
                        flex: 1, padding: '7px 8px', borderRadius: '7px',
                        border: `1.5px solid ${waitingOnType === t ? colors.amber : colors.border}`,
                        background: waitingOnType === t ? `${colors.amber}18` : '#ffffff',
                        color: waitingOnType === t ? colors.amber : colors.tertiary,
                        fontSize: '11.5px', fontWeight: waitingOnType === t ? 600 : 400,
                        cursor: 'pointer', transition: 'all 0.12s', fontFamily: font.body,
                      }}
                    >
                      {t === 'team_member' ? 'Team Member' : 'External Dependency'}
                    </button>
                  ))}
                </div>
                {waitingOnType === 'team_member' && (
                  <select
                    value={waitingOnUserId}
                    onChange={e => { setWaitingOnUserId(e.target.value); setWaitingOnError(false) }}
                    className="boe-input"
                    style={{ width: '100%', border: waitingOnError ? `1.5px solid ${colors.red}` : undefined }}
                  >
                    <option value="">Select team member…</option>
                    {teamMembers.map(m => (
                      <option key={m.id} value={m.id}>{m.full_name}</option>
                    ))}
                  </select>
                )}
                {waitingOnType === 'external' && (
                  <input
                    type="text"
                    value={waitingOnText}
                    onChange={e => { setWaitingOnText(e.target.value); setWaitingOnError(false) }}
                    placeholder="e.g. Client approval, Vendor quotation, Architect drawing…"
                    className="boe-input"
                    style={{ width: '100%', boxSizing: 'border-box', border: waitingOnError ? `1.5px solid ${colors.red}` : undefined }}
                  />
                )}
              </div>
            )}

            {/* Modal actions */}
            {modalStatus && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                  style={{
                    padding: '7px 16px', borderRadius: '7px',
                    border: `1.5px solid ${colors.border}`,
                    background: 'transparent', color: colors.tertiary,
                    fontSize: '12px', fontWeight: 500,
                    cursor: 'pointer', fontFamily: font.body,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (modalStatus === 'waiting') {
                      const filled = waitingOnType === 'team_member' ? !!waitingOnUserId : !!waitingOnText.trim()
                      if (!filled) { setWaitingOnError(true); return }
                    }
                    setSelectedStatus(modalStatus)
                    setSaving(true)
                    setWaitingOnError(false)

                    if (modalStatus === 'waiting') {
                      const now = new Date().toISOString()
                      const updates: Record<string, unknown> = {
                        status: 'waiting', last_update_at: now,
                        waiting_on_type:    waitingOnType,
                        waiting_on_user_id: waitingOnType === 'team_member' ? (waitingOnUserId || null) : null,
                        waiting_on_text:    waitingOnType === 'external' ? (waitingOnText.trim() || null) : null,
                      }
                      if (task.status === 'blocked') updates.blocker_reason = null
                      const { error: taskErr } = await supabase.from('tasks').update(updates).eq('id', task.id)
                      if (taskErr) {
                        console.error('[modal/waiting] tasks update failed:', taskErr.message)
                        window.alert('Failed to save status. Please try again.')
                        setSaving(false)
                        return
                      }
                      await supabase.from('task_activity_log').insert({
                        task_id: task.id, actor_id: currentUserId,
                        action: 'status_changed', from_status: task.status, to_status: 'waiting', note: null,
                      })
                      const recipient = currentUserId === task.created_by ? task.assigned_to : task.created_by
                      if (recipient && recipient !== currentUserId) {
                        fetch('/api/notify-status-update', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ taskId: task.id, taskTitle: task.title, createdBy: task.created_by, recipientId: recipient, action: 'waiting', actorName: profile?.full_name }),
                        }).catch(err => console.error('[modal/waiting] notification fetch error:', err))
                      }
                      const localPatch: Partial<Task> = {
                        status: 'waiting' as TaskStatus, last_update_at: now,
                        waiting_on_type:    waitingOnType,
                        waiting_on_user_id: waitingOnType === 'team_member' ? (waitingOnUserId || null) : null,
                        waiting_on_text:    waitingOnType === 'external' ? (waitingOnText.trim() || null) : null,
                      }
                      if (task.status === 'blocked') localPatch.blocker_reason = null
                      setTask({ ...task, ...localPatch })
                      setSelectedStatus('waiting')
                      await loadLog(task.id)
                    } else {
                      await applyStatusChange(modalStatus, null)
                    }

                    setSaving(false)
                    setModalOpen(false)
                  }}
                  disabled={saving || statusUpdating}
                  style={{
                    padding: '7px 18px', borderRadius: '7px',
                    border: `1.5px solid ${STATUS_COLORS[modalStatus] ?? colors.blue}`,
                    background: STATUS_COLORS[modalStatus] ?? colors.blue,
                    color: '#ffffff',
                    fontSize: '12px', fontWeight: 600,
                    cursor: saving || statusUpdating ? 'not-allowed' : 'pointer',
                    fontFamily: font.body,
                    opacity: saving || statusUpdating ? 0.6 : 1,
                    transition: 'all 0.15s',
                    boxShadow: `0 2px 6px ${(STATUS_COLORS[modalStatus] ?? colors.blue)}38`,
                  }}
                >
                  {saving ? 'Saving…' : 'Save Status'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {previewAttachment && (
        <AttachmentPreviewModal
          url={previewAttachment.url}
          fileName={previewAttachment.fileName}
          onClose={() => setPreviewAttachment(null)}
        />
      )}

      {/* ── Cancel Task Modal ───────────────────────────────────────────── */}
      {cancelModalOpen && (
        <div
          onClick={() => setCancelModalOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#ffffff', borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
              width: '100%', maxWidth: '420px',
              padding: '24px',
              display: 'flex', flexDirection: 'column', gap: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Cancel Task</span>
              <button
                onClick={() => setCancelModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: colors.muted, lineHeight: 1, padding: '2px 6px', borderRadius: '6px', fontFamily: font.body }}
              >
                ×
              </button>
            </div>

            <p style={{ fontSize: '12.5px', color: colors.secondary, margin: 0, lineHeight: 1.6 }}>
              Cancelling this task is permanent until restored. The assignee will be notified. Select a reason below.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <p style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0, color: colors.secondary }}>
                Reason <span style={{ color: colors.red }}>*</span>
              </p>
              {CANCEL_REASONS.map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setCancelReason(r); if (r !== 'Other') setCancelOtherText('') }}
                  style={{
                    padding: '9px 12px', borderRadius: '7px', textAlign: 'left',
                    border: `1.5px solid ${cancelReason === r ? '#78716C' : colors.border}`,
                    background: cancelReason === r ? '#F5F5F4' : colors.float,
                    color: cancelReason === r ? '#44403C' : colors.secondary,
                    fontSize: '13px', fontWeight: cancelReason === r ? 600 : 400,
                    cursor: 'pointer', transition: 'all 0.12s', fontFamily: font.body,
                  }}
                >
                  {r}
                </button>
              ))}
            </div>

            {cancelReason === 'Other' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0, color: colors.secondary }}>
                  Specify reason <span style={{ color: colors.red }}>*</span>
                </p>
                <input
                  type="text"
                  value={cancelOtherText}
                  onChange={e => setCancelOtherText(e.target.value)}
                  placeholder="Enter reason…"
                  className="boe-input"
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  autoFocus
                />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => setCancelModalOpen(false)}
                disabled={cancelling}
                style={{
                  padding: '7px 16px', borderRadius: '7px',
                  border: `1.5px solid ${colors.border}`,
                  background: 'transparent', color: colors.tertiary,
                  fontSize: '12px', fontWeight: 500,
                  cursor: 'pointer', fontFamily: font.body,
                }}
              >
                Back
              </button>
              <button
                onClick={handleCancelTask}
                disabled={cancelling || !cancelReason || (cancelReason === 'Other' && !cancelOtherText.trim())}
                style={{
                  padding: '7px 18px', borderRadius: '7px',
                  border: '1.5px solid #78716C',
                  background: '#78716C', color: '#ffffff',
                  fontSize: '12px', fontWeight: 600,
                  cursor: (cancelling || !cancelReason || (cancelReason === 'Other' && !cancelOtherText.trim())) ? 'not-allowed' : 'pointer',
                  fontFamily: font.body,
                  opacity: (cancelling || !cancelReason || (cancelReason === 'Other' && !cancelOtherText.trim())) ? 0.5 : 1,
                  transition: 'all 0.15s',
                }}
              >
                {cancelling ? 'Cancelling…' : 'Confirm Cancellation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {copyModalOpen && (
        <CopyAssignModal
          sourceTitle={task.title}
          initialDescription={task.note ?? ''}
          attachmentCount={copyAttachmentCount}
          initialPriority={task.priority}
          members={teamMembers}
          excludeUserId={currentUserId}
          submitting={copySubmitting}
          error={copyError}
          onClose={() => { if (!copySubmitting) setCopyModalOpen(false) }}
          onSubmit={handleCopySubmit}
        />
      )}

      {/* Success action chip — persists after the toast fades so the new task stays reachable */}
      {lastCopied && (
        <div style={{
          position: 'fixed', bottom: '70px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 9998, display: 'flex', alignItems: 'center', gap: '10px',
          background: '#ffffff', border: `1px solid ${colors.border}`,
          borderRadius: '8px', padding: '8px 12px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        }}>
          <span style={{ fontSize: '12px', color: colors.secondary }}>
            New task created for <strong>{lastCopied.name}</strong>
          </span>
          <button
            onClick={() => router.push(`/tasks/${lastCopied.id}`)}
            style={{
              fontSize: '12px', fontWeight: 600, color: colors.blue,
              background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: font.body,
            }}
          >
            View new task →
          </button>
          <button
            onClick={() => setLastCopied(null)}
            aria-label="Dismiss"
            style={{ fontSize: '14px', color: colors.muted, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      )}

      <Toast toast={toast} onDismiss={dismissToast} />
    </DashboardLayout>
  )
}
