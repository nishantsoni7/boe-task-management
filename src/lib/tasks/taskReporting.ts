// Task reporting: the Dashboard's creation counts and the Completed history.
//
// WHY THE RULES ARE DATA. Every rule below is a list of filters handed to the
// database. The browser never downloads somebody's task history to count it:
// counts come back from `count: 'exact', head: true` requests that carry no rows
// at all, and a Completed list comes back one page of twenty at a time. The same
// filter lists are what the tests read, so what is tested is exactly what the
// database is asked.
//
// WHOSE NUMBERS. Every function takes the EFFECTIVE user id — the signed-in user,
// or the employee being viewed under View As — and applies no authorization of
// its own. What a caller may read is still decided by RLS.
//
// PURITY. Clocks are passed in (`now`), never read, so every boundary is testable.

import { dateParam, idParam, isCalendarDate, optionParam, pageParam, textParam } from '@/lib/listState'

export const DAY_MS = 24 * 60 * 60 * 1000

/** Completed history renders this many rows per page, never the whole archive. */
export const COMPLETED_PAGE_SIZE = 20

// ── Filters, as data ─────────────────────────────────────────────────────────

export type TaskFilter =
  | { op: 'eq' | 'neq' | 'gte' | 'lt' | 'ilike'; column: string; value: string }
  | { op: 'notNull'; column: string }

/** The slice of a PostgREST query builder the filters need. */
export type FilterableQuery<Q> = {
  eq(column: string, value: string): Q
  neq(column: string, value: string): Q
  not(column: string, operator: string, value: null): Q
  gte(column: string, value: string): Q
  lt(column: string, value: string): Q
  ilike(column: string, pattern: string): Q
}

export function applyTaskFilters<Q extends FilterableQuery<Q>>(query: Q, filters: readonly TaskFilter[]): Q {
  let q = query
  for (const f of filters) {
    q = f.op === 'notNull' ? q.not(f.column, 'is', null) : q[f.op](f.column, f.value)
  }
  return q
}

// ── Time windows ─────────────────────────────────────────────────────────────

/** `days` × 24 hours before `now`. "Last 7 days" is rolling, not a calendar week. */
export function rollingSince(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}

export type DayRange = { start: Date; end: Date }

/**
 * One calendar day in the BROWSER'S time zone — IST for this team — as the two
 * instants [00:00, next 00:00). Built from local date parts, never from
 * `new Date('YYYY-MM-DD')`, which is UTC midnight and would move every India
 * morning before 05:30 onto the previous day.
 */
export function localDayRange(date: string): DayRange | null {
  if (!isCalendarDate(date)) return null
  const [year, month, day] = date.split('-').map(Number)
  return { start: new Date(year, month - 1, day), end: new Date(year, month - 1, day + 1) }
}

/** Yesterday as a local calendar day — not "the 24 hours before now". */
export function yesterdayRange(now: Date): DayRange {
  return {
    start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
    end:   new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  }
}

export function onOrAfter(column: string, instant: Date): TaskFilter[] {
  return [{ op: 'gte', column, value: instant.toISOString() }]
}

export function withinRange(column: string, range: DayRange): TaskFilter[] {
  return [
    { op: 'gte', column, value: range.start.toISOString() },
    { op: 'lt',  column, value: range.end.toISOString() },
  ]
}

// ── Dashboard: tasks created ─────────────────────────────────────────────────

export type CreatedKind = 'self' | 'delegated'

/**
 * Self: created by the user AND assigned to the user.
 * Delegated: created by the user AND assigned to somebody else.
 *
 * Both count ORDINARY tasks only. A quotation request is its own workflow —
 * its own create page, list and sidebar count, excluded from My Tasks, and "the
 * requester/assignee relationship there is not a delegation" (20260833) — so it
 * is neither. `task_type` is NOT NULL DEFAULT 'general', so `<>` drops nothing else.
 */
export function createdTaskFilters(kind: CreatedKind, userId: string, since: Date): TaskFilter[] {
  const created: TaskFilter[] = [
    { op: 'eq', column: 'created_by', value: userId },
    ...onOrAfter('created_at', since),
    { op: 'neq', column: 'task_type', value: 'quotation_request' },
  ]
  return kind === 'self'
    ? [...created, { op: 'eq', column: 'assigned_to', value: userId }]
    : [...created, { op: 'notNull', column: 'assigned_to' }, { op: 'neq', column: 'assigned_to', value: userId }]
}

export type CreationReport = {
  self7: number
  self30: number
  delegated7: number
  delegated30: number
}

// ── Completed history ────────────────────────────────────────────────────────

/** My Tasks → Completed, or Assigned By Me → Completed. */
export type CompletedScope = 'assigned-to-me' | 'assigned-by-me'

/**
 * Whose completed work a list shows. Status must be `completed` NOW: a reopened
 * task is no longer completed (and /api/restore-task clears its completed_at),
 * so it drops out of every list and count here.
 */
export function completedScopeFilters(scope: CompletedScope, userId: string): TaskFilter[] {
  const completed: TaskFilter = { op: 'eq', column: 'status', value: 'completed' }
  if (scope === 'assigned-to-me') {
    return [completed, { op: 'eq', column: 'assigned_to', value: userId }]
  }
  return [
    completed,
    { op: 'eq', column: 'created_by', value: userId },
    { op: 'notNull', column: 'assigned_to' },
    { op: 'neq', column: 'assigned_to', value: userId },
  ]
}

export type CompletionSummary = {
  yesterday: number
  last7: number
  last30: number
}

/** The person on the other side of the task: its assigner, or its assignee. */
export function counterpartColumn(scope: CompletedScope): 'created_by' | 'assigned_to' {
  return scope === 'assigned-to-me' ? 'created_by' : 'assigned_to'
}

export type CompletedListFilters = {
  /** The assigner (My Tasks) or assignee (Assigned By Me) filter; '' for all. */
  counterpart: string
  priority: string
  q: string
  /** A local calendar date, YYYY-MM-DD; '' for any date. */
  completedOn: string
}

/** Escape LIKE's own wildcards so a search for "50%" means those characters. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, ch => `\\${ch}`)
}

/** Every filter a Completed page applies, so the page and its total always agree. */
export function completedListFilters(
  scope: CompletedScope,
  userId: string,
  filters: CompletedListFilters,
): TaskFilter[] {
  const out = completedScopeFilters(scope, userId)
  if (filters.counterpart) out.push({ op: 'eq', column: counterpartColumn(scope), value: filters.counterpart })
  if (filters.priority)    out.push({ op: 'eq', column: 'priority', value: filters.priority })
  const q = filters.q.trim()
  if (q) out.push({ op: 'ilike', column: 'title', value: `%${escapeLikePattern(q)}%` })
  const day = filters.completedOn ? localDayRange(filters.completedOn) : null
  if (day) out.push(...withinRange('completed_at', day))
  return out
}

// ── Paging ───────────────────────────────────────────────────────────────────

/** Inclusive row offsets for a 1-based page, as `.range(from, to)` takes them. */
export function completedPageRange(page: number): { from: number; to: number } {
  const current = Math.max(1, Math.floor(page))
  const from = (current - 1) * COMPLETED_PAGE_SIZE
  return { from, to: from + COMPLETED_PAGE_SIZE - 1 }
}

export function totalPages(total: number): number {
  return Math.max(1, Math.ceil(total / COMPLETED_PAGE_SIZE))
}

/** "21–40 of 83": the 1-based positions a page covers. */
export function pageSpan(page: number, total: number): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 }
  const { from } = completedPageRange(page)
  return { first: Math.min(from + 1, total), last: Math.min(from + COMPLETED_PAGE_SIZE, total) }
}

// ── URL state ────────────────────────────────────────────────────────────────
// Module scope: useListUrlState needs a codec map with a stable identity.

const PRIORITY_KEYS = ['high', 'medium', 'low'] as const

export const MY_COMPLETED_PARAMS = {
  assignedBy:  idParam(),
  priority:    optionParam(PRIORITY_KEYS),
  q:           textParam(),
  completedOn: dateParam(),
  page:        pageParam(),
}

export const DELEGATED_COMPLETED_PARAMS = {
  assignee:    idParam(),
  priority:    optionParam(PRIORITY_KEYS),
  q:           textParam(),
  completedOn: dateParam(),
  page:        pageParam(),
}
