// The Review Workflow report and leaderboard — the pure half.
//
// EVERY NUMBER HERE COMES FROM THE DATABASE. customer_review_report(),
// customer_review_report_list(), customer_review_leaderboard() and
// customer_review_leader_card() (20270225000000) are the only place a total is
// computed; this file parses what they return, checks it reconciles, and says it in
// words. Nothing on a screen derives one figure from another whose definition
// differs — submitted and reward-eligible are two separate fields, both shown.
//
// THE DEFINITIONS (full text in the migration's header and in
// docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md §25):
//   month       the Asia/Kolkata month of the FIRST submission
//   submitted   every review of the month that is not deleted
//   text/image  the stored review_type; a review is exactly one, so they sum to submitted
//   eligible    a live credit: posted, not reversed, its month not lapsed
//   points      review credits / CREDITS_PER_POINT (credits = points x 10), per month, never carried over

export type ReviewTypeKey = 'text' | 'image'
export type ReviewStatusKey = 'pending_verification' | 'approved' | 'rejected'

/**
 * Credits = points x 10, so points = credits / 10. Pinned to customer_review_credits_per_point()
 * by a test. Credits are numeric(12,2), so points are exact to three decimals: 1 credit = 0.1
 * point, 1.5 credits = 0.15, 0.01 credit = 0.001.
 */
export const CREDITS_PER_POINT = 10

/** Points for a number of credits, computed in hundredths so 1.15 credits is exactly 0.115. */
export function pointsFromCredits(credits: number): number {
  return Math.round(credits * 100) / (CREDITS_PER_POINT * 100)
}

/** "0.1", "0.15", "0.125", "12" — up to three decimals, no trailing zeros. */
export function formatPoints(points: number): string {
  return String(Math.round(points * 1000) / 1000)
}

/** Query keys of the leaderboard reads. The month is appended, so invalidating this prefix refreshes every month. */
export const REVIEW_LEADERBOARD_KEY = ['review-leaderboard'] as const
export const REVIEW_LEADER_CARD_KEY = ['review-leader-card'] as const

export const REPORT_PAGE_SIZE = 25

export type ReportFilters = {
  /** First of the month, YYYY-MM-01 (Asia/Kolkata). Null = the current month. */
  month: string | null
  employee: string | null
  type: ReviewTypeKey | null
  status: ReviewStatusKey | null
}

export const NO_REPORT_FILTERS: ReportFilters = { month: null, employee: null, type: null, status: null }

export type ReportSummary = {
  submitted: number
  text: number
  image: number
  pending: number
  approved: number
  rejected: number
  eligible: number
  eligible_text: number
  eligible_image: number
  credits: number
  points: number
  /** Of the eligible: reviews / credits whose month was closed below target (expired, not rejected). */
  expired_reviews: number
  expired_credits: number
  /** Reviews whose credit the ledger has since reversed. */
  reversed: number
  /** Approved reviews edited and waiting for re-approval: credit still on the ledger, not eligible. */
  held: number
  held_credits: number
  /** Reviews with a "Duplicate" decision: rejected, credit reversed, still submitted. */
  confirmed_duplicates: number
  duplicates_open: number
}

export type DailyBar = { day: string; text: number; image: number }
export type MonthBar = { month: string; text: number; image: number; submitted: number; eligible: number; credits: number }
export type CategoryRow = { type: ReviewTypeKey; pending: number; approved: number; rejected: number; submitted: number; eligible: number; credits: number }
export type EmployeeRow = {
  employee_id: string
  name: string
  submitted: number
  text: number
  image: number
  eligible: number
  eligible_text: number
  eligible_image: number
  credits: number
  points: number
}

export type ReviewReport = {
  month: string
  current_month: string
  credits_per_point: number
  summary: ReportSummary
  daily: DailyBar[]
  history: MonthBar[]
  categories: CategoryRow[]
  employees: EmployeeRow[]
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])

/** Read the report; null when it is not the shape this screen was built for — never a half-drawn dashboard. */
export function parseReviewReport(raw: unknown): ReviewReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const s = r.summary as Record<string, unknown> | undefined
  if (!s || typeof r.month !== 'string' || !Array.isArray(r.daily) || !Array.isArray(r.employees)) return null
  return {
    month: str(r.month),
    current_month: str(r.current_month),
    credits_per_point: num(r.credits_per_point),
    summary: {
      submitted: num(s.submitted), text: num(s.text), image: num(s.image),
      pending: num(s.pending), approved: num(s.approved), rejected: num(s.rejected),
      eligible: num(s.eligible), eligible_text: num(s.eligible_text), eligible_image: num(s.eligible_image),
      credits: num(s.credits), points: num(s.points),
      expired_reviews: num(s.expired_reviews), expired_credits: num(s.expired_credits), reversed: num(s.reversed),
      held: num(s.held), held_credits: num(s.held_credits), confirmed_duplicates: num(s.confirmed_duplicates),
      duplicates_open: num(s.duplicates_open),
    },
    daily: arr(r.daily).map(d => ({ day: str(d.day), text: num(d.text), image: num(d.image) })),
    history: arr(r.history).map(m => ({
      month: str(m.month), text: num(m.text), image: num(m.image),
      submitted: num(m.submitted), eligible: num(m.eligible), credits: num(m.credits),
    })),
    categories: arr(r.categories).map(c => ({
      type: c.type === 'image' ? 'image' : 'text',
      pending: num(c.pending), approved: num(c.approved), rejected: num(c.rejected),
      submitted: num(c.submitted), eligible: num(c.eligible), credits: num(c.credits),
    })),
    employees: arr(r.employees).map(e => ({
      employee_id: str(e.employee_id), name: str(e.name) || 'Unknown',
      submitted: num(e.submitted), text: num(e.text), image: num(e.image),
      eligible: num(e.eligible), eligible_text: num(e.eligible_text), eligible_image: num(e.eligible_image),
      credits: num(e.credits), points: num(e.points),
    })),
  }
}

/**
 * The ways the report disagrees with itself; empty when it reconciles. The screen shows an
 * error instead of a dashboard whose parts contradict each other.
 */
export function reconciliationProblems(report: ReviewReport): string[] {
  const problems: string[] = []
  const s = report.summary
  const sum = (f: (e: EmployeeRow) => number) => report.employees.reduce((t, e) => t + f(e), 0)
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005

  if (s.text + s.image !== s.submitted) problems.push('text + image does not equal submitted')
  if (s.pending + s.approved + s.rejected !== s.submitted) problems.push('the statuses do not add up to submitted')
  if (s.eligible > s.submitted) problems.push('eligible exceeds submitted')
  if (s.eligible_text + s.eligible_image !== s.eligible) problems.push('eligible text + image does not equal eligible')
  if (sum(e => e.submitted) !== s.submitted) problems.push('the employee rows do not add up to submitted')
  if (sum(e => e.text) !== s.text || sum(e => e.image) !== s.image) problems.push('the employee rows do not add up to text / image')
  if (sum(e => e.eligible) !== s.eligible) problems.push('the employee rows do not add up to eligible')
  if (!near(sum(e => e.credits), s.credits) || !near(sum(e => e.points), s.points)) problems.push('the employee rows do not add up to credits / points')
  if (report.daily.reduce((t, d) => t + d.text + d.image, 0) !== s.submitted) problems.push('the daily bars do not add up to submitted')
  if (report.daily.reduce((t, d) => t + d.text, 0) !== s.text) problems.push('the daily text bars do not add up to text')
  if (report.categories.reduce((t, c) => t + c.submitted, 0) !== s.submitted) problems.push('the category breakdown does not add up to submitted')
  const last = report.history[report.history.length - 1]
  if (last && (last.submitted !== s.submitted || last.eligible !== s.eligible)) problems.push('the current month of the history differs from the cards')
  if (!near(s.points, pointsFromCredits(s.credits))) problems.push('points are not credits / 10')
  if (report.employees.some(e => !near(e.points, pointsFromCredits(e.credits)))) problems.push('an employee\'s points are not credits / 10')
  if (s.expired_credits > s.credits + 0.005) problems.push('expired credits exceed earned credits')
  return problems
}

// ─── Highest and lowest contributors, ties included ───────────────────────────

export type Contributors = {
  highest: EmployeeRow[]
  lowest: EmployeeRow[]
  /** Everyone is on the same count: there is no highest and no lowest to name. */
  allTied: boolean
}

/**
 * The employees at the top and the bottom by submitted reviews, ALL of those on the
 * same count (a tie is shown as a tie). Employees with zero submissions are part of
 * the field, so the lowest activity is visible.
 */
export function contributors(rows: EmployeeRow[]): Contributors {
  if (rows.length === 0) return { highest: [], lowest: [], allTied: false }
  const max = Math.max(...rows.map(r => r.submitted))
  const min = Math.min(...rows.map(r => r.submitted))
  if (max === min) return { highest: [], lowest: [], allTied: true }
  return {
    highest: rows.filter(r => r.submitted === max),
    lowest: rows.filter(r => r.submitted === min),
    allTied: false,
  }
}

// ─── Chart geometry (kept out of the component so it can be tested) ───────────

/** A friendly axis maximum: at least 4, rounded up to 1, 2, 4, 5, 10, 20 … */
export function axisMax(highest: number): number {
  if (highest <= 4) return 4
  const pow = Math.pow(10, Math.floor(Math.log10(highest)))
  for (const step of [1, 2, 4, 5, 10]) if (step * pow >= highest) return step * pow
  return 10 * pow
}

export function barSegments(text: number, image: number, max: number, height: number): { textH: number; imageH: number } {
  if (max <= 0) return { textH: 0, imageH: 0 }
  return { textH: (text / max) * height, imageH: (image / max) * height }
}

// ─── The leaderboard ──────────────────────────────────────────────────────────

export type LeaderboardState = 'leading' | 'joint' | 'behind' | 'no_activity' | 'not_taking_part'

export type LeaderboardRow = {
  rank: number
  employee_id: string
  name: string
  reviews: number
  credits: number
  points: number
  is_me: boolean
  tied: boolean
}

export type Leaderboard = {
  month: string
  current_month: string
  leader_reviews: number
  leaders: number
  state: LeaderboardState
  need: number | null
  me: { rank: number; reviews: number; credits: number; points: number } | null
  participants: number
  rows: LeaderboardRow[]
}

const STATES: readonly LeaderboardState[] = ['leading', 'joint', 'behind', 'no_activity', 'not_taking_part']

export function parseLeaderboard(raw: unknown): Leaderboard | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.month !== 'string' || !Array.isArray(r.rows) || !STATES.includes(r.state as LeaderboardState)) return null
  const me = r.me as Record<string, unknown> | null | undefined
  return {
    month: r.month,
    current_month: str(r.current_month),
    leader_reviews: num(r.leader_reviews),
    leaders: num(r.leaders),
    state: r.state as LeaderboardState,
    need: r.need == null ? null : num(r.need),
    me: me ? { rank: num(me.rank), reviews: num(me.reviews), credits: num(me.credits), points: num(me.points) } : null,
    participants: num(r.participants),
    rows: arr(r.rows).map(x => ({
      rank: num(x.rank), employee_id: str(x.employee_id), name: str(x.name) || 'Unknown',
      reviews: num(x.reviews), credits: num(x.credits), points: num(x.points),
      is_me: x.is_me === true, tied: x.tied === true,
    })),
  }
}

/** X = leader count - your count + 1, while you are behind. Null when the formula does not apply. */
export function reviewsNeededForFirst(leaderReviews: number, myReviews: number): number | null {
  return myReviews < leaderReviews ? leaderReviews - myReviews + 1 : null
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * The sentence under the leaderboard and on the dashboard card. The target is
 * ADDITIONAL ELIGIBLE reviews — reviews that must be approved with a live credit —
 * and is worded as a target, never as a guaranteed award.
 */
export function firstPlaceMessage(state: LeaderboardState, need: number | null, leaders = 1): string {
  switch (state) {
    case 'leading':
      return "You're leading"
    case 'joint':
      return `You're joint first${leaders > 1 ? ` with ${leaders - 1} ${plural(leaders - 1, 'other', 'others')}` : ''} — 1 more review makes you the sole leader`
    case 'behind':
    case 'no_activity': {
      const n = need ?? 1
      return `You need ${n} more ${plural(n, 'review', 'reviews')} to take first place`
    }
    case 'not_taking_part':
      return 'Review submissions are not open to you this month'
  }
}

/** The qualifier that keeps the target honest. */
export const FIRST_PLACE_FOOTNOTE =
  'Counts additional eligible reviews (approved, with a live credit) — a target, not a guaranteed award.'

// ─── The dashboard card ───────────────────────────────────────────────────────

export type LeaderCard = {
  month: string
  leader_reviews: number
  leaders: number
  leader_names: string[]
  state: LeaderboardState
  need: number | null
  me: { rank: number; reviews: number; credits: number; points: number } | null
}

export function parseLeaderCard(raw: unknown): LeaderCard | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.month !== 'string' || !STATES.includes(r.state as LeaderboardState)) return null
  const me = r.me as Record<string, unknown> | null | undefined
  return {
    month: r.month,
    leader_reviews: num(r.leader_reviews),
    leaders: num(r.leaders),
    leader_names: Array.isArray(r.leader_names) ? (r.leader_names as unknown[]).filter((n): n is string => typeof n === 'string') : [],
    state: r.state as LeaderboardState,
    need: r.need == null ? null : num(r.need),
    me: me ? { rank: num(me.rank), reviews: num(me.reviews), credits: num(me.credits), points: num(me.points) } : null,
  }
}

// ─── The list behind a card or a row ──────────────────────────────────────────

export type ReportFocus = 'all' | 'text' | 'image' | 'eligible' | 'duplicates' | 'confirmed_duplicates' | 'held'

export type ReportListRow = {
  id: string
  submission_ref: string
  submitted_by: string
  employee_name: string
  review_type: ReviewTypeKey
  status: ReviewStatusKey
  submitted_at: string
  published_on: string
  eligible: boolean
  credits: number
  points: number
  duplicate_open: boolean
  reward_held: boolean
  edit_count: number
  confirmed_duplicate: boolean
  expired: boolean
  reversed: boolean
  held: boolean
  held_credits: number
}

export type ReportList = { total: number; limit: number; offset: number; rows: ReportListRow[] }

export function parseReportList(raw: unknown): ReportList | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.rows)) return null
  return {
    total: num(r.total), limit: num(r.limit), offset: num(r.offset),
    rows: arr(r.rows).map(x => ({
      id: str(x.id), submission_ref: str(x.submission_ref), submitted_by: str(x.submitted_by),
      employee_name: str(x.employee_name) || 'Unknown',
      review_type: x.review_type === 'image' ? 'image' : 'text',
      status: (x.status === 'approved' || x.status === 'rejected' ? x.status : 'pending_verification') as ReviewStatusKey,
      submitted_at: str(x.submitted_at), published_on: str(x.published_on),
      eligible: x.eligible === true, credits: num(x.credits), points: num(x.points),
      duplicate_open: x.duplicate_open === true, reward_held: x.reward_held === true, edit_count: num(x.edit_count),
      confirmed_duplicate: x.confirmed_duplicate === true, expired: x.expired === true, reversed: x.reversed === true,
      held: x.held === true, held_credits: num(x.held_credits),
    })),
  }
}

export const FOCUS_LABELS: Record<ReportFocus, string> = {
  all: 'All submitted reviews',
  text: 'Text reviews',
  image: 'Image reviews',
  eligible: 'Reward-eligible reviews',
  duplicates: 'Possible duplicates awaiting a decision',
  confirmed_duplicates: 'Confirmed duplicates (rejected, credit reversed)',
  held: 'Edited approved reviews awaiting re-approval',
}

/** Months a verifier can pick: the current one and the previous eleven, newest first. */
export function monthChoices(currentMonth: string, count = 12): string[] {
  const [y, m] = currentMonth.split('-').map(Number)
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 10))
}

/** "3 Feb" from YYYY-MM-DD, without a timezone shift. */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${names[m - 1] ?? ''}`.trim()
}
