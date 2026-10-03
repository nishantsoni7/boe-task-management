// THE SALESPERSON'S OWN ORDERS DASHBOARD, AS THE PAGE USES IT (20270226000000).
//
// public.salesperson_orders_dashboard() returns the three figures and the four
// complete lists for THE CALLER ONLY, in one round trip. This module VALIDATES
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

export type SpAdvanceRow = {
  orderId: string
  displayNumber: string
  clientName: string
  /** Verified advance as a percent of the current Order value, truncated to 2 places. */
  percent: number
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

export type SpReadyRow = {
  orderId: string
  displayNumber: string
  clientName: string
  /** `YYYY-MM-DD`, or null when no date is planned. */
  plannedDispatchDate: string | null
}

export type SalespersonDashboard = {
  /** `YYYY-MM-01`, the month the revenue card is for. */
  monthFrom: string
  totalOrders: number
  revenue: { amount: number; orders: number; noProductValue: number; beforeDiscount: number }
  pendingTotal: number
  pending: SpPendingRow[]
  advance: SpAdvanceRow[]
  /** Open orders with no usable value: no percentage exists, so they are not listed. */
  advanceUnchecked: number
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

    const rev = obj(root.revenue, 'revenue')
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
    const dashboard: SalespersonDashboard = {
      monthFrom: dateOnly(root.month_from, 'month_from'),
      totalOrders: count(root.total_orders, 'total_orders'),
      revenue: {
        amount: num(rev.amount, 'revenue amount'),
        orders: count(rev.orders, 'revenue orders'),
        noProductValue: count(rev.no_product_value, 'no_product_value'),
        beforeDiscount: count(rev.before_discount, 'before_discount'),
      },
      pendingTotal: count(root.pending_total, 'pending_total'),
      pending,
      advance: arr(root.advance, 'advance').map((x): SpAdvanceRow => {
        const o = obj(x, 'advance row')
        return {
          orderId: str(o.order_id, 'order_id'),
          displayNumber: str(o.display_number, 'display_number'),
          clientName: clientOf(o.client_name),
          percent: num(o.percent, 'percent'),
          exceptionApproved: o.exception_approved === true,
        }
      }),
      advanceUnchecked: count(root.advance_unchecked, 'advance_unchecked'),
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
        }
      }),
    }

    // The card and the panel are one number.
    if (dashboard.pendingTotal !== dashboard.pending.length) throw new Bad('pending total does not match its list')

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

export const SP_CARD_TOTAL = 'Total Orders'
export const SP_CARD_TOTAL_SUB = 'All-time confirmed orders'
export const SP_CARD_REVENUE = 'Current Month Revenue'
export const SP_CARD_PENDING = 'Orders Pending Approval'
export const SP_CARD_PENDING_SUB = 'Submitted, awaiting approval'
export const SP_REVENUE_BASIS = 'Product value after discount, excl. GST'

export const SP_PANEL_PENDING = 'Orders Pending Approval'
export const SP_PANEL_ADVANCE = 'Advance Below 40%'
export const SP_PANEL_FABRIC = 'Fabric / Finish Pending Approval'
export const SP_PANEL_READY = 'Ready for Dispatch'

export const SP_EMPTY = {
  pending: 'No orders are waiting for approval.',
  advance: 'Every active order has at least 40% verified advance.',
  fabric: 'No fabric or finish approvals are pending.',
  ready: 'No orders are ready for dispatch.',
} as const

export const SP_PENDING_STATUS = 'Pending approval'
export const SP_BELOW_40 = 'Below 40%'
export const SP_READY_STATUS = 'Ready for dispatch'
export const SP_OVER_15 = 'Over 15 days'
export const SP_NOT_OPENABLE = 'Only the person who filed this PI, its reviewer or an approver can open it'
export const SP_NOT_OPENABLE_SHORT = 'Opens only for whoever filed it'
export const SP_FABRIC_PENDING_HEADING = 'Pending approval'
export const SP_UNKNOWN_HEADING = 'Approval status unknown'
export const SP_UNKNOWN_RULE = 'No approval record exists for these orders, so they are neither approved nor pending. Nothing is assumed.'
export const SP_FABRIC_NO_KNOWN_PENDING = 'No order has a recorded pending approval.'

/** `2026-10-01` → `October 2026`. */
export const revenueMonthLabel = (monthFrom: string): string => formatMonth(monthFrom)

export const revenueText = (amount: number): string => formatRupees(amount)

export function revenueNotes(r: SalespersonDashboard['revenue']): string[] {
  const notes: string[] = []
  if (r.noProductValue > 0) notes.push(`${plural(r.noProductValue, 'order')} this month with no product value on record ${r.noProductValue === 1 ? 'is' : 'are'} not counted.`)
  if (r.beforeDiscount > 0) notes.push(`${plural(r.beforeDiscount, 'order')} this month ${r.beforeDiscount === 1 ? 'carries' : 'carry'} a value before discount.`)
  return notes
}

/** `Pending 3 days`, `Pending 5 h`, `Pending <1 h`. */
export function pendingWaitText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  if (days >= 1) return `Pending ${plural(days, 'day')}`
  const hours = Math.floor(s / 3600)
  return hours >= 1 ? `Pending ${hours} h` : 'Pending <1 h'
}

/** `Fabric`, `Finish` or `Fabric + Finish`. */
export function pendingKindsText(kinds: readonly SpPendingKind[]): string {
  return kinds.map(k => (k === 'fabric' ? 'Fabric' : 'Finish')).join(' + ')
}

export function sinceConfirmationText(days: number | null): string {
  if (days === null) return 'Confirmation date not recorded'
  if (days < 0) return 'Confirmation date is ahead'
  return days === 0 ? 'Confirmed today' : `${plural(days, 'day')} since confirmation`
}

/** `87.5% verified`; two places at most, never more precision than the database truncated to. */
export function advancePercentText(percent: number): string {
  return `${percent.toFixed(2).replace(/\.?0+$/, '')}% verified`
}

export function dispatchDateText(iso: string | null): string {
  return iso ? `Dispatch ${formatDate(iso)}` : 'No dispatch date'
}

export function advanceUncheckedNote(n: number): string | null {
  return n > 0 ? `${plural(n, 'active order')} with no order value could not be checked.` : null
}

/** `Fabric status unknown`, `Finish status unknown`, `Fabric + Finish status unknown`. */
export function unknownKindsText(kinds: readonly SpPendingKind[]): string {
  return `${pendingKindsText(kinds)} status unknown`
}

/** The fabric/finish heading's count: known pending and unknown are two numbers, never one. */
export function fabricCountText(pending: number, unknown: number): string {
  return unknown > 0 ? `${pending} pending · ${unknown} unknown` : String(pending)
}
