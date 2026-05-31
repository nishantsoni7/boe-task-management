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
export function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false
  return new Date(dueDate) < new Date()
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
): 'overdue' | 'danger' | 'caution' | null {
  if (!lastUpdateAt) return null
  if (status === 'completed' || status === 'waiting') return null
  const hoursSince = (Date.now() - new Date(lastUpdateAt).getTime()) / 3_600_000
  if (dueDate && new Date(dueDate) < new Date() && hoursSince >= 24) return 'overdue'
  if (hoursSince >= 72) return 'danger'
  if (hoursSince >= 48) return 'caution'
  return null
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
  if (action === 'deadline_changed') return 'Deadline updated'
  if (action === 'escalated')        return 'Escalated'
  if (action === 'progress_update')  return 'Progress update'
  return action.replace(/_/g, ' ')
}