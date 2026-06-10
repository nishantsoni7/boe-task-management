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
  waiting_on_type: 'team_member' | 'external' | null
  waiting_on_user_id: string | null
  waiting_on_text: string | null
  team: string
  attachment_url: string | null
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
  // Employee Master V1 fields (nullable — backfilled gradually)
  employee_code: string | null
  joining_date: string | null
  monthly_salary: number | null
  office_timing: string | null
  fingerprint_employee_code: string | null
  // Payroll configuration fields (V2)
  payroll_active: boolean
  employment_type: 'permanent' | 'contract' | null
  payroll_notes: string | null
  is_deleted?: boolean
  deleted_at?: string | null
  deleted_by?: string | null
  deletion_scheduled_at?: string | null
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

// ─── Performance ──────────────────────────────────────────────────────────────

// Ratings calibrated to a max-possible score of ~85 in real conditions.
// Perfect day = 50 (output) + 20 (momentum) + 20 (discipline) - 0 (risk) = 90 (capped 100)
// Typical productive day ≈ 55–68
export type PerformanceRating = 'excellent' | 'good' | 'average' | 'needs_improvement' | 'critical'

// The 4 pillars that compose the score
export type ScoreBreakdown = {
  output:     number   // 0–50  — weighted completions by priority
  momentum:   number   // 0–20  — status updates + blocker resolutions
  discipline: number   // 0–20  — EOD log + activity presence
  risk:       number   // 0–(−40) — stored as negative integer, e.g. −12
  total:      number   // clamped 0–100
}

// Raw inputs for a single day (what actually happened)
export type DayInputs = {
  // Output inputs
  completedHigh:   number
  completedMedium: number
  completedLow:    number
  // Momentum inputs
  statusUpdates:      number   // status_changed events (excluding completions)
  blockerResolutions: number   // blocked → any other status
  // Discipline inputs
  hasEodLog:          boolean
  wasActiveToday:     boolean  // any log entry at all today
  timelyAcks:         number   // acknowledged within 4h of task creation
  // Risk inputs
  overdueCount:       number   // tasks past due date and not completed
  staleBlockedCount:  number   // blocked tasks with no update in >2 days
  // Portfolio
  activeTasks:        number
  blockedCount:       number   // total blocked (includes non-stale)
}

// One bar in the trend chart
export type TrendDay = {
  date:      string
  score:     number
  breakdown: ScoreBreakdown
  inputs:    Pick<DayInputs, 'completedHigh' | 'completedMedium' | 'completedLow' | 'statusUpdates' | 'hasEodLog'>
}

// How the 7-day trend is classified
export type TrendClassification =
  | 'improving'          // clear upward direction
  | 'declining'          // clear downward direction
  | 'volatile'           // high variance, unpredictable
  | 'consistent'         // low variance, performing steadily
  | 'stagnant'           // flat, neither improving nor declining
  | 'insufficient_data'  // < 3 days of data

export type TrendAnalysis = {
  classification:    TrendClassification
  direction:         'up' | 'down' | 'flat'
  streak:            number   // consecutive days in current direction
  weekOverWeekDelta: number   // avg(last 7d) − avg(prev 7d), or ≈ half-period delta
  description:       string   // human-readable one-liner
}

// Aggregate window (weekly / monthly summary)
export type PeriodAggregate = {
  totalCompletedHigh:   number
  totalCompletedMedium: number
  totalCompletedLow:    number
  totalCompleted:       number
  totalStatusUpdates:   number
  eodLogRate:           number   // 0–100 percentage of days with EOD log
  avgScore:             number
  bestDay:              TrendDay
  worstDay:             TrendDay
}

export type PerformanceData = {
  period:   'daily' | 'weekly' | 'monthly'
  date:     string
  userId:   string
  userName: string
  score:    number
  rating:   PerformanceRating
  breakdown: ScoreBreakdown
  inputs:    DayInputs
  trend:     TrendDay[]            // always 7 days (daily view) or full window
  trendAnalysis: TrendAnalysis
  eodLog:    DailyWorkLog | null
  aggregate?: PeriodAggregate      // only on weekly / monthly
}

export type DailyWorkLog = {
  id:         string
  user_id:    string
  log_date:   string
  summary:    string
  highlights: string | null
  blockers:   string | null
  self_score: number | null
  created_at: string
  updated_at: string
}

export type PerformanceAudit = {
  progressive:      boolean
  progressiveLabel: string   // "Progressive Day" | "Moderate Day" | "Needs Improvement"
  verdict:          string   // one sentence overall
  insights:         string[] // 2–3 specific observations
  suggestions:      string[] // 2–3 actionable next steps
}

// ─── Stuck task (waiting or stale-blocked) ────────────────────────────────────
export type StuckTask = {
  id:                 string
  title:              string
  status:             string
  priority:           string
  due_date:           string | null
  last_update_at:     string | null
  waiting_on_type:    'team_member' | 'external' | null
  waiting_on_text:    string | null
  waiting_on_name:    string | null   // resolved full name when waiting_on_type = 'team_member'
  blocker_reason:     string | null
  note:               string | null
}

export type TaskDetailActivity = {
  action:      string
  note:        string | null
  from_status: string | null
  to_status:   string | null
  created_at:  string
  actor_name:  string | null
}

export type TaskDetailData = {
  created_by_name: string | null
  activity:        TaskDetailActivity[]
}

// ─── Manager leaderboard entry ────────────────────────────────────────────────
export type MemberPerfEntry = {
  userId:   string
  userName: string
  team:     string
  position: string | null
  // Today's performance
  score:       number
  rating:      PerformanceRating
  breakdown:   ScoreBreakdown
  // Risk signals (for quick scan)
  overdueCount:      number
  staleBlockedCount: number
  riskLevel:         'high' | 'medium' | 'low'
  // Trajectory
  trendClassification: TrendClassification
  weekOverWeekDelta:   number
  // Discipline
  hasEodLogToday: boolean
  eodLogStreak:   number   // consecutive days with EOD log
  // Portfolio
  activeTasks: number
  completedThisWeek: number
  // Analysis extras
  updatesCount:       number          // status updates made today
  latestAchievement:  string | null   // today's EOD log summary
  latestHighlight:    string | null   // today's EOD log highlights
  // Monthly health summary (computed from trend window)
  monthlyAvgScore: number
  submittedDays:   number
  missedDays:      number
  pendingDays:     number
  lowScoreDays:    number
  // Extended fields for owner management view
  selfScoreToday:  number | null   // member's self-rated score from today's EOD (1–5)
  eodSubmittedAt:  string | null   // ISO timestamp of today's EOD submission
  waitingCount:    number          // tasks currently in 'waiting' status
  timelyAcksToday: number          // tasks acknowledged within 4h of creation, today
  stuckTasks:      StuckTask[]     // exact tasks behind waitingCount + staleBlockedCount
}

// ─── Payroll period ───────────────────────────────────────────────────────────
export type PayrollPeriodStatus = 'draft' | 'locked'

export type PayrollPeriod = {
  id: string
  payroll_month: number   // 1–12
  payroll_year: number
  status: PayrollPeriodStatus
  notes: string | null
  created_at: string
}

// ─── Payroll results ──────────────────────────────────────────────────────────
export type PayrollResultStatus = 'draft' | 'locked'

export type PayrollResult = {
  id: string
  payroll_period_id: string
  employee_id: string
  monthly_salary: number
  // Attendance summary
  working_days_in_month: number | null
  days_present: number | null
  days_absent: number | null
  days_on_leave: number | null
  paid_leave_available: number | null
  paid_leave_used: number | null
  // Deduction hours
  late_deduction_hours: number | null
  short_hours_deduction: number | null
  missing_punch_hours: number | null
  leave_absorbed_deductions: boolean
  // Monetary totals
  gross_salary: number | null
  total_deductions: number | null
  pending_adjustment_total: number
  net_salary: number | null
  status: PayrollResultStatus
  admin_notes: string | null
  half_day_count: number | null
  generated_at: string | null
  created_at: string
  updated_at: string
}

export type DeductionType =
  | 'late_arrival'
  | 'early_checkout'
  | 'missing_punch_in'
  | 'missing_punch_out'
  | 'absent'
  | 'half_day'
  | 'short_hours'

export type PayrollDeductionLine = {
  id: string
  payroll_result_id: string
  line_date: string
  deduction_type: DeductionType
  hours_deducted: number
  amount_deducted: number
  is_overridden: boolean
  override_reason: string | null
  created_at: string
}

export type PendingAdjustmentStatus = 'pending' | 'applied' | 'cancelled'

export type PayrollPendingAdjustment = {
  id: string
  employee_id: string
  applied_in_period_id: string | null
  payroll_result_id: string | null
  description: string
  amount: number   // positive = credit, negative = deduction
  status: PendingAdjustmentStatus
  created_at: string
}

// ─── Payroll holidays ─────────────────────────────────────────────────────────
export type PayrollHoliday = {
  id: string
  holiday_date: string   // ISO date string, e.g. "2026-08-15"
  description: string | null
  created_at: string
}

// ─── Notifications ────────────────────────────────────────────────────────────
export type Notification = {
  id: string
  user_id: string
  task_id: string | null
  type: string
  title: string
  body: string | null
  is_read: boolean
  is_push_sent: boolean
  is_digest: boolean
  created_at: string
  read_at: string | null
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
  attachment_url?: string | null
}