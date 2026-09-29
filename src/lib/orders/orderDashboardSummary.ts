// THE ORDERS DASHBOARD'S ONE READ, AS THE PAGE USES IT (20270221000000).
//
// WHAT THIS MODULE IS FOR
// -----------------------
// public.orders_dashboard_summary() returns everything the dashboard draws in a
// single round trip, computed by the database over the Orders the caller may
// open. This module does three things and no more: it VALIDATES that payload, it
// owns the words, and it formats the figures.
//
// IT COMPUTES NOTHING ABOUT ORDERS. Every rule — which Orders are open, what
// "below 40%" means, the 15-day line, the revenue periods — is the database's,
// stated once in the migration and pinned by supabase/tests/
// orders_dashboard_assertions.sql. Re-deriving any of them here would create a
// second definition that can drift.
//
// AND A PAYLOAD IT CANNOT READ IS AN ERROR, NEVER AN EMPTY DASHBOARD. A parse
// that quietly turned a malformed answer into zero counts would tell somebody
// nothing needs their attention because a query misbehaved.

// ── The payload ───────────────────────────────────────────────────────────────

export type DashboardOrderRef = {
  orderId: string
  displayNumber: string
  clientName: string
  status: string
}

export type AdvanceRow = DashboardOrderRef & {
  orderValue: number
  verified: number
  /** Truncated (never rounded up) percent of the current Order value, verified. */
  percent: number
  shortfall: number
  exceptionApproved: boolean
  held: boolean
}

export type OverdueRow = DashboardOrderRef & { dueDate: string; daysOverdue: number }

export type PendingItem = { kind: 'fabric' | 'finish'; status: 'not_approved' | 'partially_approved' }
export type FabricFinishRow = DashboardOrderRef & {
  confirmDate: string
  daysSinceConfirmation: number
  pending: PendingItem[]
}

export type AlignmentReason =
  | 'clarification_needed' | 'awaiting_unassigned' | 'awaiting_review'
  | 'held_advance' | 'accepted_not_aligned' | 'no_handoff'
export type AlignmentRow = DashboardOrderRef & {
  reason: AlignmentReason
  /** Operations' own words, only for clarification_needed. */
  detail: string | null
  advanceBlocks: boolean
}

export type GroupKey = 'not_aligned' | 'advance_below_40' | 'overdue' | 'fabric_finish_pending'

export type DashboardGaps = {
  openOrders: number
  advanceValueUnknown: number
  noDueDate: number
  noConfirmDate: number
}

export type RevenuePeriod = { from: string; to: string; amount: number; orders: number }
export type DashboardRevenue = {
  currentMonth: RevenuePeriod
  lastSixMonths: RevenuePeriod
  currentYear: RevenuePeriod
  gaps: {
    noConfirmDate: number
    futureConfirmDate: number
    noProductValueInYear: number
    beforeDiscountInYear: number
  }
}

export type PanicRow = {
  designationId: string
  orderId: string
  displayNumber: string
  clientName: string
  dueDate: string | null
  reason: string | null
  designatedAt: string
  designatedByName: string | null
}
export type DashboardPanic = {
  active: PanicRow[]
  monthStart: string
  monthUsed: number
  monthLimit: number
  canManage: boolean
}

export type DashboardSummary = {
  today: string
  viewer: { seesAllOrders: boolean; canViewRevenue: boolean; canViewPanic: boolean; canManagePanic: boolean }
  advance: AdvanceRow[]
  overdue: OverdueRow[]
  fabricFinish: FabricFinishRow[]
  notAligned: AlignmentRow[]
  gaps: DashboardGaps
  /** Null when the caller does not see every Order. */
  revenue: DashboardRevenue | null
  /** Null when the caller may not see PANIC MODE — the key carries no data at all. */
  panic: DashboardPanic | null
}

export type ParsedSummary =
  | { ok: true; summary: DashboardSummary }
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
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new Bad(what)
  return n
}
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw new Bad(what)
  return v
}
const date = (v: unknown, what: string): string => {
  const s = str(v, what)
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Bad(what)
  return s.slice(0, 10)
}

const ref = (o: Obj): DashboardOrderRef => ({
  orderId: str(o.order_id, 'order_id'),
  displayNumber: str(o.display_number, 'display_number'),
  clientName: typeof o.client_name === 'string' ? o.client_name : '',
  status: str(o.status, 'status'),
})

const REASONS: readonly AlignmentReason[] = [
  'clarification_needed', 'awaiting_unassigned', 'awaiting_review',
  'held_advance', 'accepted_not_aligned', 'no_handoff',
]

const period = (v: unknown, what: string): RevenuePeriod => {
  const o = obj(v, what)
  return { from: date(o.from, what), to: date(o.to, what), amount: num(o.amount, what), orders: num(o.orders, what) }
}

/** Turns the RPC's answer into the page's model, or says why it cannot. */
export function parseDashboardSummary(raw: unknown): ParsedSummary {
  try {
    const root = obj(raw, 'the summary')
    const groups = obj(root.groups, 'groups')
    const viewer = obj(root.viewer, 'viewer')
    const gaps = obj(root.gaps, 'gaps')

    const summary: DashboardSummary = {
      today: date(root.today, 'today'),
      viewer: {
        seesAllOrders: bool(viewer.sees_all_orders, 'viewer'),
        canViewRevenue: bool(viewer.can_view_revenue, 'viewer'),
        canViewPanic: bool(viewer.can_view_panic, 'viewer'),
        canManagePanic: bool(viewer.can_manage_panic, 'viewer'),
      },
      advance: arr(groups.advance_below_40, 'advance group').map(x => {
        const o = obj(x, 'advance row')
        return {
          ...ref(o),
          orderValue: num(o.order_value, 'order_value'),
          verified: num(o.verified, 'verified'),
          percent: num(o.percent, 'percent'),
          shortfall: num(o.shortfall, 'shortfall'),
          exceptionApproved: o.exception_approved === true,
          held: o.held === true,
        }
      }),
      overdue: arr(groups.overdue, 'overdue group').map(x => {
        const o = obj(x, 'overdue row')
        return { ...ref(o), dueDate: date(o.due_date, 'due_date'), daysOverdue: num(o.days_overdue, 'days_overdue') }
      }),
      fabricFinish: arr(groups.fabric_finish_pending, 'fabric group').map(x => {
        const o = obj(x, 'fabric row')
        const pending = arr(o.pending, 'pending').map(p => {
          const po = obj(p, 'pending item')
          const kind = po.kind
          const status = po.status
          if (kind !== 'fabric' && kind !== 'finish') throw new Bad('pending kind')
          if (status !== 'not_approved' && status !== 'partially_approved') throw new Bad('pending status')
          return { kind, status } as PendingItem
        })
        if (pending.length === 0) throw new Bad('a fabric row with nothing pending')
        return {
          ...ref(o), confirmDate: date(o.confirm_date, 'confirm_date'),
          daysSinceConfirmation: num(o.days_since_confirmation, 'days_since_confirmation'), pending,
        }
      }),
      notAligned: arr(groups.not_aligned, 'alignment group').map(x => {
        const o = obj(x, 'alignment row')
        const reason = o.reason
        if (typeof reason !== 'string' || !REASONS.includes(reason as AlignmentReason)) throw new Bad('alignment reason')
        return { ...ref(o), reason: reason as AlignmentReason, detail: optStr(o.detail), advanceBlocks: o.advance_blocks === true }
      }),
      gaps: {
        openOrders: num(gaps.open_orders, 'open_orders'),
        advanceValueUnknown: num(gaps.advance_value_unknown, 'advance_value_unknown'),
        noDueDate: num(gaps.no_due_date, 'no_due_date'),
        noConfirmDate: num(gaps.no_confirm_date, 'no_confirm_date'),
      },
      revenue: null,
      panic: null,
    }

    if (root.revenue !== null && root.revenue !== undefined) {
      const r = obj(root.revenue, 'revenue')
      const g = obj(r.gaps, 'revenue gaps')
      summary.revenue = {
        currentMonth: period(r.current_month, 'current month'),
        lastSixMonths: period(r.last_six_months, 'last six months'),
        currentYear: period(r.current_year, 'current year'),
        gaps: {
          noConfirmDate: num(g.no_confirm_date, 'gap'),
          futureConfirmDate: num(g.future_confirm_date, 'gap'),
          noProductValueInYear: num(g.no_product_value_in_year, 'gap'),
          beforeDiscountInYear: num(g.before_discount_in_year, 'gap'),
        },
      }
    }
    // A viewer told they may not see revenue/panic must not be handed data for it,
    // and one told they may must be handed some: a mismatch is an error, not a shrug.
    if (summary.viewer.canViewRevenue !== (summary.revenue !== null)) throw new Bad('revenue does not match the viewer')

    if (root.panic !== null && root.panic !== undefined) {
      const p = obj(root.panic, 'panic')
      summary.panic = {
        active: arr(p.active, 'panic active').map(x => {
          const o = obj(x, 'panic row')
          return {
            designationId: str(o.designation_id, 'designation_id'),
            orderId: str(o.order_id, 'order_id'),
            displayNumber: str(o.display_number, 'display_number'),
            clientName: typeof o.client_name === 'string' ? o.client_name : '',
            dueDate: o.due_date === null || o.due_date === undefined ? null : date(o.due_date, 'due_date'),
            reason: optStr(o.reason),
            designatedAt: str(o.designated_at, 'designated_at'),
            designatedByName: optStr(o.designated_by_name),
          }
        }),
        monthStart: date(p.month_start, 'month_start'),
        monthUsed: num(p.month_used, 'month_used'),
        monthLimit: num(p.month_limit, 'month_limit'),
        canManage: bool(p.can_manage, 'can_manage'),
      }
    }
    if (summary.viewer.canViewPanic !== (summary.panic !== null)) throw new Bad('panic does not match the viewer')

    return { ok: true, summary }
  } catch (e) {
    return { ok: false, message: e instanceof Bad ? `The dashboard answer was not in the expected shape (${e.message}).` : 'The dashboard answer could not be read.' }
  }
}

// ── Words ─────────────────────────────────────────────────────────────────────

export const DASHBOARD_ERROR_HEADING = 'The dashboard could not be loaded'
export const DASHBOARD_ERROR_BODY =
  'None of the counts, PANIC MODE or revenue could be read, so an empty screen here does not mean nothing needs attention. Try again; if it keeps failing, tell an administrator.'
export const DASHBOARD_RETRY_LABEL = 'Try again'
export const DASHBOARD_LOADING_LABEL = 'Loading the dashboard'
export const SCOPED_VIEW_NOTE = 'Counts cover the orders you can open.'
export const COUNT_MEANS_ORDERS_NOTE = 'An order can appear under more than one heading.'

/** The one line above the lists: scope (when narrower than the company) and overlap. */
export function listsNote(seesAllOrders: boolean): string {
  return seesAllOrders ? COUNT_MEANS_ORDERS_NOTE : `${SCOPED_VIEW_NOTE} ${COUNT_MEANS_ORDERS_NOTE}`
}

export type GroupCopy = {
  key: GroupKey
  /** The tile and the heading. */
  label: string
  /** One line under the heading, saying what qualifies. */
  rule: string
  emptyText: string
  prominent: boolean
}

/** In reading order; alignment first and the only prominent one. */
export const GROUP_COPY: readonly GroupCopy[] = [
  {
    key: 'not_aligned', label: 'Not aligned for manufacturing', prominent: true,
    rule: 'Open orders whose PI version in force operations has not accepted for production.',
    emptyText: 'Every open order is aligned for manufacturing.',
  },
  {
    key: 'advance_below_40', label: 'Advance below 40%', prominent: false,
    rule: 'Verified payments are under 40% of the current approved order value.',
    emptyText: 'No open order has a verified advance below 40%.',
  },
  {
    key: 'overdue', label: 'Past due date', prominent: false,
    rule: 'Open orders whose due date has passed.',
    emptyText: 'No open order is past its due date.',
  },
  {
    key: 'fabric_finish_pending', label: 'Fabric or finish pending', prominent: false,
    rule: 'Not fully approved more than 15 days after the order was confirmed.',
    emptyText: 'No open order has fabric or finish pending beyond 15 days.',
  },
]

export const ALIGNMENT_REASON_LABEL: Record<AlignmentReason, string> = {
  clarification_needed: 'Operations needs clarification',
  awaiting_unassigned: 'Awaiting operations review — no reviewer assigned',
  awaiting_review: 'Awaiting operations review',
  held_advance: 'Held: verified advance fell below 40%',
  accepted_not_aligned: 'Accepted, but not aligned',
  no_handoff: 'No operations handoff recorded',
}

export const ADVANCE_BLOCKS_NOTE = 'Advance below 40% also blocks alignment'
export const EXCEPTION_APPROVED_NOTE = 'Reduced advance approved'

export const PENDING_KIND_LABEL: Record<PendingItem['kind'], string> = { fabric: 'Fabric', finish: 'Finish' }
export const PENDING_STATUS_LABEL: Record<PendingItem['status'], string> = {
  not_approved: 'not approved',
  partially_approved: 'partially approved',
}

// ── What could not be assessed — said, never counted as fine ─────────────────

/** Lines under a group that say how many open orders could not be checked. */
export function groupGapNote(key: GroupKey, gaps: DashboardGaps): string | null {
  const n = (count: number, what: string) =>
    count > 0 ? `${count} open ${count === 1 ? 'order' : 'orders'} ${what}` : null
  switch (key) {
    case 'advance_below_40':
      return n(gaps.advanceValueUnknown, 'with no order value could not be checked.')
    case 'overdue':
      return n(gaps.noDueDate, 'with no due date could not be checked.')
    case 'fabric_finish_pending':
      return n(gaps.noConfirmDate, 'with no confirmation date could not be checked.')
    default:
      return null
  }
}

export function groupRows(summary: DashboardSummary, key: GroupKey): readonly DashboardOrderRef[] {
  switch (key) {
    case 'not_aligned': return summary.notAligned
    case 'advance_below_40': return summary.advance
    case 'overdue': return summary.overdue
    case 'fabric_finish_pending': return summary.fabricFinish
  }
}

// ── Row copy ──────────────────────────────────────────────────────────────────

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function advanceLine(r: AdvanceRow): string {
  return `${formatPercent(r.percent)} verified · ${formatRupees(r.shortfall)} short of 40%`
}

export function overdueLine(r: OverdueRow): string {
  return `${plural(r.daysOverdue, 'day')} overdue · due ${formatDate(r.dueDate)}`
}

export function fabricFinishLine(r: FabricFinishRow): string {
  const items = r.pending.map(p => `${PENDING_KIND_LABEL[p.kind]} ${PENDING_STATUS_LABEL[p.status]}`).join(' · ')
  return `${items} · ${plural(r.daysSinceConfirmation, 'day')} since confirmation`
}

export function alignmentLine(r: AlignmentRow): string {
  const base = ALIGNMENT_REASON_LABEL[r.reason]
  return r.detail ? `${base}: ${r.detail}` : base
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** ₹ with Indian grouping; paise only when there are some. */
export function formatRupees(n: number): string {
  const whole = Number.isInteger(n)
  return '₹' + n.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })
}

export function formatPercent(n: number): string {
  return `${n.toFixed(2).replace(/\.?0+$/, '')}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-09-29` → `29 Sep 2026`. Pure string work, so no time zone can move the day. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

/** `1 Sep – 29 Sep 2026`; the year is said once when both ends share it. */
export function formatRange(from: string, to: string): string {
  if (from.slice(0, 4) === to.slice(0, 4)) {
    const f = formatDate(from)
    return `${f.slice(0, f.length - 5)} – ${formatDate(to)}`
  }
  return `${formatDate(from)} – ${formatDate(to)}`
}

// ── Revenue words ─────────────────────────────────────────────────────────────

export const REVENUE_TITLE = 'Revenue'
export const REVENUE_BASIS = 'Product value, excluding GST and other charges'
export const REVENUE_METHOD_NOTE =
  'By the date the order was confirmed. Each order is counted once, at its current approved product value; cancelled orders are left out.'

export type RevenueTile = { key: string; label: string; period: RevenuePeriod }

export function revenueTiles(r: DashboardRevenue): RevenueTile[] {
  return [
    { key: 'month', label: 'Current month', period: r.currentMonth },
    { key: 'six', label: 'Last 6 months', period: r.lastSixMonths },
    { key: 'year', label: 'Current year', period: r.currentYear },
  ]
}

/** Every reason a figure may be short of the truth, as sentences. Empty when none. */
export function revenueGapNotes(r: DashboardRevenue): string[] {
  const notes: string[] = []
  const g = r.gaps
  if (g.noConfirmDate > 0) notes.push(`${plural(g.noConfirmDate, 'order')} with no confirmation date ${g.noConfirmDate === 1 ? 'is' : 'are'} not in any figure.`)
  if (g.futureConfirmDate > 0) notes.push(`${plural(g.futureConfirmDate, 'order')} confirmed after today ${g.futureConfirmDate === 1 ? 'is' : 'are'} not in any figure yet.`)
  if (g.noProductValueInYear > 0) notes.push(`${plural(g.noProductValueInYear, 'order')} this year with no product value on record ${g.noProductValueInYear === 1 ? 'is' : 'are'} not counted.`)
  if (g.beforeDiscountInYear > 0) notes.push(`${plural(g.beforeDiscountInYear, 'order')} this year ${g.beforeDiscountInYear === 1 ? 'carries' : 'carry'} a value before discount.`)
  return notes
}

// ── PANIC MODE words ─────────────────────────────────────────────────────────

export const PANIC_TITLE = 'PANIC MODE'
export const PANIC_ADD_LABEL = 'Add an order'
export const PANIC_REASON_MAX = 200

export function panicSlotsLabel(p: DashboardPanic): string {
  const used = `${p.monthUsed} of ${p.monthLimit} designations used this month`
  return p.monthUsed >= p.monthLimit ? `${used} — none left` : used
}

const PANIC_FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'PANIC_MODE_MONTH_LIMIT', message: 'Two orders have already been designated this month. A removal does not free a slot; a new month does.' },
  { marker: 'PANIC_MODE_ALREADY_ACTIVE', message: 'That order is already in PANIC MODE.' },
  { marker: 'PANIC_MODE_ORDER_CLOSED', message: 'That order is dispatched or cancelled, so it cannot be put in PANIC MODE.' },
  { marker: 'PANIC_MODE_NOT_OWNER', message: 'Only the owner account can add or remove PANIC MODE.' },
  { marker: 'PANIC_MODE_NOT_ACTIVE', message: 'That order is no longer in PANIC MODE.' },
  { marker: 'PANIC_MODE_REASON_TOO_LONG', message: `The reason may be at most ${PANIC_REASON_MAX} characters.` },
  { marker: 'ORDER_NOT_FOUND', message: 'That order no longer exists.' },
  { marker: 'Authentication required', message: 'Your session has expired. Sign in again and try once more.' },
]
export const PANIC_FALLBACK = 'PANIC MODE could not be changed just now. Try again in a moment.'

export function describePanicFailure(error: unknown): string {
  const raw = typeof error === 'string' ? error : String((error as { message?: unknown } | null)?.message ?? '')
  return PANIC_FAILURES.find(f => raw.includes(f.marker))?.message ?? PANIC_FALLBACK
}
