// ─── Domain types shared across all pages ────────────────────────────────────
// Import from here. Never redefine these in individual pages.

export type TaskStatus =
  | 'pending'
  | 'started'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'completed'

export type TaskPriority = 'high' | 'medium' | 'low'

export type TaskType = 'completion' | 'daily_update'

export type UserRole = 'admin' | 'manager' | 'member'

// ─── Task ─────────────────────────────────────────────────────────────────────
export type Task = {
  id: string
  title: string
  note: string | null
  status: TaskStatus
  priority: TaskPriority
  type: TaskType
  is_urgent: boolean
  due_date: string | null
  acknowledged_at: string | null
  created_at: string
  last_update_at: string | null
  assigned_to: string
  created_by: string
  delegated_by: string | null
  blocker_reason: string | null
  team: string
  // Manager view enrichment (joined from assignee relation)
  is_stale?: boolean
  stale_day_count?: number
  assignee_name?: string
  assignee_team?: string
}

// ─── User ─────────────────────────────────────────────────────────────────────
export type UserProfile = {
  id: string
  full_name: string
  email: string
  phone: string | null
  role: UserRole
  team: string
  position: string | null
  is_active: boolean
  created_at: string
}

// ─── Password reset log ───────────────────────────────────────────────────────
export type PasswordResetLogEntry = {
  id:         string
  target_id:  string
  actor_id:   string | null
  reset_at:   string
  ip_address: string | null
  actor_name?: string | null
}

// ─── Position ─────────────────────────────────────────────────────────────────
export type Position = {
  id: string
  name: string
  created_at: string
}

// ─── Activity log ─────────────────────────────────────────────────────────────
export type LogEntry = {
  id: string
  action: string
  note: string | null
  from_status: TaskStatus | null
  to_status: TaskStatus | null
  created_at: string
  actor_id: string
  actor_name?: string
}