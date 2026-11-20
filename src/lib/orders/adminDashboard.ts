// THE ADMIN'S ORDERS DASHBOARD — the parts that are plain rules (owner's layout, 2026-11-02).
//
// Since 2026-11-20 (owner) the page is FOUR CARDS, by who holds the next move: New PIs to approve, Changes on
// running orders, Clarifications from Operations (all on the approver) and Waiting on others, then a revenue strip.
// "Orders to watch" is no longer drawn. This file holds what the screens decide without a browser: which card a
// row sits in, how the decision queues merge into one sorted list, when a wait turns amber or red, what the payment
// chip says, and the monthly average. The pipeline bar and board rules below belong to AdminOrdersBoard, which the
// page no longer draws. The components only draw it.
//
// THE PAYMENT CHIP IS THE DATABASE'S ANSWER. pi_submission_payment_summary() resolves
// `approval_position` in the same order approve_order_submission() does, so the chip says what the
// approval will do — never a percentage worked out here. `attached_percent` includes payments still
// awaiting Finance, so it cannot answer "will approving be refused?". The words never say "ready to
// approve": approval also needs confirmed internal details, which the position does not cover.

import { withReturnTo } from '@/lib/navigation/recordReturn'
import { draftDetailHref } from '@/lib/orders/draftsView'
import {
  FLAGGED_KIND_LABEL, RETURNED_TO_SALES_LABEL, SALES_REPLIED_ROW_LABEL, commentLine, flaggedHref, flaggedLabel, isReturnedToSales, reasonLine,
  roundLabel, type FlaggedPi, type SentBack,
} from '@/lib/orders/flaggedPis'
import {
  SUBMISSION_STATUS_LABEL,
  categoriesLabel,
  queueHref,
  type QueueRow,
} from '@/lib/orders/orderDocumentSubmissions'
import type { RevisionQueueRow } from '@/lib/orders/orderPiVersions'
import {
  PAYMENT_POSITION_TONE,
  asPaymentPosition,
  type PaymentPosition,
  type PaymentPositionTone,
} from '@/lib/orders/paymentGate'
import {
  ALIGNMENT_STATE_LABEL,
  formatInstantIst,
  formatPercent,
  formatRupees,
  plural,
  type AlignmentRow,
  type BoardKey,
  type DashboardOverview,
} from '@/lib/orders/orderDashboardSummary'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { responseSummary, responseTone, type ChangeResponse } from '@/lib/orders/operationsDashboard'

// ── Tones ────────────────────────────────────────────────────────────────────

export type ChipTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'
export type Chip = { tone: ChipTone; label: string; sub: string | null }

/** A wait turns amber after a day and red after three (owner's default, 2026-11-02). */
export const WAIT_WARN_SECONDS = 24 * 3600
export const WAIT_DANGER_SECONDS = 72 * 3600

export function waitTone(seconds: number): 'normal' | 'warn' | 'danger' {
  if (seconds >= WAIT_DANGER_SECONDS) return 'danger'
  return seconds >= WAIT_WARN_SECONDS ? 'warn' : 'normal'
}

// ── The payment chip ─────────────────────────────────────────────────────────

const POSITION_LABEL: Record<PaymentPosition, string> = {
  standard_met:         'Payment met',
  exception_approved:   'Exception approved',
  exception_stale:      'Exception out of date',
  exception_pending:    'Exception to decide',
  exception_rejected:   'Exception refused',
  verification_pending: 'Awaiting Finance',
  payment_required:     'Payment short',
}

const POSITION_TONE: Record<PaymentPositionTone, ChipTone> = { green: 'ok', amber: 'warn', red: 'danger', blue: 'info' }

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** null when the summary could not be read, or names a position this screen does not know: no chip, never a guess. */
export function paymentChip(
  summary: { approval_position?: string | null; verified_percent?: string | number | null } | null,
): Chip | null {
  const position = asPaymentPosition(summary?.approval_position)
  if (!summary || !position) return null
  const verified = toNumber(summary.verified_percent)
  return {
    tone: POSITION_TONE[PAYMENT_POSITION_TONE[position]],
    label: POSITION_LABEL[position],
    sub: verified === null ? null : `Verified ${formatPercent(verified)}`,
  }
}

// ── One list of decisions ────────────────────────────────────────────────────

export type DecisionKind =
  | 'pi_review' | 'pi_revision' | 'documents' | 'pi_flagged' | 'change_request'
  | 'operations_answer' | 'awaiting_review'

/**
 * THE FOUR CARDS (owner, 2026-11-20). A row sits in exactly one card: the one for who holds the next move
 * RIGHT NOW. When the holder changes (Sales replies, the approver forwards it on), the row changes card by itself.
 */
export type CardKey = 'new_pis' | 'changes' | 'from_ops' | 'waiting'
export type RowTeam = 'sales' | 'operations' | 'nobody'
/** The person a row names (who sent it, or who holds it), with the word for how they relate to it. */
export type RowWho = { name: string | null; team: RowTeam; caption: string }

export type DecisionRow = {
  key: string
  kind: DecisionKind
  card: CardKey
  who: RowWho
  /** The short word for what happens when the row is opened: Review, Decide, Forward, Respond, Open. */
  next: string
  /** The number the owner reads first: `PID-00001` for a PI Draft, `#531` for an Order. */
  order: string
  /** `Round 2`, said only from the second flag on; null otherwise. */
  round: string | null
  /** The small tag above the client when the list mixes kinds. */
  kindLabel: string
  href: string
  client: string
  ref: string
  by: string | null
  sinceIso: string | null
  /** Filled by sortDecisionRows. */
  waitSeconds: number
  value: number | null
  chip: Chip | null
}

export type ReviewSource = {
  id: string
  client_name: string | null
  bill_to_name: string | null
  draft_reference: string | null
  subtotal_after_discount: unknown
  submitted_by: string | null
  submitted_at: string | null
}

export function reviewRow(r: ReviewSource, byName: string | null, chip: Chip | null): DecisionRow {
  return {
    key: `pi-${r.id}`, kind: 'pi_review', kindLabel: 'PI review',
    href: withReturnTo(draftDetailHref(r.id), '/orders'),
    client: r.client_name || r.bill_to_name || 'Unnamed client',
    ref: r.draft_reference ?? 'PI draft',
    by: byName, sinceIso: r.submitted_at, waitSeconds: 0,
    value: toNumber(r.subtotal_after_discount),
    chip,
    card: 'new_pis', who: { name: byName, team: 'sales', caption: 'Sales' }, next: 'Review',
    order: r.draft_reference ?? 'PI draft', round: null,
  }
}

export type RevisionSource = RevisionQueueRow & { client: string; reason: string | null }

export function revisionRow(r: RevisionSource, byName: string | null): DecisionRow {
  return {
    key: `rev-${r.id}`, kind: 'pi_revision', kindLabel: 'PI revision',
    href: withReturnTo(`/orders/${r.orderId}`, '/orders'),
    client: r.client,
    ref: `Order ${r.orderNumber} · PI V${r.versionNumber}`,
    by: byName, sinceIso: r.uploadedAt, waitSeconds: 0, value: null,
    chip: { tone: 'info', label: `Revised PI · V${r.versionNumber}`, sub: r.reason ? `“${r.reason}”` : 'Awaiting your decision' },
    card: 'changes', who: { name: byName, team: 'sales', caption: 'Asked' }, next: 'Review',
    order: `#${r.orderNumber}`, round: null,
  }
}

/**
 * A PI Operations flagged ("cannot accept") that THIS reader must answer (my_flagged_pis, 20270611000000).
 * The row opens the Order, where Respond and resubmit is; Operations' reason is the sub-line.
 */
export function flaggedRow(r: FlaggedPi, sent?: SentBack, salesperson?: string | null): DecisionRow {
  // With Sales: still listed, but it no longer asks the approver for a decision. With the review chain
  // (20270718000000) the row says who holds it; the round shows from the second flag on, so a loop is seen.
  const returned = isReturnedToSales(r, sent)
  const round = roundLabel(r.round)
  return {
    key: `flag-${r.handoffId}`, kind: 'pi_flagged', kindLabel: FLAGGED_KIND_LABEL,
    href: withReturnTo(flaggedHref(r.orderId), '/orders'),
    client: r.clientName || 'Client not recorded',
    ref: `Order ${r.orderNumber} · PI V${r.versionNumber}${round ? ` · ${round}` : ''}`,
    by: r.byName, sinceIso: r.since, waitSeconds: 0, value: null,
    chip: returned
      ? { tone: 'info', label: RETURNED_TO_SALES_LABEL, sub: sent ? `${sent.by ?? 'You'}: “${commentLine(sent.text)}”` : `“${reasonLine(r.reason)}”` }
      : r.reply
        ? { tone: 'warn', label: SALES_REPLIED_ROW_LABEL, sub: `${r.replyByName ?? 'Sales'}: “${commentLine(r.reply)}”` }
        : { tone: 'danger', label: flaggedLabel(r), sub: `“${reasonLine(r.reason)}”` },
    // With Sales: it waits on them. Sales replied: it waits on the approver again, as a change to look at.
    // Otherwise Operations is asking the approver. The Order's salesperson stands in for "Sales": the database
    // records the holder as a team, not a person.
    order: `#${r.orderNumber}`, round: roundLabel(r.round),
    ...(returned
      ? { card: 'waiting' as const, who: { name: salesperson ?? null, team: 'sales' as const, caption: 'Sales' }, next: 'Open' }
      : r.reply
        ? { card: 'changes' as const, who: { name: r.replyByName, team: 'sales' as const, caption: 'Replied' }, next: 'Forward' }
        : { card: 'from_ops' as const, who: { name: r.byName, team: 'operations' as const, caption: 'Operations' }, next: 'Respond' }),
  }
}

/** What the list says when the change-request read failed: said, never read as "nothing is waiting". */
export const CHANGES_LOAD_FAILED = 'Change requests could not be loaded. Everything else on this list is shown.'

/**
 * A pending amendment or cancellation raised against a Confirmed Order (order_change_requests,
 * 20260816000000). Only an acting administrator is asked to decide one, so the list reads it for
 * nobody else (the table's own policy also returns a requester's own rows, which must never be
 * offered back to them as a decision). The row opens the Order, whose Change Requests card holds the
 * Review dialog.
 */
export type ChangeRequestSource = {
  id: string
  order_id: string
  order_number_snapshot: string
  request_type: 'edit' | 'cancel'
  proposed_total_value: unknown
  created_at: string
  order: { client_name: string | null } | null
}

export function changeRequestRow(r: ChangeRequestSource, byName: string | null): DecisionRow {
  const cancel = r.request_type === 'cancel'
  return {
    key: `chg-${r.id}`, kind: 'change_request', kindLabel: cancel ? 'Cancellation request' : 'Change request',
    href: withReturnTo(`/orders/${r.order_id}`, '/orders'),
    // The Order's live client name; the snapshot number stands in only when the join is unavailable.
    client: r.order?.client_name || 'Client not recorded',
    ref: `Order ${r.order_number_snapshot}`,
    by: byName, sinceIso: r.created_at, waitSeconds: 0,
    // Null for a cancellation, and for an edit that proposes no new total: a dash, never a ₹0 request.
    value: cancel ? null : toNumber(r.proposed_total_value),
    chip: { tone: 'info', label: cancel ? 'Cancel this Order' : 'Amend this Order', sub: 'Awaiting your decision' },
    card: 'changes', who: { name: byName, team: 'sales', caption: 'Asked' }, next: 'Decide',
    order: `#${displayOrderNumber(r.order_number_snapshot) || r.order_number_snapshot}`, round: null,
  }
}

export type DocumentSource = QueueRow & { client: string }

export function documentRow(r: DocumentSource, byName: string | null): DecisionRow {
  const s = r.submission
  return {
    key: `doc-${s.id}`, kind: 'documents', kindLabel: categoriesLabel(s),
    href: queueHref(s.order_id ?? ''),
    client: r.client,
    ref: `Order ${r.orderNumber}`,
    by: byName, sinceIso: s.submitted_at, waitSeconds: 0, value: null,
    chip: {
      tone: 'info', label: categoriesLabel(s),
      sub: `${plural(s.file_count, 'file')} · ${s.status === 'pending_admin' ? 'Awaiting your decision'
        : s.status === 'awaiting_operations' ? 'Awaiting your acceptance'
        : SUBMISSION_STATUS_LABEL[s.status]}`,
    },
    card: 'changes', who: { name: byName, team: 'sales', caption: 'Sales' }, next: 'Review',
    order: `#${r.orderNumber}`, round: null,
  }
}

// ── Rows the page already holds: Operations' answers and the orders waiting on Operations ──

/**
 * Operations' answers stay in the read for 45 days and have no "done" state, so only the ones that still ask
 * something of the approver are rows: the answered version is still the one in force, and anything but a clean
 * yes was said (a "cannot do" or a "to discuss"), and it was said recently. A clean yes needs nothing.
 */
export const OPERATIONS_ANSWER_DAYS = 14

export function needsFollowUp(r: ChangeResponse, nowMs: number): boolean {
  if (!r.stillCurrent || r.cannotDo + r.discuss === 0) return false
  const at = Date.parse(r.answeredAt)
  return !Number.isNaN(at) && nowMs - at <= OPERATIONS_ANSWER_DAYS * 86400 * 1000
}

export function operationsAnswerRow(r: ChangeResponse): DecisionRow {
  const tone = responseTone(r)
  return {
    key: `ans-${r.handoffId}`, kind: 'operations_answer', kindLabel: 'Operations answered',
    href: withReturnTo(`/orders/${r.orderId}`, '/orders'),
    client: r.clientName || 'Client not recorded',
    ref: `Order ${displayOrderNumber(r.displayNumber) || '—'} · PI V${r.versionNumber}`,
    by: r.answeredByName, sinceIso: r.answeredAt, waitSeconds: 0, value: null,
    chip: { tone: tone === 'danger' ? 'danger' : 'warn', label: `Answer on PI V${r.versionNumber}`, sub: responseSummary(r) },
    card: 'from_ops', who: { name: r.answeredByName, team: 'operations', caption: 'Operations' }, next: 'Open',
    order: `#${displayOrderNumber(r.displayNumber) || '—'}`, round: null,
  }
}

/**
 * An order waiting on the Operations reviewer (the database's own alignment list, which the page already read):
 * a first review, or a PI the approver forwarded back to them. With nobody assigned it waits on an administrator,
 * so it says so instead of naming a person.
 */
export function awaitingReviewRow(a: AlignmentRow, reviewerName: string | null): DecisionRow | null {
  if (a.state !== 'awaiting_reviewer' && a.state !== 'awaiting_unassigned') return null
  const unassigned = a.state === 'awaiting_unassigned'
  return {
    key: `wait-${a.orderId}`, kind: 'awaiting_review', kindLabel: 'With Operations',
    href: withReturnTo(`/orders/${a.orderId}`, '/orders'),
    client: a.clientName || 'Client not recorded',
    ref: `Order ${displayOrderNumber(a.displayNumber) || '—'}`,
    by: unassigned ? null : reviewerName, sinceIso: a.since, waitSeconds: 0, value: null,
    chip: { tone: unassigned ? 'warn' : 'info', label: ALIGNMENT_STATE_LABEL[a.state], sub: null },
    card: 'waiting',
    who: unassigned ? { name: null, team: 'nobody', caption: 'No reviewer' } : { name: reviewerName, team: 'operations', caption: 'Operations' },
    next: 'Open',
    order: `#${displayOrderNumber(a.displayNumber) || '—'}`, round: null,
  }
}

// ── The four cards ───────────────────────────────────────────────────────────

export type CardSide = 'you' | 'others'
export type CardDef = { key: CardKey; title: string; bandNote: string; side: CardSide }

export const CARD_DEFS: readonly CardDef[] = [
  { key: 'new_pis',  title: 'New PIs to approve',              bandNote: 'Sent by Sales', side: 'you' },
  { key: 'changes',  title: 'Changes on running orders',       bandNote: 'Sales asked, or replied to you', side: 'you' },
  { key: 'from_ops', title: 'Clarifications from Operations',  bandNote: 'Operations needs your answer', side: 'you' },
  { key: 'waiting',  title: 'Waiting on others',               bandNote: 'Passed on by you', side: 'others' },
]

/** Rows "Waiting on others" shows before "Show all". */
export const CARD_VISIBLE_ROWS = 5

/** Sorted rows (longest waiting first) split into the four groups, each keeping that order. */
export function splitCards(rows: readonly DecisionRow[]): Record<CardKey, DecisionRow[]> {
  const cards: Record<CardKey, DecisionRow[]> = { new_pis: [], changes: [], from_ops: [], waiting: [] }
  for (const r of rows) cards[r.card].push(r)
  return cards
}

/** The longest wait in a card, in seconds; 0 for an empty card. Rows are expected sorted, but this does not rely on it. */
export const oldestWait = (rows: readonly DecisionRow[]): number => rows.reduce((m, r) => Math.max(m, r.waitSeconds), 0)

export type PersonTally = { key: string; name: string | null; team: RowTeam; count: number; oldestSeconds: number }

/** One person (or "nobody") as a card's filter knows them. */
export const personKey = (w: RowWho): string => `${w.team}:${w.name ?? ''}`

/** Who holds the rows, the longest-waiting person first: the answer to "who is not taking action". */
export function peopleOf(rows: readonly DecisionRow[]): PersonTally[] {
  const by = new Map<string, PersonTally>()
  for (const r of rows) {
    const key = personKey(r.who)
    const t = by.get(key) ?? { key, name: r.who.name, team: r.who.team, count: 0, oldestSeconds: 0 }
    t.count += 1
    t.oldestSeconds = Math.max(t.oldestSeconds, r.waitSeconds)
    by.set(key, t)
  }
  return [...by.values()].sort((a, b) => b.oldestSeconds - a.oldestSeconds)
}

/** `Mohit Sharma` → `Mohit`. */
export const firstName = (name: string | null): string => (name ?? '').trim().split(/\s+/)[0] ?? ''

/** `Mohit Sharma` → `MS`; a single name gives its first two letters. */
export function initialsOf(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '–'
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const secondsSince = (iso: string | null, nowMs: number): number => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor((nowMs - ms) / 1000))
}

/** Longest waiting first; equal waits keep the order they arrived in. */
export function sortDecisionRows(rows: readonly DecisionRow[], nowMs: number): DecisionRow[] {
  return rows.map(r => ({ ...r, waitSeconds: secondsSince(r.sinceIso, nowMs) })).sort((a, b) => b.waitSeconds - a.waitSeconds)
}

/** `31 Oct`: the IST day an instant fell on, without the year or the time. */
export function sinceLabel(iso: string | null): string {
  if (!iso) return '—'
  return formatInstantIst(iso).split(',')[0].replace(/ \d{4}$/, '')
}

// ── Revenue ──────────────────────────────────────────────────────────────────

/** `₹22.6 L`, `₹1.36 Cr`; whole rupees below a lakh. */
export function formatCompactRupees(n: number): string {
  const trim = (x: number, d: number) => x.toFixed(d).replace(/\.0+$/, '')
  if (n >= 1e7) return `₹${trim(n / 1e7, 2)} Cr`
  if (n >= 1e5) return `₹${trim(n / 1e5, 1)} L`
  return formatRupees(Math.round(n))
}

/** The six completed months averaged. null when nothing was confirmed, so no line is drawn. */
export function monthlyAverageNote(lastSixMonthsAmount: number): string | null {
  return lastSixMonthsAmount > 0 ? `≈ ${formatCompactRupees(lastSixMonthsAmount / 6)} a month` : null
}

// ── The pipeline bar ─────────────────────────────────────────────────────────

export type Pipeline = { running: number; ready: number; readyValue: number; notAligned: number; readyPct: number; notAlignedPct: number }

export function pipelineOf(overview: DashboardOverview, notAlignedCount: number): Pipeline {
  const running = overview.running.orders
  const ready = overview.aligned.orders
  const readyPct = running > 0 ? Math.min(100, (ready / running) * 100) : 0
  const notAlignedPct = running > 0 ? Math.min(100 - readyPct, (notAlignedCount / running) * 100) : 0
  return { running, ready, readyValue: overview.aligned.value, notAligned: notAlignedCount, readyPct, notAlignedPct }
}

// ── The board ────────────────────────────────────────────────────────────────

/** Five lists to chase; "ready for production" lives in the pipeline bar, not a tab. */
export const ADMIN_BOARD_ORDER: readonly BoardKey[] = ['delayed', 'due_soon', 'payments', 'fabric', 'not_aligned']

/** Rows a tab shows before "Show all". */
export const ADMIN_BOARD_VISIBLE_ROWS = 5

export const BOARD_TONE: Record<BoardKey, ChipTone> = {
  delayed: 'danger', due_soon: 'warn', payments: 'warn', fabric: 'warn', not_aligned: 'info', aligned: 'ok',
}
