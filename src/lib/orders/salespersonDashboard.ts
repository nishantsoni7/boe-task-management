// THE SALESPERSON'S OWN ORDERS DASHBOARD, AS THE PAGE USES IT (20270228000000).
//
// public.salesperson_orders_dashboard() returns the figures and the complete
// lists for THE CALLER ONLY, in one round trip. This module VALIDATES
// that payload, owns the words, and turns elapsed days into text. It computes
// nothing about orders: which orders are confirmed, what revenue is, what "below
// 40%" means and who owns an order are the database's, stated once in the
// migration and pinned by supabase/tests/salesperson_orders_dashboard_assertions.sql.
//
// A PAYLOAD IT CANNOT READ IS AN ERROR, NEVER AN EMPTY DASHBOARD. A parse that
// turned a malformed answer into zero orders and ₹0 would tell a salesperson
// nothing needs them because a query misbehaved.
//
// THE CARD AND THE PANEL ARE ONE NUMBER: `pendingTotal` must equal the length of
// the pending list, or the payload is refused.
//
// 20270508000000 (owner, 2026-10-30) adds last month's sales, the rupees each
// below-40% order is short, and since when each ready order has been ready. A
// database without that migration simply does not send them: the page then says
// "–" or nothing, never an error and never a zero.

import { formatDate, formatMonth, formatRupees, plural } from './orderDashboardSummary'

// ── The payload ───────────────────────────────────────────────────────────────

export type SpPendingRow = {
  submissionId: string
  /** The PI's draft reference. An Order number does not exist until approval. */
  reference: string
  clientName: string
  waitingSeconds: number
  /** False when the existing PI detail rules would refuse this reader: drawn without a link. */
  canOpen: boolean
}

/** A PI the reviewer sent back for changes, or rejected (20270328000200). */
export type SpReviewedRow = {
  submissionId: string
  reference: string
  clientName: string
  /** The reviewer's note or reason; null when none is on record. */
  note: string | null
  /** Who decided it; null when the person is no longer on record. */
  byName: string | null
  /** Seconds since the decision. */
  sinceSeconds: number
  canOpen: boolean
}

export type SpAdvanceRow = {
  orderId: string
  displayNumber: string
  clientName: string
  /** Verified advance as a percent of the current Order value, truncated to 2 places. */
  percent: number
  /** Rupees still needed to reach 40% — the advance rule's own figure; null when not sent. */
  shortfall: number | null
  /** Whole days since confirmation (India time); null when no date is on record or not sent. */
  daysSinceConfirmation: number | null
  exceptionApproved: boolean
}

export type SpPendingKind = 'fabric' | 'finish'
export type SpApprovalStatus = 'not_approved' | 'partially_approved' | 'no_approval_recorded'

export type SpFabricFinishRow = {
  orderId: string
  displayNumber: string
  clientName: string
  pending: SpPendingKind[]
  /** Items of this order with NO approval record at all (an older order): status unknown, said beside the pending. */
  unknown: SpPendingKind[]
  /** Null when the order has no confirmation date. */
  daysSinceConfirmation: number | null
  over15Days: boolean
}

/** An order whose fabric/finish approval status is unknown: no record exists, so it is neither approved nor pending. */
export type SpUnknownRow = {
  orderId: string
  displayNumber: string
  clientName: string
  unknown: SpPendingKind[]
  daysSinceConfirmation: number | null
}

/** An open order whose advance could not be checked: no total before GST is on record for its current value. */
export type SpUncheckedRow = {
  orderId: string
  displayNumber: string
  clientName: string
}

export type SpReadyRow = {
  orderId: string
  displayNumber: string
  clientName: string
  /** `YYYY-MM-DD`, or null when no date is planned. */
  plannedDispatchDate: string | null
  /**
   * Whole days since it last became ready (India time). null: no status-history
   * entry, so the date is not recorded. undefined: the database did not send it.
   */
  readyDays?: number | null
}

export type SpRevenue = { amount: number; orders: number; noProductValue: number; beforeDiscount: number }

export type SalespersonDashboard = {
  /** `YYYY-MM-01`, the month the revenue card is for. */
  monthFrom: string
  /** `YYYY-MM-DD`, today in India, as the database saw it; null when not sent. */
  today: string | null
  totalOrders: number
  revenue: SpRevenue
  /** The previous calendar month by the same rule; null when the database did not send it. */
  revenueLastMonth: (SpRevenue & { monthFrom: string }) | null
  pendingTotal: number
  pending: SpPendingRow[]
  /** PIs sent back for changes: waiting on the salesperson, no age limit. */
  returnedTotal: number
  returned: SpReviewedRow[]
  /** PIs rejected in the last 7 days. */
  rejectedTotal: number
  rejected: SpReviewedRow[]
  advance: SpAdvanceRow[]
  /** Open orders with no usable value: no percentage exists, so they are not listed. */
  advanceUnchecked: SpUncheckedRow[]
  fabricFinish: SpFabricFinishRow[]
  /** Older orders with no fabric/finish record at all: listed apart, as unknown — never approved, never invented. */
  fabricFinishUnknown: SpUnknownRow[]
  readyForDispatch: SpReadyRow[]
}

export type ParsedSalespersonDashboard =
  | { ok: true; applicable: false }
  | { ok: true; applicable: true; dashboard: SalespersonDashboard }
  | { ok: false; message: string }

// ── Validation ────────────────────────────────────────────────────────────────

class Bad extends Error {}

type Obj = Record<string, unknown>
const obj = (v: unknown, what: string): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Bad(what)
  return v as Obj
}
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Bad(what)
  return v
}
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v === '') throw new Bad(what)
  return v
}
const num = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new Bad(what)
  return n
}
const count = (v: unknown, what: string): number => {
  const n = num(v, what)
  if (!Number.isInteger(n) || n < 0) throw new Bad(what)
  return n
}
const dateOnly = (v: unknown, what: string): string => {
  const s = str(v, what)
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Bad(what)
  return s.slice(0, 10)
}
const optDate = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : dateOnly(v, what))
const optNum = (v: unknown, what: string): number | null => (v === null || v === undefined ? null : num(v, what))
const revenueOf = (v: unknown, what: string): SpRevenue => {
  const r = obj(v, what)
  return {
    amount: num(r.amount, what + ' amount'),
    orders: count(r.orders, what + ' orders'),
    noProductValue: count(r.no_product_value, what + ' no_product_value'),
    beforeDiscount: count(r.before_discount, what + ' before_discount'),
  }
}
const kindsOf = (v: unknown, what: string): SpPendingKind[] => {
  const seen = new Set<SpPendingKind>()
  for (const k of arr(v ?? [], what)) {
    if (k !== 'fabric' && k !== 'finish') throw new Bad(what)
    seen.add(k)
  }
  return (['fabric', 'finish'] as const).filter(k => seen.has(k))
}
const clientOf = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Turns the RPC's answer into the page's model, or says why it cannot. */
export function parseSalespersonDashboard(raw: unknown): ParsedSalespersonDashboard {
  try {
    const root = obj(raw, 'the dashboard')
    if (root.applicable === false) return { ok: true, applicable: false }
    if (root.applicable !== true) throw new Bad('applicable')

    // Absent before 20270508000000: "not available", never an error and never ₹0.
    const lastMonth = root.revenue_last_month === undefined || root.revenue_last_month === null
      ? null
      : { ...revenueOf(root.revenue_last_month, 'revenue_last_month'),
          monthFrom: dateOnly(obj(root.revenue_last_month, 'revenue_last_month').month_from, 'revenue_last_month month_from') }
    const pending = arr(root.pending, 'pending').map((x): SpPendingRow => {
      const o = obj(x, 'pending row')
      return {
        submissionId: str(o.submission_id, 'submission_id'),
        reference: typeof o.reference === 'string' && o.reference !== '' ? o.reference : 'PI',
        clientName: clientOf(o.client_name),
        waitingSeconds: Math.max(0, num(o.waiting_seconds, 'waiting_seconds')),
        canOpen: o.can_open === true,
      }
    })
    // A payload from a database that predates 20270328000200 has neither list: that is "none", never an error.
    const reviewed = (v: unknown, what: string): SpReviewedRow[] => arr(v ?? [], what).map((x): SpReviewedRow => {
      const o = obj(x, what + ' row')
      return {
        submissionId: str(o.submission_id, 'submission_id'),
        reference: typeof o.reference === 'string' && o.reference !== '' ? o.reference : 'PI',
        clientName: clientOf(o.client_name),
        note: typeof o.note === 'string' && o.note.trim() !== '' ? o.note.trim() : null,
        byName: typeof o.by_name === 'string' && o.by_name !== '' ? o.by_name : null,
        sinceSeconds: Math.max(0, num(o.waiting_seconds ?? 0, 'waiting_seconds')),
        canOpen: o.can_open === true,
      }
    })
    const returned = reviewed(root.returned, 'returned')
    const rejected = reviewed(root.rejected, 'rejected')
    const dashboard: SalespersonDashboard = {
      monthFrom: dateOnly(root.month_from, 'month_from'),
      today: optDate(root.today, 'today'),
      totalOrders: count(root.total_orders, 'total_orders'),
      revenue: revenueOf(root.revenue, 'revenue'),
      revenueLastMonth: lastMonth,
      pendingTotal: count(root.pending_total, 'pending_total'),
      pending,
      returnedTotal: count(root.returned_total ?? returned.length, 'returned_total'),
      returned,
      rejectedTotal: count(root.rejected_total ?? rejected.length, 'rejected_total'),
      rejected,
      advance: arr(root.advance, 'advance').map((x): SpAdvanceRow => {
        const o = obj(x, 'advance row')
        return {
          orderId: str(o.order_id, 'order_id'),
          displayNumber: str(o.display_number, 'display_number'),
          clientName: clientOf(o.client_name),
          percent: num(o.percent, 'percent'),
          shortfall: optNum(o.shortfall, 'shortfall'),
          daysSinceConfirmation: optNum(o.days_since_confirmation, 'days_since_confirmation'),
          exceptionApproved: o.exception_approved === true,
        }
      }),
      advanceUnchecked: arr(root.advance_unchecked, 'advance_unchecked').map((x): SpUncheckedRow => {
        const o = obj(x, 'unchecked row')
        return { orderId: str(o.order_id, 'order_id'), displayNumber: str(o.display_number, 'display_number'), clientName: clientOf(o.client_name) }
      }),
      fabricFinish: arr(root.fabric_finish, 'fabric_finish').map((x): SpFabricFinishRow => {
        const o = obj(x, 'fabric row')
        const kinds = new Set<SpPendingKind>()
        for (const p of arr(o.pending, 'pending items')) {
          const po = obj(p, 'pending item')
          if (po.kind !== 'fabric' && po.kind !== 'finish') throw new Bad('pending kind')
          kinds.add(po.kind)
        }
        if (kinds.size === 0) throw new Bad('a fabric row with nothing pending')
        const unknown = kindsOf(o.unknown, 'unknown items')
        return {
          orderId: str(o.order_id, 'order_id'),
          displayNumber: str(o.display_number, 'display_number'),
          clientName: clientOf(o.client_name),
          pending: (['fabric', 'finish'] as const).filter(k => kinds.has(k)),
          unknown,
          daysSinceConfirmation: o.days_since_confirmation === null || o.days_since_confirmation === undefined
            ? null : num(o.days_since_confirmation, 'days_since_confirmation'),
          over15Days: o.over_15_days === true,
        }
      }),
      fabricFinishUnknown: arr(root.fabric_finish_unknown, 'fabric_finish_unknown').map((x): SpUnknownRow => {
        const o = obj(x, 'unknown row')
        const unknown = kindsOf(o.unknown, 'unknown items')
        if (unknown.length === 0) throw new Bad('an unknown row with nothing unknown')
        return {
          orderId: str(o.order_id, 'order_id'),
          displayNumber: str(o.display_number, 'display_number'),
          clientName: clientOf(o.client_name),
          unknown,
          daysSinceConfirmation: o.days_since_confirmation === null || o.days_since_confirmation === undefined
            ? null : num(o.days_since_confirmation, 'days_since_confirmation'),
        }
      }),
      readyForDispatch: arr(root.ready_for_dispatch, 'ready_for_dispatch').map((x): SpReadyRow => {
        const o = obj(x, 'ready row')
        return {
          orderId: str(o.order_id, 'order_id'),
          displayNumber: str(o.display_number, 'display_number'),
          clientName: clientOf(o.client_name),
          plannedDispatchDate: optDate(o.planned_dispatch_date, 'planned_dispatch_date'),
          ...('ready_days' in o ? { readyDays: optNum(o.ready_days, 'ready_days') } : {}),
        }
      }),
    }

    // The card and the panel are one number.
    if (dashboard.pendingTotal !== dashboard.pending.length) throw new Bad('pending total does not match its list')

    if (dashboard.returnedTotal !== returned.length) throw new Bad('returned total does not match its list')
    if (dashboard.rejectedTotal !== rejected.length) throw new Bad('rejected total does not match its list')

    return { ok: true, applicable: true, dashboard }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Bad
        ? `The dashboard answer was not in the expected shape (${e.message}).`
        : 'The dashboard answer could not be read.',
    }
  }
}

/**
 * The database says this function does not exist (the migration is not on this
 * database yet). The page then keeps the dashboard it had; any OTHER failure is an
 * error state, never a quiet fallback.
 */
export function isDashboardFunctionMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883'
    || /could not find the function|does not exist/i.test(error.message ?? '')
}

/**
 * What the page does with the personal read's answer. ONE decision, in one place:
 *   - the function is missing on this database      → 'other'  (the dashboard everybody else has)
 *   - any OTHER failure, or an unreadable answer     → 'error'  (shown, with a retry; never zeros)
 *   - { applicable: false }                          → 'other'
 *   - a valid personal answer                        → 'ready'
 */
export type PersonalRead =
  | { kind: 'other' }
  | { kind: 'error' }
  | { kind: 'ready'; data: SalespersonDashboard }

export function resolvePersonalRead(res: { data: unknown; error: { code?: string; message?: string } | null }): PersonalRead {
  if (res.error) return isDashboardFunctionMissing(res.error) ? { kind: 'other' } : { kind: 'error' }
  const parsed = parseSalespersonDashboard(res.data)
  if (!parsed.ok) return { kind: 'error' }
  return parsed.applicable ? { kind: 'ready', data: parsed.dashboard } : { kind: 'other' }
}

// ── Words ─────────────────────────────────────────────────────────────────────

export const SP_TITLE = 'Your orders'
export const SP_ERROR_HEADING = 'Your orders could not be loaded'
export const SP_ERROR_BODY =
  'None of the figures or lists could be read, so an empty screen here does not mean you have no orders. Try again; if it keeps failing, tell an administrator.'
export const SP_RETRY_LABEL = 'Try again'
export const SP_LOADING_LABEL = 'Loading your orders'

// The sales figures (owner, 2026-10-30): this month so far beside last month.
export const SP_SALES_THIS_MONTH = 'This month so far'
export const SP_SALES_LAST_MONTH = 'Last month'
export const SP_SALES_BASIS = 'Your confirmed orders, by confirmation date · product value after discount, excluding GST'
export const SP_SALES_NOT_AVAILABLE = 'Not available yet'

// A PI returned to Sales: one line each. The approver's note is NOT drawn here;
// it is at the top of the PI page, where the change is made.
export const SP_RETURNED_HINT_ONE = 'Open it to see what to change, then submit it again.'
export const SP_RETURNED_HINT_MANY = 'Open each one to see what to change, then submit it again.'
export const SP_OPEN_PI = 'Open PI'

export const SP_LIST_ADVANCE = 'Advance below 40%'
export const SP_LIST_READY = 'Ready for dispatch'
export const SP_LIST_PENDING = 'Waiting for approval'
export const SP_HINT = {
  advance: 'Call these clients for payment',
  ready: 'Not dispatched yet',
  pending: 'Submitted, not decided yet',
} as const
/** The phone's jump chips, one per list. */
export const SP_CHIP = {
  advance: 'Below 40%',
  ready: 'Ready to dispatch',
  pending: 'Waiting approval',
} as const
/** "Confirmed N days ago" is drawn under the client, so the table fits a third of a wide screen. */
export const SP_ADVANCE_COLUMNS = ['Order', 'Client', 'Verified', 'Short of 40%'] as const

export const SP_EMPTY = {
  pending: 'No PIs are waiting for approval.',
  advance: 'Every active order has at least 40% verified advance.',
  ready: 'No orders are ready for dispatch.',
} as const

export const SP_EXCEPTION_APPROVED = 'Exception approved'
export const SP_ADVANCE_UNCHECKED_HEADING = 'Advance not checked'
export const SP_ADVANCE_UNCHECKED_PILL = 'Advance not checked'
export const SP_ADVANCE_UNCHECKED_RULE =
  'No total before GST is on record for these orders\' current value, so their advance cannot be measured. They are not cleared: check them, or ask for the PI to be corrected.'
export const SP_ADVANCE_BELOW_NONE_KNOWN = 'No checked order is below 40%.'
export const SP_NOT_OPENABLE = 'Only the person who filed this PI, its reviewer or an approver can open it'
export const SP_NOT_OPENABLE_SHORT = 'Opens only for whoever filed it'

/** `2026-10-01` → `October 2026`. */
export const revenueMonthLabel = (monthFrom: string): string => formatMonth(monthFrom)

export const revenueText = (amount: number): string => formatRupees(amount)

/** What a month's figure leaves out, said under it; `when` is `this month` or `last month`. */
export function revenueNotes(r: SpRevenue, when = 'this month'): string[] {
  const notes: string[] = []
  if (r.noProductValue > 0) notes.push(`${plural(r.noProductValue, 'order')} ${when} with no product value on record ${r.noProductValue === 1 ? 'is' : 'are'} not counted.`)
  if (r.beforeDiscount > 0) notes.push(`${plural(r.beforeDiscount, 'order')} ${when} ${r.beforeDiscount === 1 ? 'carries' : 'carry'} a value before discount.`)
  return notes
}

/** `1 PI returned to you`, `3 PIs returned to you`. */
export function returnedTitle(n: number): string {
  return `${n} ${n === 1 ? 'PI' : 'PIs'} returned to you`
}

export function returnedByText(byName: string | null): string {
  return byName ? `Returned by ${byName}` : 'Returned'
}

/** `Waiting 3 days`, `Waiting 1 day`, `Waiting 5 h`, `Waiting <1 h`. */
export function waitingText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  if (days >= 1) return `Waiting ${plural(days, 'day')}`
  const hours = Math.floor(s / 3600)
  return hours >= 1 ? `Waiting ${hours} h` : 'Waiting <1 h'
}

/** `87.5% verified`; two places at most, never more precision than the database truncated to. */
export function advancePercentText(percent: number): string {
  return `${percent.toFixed(2).replace(/\.?0+$/, '')}% verified`
}

/** `₹1,86,400 short`; `–` when the database did not send the figure (never ₹0). */
export function shortfallText(shortfall: number | null): string {
  return shortfall === null ? '–' : `${formatRupees(shortfall)} short`
}

export function confirmedAgoText(days: number | null): string {
  if (days === null) return 'Confirmation date not recorded'
  if (days < 0) return 'Confirmation date is ahead'
  return days === 0 ? 'Confirmed today' : `Confirmed ${plural(days, 'day')} ago`
}

/** `Ready for 6 days`, `Ready today`, `Ready date not recorded`; nothing when the database did not send it. */
export function readyForText(days: number | null | undefined): string | null {
  if (days === undefined) return null
  if (days === null) return 'Ready date not recorded'
  return days <= 0 ? 'Ready today' : `Ready for ${plural(days, 'day')}`
}

/** The planned dispatch date, and whether it has passed (by India's today, as the database saw it). */
export function plannedDispatchText(iso: string | null, today: string | null): { text: string; tone: 'good' | 'alert' | 'muted' } {
  if (!iso) return { text: 'No dispatch date', tone: 'muted' }
  if (today && iso < today) return { text: `Planned ${formatDate(iso)} · passed`, tone: 'alert' }
  return { text: `Planned ${formatDate(iso)}`, tone: 'good' }
}

/** The advance heading's count: orders known to be below 40% and orders NOT CHECKED are two numbers, never one. */
export function advanceCountText(below: number, unchecked: number): string {
  return unchecked > 0 ? `${below} below 40% · ${unchecked} not checked` : String(below)
}
