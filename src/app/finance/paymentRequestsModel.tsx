'use client'

// The data model, constants and small helpers of the Payment Requests page, split out of
// page.tsx (which had grown past 3,700 lines). Nothing here changed.

import { formatMoney } from '@/lib/finance/piPaymentView'
import { accentFromBadge, BRAND_TAB_ACCENT, type TabAccent } from '@/components/ui/StatusTabs'
import { Archive, CircleX, Clock, Layers, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import { type FilterTab } from './paymentRequestsQuery'
import { paymentTargetErrorMessage } from './paymentTargets'
import { PAYMENT_DISPLAY_STATE_META, orderNumberDisplay, type PaymentDestination } from '@/lib/finance/paymentDestination'

// ── Types ─────────────────────────────────────────────────────────────────────

// Exported for the table's render test, which needs to build a row.
export type PaymentRequest = {
  id: string
  request_number: string
  /** P-AA-0001 style, database-generated, immutable, unique — THE user-facing
   *  Payment ID. request_number is retained in the database and this type only
   *  because other logic still reads it; it is never the primary label. */
  human_payment_id: string
  /**
   * NULLABLE since 20261013000000 §1. Null means exactly one thing: no customer
   * could be derived, because the payment names no PI Draft and no Order. It is
   * never typed and never invented — render it through customerDisplayName so a
   * blank, a 'null' or an 'undefined' can never reach a screen.
   */
  client_name: string | null
  amount: number
  payment_date: string
  // WHERE the money went. Read as a pair through paymentDestinations.ts — never
  // one column alone, since 'cash' does not say Paytm and 'other' does not say PNB.
  payment_mode: string
  /**
   * NULLABLE since 20260919000000, and null on EVERY payment written through
   * the two redesigned entry forms: the four-account picker is gone and no
   * account is fabricated in its place. A null pair reads as the payment mode.
   */
  received_in: string | null
  // WHO physically handled it, for the two cash destinations (20260716). A
  // separate fact from the destination above: the account says where the money
  // ended up, these say who is accountable for carrying it there.
  collected_by_user_id: string | null
  collected_from_text: string | null
  handed_over_to_user_id: string | null
  handed_over_at: string | null
  collection_handover_note: string | null
  // Resolved in the SAME list query as submitted_by_name (one join each, no
  // per-row lookup), so a read-only view can name the people involved instead
  // of printing the uuids it stores.
  collected_by_name?: string
  handed_over_to_name?: string
  proof_note: string | null
  order_number: string | null
  order_id: string | null
  // Order Request linkage. Since 20260715 a payment may carry this from the
  // moment it is submitted, not only once Finance has approved it.
  order_request_id: string | null
  order_request_number: string | null
  sales_note: string | null
  payment_against: string
  payment_target_type: string
  status: string
  submitted_by: string
  submitted_by_name?: string
  admin_note: string | null
  created_at: string
  updated_at: string
  rejected_at: string | null
  clarification_requested_at: string | null
}

export type AdminAction = 'approve' | 'needs_clarification' | 'reject'

// FilterTab, parseFilterTab, the archive window and the tab predicates all live
// in ./paymentRequestsQuery now — they had to, because the tabs became DATABASE
// filters and the two forms must be one definition. See that module's tests,
// which evaluate both forms against the same rows and require them to agree.

// ── Constants ─────────────────────────────────────────────────────────────────

// The account a payment landed in is resolved by paymentDestinations.ts from the
// stored (payment_mode, received_in) PAIR — the four destinations, the legacy
// fallbacks and the pair mapping all live there now, so the form, this page's
// read-only views and the tests read one definition.
//
// This page used to keep a local received_in → account map alongside it, for the
// review modal's "Received In" row. That row is gone — the destination names the
// account once, with what it means — and with it the last reason for a second
// copy of the mapping here.

// THE BADGE PALETTE IS THE SHARED ONE, and the mapping below exists only for the
// tab accents — a tab is named after a DATABASE status, and every row and modal
// badge is resolved live through paymentDisplayStateMeta(status, destination).
//
// WHAT CHANGED, AND WHY. approved_unlinked used to read "Order No. Pending",
// which a Confirmed-Order payment wore even after Finance had approved it and
// the Order had received its allocation in full — because the status column is
// derived from order_id, which submit_payment_request deliberately leaves NULL.
// The two verified states are now decided by the ALLOCATION LEDGER through
// finance_payment_destinations, so a reversal takes the badge with it and no
// stale linked state can survive.
export const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    PAYMENT_DISPLAY_STATE_META.pending,
  approved_unlinked:   PAYMENT_DISPLAY_STATE_META.received_unallocated,
  approved_linked:     PAYMENT_DISPLAY_STATE_META.received,
  needs_clarification: PAYMENT_DISPLAY_STATE_META.needs_clarification,
  rejected:            PAYMENT_DISPLAY_STATE_META.rejected,
}

// Tab accents come from the STATUS_META row badges above, so a status wears one
// colour in the strip, the row, and the modal. One exception, deliberate:
//   • archive — a derived view, not a DB status, so it has no badge. It uses
//     the neutral palette STATUS_META already falls back to for unknowns.
//
// There is no longer an "Order No. Pending" tab. A confirmed payment is not a
// payment request in any state, so it has no tab here to sit in — it belongs to
// Received Payments from the moment of approval. See the query scope below.
export const ARCHIVE_TAB_ACCENT: TabAccent = {
  color: '#4C5352', tint: '#F1EEE9', badge: '#F1EEE9', badgeActive: '#E4DED7',
}

export const FILTER_TABS: { key: FilterTab; label: string; Icon: LucideIcon; accent: TabAccent }[] = [
  { key: 'pending',       label: 'Pending',             Icon: Clock,                  accent: accentFromBadge(STATUS_META.pending_approval) },
  { key: 'clarification', label: 'Needs Clarification', Icon: MessageCircleQuestion,  accent: accentFromBadge(STATUS_META.needs_clarification) },
  { key: 'rejected',      label: 'Rejected',            Icon: CircleX,                accent: accentFromBadge(STATUS_META.rejected) },
  { key: 'archive',       label: 'Archive',             Icon: Archive,                accent: ARCHIVE_TAB_ACCENT },
  { key: 'all',           label: 'All',                 Icon: Layers,                 accent: BRAND_TAB_ACCENT },
]

export const EMPTY_MESSAGES: Record<FilterTab, string> = {
  pending:       'No pending payment requests.',
  clarification: 'No payments awaiting clarification.',
  rejected:      'No rejected payments.',
  archive:       'No archived rejected requests.',
  all:           'No payment requests here.',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// A custody activity happens at a TIME, not on a day: "collected at 9pm, handed
// over at 10pm" is an ordinary trail, and a date-only formatter would print the
// two as the same moment. Read in the reader's own zone, which is where the
// person entering it was standing.
export function fmtDateTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// ONE MONEY FORMATTER for Order Management and Finance — formatMoney, the same
// one the PI payment card and the Order's payment summary read.
//
// THE DEFECT THIS CLOSES. Three formatters were in use across the two modules
// and each rendered the same amount differently:
//
//   formatINR         maximumFractionDigits: 2 with NO minimum, so ₹1,000 and
//                     ₹1,000.5 and ₹1,000.55 — ragged decimals that do not line
//                     up in a tabular-nums column
//   toLocaleString    default maximumFractionDigits: 3, so a legacy amount with
//                     more precision than paise printed ₹1,000.555
//   formatMoney       always two decimal places
//
// So one Received Payments row could read "₹1,000.5" in its Amount column and
// "₹1,000.50" in the Allocation cell beside it — the same money, on the same
// line, twice. Money on a finance screen is stated to the paise or it is not
// reconcilable against a bank statement.
//
// formatMoney also accepts a STRING, which formatINR cannot: `numeric` crosses
// the wire as a string precisely so it is not rounded by JSON's double, and a
// formatter that only takes a number forces a lossy conversion at the boundary.
export const fmtAmount = formatMoney

// ── The Order Number cell, from the ALLOCATION LEDGER ────────────────────────
//
// THE DEFECT THIS REPLACES. The old helper read order_number, then
// order_request_number, then payment_against — and printed "New Order — no order
// created yet" whenever all three were empty, which is EVERY request the current
// form writes, including one naming a Confirmed Order that Finance has already
// approved and allocated in full. All three columns became provenance at
// 20261012000000; the answer lives in finance_payment_destinations now.
//
// A number appears only when exactly one Confirmed Order is the whole
// destination. A split payment says how many rather than naming one.
export function orderNoCell(destination: PaymentDestination | null | undefined) {
  return orderNumberDisplay(destination)
}

// Maps the approved_linked-requires-order_id CHECK constraint violation to a
// clear message instead of surfacing the raw Postgres error.
//
// Target failures (20260715) are consulted FIRST and are far more specific:
// each names the rule that refused, so "that request was already converted"
// never collapses into a generic constraint sentence.
export function friendlyDbErrorMessage(dbError: { code?: string; message: string } | null): string {
  if (!dbError) return ''
  const target = paymentTargetErrorMessage(dbError.message)
  if (target) return target
  // Named BEFORE the generic 23514 branch: all three are check-constraint
  // failures, and these two have nothing to do with order linkage.
  if (dbError.message?.includes('finance_payment_requests_handover_pair')) {
    return 'Record who the cash was handed over to and the handover date together, or leave both blank.'
  }
  // The form blocks this too (collectionErrorFor), so reaching here means a
  // stale client or a direct API call — 20260717 is what makes the rule real.
  if (dbError.message?.includes('finance_payment_requests_handover_not_before_payment')) {
    return 'Handover date cannot be earlier than the payment date.'
  }
  if (dbError.code === '23514' || dbError.message?.includes('finance_payment_requests_approved_linked_requires_order_id')) {
    return 'Select a valid order before marking this payment as linked.'
  }
  return dbError.message
}

// ── Approval lock ─────────────────────────────────────────────────────────────
// Approval is the single hard locking point for this page, and now also its
// boundary. BOTH approved_* statuses are the Received Payments workflow's
// territory and neither is loaded here any more: once an admin confirms the
// money arrived, the record is a received payment, not an outstanding request,
// and it leaves this page in the same breath.
//
// THE SAME RULE IS RE-EVALUATED SERVER-SIDE at mutation time. Corrections now
// go through edit_payment_request, which locks the payment row and re-reads its
// status under that lock — so a request approved between load and click is
// refused by name (PAYMENT_ALREADY_APPROVED) rather than merely hidden. See the
// race note on APPROVED_RACE_MESSAGE.

/**
 * How long the search box waits before asking the database.
 *
 * Search is answered server-side now, so without this every keystroke would be
 * a list query plus four count queries. 250ms is below the threshold at which
 * typing feels laggy and comfortably above the interval between keystrokes, so
 * an ordinary term costs one round of queries rather than one per character.
 */
export const SEARCH_DEBOUNCE_MS = 250

export function isApproved(status: string): boolean {
  return status === 'approved_unlinked' || status === 'approved_linked'
}

// Shown when an update or delete matched zero rows because the request was
// approved after the modal was opened. The mutation is filtered on status
// server-side, so the approved record is never touched — the stale UI is.
export const APPROVED_RACE_MESSAGE =
  'This request has already been verified and can no longer be changed here.'

export const APPROVED_LOCK_NOTE =
  'This request has been verified and is now managed under Received Payments.'

// Who may act on a request from this page. Ownership and role are re-checked by
// RLS (finance_payment_requests_own_update / own_delete / admin_*) and by the
// approval guard triggers — this only decides which controls are worth showing.
export function canManageRequest(r: PaymentRequest, isAdmin: boolean, userId: string): boolean {
  return !isApproved(r.status) && (isAdmin || r.submitted_by === userId)
}

// ── Age-based partitioning (Phase 2C) ─────────────────────────────────────────
// Rejected requests move from the active Rejected tab into Archive once they are
// at least 30 days old; needs_clarification requests older than 30 days show a
// (display-only) Stale badge. Age is measured from the DB-managed status-entry
// timestamps (rejected_at / clarification_requested_at). updated_at is only a
// defensive fallback for rows written before those columns existed (the
// migration backfills all current matching rows, so it should rarely apply).
//
// Boundary: archived/stale when the timestamp is at or before the cutoff
// (age >= 30d); active/normal when it is strictly after the cutoff (age < 30d).
// Null-safe: a row with no known timestamp is treated as active/not-stale so it
// can never silently vanish from the active view.

// ARCHIVE_WINDOW_MS, archiveCutoffIso, isArchivedRejected and matchesTab (now
// tabMatches) moved to ./paymentRequestsQuery when the tabs became database
// filters: the predicate a row is tested against in memory and the predicate the
// query is built from have to be one rule, and keeping a second copy here is
// exactly how they would drift.

export function isStaleClarification(r: PaymentRequest, cutoff: number): boolean {
  if (r.status !== 'needs_clarification') return false
  const ts = r.clarification_requested_at ?? r.updated_at ?? null
  if (!ts) return false
  return new Date(ts).getTime() <= cutoff
}

