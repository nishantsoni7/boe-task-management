// Follow-up due/overdue classification and filtering.
//
// One rule, in one place, because the same question is asked by the Follow-ups
// screen, its tab counts, and the red date in the meeting working table — and
// three implementations of "is this overdue?" would eventually disagree at
// midnight.
//
// Dates here are IST business dates (`YYYY-MM-DD`), the same convention the
// Attendance and Performance modules use. `next_follow_up_date` is a Postgres
// `date`, so it comes back as a plain `YYYY-MM-DD` string and string comparison
// IS date comparison — no Date objects, no timezone drift.

import { istToday } from '@/lib/istDate'
import type { ItemStatus, MeetingType } from './types'

export type FollowUpDue = 'overdue' | 'today' | 'upcoming'

/** The Follow-ups screen's date filter. `all` is the default view. */
export type FollowUpDueFilter = 'all' | FollowUpDue

export const FOLLOW_UP_DUE_FILTERS: readonly FollowUpDueFilter[] = ['all', 'overdue', 'today', 'upcoming']

/**
 * One row of the follow-up list: a SKU line, flattened together with the order
 * and meeting it belongs to. Built by the page from its joined query; kept as a
 * plain shape so every rule below is testable without a database.
 */
export type FollowUpRow = {
  itemId: string
  meetingId: string
  meetingType: MeetingType
  orderId: string
  orderNumber: string
  sku: string
  productName: string
  responsibleDepartment: string | null
  latestUpdate: string | null
  /** When the latest update was entered — not when the row was created. */
  lastUpdatedAt: string | null
  nextFollowUpDate: string | null
  status: ItemStatus
  linkedTaskId: string | null
  linkedTaskTitle?: string | null
  linkedTaskStatus?: string | null
}

/**
 * Where a dated follow-up sits relative to today.
 *
 * Returns null for a line with no date and for anything already resolved: a
 * resolved item is not a follow-up, whatever date it still carries. This is the
 * counterpart of the rule the database enforces on save (resolving a line
 * clears its date) — the two together mean a resolved item cannot appear in the
 * Overdue list by either route.
 */
export function followUpDue(
  nextFollowUpDate: string | null | undefined,
  status: ItemStatus,
  today: string = istToday(),
): FollowUpDue | null {
  if (!nextFollowUpDate) return null
  if (status === 'resolved') return null
  if (nextFollowUpDate < today) return 'overdue'
  if (nextFollowUpDate === today) return 'today'
  return 'upcoming'
}

export const FOLLOW_UP_DUE_META: Record<FollowUpDue, { label: string; bg: string; color: string; border: string }> = {
  overdue:  { label: 'Overdue',  bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  today:    { label: 'Due Today', bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  upcoming: { label: 'Upcoming', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
}

/** How many days late, for the "3 days overdue" hint. Never negative. */
export function daysOverdue(nextFollowUpDate: string, today: string = istToday()): number {
  const due = Date.parse(`${nextFollowUpDate}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(now)) return 0
  return Math.max(0, Math.round((now - due) / 86_400_000))
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export type FollowUpFilters = {
  due: FollowUpDueFilter
  /** '' = every meeting type. */
  meetingType: MeetingType | ''
  /** '' = every department. */
  department: string
  /** '' = every status. Resolved lines are excluded from this screen entirely. */
  status: ItemStatus | ''
  search: string
}

export const EMPTY_FOLLOW_UP_FILTERS: FollowUpFilters = {
  due: 'all', meetingType: '', department: '', status: '', search: '',
}

/**
 * The Follow-ups screen's population, before any filter: everything with a date
 * that is not resolved.
 *
 * A resolved line is dropped here rather than being offered as a status filter,
 * because "resolved follow-ups" is not an operational list — it is history, and
 * history is read on the item, in its drawer.
 */
export function isFollowUp(row: FollowUpRow, today: string = istToday()): boolean {
  return followUpDue(row.nextFollowUpDate, row.status, today) !== null
}

/**
 * Apply the toolbar. Search covers order number, SKU and product name — the
 * three things someone reads off a screen or hears in a meeting — plus the
 * latest update text, so "fabric" finds the line whose update mentions it.
 */
export function filterFollowUps(
  rows: readonly FollowUpRow[],
  filters: FollowUpFilters,
  today: string = istToday(),
): FollowUpRow[] {
  const q = filters.search.trim().toLowerCase()
  return rows.filter(row => {
    const due = followUpDue(row.nextFollowUpDate, row.status, today)
    if (due === null) return false
    if (filters.due !== 'all' && due !== filters.due) return false
    if (filters.meetingType && row.meetingType !== filters.meetingType) return false
    if (filters.department && (row.responsibleDepartment ?? '') !== filters.department) return false
    if (filters.status && row.status !== filters.status) return false
    if (q) {
      const haystack = [row.orderNumber, row.sku, row.productName, row.latestUpdate ?? '']
        .join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}

/**
 * Oldest first. The most overdue line is the one that needs attention, so it is
 * the one at the top; undated rows cannot reach here.
 */
export function sortFollowUps(rows: readonly FollowUpRow[]): FollowUpRow[] {
  return [...rows].sort((a, b) => {
    const byDate = (a.nextFollowUpDate ?? '').localeCompare(b.nextFollowUpDate ?? '')
    if (byDate !== 0) return byDate
    return a.orderNumber.localeCompare(b.orderNumber) || a.sku.localeCompare(b.sku)
  })
}

/** Counts for the tab strip, computed against the non-date filters only. */
export function followUpCounts(
  rows: readonly FollowUpRow[],
  filters: FollowUpFilters,
  today: string = istToday(),
): Record<FollowUpDueFilter, number> {
  const base = filterFollowUps(rows, { ...filters, due: 'all' }, today)
  const counts: Record<FollowUpDueFilter, number> = { all: base.length, overdue: 0, today: 0, upcoming: 0 }
  for (const row of base) {
    const due = followUpDue(row.nextFollowUpDate, row.status, today)
    if (due) counts[due] += 1
  }
  return counts
}
