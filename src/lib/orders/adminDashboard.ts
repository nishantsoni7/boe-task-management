// THE ADMIN'S ORDERS DASHBOARD — the parts that are plain rules (owner's layout, 2026-11-02).
//
// Three zones, in the order a person asks the questions: what needs MY decision, how is revenue,
// which orders are at risk. This file holds what the screens decide without a browser: how the
// three decision queues merge into one list, when a wait turns amber or red, what the payment
// chip says, the monthly average, and the pipeline bar. The components only draw it.
//
// THE PAYMENT CHIP IS THE DATABASE'S ANSWER. pi_submission_payment_summary() resolves
// `approval_position` in the same order approve_order_submission() does, so the chip says what the
// approval will do — never a percentage worked out here. `attached_percent` includes payments still
// awaiting Finance, so it cannot answer "will approving be refused?". The words never say "ready to
// approve": approval also needs confirmed internal details, which the position does not cover.

import { withReturnTo } from '@/lib/navigation/recordReturn'
import { draftDetailHref } from '@/lib/orders/draftsView'
import {
  FLAGGED_KIND_LABEL, RETURNED_TO_SALES_LABEL, commentLine, flaggedHref, flaggedLabel, isReturnedToSales, reasonLine,
  type FlaggedPi, type SentBack,
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
  formatInstantIst,
  formatPercent,
  formatRupees,
  plural,
  type BoardKey,
  type DashboardOverview,
} from '@/lib/orders/orderDashboardSummary'

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

export type DecisionKind = 'pi_review' | 'pi_revision' | 'documents' | 'pi_flagged'

export type DecisionRow = {
  key: string
  kind: DecisionKind
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
  }
}

/**
 * A PI Operations flagged ("cannot accept") that THIS reader must answer (my_flagged_pis, 20270611000000).
 * The row opens the Order, where Respond and resubmit is; Operations' reason is the sub-line.
 */
export function flaggedRow(r: FlaggedPi, sent?: SentBack): DecisionRow {
  // Returned to Sales: still listed, but it no longer asks the approver for a decision.
  const returned = isReturnedToSales(r, sent)
  return {
    key: `flag-${r.handoffId}`, kind: 'pi_flagged', kindLabel: FLAGGED_KIND_LABEL,
    href: withReturnTo(flaggedHref(r.orderId), '/orders'),
    client: r.clientName || 'Client not recorded',
    ref: `Order ${r.orderNumber} · PI V${r.versionNumber}`,
    by: r.byName, sinceIso: r.since, waitSeconds: 0, value: null,
    chip: returned && sent
      ? { tone: 'info', label: RETURNED_TO_SALES_LABEL, sub: `${sent.by ?? 'You'}: “${commentLine(sent.text)}”` }
      : { tone: 'danger', label: flaggedLabel(r), sub: `“${reasonLine(r.reason)}”` },
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
      tone: 'info', label: plural(s.file_count, 'file'),
      sub: s.status === 'pending_admin' ? 'Awaiting your decision'
        : s.status === 'awaiting_operations' ? 'Awaiting your acceptance'
        : SUBMISSION_STATUS_LABEL[s.status],
    },
  }
}

const secondsSince = (iso: string | null, nowMs: number): number => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor((nowMs - ms) / 1000))
}

/** Longest waiting first; equal waits keep the order they arrived in. */
export function sortDecisionRows(rows: readonly DecisionRow[], nowMs: number): DecisionRow[] {
  return rows.map(r => ({ ...r, waitSeconds: secondsSince(r.sinceIso, nowMs) })).sort((a, b) => b.waitSeconds - a.waitSeconds)
}

/** True when the list holds more than one kind, so each row says which. */
export const isMixed = (rows: readonly DecisionRow[]): boolean => new Set(rows.map(r => r.kind)).size > 1

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
