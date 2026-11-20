// THE OPERATIONS TEAM'S ORDERS DASHBOARD — which row sits where (owner-approved preview, 2026-11-20).
//
// Same sheet and same flat "Watching" list as the approver's dashboard (lib/orders/adminDashboard.ts), drawn from
// what the Orders page already holds for the Operations team:
//
//   New orders to accept       the database's alignment list: an order waiting on the reviewer for a first look
//   Changes on running orders  revised PIs the approver approved (answered line by line), and orders that came back
//                              to Operations after it flagged them ("New update", lib/orders/backWithOperations.ts)
//   Watching                   PIs Operations flagged that wait on the approver or on Sales
//
// AN ORDER IS ONE ROW. A pending change wins over a reply that came back, which wins over a new order. Orders that wait
// on payment, older orders and accepted-but-not-aligned orders are not on this page (owner, 2026-11-20): they stay on the
// Confirmed Orders list. Nothing is computed here about who may answer: the database decides that.
//
// The approver's name is the person who approved the PI version in force (order_operations_handoffs.approved_by): it needs no
// extra read, only a column in the read the page already makes. Who holds a flagged PI is the stored holder (chain_holder).

import { withReturnTo } from '@/lib/navigation/recordReturn'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { sortDecisionRows, type DecisionRow } from '@/lib/orders/adminDashboard'
import { BACK_WITH_OPERATIONS_NOTE } from '@/lib/orders/backWithOperations'
import { reasonLine } from '@/lib/orders/flaggedPis'
import { changeText, lateLabel, type OperationsRead, type PendingChange } from '@/lib/orders/operationsDashboard'
import { formatDate, plural, type AlignmentRow } from '@/lib/orders/orderDashboardSummary'
import type { ChainHolder, DashboardHandoff } from '@/lib/orders/operationsHandoff'

export type OpsGroupKey = 'new_orders' | 'changes'

export const OPS_GROUPS: readonly { key: OpsGroupKey; title: string; note: string }[] = [
  { key: 'new_orders', title: 'New orders to accept', note: 'Waiting for your first look' },
  { key: 'changes', title: 'Changes on running orders', note: 'Approved changes, and replies to your flags' },
]

export const OPS_WATCHING_HINT = 'Held by the approver or Sales. Nothing for you to do; chase if it runs long.'

/** What is said when the approver's name is not on record. */
export const APPROVER_FALLBACK = 'Approver'

export type OpsHandoffInfo = { holder: ChainHolder | null; approver: string | null }

/** The live handoffs the page read, by Order: who holds the version, and who approved it. */
export function handoffInfoByOrder(rows: readonly DashboardHandoff[]): Map<string, OpsHandoffInfo> {
  return new Map(rows.map(h => [h.order_id, { holder: h.chain_holder, approver: h.approver?.full_name?.trim() || null }] as const))
}

const orderLabel = (display: string): string => `#${displayOrderNumber(display) || '—'}`
const orderHref = (orderId: string): string => withReturnTo(`/orders/${orderId}`, '/orders')

export function newOrderRow(a: AlignmentRow, details: OperationsRead['orderDetails'], today: string): DecisionRow {
  const d = details[a.orderId]
  const late = lateLabel(d?.dueDate ?? null, today)
  const due = d?.dueDate ? `Due ${formatDate(d.dueDate)}${late ? ` · ${late}` : ''}` : null
  return {
    key: `new-${a.orderId}`, kind: 'awaiting_review', kindLabel: 'New order', href: orderHref(a.orderId),
    client: a.clientName || 'Client not recorded', ref: `Order ${displayOrderNumber(a.displayNumber) || '—'}`,
    by: d?.salesperson ?? null, sinceIso: a.since, waitSeconds: 0, value: null,
    chip: { tone: 'info', label: 'Awaiting your review', sub: due },
    card: 'new_orders', who: { name: d?.salesperson ?? null, team: 'sales', caption: 'Sales' }, next: 'Review',
    order: orderLabel(a.displayNumber), round: null,
  }
}

/** An order that came back after Operations flagged it (the approver passed it on, with Sales' reply when there was one). */
export function replyBackRow(a: AlignmentRow, info: OpsHandoffInfo | undefined): DecisionRow {
  const approver = info?.approver ?? APPROVER_FALLBACK
  return {
    key: `back-${a.orderId}`, kind: 'awaiting_review', kindLabel: BACK_WITH_OPERATIONS_NOTE, href: orderHref(a.orderId),
    client: a.clientName || 'Client not recorded', ref: `Order ${displayOrderNumber(a.displayNumber) || '—'}`,
    by: approver, sinceIso: a.since, waitSeconds: 0, value: null,
    chip: { tone: 'info', label: BACK_WITH_OPERATIONS_NOTE, sub: 'Back after your flag' },
    card: 'changes', who: { name: approver, team: 'approver', caption: 'Approver' }, next: 'Decide',
    order: orderLabel(a.displayNumber), round: null,
  }
}

/** `2 lines changed · Quantity 40 → 60, and 1 more`: the first difference, so the row says what changed. */
export function changeSummary(p: Pick<PendingChange, 'lines' | 'available'>): string | null {
  if (!p.available || p.lines.length === 0) return null
  const all = p.lines.flatMap(l => l.changes)
  const first = all[0]
  const head = `${plural(p.lines.length, 'line')} changed`
  if (!first) return head
  const t = changeText(first)
  return `${head} · ${first.label} ${t.from} → ${t.to}${all.length > 1 ? `, and ${all.length - 1} more` : ''}`
}

/** A revised PI the approver approved: answered line by line, on the row. */
export function changeRow(p: PendingChange): DecisionRow {
  const approver = p.approvedByName ?? APPROVER_FALLBACK
  const n = p.lines.length
  return {
    key: `chg-${p.handoffId}`, kind: 'pi_revision', kindLabel: 'Revised PI', href: orderHref(p.orderId),
    client: p.clientName || 'Client not recorded', ref: `Order ${displayOrderNumber(p.displayNumber) || '—'} · PI V${p.versionNumber}`,
    by: approver, sinceIso: p.approvedAt, waitSeconds: 0, value: null,
    chip: { tone: 'info', label: `Revised PI V${p.versionNumber}`, sub: changeSummary(p) ?? p.revisionReason },
    card: 'changes', who: { name: approver, team: 'approver', caption: 'Approver' },
    next: n > 0 ? `Answer ${plural(n, 'line')}` : 'Open',
    order: orderLabel(p.displayNumber), round: null,
  }
}

/** A PI Operations flagged: with Sales when the approver sent it to them, otherwise with the approver. Operations' own words are the ask. */
export function watchingRow(a: AlignmentRow, details: OperationsRead['orderDetails'], info: OpsHandoffInfo | undefined): DecisionRow {
  const withSales = info?.holder === 'sales'
  const salesperson = details[a.orderId]?.salesperson ?? null
  const approver = info?.approver ?? APPROVER_FALLBACK
  return {
    key: `wait-${a.orderId}`, kind: 'pi_flagged', kindLabel: 'Flagged by you', href: orderHref(a.orderId),
    client: a.clientName || 'Client not recorded', ref: `Order ${displayOrderNumber(a.displayNumber) || '—'}`,
    by: withSales ? salesperson : approver, sinceIso: a.since, waitSeconds: 0, value: null,
    chip: { tone: 'neutral', label: 'Flagged', sub: `“${reasonLine(a.detail ?? '')}”` },
    card: 'waiting',
    who: withSales ? { name: salesperson, team: 'sales', caption: 'Sales' } : { name: approver, team: 'approver', caption: 'Approver' },
    next: 'Open', order: orderLabel(a.displayNumber), round: null,
  }
}

export type OperationsRows = {
  groups: Record<OpsGroupKey, DecisionRow[]>
  /** Null while it is not known who holds the flagged PIs (the read has not landed, or failed): never "nothing is held". */
  watching: DecisionRow[] | null
  /** The pending change behind each change row, so the row can open its answer form. */
  changeItems: Map<string, PendingChange>
}

export function operationsRows(
  input: {
    alignment: readonly AlignmentRow[]
    pending: readonly PendingChange[]
    details: OperationsRead['orderDetails']
    today: string
    backWithOps: ReadonlySet<string>
    handoffs: ReadonlyMap<string, OpsHandoffInfo> | null
  },
  nowMs: number,
): OperationsRows {
  const changeItems = new Map<string, PendingChange>()
  const changes: DecisionRow[] = []
  const pendingOrders = new Set<string>()
  for (const p of input.pending) {
    const row = changeRow(p)
    changeItems.set(row.key, p)
    changes.push(row)
    pendingOrders.add(p.orderId)
  }
  const newOrders: DecisionRow[] = []
  const watching: DecisionRow[] = []
  for (const a of input.alignment) {
    if (pendingOrders.has(a.orderId)) continue
    if (a.state === 'awaiting_reviewer') {
      if (input.backWithOps.has(a.orderId)) changes.push(replyBackRow(a, input.handoffs?.get(a.orderId)))
      else newOrders.push(newOrderRow(a, input.details, input.today))
    } else if (a.state === 'clarification_needed') {
      watching.push(watchingRow(a, input.details, input.handoffs?.get(a.orderId)))
    }
  }
  return {
    groups: { new_orders: sortDecisionRows(newOrders, nowMs), changes: sortDecisionRows(changes, nowMs) },
    watching: input.handoffs === null ? null : sortDecisionRows(watching, nowMs),
    changeItems,
  }
}
