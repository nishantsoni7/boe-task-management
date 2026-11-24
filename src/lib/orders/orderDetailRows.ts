// THE CONFIRMED ORDER PAGE'S QUIET PARTS, IN WORDS (Nitish / Operations, 24 Nov 2026).
//
// The top of the Order page used to carry everything: client, dates, approvals,
// payment. Operations reads the products and the PI all day and the rest rarely,
// so those parts now sit in folded rows BELOW the products, each with one line
// that says where it stands, and a small "Order bar" above the PI carries the
// four facts that decide whether production can start.
//
// THIS FILE ONLY WORDS THINGS. Every figure and status is handed in already
// computed by the page's own builders (buildOrderFinancePosition, the advance
// readiness, the approval standing, the dates timeline) and is never recomputed
// here: the bar and the row summaries are second VIEWS of the same values, and
// the detail still lives once, in its row. Nothing here reads, writes or
// authorizes, so it is safe to unit test without React.
//
// QUIET WHEN FINE, LOUD WHEN NOT. A row carries a badge only when something
// needs somebody, and opens by itself only when it is holding up the viewer's
// decision (the advance is short while Accept for production is offered).

import { dueCountdownLabel } from '@/lib/orders/orderDatesTimeline'
import { APPROVAL_STATUS_LABEL, type ApprovalKindStanding } from '@/lib/orders/orderApprovals'
import { percentText, type AdvanceReadiness } from '@/lib/orders/advanceReadiness'

export type DetailRowKey = 'client' | 'dates' | 'pay' | 'pend' | 'terms' | 'totals' | 'act'

/** The order the rows are drawn in. */
export const DETAIL_ROW_ORDER: readonly DetailRowKey[] = ['client', 'dates', 'pay', 'pend', 'terms', 'totals', 'act']

export const DETAIL_ROW_TITLE: Record<DetailRowKey, string> = {
  client: 'Client and sale',
  dates: 'Dates',
  pay: 'Payment',
  pend: 'Pendencies',
  terms: 'Internal details and terms',
  totals: 'Commercial breakdown',
  act: 'Activity',
}

export const DETAILS_HEADING = 'Order details'
export const DETAILS_HEADING_NOTE = 'Folded away until you want them. A row opens by itself only when it is holding up your decision.'

export type ChipTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red'

export type DetailBadge = {
  text: string
  tone: ChipTone
  /** What a screen reader says: a bare number is never announced on its own. */
  label: string
}

export type DetailRowView = {
  key: DetailRowKey
  title: string
  /** One line, drawn beside the title while the row is folded. */
  summary: string
  badge: DetailBadge | null
  /** Tints the row's icon: amber for something open, red for something blocking. */
  flag: 'amber' | 'red' | null
  /** Open on first draw: only a row that is holding up this viewer's decision. */
  openByDefault: boolean
}

// ── The Order bar's advance gate and the due date ────────────────────────────

export type BarGate = {
  /** What is drawn in the cell. */
  value: string
  chip: { text: string; tone: ChipTone } | null
  /** One sentence for a screen reader and the tooltip. */
  label: string
}

export type OrderBarGates = {
  due: { date: string | null; countdown: string | null; late: boolean }
  advance: BarGate
}

const DASH = '—'

const allFullyApproved = (kinds: readonly ApprovalKindStanding[]): boolean =>
  kinds.length > 0 && kinds.every(k => k.status === 'fully_approved')

/**
 * The advance cell. The percentage and the threshold are the database's own
 * (order_advance_readiness), measured on the Total before GST exactly as the
 * Payment section says; the 40 is never a literal here.
 */
export function advanceGate(advance: AdvanceReadiness | null): BarGate {
  if (!advance) return { value: DASH, chip: null, label: 'Not read yet' }
  const threshold = percentText(advance.threshold_percent)
  if (advance.value_known === false) {
    return {
      value: DASH,
      chip: { text: 'Cannot measure', tone: 'amber' },
      label: 'The advance cannot be measured: no Total before GST is on record',
    }
  }
  const value = advance.percent === null || advance.percent === undefined ? DASH : percentText(advance.percent)
  const base = 'of the Total before GST, verified by Finance'
  if (!advance.below) {
    return { value, chip: { text: 'Met', tone: 'green' }, label: `${value} ${base}; the ${threshold} requirement is met` }
  }
  if (advance.ready && advance.exception) {
    return {
      value,
      chip: { text: `Approved below ${threshold}`, tone: 'amber' },
      label: `${value} ${base}; production is approved below ${threshold}`,
    }
  }
  if (advance.hold) {
    return { value, chip: { text: 'On hold', tone: 'red' }, label: `${value} ${base}; production is on hold, below ${threshold}` }
  }
  return { value, chip: { text: `Below ${threshold}`, tone: 'red' }, label: `${value} ${base}; below the ${threshold} requirement` }
}

export function orderBarGates(input: {
  advance: AdvanceReadiness | null
  dueDate: string | null
  daysToDue: number | null
}): OrderBarGates {
  return {
    due: {
      date: input.dueDate,
      countdown: input.daysToDue === null ? null : dueCountdownLabel(input.daysToDue),
      late: input.daysToDue !== null && input.daysToDue < 0,
    },
    advance: advanceGate(input.advance),
  }
}

// ── The folded rows ───────────────────────────────────────────────────────────

type Fact = { key: string; label: string; value: string; missing?: boolean; muted?: boolean }

const factValue = (rows: readonly Fact[], key: string): string | null => {
  const r = rows.find(x => x.key === key)
  return r && !r.missing && r.value.trim() !== '' ? r.value : null
}

const join = (parts: readonly (string | null | undefined | false)[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' · ')

export type DetailRowsInput = {
  /** The summary panel's own rows (client name, location; lead source, salesperson). */
  clientRows: readonly Fact[]
  salesRows: readonly Fact[]
  dates: { confirm: string | null; approved: string | null; due: string | null; daysToDue: number | null }
  payment: {
    loaded: boolean
    /** buildOrderFinancePosition's figures, already formatted by the page. */
    verifiedPercent: string | null
    orderValue: string | null
    awaiting: string | null
    awaitingCount: number
  }
  advance: AdvanceReadiness | null
  approvals: readonly ApprovalKindStanding[]
  pendingFromClient: number | null
  internalRows: readonly Fact[]
  termsCount: number
  /** The commercial breakdown's lines: the last one with role 'final' is the order total. */
  commercial: readonly { label: string; value: string; role: string }[]
  activity: { count: number; latestLabel: string | null; latestWhen: string | null; newCount: number }
  /** Accept for production is offered to this viewer AND the advance is holding it up. */
  acceptBlockedByAdvance: boolean
}

export function detailRows(input: DetailRowsInput): DetailRowView[] {
  const { advance, approvals } = input

  // Client and sale
  const clientSummary = join([
    factValue(input.clientRows, 'client'),
    factValue(input.clientRows, 'location'),
    factValue(input.salesRows, 'salesperson') && `Sales: ${factValue(input.salesRows, 'salesperson')}`,
    factValue(input.salesRows, 'lead_source') && `Lead: ${factValue(input.salesRows, 'lead_source')}`,
  ]) || 'No client details are recorded'

  // Dates
  const d = input.dates
  const datesSummary = join([
    d.confirm && `Confirmed ${d.confirm}`,
    d.approved && `PI approved ${d.approved}`,
    d.due && `Due ${d.due}${d.daysToDue === null ? '' : ` (${dueCountdownLabel(d.daysToDue).toLowerCase()})`}`,
  ]) || 'No dates are recorded'
  const overdue = d.daysToDue !== null && d.daysToDue < 0

  // Payment
  const p = input.payment
  const gate = advanceGate(advance)
  let paySummary: string
  if (!p.loaded) {
    paySummary = 'Reading payments…'
  } else {
    const verified = p.verifiedPercent && p.orderValue
      ? `${percentText(p.verifiedPercent)} verified of the Total before GST`
      : 'Verified payment is shown in the row'
    const advanceClause = !advance || advance.value_known === false
      ? null
      : !advance.below ? 'advance met'
        : advance.ready && advance.exception ? `production approved below ${percentText(advance.threshold_percent)}`
        : `${percentText(advance.threshold_percent)} advance not met`
    paySummary = join([
      verified,
      input.payment.awaitingCount > 0 && p.awaiting ? `${p.awaiting} waiting for Finance` : null,
      advanceClause,
    ])
  }
  const payBlocking = !!advance && advance.below && !advance.ready
  const payBadge: DetailBadge | null = payBlocking
    ? { text: gate.chip?.text ?? 'Below requirement', tone: 'red', label: gate.label }
    : null

  // Pendencies
  const fullyApproved = allFullyApproved(approvals)
  const open = input.pendingFromClient
  const pendBits = approvals.map(k => `${k.label} ${APPROVAL_STATUS_LABEL[k.status]}`)
  const pendSummary = approvals.length === 0
    ? 'Reading approvals…'
    : fullyApproved && open === 0
      ? 'Fabric and Finish are fully approved · nothing pending from the client'
      : join([...pendBits, open === null ? null : open === 0 ? 'nothing pending from the client' : `${open} pending from the client`])
  const pendOpen = approvals.length > 0 && !fullyApproved
  const pendBadge: DetailBadge | null = open !== null && open > 0
    ? { text: String(open), tone: 'amber', label: `${open} item${open === 1 ? '' : 's'} pending from the client` }
    : pendOpen
      ? { text: 'Approvals open', tone: 'amber', label: 'Fabric or Finish is not fully approved' }
      : null

  // Internal details and terms
  const internalBits = input.internalRows
    .filter(r => !r.muted && !r.missing && r.value.trim() !== '')
    .slice(0, 2)
    .map(r => `${r.label}: ${r.value}`)
  const termsBit = input.termsCount > 0 ? `${input.termsCount} general term${input.termsCount === 1 ? '' : 's'}` : null
  const termsSummary = join([...internalBits, termsBit]) || 'Nothing is recorded on the PI'

  // Commercial breakdown
  const finalLine = [...input.commercial].reverse().find(l => l.role === 'final')
  const totalsSummary = finalLine ? `${finalLine.label} ${finalLine.value}` : 'No commercial lines are recorded'

  // Activity
  const a = input.activity
  const actSummary = a.count === 0
    ? 'No activity yet'
    : join([a.latestLabel && `Latest: ${a.latestLabel}`, a.latestWhen])
  const actBadge: DetailBadge | null = a.newCount > 0
    ? { text: `${a.newCount} new`, tone: 'blue', label: `${a.newCount} update${a.newCount === 1 ? '' : 's'} since your last visit` }
    : null

  const rows: Record<DetailRowKey, Omit<DetailRowView, 'key' | 'title'>> = {
    client: { summary: clientSummary, badge: null, flag: null, openByDefault: false },
    dates: {
      summary: datesSummary,
      badge: overdue ? { text: 'Overdue', tone: 'red', label: 'The due date has passed' } : null,
      flag: overdue ? 'red' : null,
      openByDefault: false,
    },
    pay: {
      summary: paySummary,
      badge: payBadge,
      flag: payBlocking ? 'red' : null,
      openByDefault: input.acceptBlockedByAdvance,
    },
    pend: { summary: pendSummary, badge: pendBadge, flag: pendBadge ? 'amber' : null, openByDefault: false },
    terms: { summary: termsSummary, badge: null, flag: null, openByDefault: false },
    totals: { summary: totalsSummary, badge: null, flag: null, openByDefault: false },
    act: { summary: actSummary, badge: actBadge, flag: null, openByDefault: false },
  }
  return DETAIL_ROW_ORDER.map(key => ({ key, title: DETAIL_ROW_TITLE[key], ...rows[key] }))
}
