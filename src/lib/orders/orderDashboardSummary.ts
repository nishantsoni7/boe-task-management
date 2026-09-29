// THE ORDERS DASHBOARD'S ONE READ, AS THE PAGE USES IT (20270221000000).
//
// WHAT THIS MODULE IS FOR
// -----------------------
// public.orders_dashboard_summary() returns everything the dashboard draws in a
// single round trip, computed by the database over the Orders the caller may
// open. This module does three things and no more: it VALIDATES that payload, it
// owns the words, and it formats the figures.
//
// IT COMPUTES NOTHING ABOUT ORDERS. Every rule — which Orders are open, whose
// court an unaligned order is in, what "below 40%" means, the 15-day line, the
// revenue periods, who may open which Order — is the database's, stated once in
// the migration and pinned by supabase/tests/orders_dashboard_assertions.sql.
// Re-deriving any of them here would create a second definition that can drift.
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

export type ItemKind = 'fabric' | 'finish'
export type PendingItem = { kind: ItemKind; status: 'not_approved' | 'partially_approved' }

/** Fabric or finish RECORDED as not fully approved, more than 15 days after confirmation. */
export type FabricFinishRow = DashboardOrderRef & {
  confirmDate: string
  daysSinceConfirmation: number
  pending: PendingItem[]
  /** The other item, when nobody ever recorded a status for it. */
  notRecorded: ItemKind[]
}

/** Nothing ever recorded for the item(s): a historical gap, NOT a confirmed pending. */
export type UnrecordedRow = DashboardOrderRef & {
  confirmDate: string
  daysSinceConfirmation: number
  notRecorded: ItemKind[]
}

export type AlignmentState =
  | 'awaiting_reviewer' | 'awaiting_unassigned' | 'clarification_needed'
  | 'held_advance' | 'accepted_not_aligned' | 'no_handoff'
export type WaitingOn = 'reviewer' | 'administrator' | 'approver' | 'payment' | 'legacy'

export type AlignmentRow = DashboardOrderRef & {
  state: AlignmentState
  waitingOn: WaitingOn
  /** When this state began (ISO timestamp). */
  since: string
  /** Seconds waited as of the read. */
  waitingSeconds: number
  /** Operations' own words, only for clarification_needed. */
  detail: string | null
  advanceBlocks: boolean
}

export type GroupKey = 'not_aligned' | 'advance_below_40' | 'fabric_finish_pending'

export type DashboardGaps = {
  openOrders: number
  advanceValueUnknown: number
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

/**
 * One Factory Focus card. When the reader may NOT open the Order, everything
 * past the number, the salesperson and the month is null — the database sends no
 * client, note, status or id, so there is nothing here to hide.
 */
export type FocusCard = {
  selectionId: string
  displayNumber: string
  selectedMonth: string
  selectedAt: string
  salespersonName: string | null
  canOpen: boolean
  orderId: string | null
  clientName: string | null
  status: string | null
  note: string | null
}

export type RemovedNotice = {
  displayNumber: string
  selectedMonth: string
  removedAt: string
  removalReason: string
}

export type DashboardFocus = {
  active: FocusCard[]
  /** Removals of the reader's own Orders in the last 30 days, with the reason. */
  removedForYou: RemovedNotice[]
  monthStart: string
  /** Only the owner is told how many of the month's selections are used. */
  monthUsed: number | null
  monthLimit: number
  canManage: boolean
}

export type DashboardSummary = {
  today: string
  /** The database's clock at the read, for elapsed times. */
  now: string
  viewer: { seesAllOrders: boolean; canViewRevenue: boolean; canManageFocus: boolean }
  /** The configured operations reviewer, or null when nobody is assigned. */
  reviewer: { userId: string | null; name: string | null } | null
  notAligned: AlignmentRow[]
  advance: AdvanceRow[]
  fabricFinish: FabricFinishRow[]
  fabricUnrecorded: UnrecordedRow[]
  gaps: DashboardGaps
  /** Null when the caller does not see every Order. */
  revenue: DashboardRevenue | null
  focus: DashboardFocus
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
const instant = (v: unknown, what: string): string => {
  const s = str(v, what)
  if (Number.isNaN(Date.parse(s))) throw new Bad(what)
  return s
}
const kinds = (v: unknown, what: string): ItemKind[] =>
  arr(v ?? [], what).map(k => {
    if (k !== 'fabric' && k !== 'finish') throw new Bad(what)
    return k
  })

const ref = (o: Obj): DashboardOrderRef => ({
  orderId: str(o.order_id, 'order_id'),
  displayNumber: str(o.display_number, 'display_number'),
  clientName: typeof o.client_name === 'string' ? o.client_name : '',
  status: str(o.status, 'status'),
})

const STATES: readonly AlignmentState[] = [
  'awaiting_reviewer', 'awaiting_unassigned', 'clarification_needed',
  'held_advance', 'accepted_not_aligned', 'no_handoff',
]
const WAITING: readonly WaitingOn[] = ['reviewer', 'administrator', 'approver', 'payment', 'legacy']

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
    const focusRaw = obj(root.factory_focus, 'factory_focus')

    const reviewerRaw = root.alignment_reviewer
    const reviewer = reviewerRaw === null || reviewerRaw === undefined ? null : (() => {
      const r = obj(reviewerRaw, 'reviewer')
      return { userId: optStr(r.user_id), name: optStr(r.name) }
    })()

    const summary: DashboardSummary = {
      today: date(root.today, 'today'),
      now: instant(root.now, 'now'),
      viewer: {
        seesAllOrders: bool(viewer.sees_all_orders, 'viewer'),
        canViewRevenue: bool(viewer.can_view_revenue, 'viewer'),
        canManageFocus: bool(viewer.can_manage_focus, 'viewer'),
      },
      reviewer,
      notAligned: arr(groups.not_aligned, 'alignment group').map(x => {
        const o = obj(x, 'alignment row')
        const state = o.state
        const waitingOn = o.waiting_on
        if (typeof state !== 'string' || !STATES.includes(state as AlignmentState)) throw new Bad('alignment state')
        if (typeof waitingOn !== 'string' || !WAITING.includes(waitingOn as WaitingOn)) throw new Bad('waiting on')
        return {
          ...ref(o), state: state as AlignmentState, waitingOn: waitingOn as WaitingOn,
          since: instant(o.since, 'since'), waitingSeconds: num(o.waiting_seconds, 'waiting_seconds'),
          detail: optStr(o.detail), advanceBlocks: o.advance_blocks === true,
        }
      }),
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
      fabricFinish: arr(groups.fabric_finish_pending, 'fabric group').map(x => {
        const o = obj(x, 'fabric row')
        const pending = arr(o.pending, 'pending').map(p => {
          const po = obj(p, 'pending item')
          if (po.kind !== 'fabric' && po.kind !== 'finish') throw new Bad('pending kind')
          if (po.status !== 'not_approved' && po.status !== 'partially_approved') throw new Bad('pending status')
          return { kind: po.kind, status: po.status } as PendingItem
        })
        if (pending.length === 0) throw new Bad('a fabric row with nothing pending')
        return {
          ...ref(o), confirmDate: date(o.confirm_date, 'confirm_date'),
          daysSinceConfirmation: num(o.days_since_confirmation, 'days_since_confirmation'),
          pending, notRecorded: kinds(o.not_recorded, 'not_recorded'),
        }
      }),
      fabricUnrecorded: arr(groups.fabric_finish_unrecorded, 'unrecorded group').map(x => {
        const o = obj(x, 'unrecorded row')
        const notRecorded = kinds(o.not_recorded, 'not_recorded')
        if (notRecorded.length === 0) throw new Bad('an unrecorded row with nothing unrecorded')
        return {
          ...ref(o), confirmDate: date(o.confirm_date, 'confirm_date'),
          daysSinceConfirmation: num(o.days_since_confirmation, 'days_since_confirmation'), notRecorded,
        }
      }),
      gaps: {
        openOrders: num(gaps.open_orders, 'open_orders'),
        advanceValueUnknown: num(gaps.advance_value_unknown, 'advance_value_unknown'),
        noConfirmDate: num(gaps.no_confirm_date, 'no_confirm_date'),
      },
      revenue: null,
      focus: {
        active: arr(focusRaw.active, 'focus active').map(x => {
          const o = obj(x, 'focus card')
          const canOpen = bool(o.can_open, 'can_open')
          const card: FocusCard = {
            selectionId: str(o.selection_id, 'selection_id'),
            displayNumber: str(o.display_number, 'display_number'),
            selectedMonth: date(o.selected_month, 'selected_month'),
            selectedAt: instant(o.selected_at, 'selected_at'),
            salespersonName: optStr(o.salesperson_name),
            canOpen,
            orderId: optStr(o.order_id),
            clientName: optStr(o.client_name),
            status: optStr(o.status),
            note: optStr(o.note),
          }
          // A card for an Order the reader cannot open must carry nothing more.
          // If the database ever sent more, refuse to draw it rather than trust the page to hide it.
          if (!canOpen && (card.orderId || card.clientName || card.status || card.note)) throw new Bad('a card leaks detail')
          if (canOpen && !card.orderId) throw new Bad('an openable card with no order')
          return card
        }),
        removedForYou: arr(focusRaw.removed_for_you ?? [], 'removed_for_you').map(x => {
          const o = obj(x, 'removal notice')
          return {
            displayNumber: str(o.display_number, 'display_number'),
            selectedMonth: date(o.selected_month, 'selected_month'),
            removedAt: instant(o.removed_at, 'removed_at'),
            removalReason: str(o.removal_reason, 'removal_reason'),
          }
        }),
        monthStart: date(focusRaw.month_start, 'month_start'),
        monthUsed: focusRaw.month_used === null || focusRaw.month_used === undefined ? null : num(focusRaw.month_used, 'month_used'),
        monthLimit: num(focusRaw.month_limit, 'month_limit'),
        canManage: bool(focusRaw.can_manage, 'can_manage'),
      },
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
    // A viewer told they may not see revenue must not be handed it, and one told they may must be
    // handed some: a mismatch is an error, not a shrug.
    if (summary.viewer.canViewRevenue !== (summary.revenue !== null)) throw new Bad('revenue does not match the viewer')
    if (summary.viewer.canManageFocus !== summary.focus.canManage) throw new Bad('focus controls do not match the viewer')
    if (!summary.focus.canManage && summary.focus.monthUsed !== null) throw new Bad('slot counts sent to a reader who cannot manage')

    return { ok: true, summary }
  } catch (e) {
    return { ok: false, message: e instanceof Bad ? `The dashboard answer was not in the expected shape (${e.message}).` : 'The dashboard answer could not be read.' }
  }
}

// ── Words ─────────────────────────────────────────────────────────────────────

export const DASHBOARD_ERROR_HEADING = 'The dashboard could not be loaded'
export const DASHBOARD_ERROR_BODY =
  'None of the counts, Factory Focus or revenue could be read, so an empty screen here does not mean nothing needs attention. Try again; if it keeps failing, tell an administrator.'
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
  label: string
  /** One line under the heading, saying what qualifies. */
  rule: string
  emptyText: string
}

export const GROUP_COPY: Record<GroupKey, GroupCopy> = {
  not_aligned: {
    key: 'not_aligned', label: 'Not aligned for manufacturing',
    rule: 'Open orders waiting for manufacturing alignment. Each row says whose court it is in, and since when.',
    emptyText: 'Every open order is aligned for manufacturing.',
  },
  advance_below_40: {
    key: 'advance_below_40', label: 'Advance below 40%',
    rule: 'Verified payments are under 40% of the current approved order value. An approved exception does not remove an order from this list.',
    emptyText: 'No open order has a verified advance below 40%.',
  },
  fabric_finish_pending: {
    key: 'fabric_finish_pending', label: 'Fabric or finish pending',
    rule: 'Fabric or finish recorded as not fully approved more than 15 days after the client confirmed the order. Each item is judged on its own.',
    emptyText: 'No open order has fabric or finish pending beyond 15 days.',
  },
}

export const ALIGNMENT_STATE_LABEL: Record<AlignmentState, string> = {
  awaiting_reviewer: 'Awaiting operations review',
  awaiting_unassigned: 'No operations reviewer assigned',
  clarification_needed: 'Flagged by operations — needs clarification',
  held_advance: 'Held — verified advance fell below 40%',
  accepted_not_aligned: 'Accepted, but not aligned',
  no_handoff: 'Older order — no operations handoff recorded',
}

/** WHOSE COURT, in words. The reviewer is named when there is one. */
export function waitingOnLabel(on: WaitingOn, reviewerName: string | null): string {
  switch (on) {
    case 'reviewer': return `Waiting on ${reviewerName ?? 'the operations reviewer'}`
    case 'administrator': return 'Waiting on an administrator to assign a reviewer'
    case 'approver': return 'Waiting on the approver to answer'
    case 'payment': return 'Waiting on the verified advance'
    case 'legacy': return 'Waiting for alignment (no handoff on record)'
  }
}

export const ADVANCE_BLOCKS_NOTE = 'Advance below 40% also blocks alignment'
export const EXCEPTION_APPROVED_NOTE = 'Exception approved'

export const ITEM_LABEL: Record<ItemKind, string> = { fabric: 'Fabric', finish: 'Finish' }
export const PENDING_STATUS_LABEL: Record<PendingItem['status'], string> = {
  not_approved: 'not approved',
  partially_approved: 'partially approved',
}

export const UNRECORDED_TITLE = 'Fabric or finish status never recorded'
export const UNRECORDED_RULE =
  'More than 15 days after confirmation, but nobody has recorded a status for the item — typically an order from before this was tracked. This is a gap in the record, not a confirmed pending.'

// ── What could not be assessed — said, never counted as fine ─────────────────

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Lines under a group that say how many open orders could not be checked. */
export function groupGapNote(key: GroupKey, gaps: DashboardGaps): string | null {
  const n = (count: number, what: string) =>
    count > 0 ? `${count} open ${count === 1 ? 'order' : 'orders'} ${what}` : null
  switch (key) {
    case 'advance_below_40':
      return n(gaps.advanceValueUnknown, 'with no order value could not be checked.')
    case 'fabric_finish_pending':
      return n(gaps.noConfirmDate, 'with no confirmation date could not be checked.')
    default:
      return null
  }
}

// ── Row copy ──────────────────────────────────────────────────────────────────

export function advanceLine(r: AdvanceRow): string {
  return `${formatPercent(r.percent)} verified · ${formatRupees(r.shortfall)} short of 40%`
}

const items = (ks: ItemKind[]) => ks.map(k => ITEM_LABEL[k]).join(' and ')

export function fabricFinishLine(r: FabricFinishRow): string {
  const pending = r.pending.map(p => `${ITEM_LABEL[p.kind]} ${PENDING_STATUS_LABEL[p.status]}`).join(' · ')
  const gap = r.notRecorded.length > 0 ? ` · ${items(r.notRecorded)} status not recorded` : ''
  return `${pending}${gap} · ${plural(r.daysSinceConfirmation, 'day')} since confirmation`
}

export function unrecordedLine(r: UnrecordedRow): string {
  return `${items(r.notRecorded)} status not recorded · ${plural(r.daysSinceConfirmation, 'day')} since confirmation`
}

export function alignmentLine(r: AlignmentRow): string {
  const base = ALIGNMENT_STATE_LABEL[r.state]
  return r.detail ? `${base}: ${r.detail}` : base
}

export function alignmentSummary(rows: readonly AlignmentRow[], reviewerName: string | null): string {
  const onReviewer = rows.filter(r => r.waitingOn === 'reviewer').length
  const others = rows.length - onReviewer
  const who = reviewerName ?? 'the operations reviewer'
  return `${onReviewer} waiting on ${who} · ${others} waiting on others`
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
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** `2026-09-29` → `29 Sep 2026`. Pure string work, so no time zone can move the day. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

/** `2026-09-01` → `September 2026`. */
export function formatMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}`
}

/**
 * An instant as Indian time, `26 Sep 2026, 14:32 IST`. IST is a fixed UTC+05:30, so
 * offset arithmetic is exact and no runtime time-zone database (or device setting)
 * can change what the reader is told.
 */
export function formatInstantIst(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms + 5.5 * 3600 * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} IST`
}

/** `3 d 4 h`, `5 h 12 m`, `12 m`: elapsed time, coarse where it can be. */
export function formatWaiting(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return `${days} d ${hours} h`
  if (hours > 0) return `${hours} h ${minutes} m`
  return `${minutes} m`
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
    { key: 'six', label: 'Last 6 completed months', period: r.lastSixMonths },
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

// ── Factory Focus words ──────────────────────────────────────────────────────

export const FOCUS_TITLE = 'Factory Focus'
export const FOCUS_INTRO =
  'Highest factory priority. Each order is recognised for its salesperson.'
export const FOCUS_ADD_LABEL = 'Select an order'
export const FOCUS_NOTE_MAX = 200
export const FOCUS_REMOVAL_REASON_MAX = 300
export const FOCUS_OUT_OF_SCOPE_NOTE = 'Details are shown only to people who may open this order.'

export function focusSlotsLabel(f: DashboardFocus): string {
  if (f.monthUsed === null) return ''
  const used = `${f.monthUsed} of ${f.monthLimit} selections used in ${formatMonth(f.monthStart)}`
  return f.monthUsed >= f.monthLimit ? `${used} — none left` : used
}

export function focusSelectedLine(c: FocusCard): string {
  const who = c.salespersonName ? `Salesperson: ${c.salespersonName}` : 'Salesperson not recorded'
  return `${who} · Selected ${formatMonth(c.selectedMonth)}`
}

export function removedNoticeLine(n: RemovedNotice): string {
  return `Factory Focus was removed from order ${n.displayNumber} (selected ${formatMonth(n.selectedMonth)}, removed ${formatDate(n.removedAt)}): ${n.removalReason}`
}

const FOCUS_FAILURES: readonly { marker: string; message: string }[] = [
  { marker: 'FACTORY_FOCUS_MONTH_LIMIT', message: 'Two orders have already been selected this month. Removing one does not free a selection; a new month does.' },
  { marker: 'FACTORY_FOCUS_ALREADY_ACTIVE', message: 'That order is already in Factory Focus.' },
  { marker: 'FACTORY_FOCUS_ORDER_CLOSED', message: 'That order is dispatched or cancelled, so it cannot be selected.' },
  { marker: 'FACTORY_FOCUS_NO_SALESPERSON', message: 'That order has no salesperson recorded, so there is nobody to recognise.' },
  { marker: 'FACTORY_FOCUS_NOT_OWNER', message: 'Only the owner account can select or remove Factory Focus.' },
  { marker: 'FACTORY_FOCUS_NOT_ACTIVE', message: 'That order is no longer in Factory Focus.' },
  { marker: 'FACTORY_FOCUS_REASON_REQUIRED', message: 'Say why Factory Focus is being removed.' },
  { marker: 'FACTORY_FOCUS_REASON_TOO_LONG', message: `The reason may be at most ${FOCUS_REMOVAL_REASON_MAX} characters.` },
  { marker: 'FACTORY_FOCUS_NOTE_TOO_LONG', message: `The note may be at most ${FOCUS_NOTE_MAX} characters.` },
  { marker: 'ORDER_NOT_FOUND', message: 'That order no longer exists.' },
  { marker: 'Authentication required', message: 'Your session has expired. Sign in again and try once more.' },
]
export const FOCUS_FALLBACK = 'Factory Focus could not be changed just now. Try again in a moment.'

export function describeFocusFailure(error: unknown): string {
  const raw = typeof error === 'string' ? error : String((error as { message?: unknown } | null)?.message ?? '')
  return FOCUS_FAILURES.find(f => raw.includes(f.marker))?.message ?? FOCUS_FALLBACK
}
