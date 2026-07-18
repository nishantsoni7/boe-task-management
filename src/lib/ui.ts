import type { TaskStatus, TaskPriority } from './types'

// ─── Status badge class ───────────────────────────────────────────────────────
export function statusBadgeClass(status: TaskStatus | string): string {
  const map: Record<string, string> = {
    pending:   'boe-badge boe-badge-pending',
    started:   'boe-badge boe-badge-started',
    working:   'boe-badge boe-badge-working',
    waiting:   'boe-badge boe-badge-waiting',
    blocked:   'boe-badge boe-badge-blocked',
    completed: 'boe-badge boe-badge-completed',
  }
  return map[status] ?? 'boe-badge boe-badge-pending'
}

// ─── Priority dot color ───────────────────────────────────────────────────────
export function priorityDotColor(priority: TaskPriority | string): string {
  const map: Record<string, string> = {
    high:   '#D94F4F',
    medium: '#E8A030',
    low:    '#42475A',
  }
  return map[priority] ?? '#42475A'
}

// ─── Avatar initials ──────────────────────────────────────────────────────────
export function initials(fullName: string): string {
  return fullName
    .split(' ')
    .map(n => n[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

// ─── Date formatting ──────────────────────────────────────────────────────────
export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  })
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// "13 Jul 2026, 6:21 PM" — used for activity feed timestamps
export function formatActivityTimestamp(iso: string): string {
  const formatted = new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return formatted.replace(/\b(am|pm)\b/i, m => m.toUpperCase())
}

export function timeAgo(iso: string): string {
  const diff  = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 1)  return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Returns compact "Xh" / "Xd" — used for inline pills
export function timeSince(iso: string): string {
  const diff  = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 1)  return '<1h'
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// ─── Task state helpers ───────────────────────────────────────────────────────
export function isOverdue(dueDate: string | null, status?: string): boolean {
  if (!dueDate) return false
  if (status === 'completed' || status === 'cancelled') return false
  return dueDate < new Date().toISOString().slice(0, 10)
}

export function isUpdatedToday(lastUpdateAt: string | null): boolean {
  if (!lastUpdateAt) return false
  const d   = new Date(lastUpdateAt)
  const now = new Date()
  return (
    d.getDate()     === now.getDate()  &&
    d.getMonth()    === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  )
}

// Returns true if a task is old enough to reasonably expect an update.
// Threshold: 4 hours — matches the system's acknowledgement window (Design Principles §9).
// Tasks created less than 4 hours ago are excluded from "No Update Today" to avoid
// flagging assignees who haven't had a reasonable window to act yet.
export function isOldEnoughToFlag(createdAt: string): boolean {
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / 3_600_000
  return ageHours >= 4
}

export function escalationLevel(
  lastUpdateAt: string | null,
  status: string,
  dueDate: string | null,
  createdAt?: string,
): 'overdue' | 'danger' | 'caution' | null {
  if (status === 'completed') return null

  if (status === 'waiting') {
    const ref = lastUpdateAt ?? createdAt
    if (!ref) return null
    const days = (Date.now() - new Date(ref).getTime()) / 86_400_000
    if (days > 10) return 'overdue'
    if (days >= 6)  return 'danger'
    if (days >= 3)  return 'caution'
    return null
  }

  if (!lastUpdateAt) return null
  const hoursSince = (Date.now() - new Date(lastUpdateAt).getTime()) / 3_600_000
  if (dueDate && new Date(dueDate) < new Date() && hoursSince >= 24) return 'overdue'
  if (hoursSince >= 72) return 'danger'
  if (hoursSince >= 48) return 'caution'
  return null
}

// ─── Task aging ───────────────────────────────────────────────────────────────

export type TaskAging = {
  label: string
  severity: 'warning' | 'danger'
  daysSinceUpdate: number
  message: string
}

export function getTaskAging(task: {
  status: string
  last_update_at: string | null
  created_at: string
}): TaskAging | null {
  if (task.status === 'completed') return null
  const ref = task.last_update_at ?? task.created_at
  const days = (Date.now() - new Date(ref).getTime()) / 86_400_000
  const d = Math.floor(days)
  if (task.status === 'blocked' && days >= 3) {
    return { label: 'Blocked too long', severity: 'danger',  daysSinceUpdate: d, message: `Blocked for ${d}d — needs resolution` }
  }
  if (task.status === 'waiting' && days >= 3) {
    return { label: 'Waiting too long', severity: 'warning', daysSinceUpdate: d, message: `Waiting for ${d}d — no update` }
  }
  if (days >= 7) {
    return { label: 'Stale',        severity: 'danger',  daysSinceUpdate: d, message: `No update for ${d}d` }
  }
  if (days >= 3) {
    return { label: 'Needs update', severity: 'warning', daysSinceUpdate: d, message: `No update for ${d}d` }
  }
  return null
}

// ─── Assigned-by display ─────────────────────────────────────────────────────
// Returns "Self" when the creator and assignee are the same person;
// otherwise returns the creator's display name from the user map.
export function getAssignedByDisplay(
  task: { created_by: string; assigned_to: string },
  userMap: Record<string, string>,
  fallback = '—',
): string {
  if (task.created_by === task.assigned_to) return 'Self'
  return userMap[task.created_by] ?? fallback
}

// ─── UUID validation ─────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isValidUUID(id: string | null | undefined): id is string {
  return !!id && UUID_RE.test(id)
}

// ─── Activity log label ───────────────────────────────────────────────────────
export function formatLogAction(
  action: string,
  fromStatus?: string | null,
  toStatus?: string | null,
): string {
  if (action === 'status_changed') {
    if (fromStatus && toStatus && fromStatus === toStatus) return 'Progress update'
    return `Status: ${fromStatus ?? '?'} → ${toStatus ?? '?'}`
  }
  if (action === 'acknowledged')     return 'Task acknowledged'
  if (action === 'delegated')        return 'Task delegated'
  if (action === 'created')          return 'Task created'
  if (action === 'title_changed')    return 'Title changed'
  if (action === 'due_date_changed') return 'Due date changed'
  if (action === 'deadline_changed') return 'Due date changed'
  if (action === 'priority_changed') return 'Priority changed'
  if (action === 'escalated')        return 'Escalated'
  if (action === 'progress_update')  return 'Progress update'
  if (action === 'task_copied')      return 'Task copied'
  return action.replace(/_/g, ' ')
}