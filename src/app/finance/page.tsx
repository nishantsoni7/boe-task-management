'use client'

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { compressImageFile } from '@/lib/attachment-utils'
import { PROOF_BUCKET, validateProofFile, buildProofPath, proofContentType } from '@/lib/paymentProof'
import { canDeletePayment } from '@/lib/finance/paymentDeletion'
import { DeletePaymentModal } from '@/components/finance/DeletePaymentModal'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { groupIndianDigits, sanitizeAmountInput, isValidAmount } from '@/lib/currency'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { notifyFinance } from '@/lib/notify'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'
import {
  FinanceModal,
  RequestModalShell,
  useDialogFocus,
  useModalScrollLock,
  FINANCE_MODAL_OVERLAY_Z,
  FINANCE_MODAL_DIALOG_Z,
} from '@/app/finance/components/FinanceModalShell'
import {
  StatusTabs,
  accentFromBadge,
  BRAND_TAB_ACCENT,
  type TabAccent,
} from '@/components/ui/StatusTabs'
import { Archive, CircleCheck, CircleX, Clock, Layers, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import { REQUEST_STAGE_STATUSES, canVerifyPayment } from './paymentRouting'
import {
  COUNTED_TABS,
  archiveCutoffIso,
  clampPage,
  pageCount,
  pageRange,
  parseFilterTab,
  paymentRequestsSearchFilter,
  resultSummary,
  tabClauses,
  tabCounts,
  tabMatches,
  type FilterTab,
} from './paymentRequestsQuery'
import { paymentTargetErrorMessage } from './paymentTargets'
import {
  destinationFromDb,
  paymentDestinationLabel,
} from './paymentDestinations'
import { DESTINATION_ICON } from './components/AccountIcons'
import {
  EMPTY_PAYMENT_ENTRY,
  PaymentEntryFields,
  isPaymentEntryComplete,
  type PaymentEntryState,
  type PaymentEntryTarget,
} from './components/PaymentEntryFields'
import { CustodyTrailFields } from './components/CustodyTrailFields'
import {
  PaymentCustodyTrail,
  PaymentDestinationSummary,
  usePaymentDestination,
} from './components/PaymentDestinationBlock'
import { DiscardConfirmation, useDiscardGuard } from './components/DiscardGuard'
import { ProofReferenceField, ProofReferenceSection } from './components/ProofReferenceSection'
import {
  DEFAULT_PAYMENT_MODE,
  customerDisplayName,
  isPaymentMode,
  paymentEntryErrorMessage,
  paymentModeLabel,
  paymentModeOptionsFor,
  type PaymentDestination as PaymentEntryDestination,
} from '@/lib/finance/paymentEntry'
import {
  custodyDraftsError,
  modeRequiresCustodyTrail,
  toRpcCustodyEvents,
  type CustodyDraft,
} from '@/lib/finance/custodyTrail'
import {
  PAYMENT_DISPLAY_STATE_META,
  loadPaymentDestinations,
  orderNumberDisplay,
  paymentAgainstDisplay,
  paymentDisplayStateMeta,
  type PaymentDestination,
} from '@/lib/finance/paymentDestination'
import { searchAllocationTargets } from './received/AllocatePaymentModal'
import { loadPaymentIntent } from './paymentIntents'
import { useQueryClient } from '@tanstack/react-query'
import { RECEIVED_PAYMENTS_COUNTS_KEY } from '@/hooks/queries/useReceivedPaymentsCounts'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

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

type AdminAction = 'approve' | 'needs_clarification' | 'reject'

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
const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
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
const ARCHIVE_TAB_ACCENT: TabAccent = {
  color: '#4B5563', tint: '#F3F4F6', badge: '#F3F4F6', badgeActive: '#E5E7EB',
}

const FILTER_TABS: { key: FilterTab; label: string; Icon: LucideIcon; accent: TabAccent }[] = [
  { key: 'pending',       label: 'Pending',             Icon: Clock,                  accent: accentFromBadge(STATUS_META.pending_approval) },
  { key: 'clarification', label: 'Needs Clarification', Icon: MessageCircleQuestion,  accent: accentFromBadge(STATUS_META.needs_clarification) },
  { key: 'rejected',      label: 'Rejected',            Icon: CircleX,                accent: accentFromBadge(STATUS_META.rejected) },
  { key: 'archive',       label: 'Archive',             Icon: Archive,                accent: ARCHIVE_TAB_ACCENT },
  { key: 'all',           label: 'All',                 Icon: Layers,                 accent: BRAND_TAB_ACCENT },
]

const EMPTY_MESSAGES: Record<FilterTab, string> = {
  pending:       'No pending payment requests.',
  clarification: 'No payments awaiting clarification.',
  rejected:      'No rejected payments.',
  archive:       'No archived rejected requests.',
  all:           'No payment requests here.',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// A custody activity happens at a TIME, not on a day: "collected at 9pm, handed
// over at 10pm" is an ordinary trail, and a date-only formatter would print the
// two as the same moment. Read in the reader's own zone, which is where the
// person entering it was standing.
function fmtDateTime(iso: string) {
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
const fmtAmount = formatMoney

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
function orderNoCell(destination: PaymentDestination | null | undefined) {
  return orderNumberDisplay(destination)
}

// Maps the approved_linked-requires-order_id CHECK constraint violation to a
// clear message instead of surfacing the raw Postgres error.
//
// Target failures (20260715) are consulted FIRST and are far more specific:
// each names the rule that refused, so "that request was already converted"
// never collapses into a generic constraint sentence.
function friendlyDbErrorMessage(dbError: { code?: string; message: string } | null): string {
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
const SEARCH_DEBOUNCE_MS = 250

function isApproved(status: string): boolean {
  return status === 'approved_unlinked' || status === 'approved_linked'
}

// Shown when an update or delete matched zero rows because the request was
// approved after the modal was opened. The mutation is filtered on status
// server-side, so the approved record is never touched — the stale UI is.
const APPROVED_RACE_MESSAGE =
  'This request has already been verified and can no longer be changed here.'

const APPROVED_LOCK_NOTE =
  'This request has been verified and is now managed under Received Payments.'

// Who may act on a request from this page. Ownership and role are re-checked by
// RLS (finance_payment_requests_own_update / own_delete / admin_*) and by the
// approval guard triggers — this only decides which controls are worth showing.
function canManageRequest(r: PaymentRequest, isAdmin: boolean, userId: string): boolean {
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

function isStaleClarification(r: PaymentRequest, cutoff: number): boolean {
  if (r.status !== 'needs_clarification') return false
  const ts = r.clarification_requested_at ?? r.updated_at ?? null
  if (!ts) return false
  return new Date(ts).getTime() <= cutoff
}

// ── Shared modal shell ────────────────────────────────────────────────────────
// FinanceModal, RequestModalShell, and useModalScrollLockAndEscape live in
// src/app/finance/components/FinanceModalShell.tsx — shared with Received
// Payments so both pages use one Finance modal layering system.

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}{required && <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px' }}>
      {message}
    </div>
  )
}

// Indian-grouped amount input. While focused it shows the raw, comma-free
// value for easy editing; on blur it displays Indian digit grouping. The
// canonical value passed to onChange is always comma-free numeric text.
function AmountInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false)
  const display = focused ? value : (value ? groupIndianDigits(value) : '')
  return (
    <input
      className="boe-input"
      type="text"
      inputMode="decimal"
      value={display}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={e => onChange(sanitizeAmountInput(e.target.value))}
      placeholder="0"
      style={{ width: '100%' }}
    />
  )
}


// Compact uppercase section label used throughout the details modal.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

// Label-over-value metadata item; muted styling for empty/placeholder values.
function MetaItem({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: '14px', color: muted ? colors.muted : colors.primary, wordBreak: 'break-word', lineHeight: 1.4 }}>{value}</span>
    </div>
  )
}

// One payment destination, read-only: icon, the account name, and what that
// account means. The icon is decorative — it sits beside a label and a helper
// that both stay visible, and nothing here is carried by icon or colour alone.
//
// A legacy pair no account matches has no icon and no helper; it still prints
// the honest legacy label rather than being forced into an account it was never
// recorded against.
// ── The account, and NOTHING ABOUT WHAT IT MEANS ─────────────────────────────
//
// The four accounts a payment may name are HDFC, PNB, Paytm and Canara. What
// each MEANS internally is recorded in the database's own column comment and
// appears on no screen — so this prints the account name and stops.
//
// THE HELPER LINE IS GONE, deliberately. It described the four legacy account
// PAIRS ("cash collected through an external source" and so on), which is
// exactly the kind of sentence this product no longer puts beside a mode name.
// paymentDestinationLabel still resolves a historical pair to its account, so a
// 2026 row keeps reading as the account it was recorded against.
function PaymentDestinationLine({ payment_mode, received_in }: { payment_mode: string; received_in: string | null }) {
  const d    = destinationFromDb(payment_mode, received_in)
  const Icon = d ? DESTINATION_ICON[d.iconKey] : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Payment Mode
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        {Icon && <Icon size={15} aria-hidden="true" color={colors.muted} style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: '14px', color: colors.primary, wordBreak: 'break-word', lineHeight: 1.4 }}>
          {paymentDestinationLabel(payment_mode, received_in)}
        </span>
      </span>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

// THE BADGE IS NOT THE STATUS COLUMN. For the three request-stage statuses it is
// the same thing; for the two verified ones the label is decided by whether the
// ALLOCATION LEDGER actually attaches this payment to anything, which is what
// stops a fully allocated Confirmed-Order payment reading "Order No. Pending".
function StatusBadge({ status, destination }: {
  status: string
  destination?: PaymentDestination | null
}) {
  const meta = destination !== undefined
    ? paymentDisplayStateMeta(status, destination)
    : STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// Display-only indicator for a needs_clarification request that has been waiting
// at least 30 days. Purely visual — it never changes the request's status.
function StaleBadge() {
  return (
    <span style={{
      display: 'inline-block', marginLeft: '6px', padding: '2px 8px', borderRadius: '5px',
      background: '#FFF7ED', color: '#9A3412', border: '1px solid #FED7AA',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      Stale
    </span>
  )
}

// ── Status correction options (admin) ────────────────────────────────────────
// approved_unlinked and approved_linked are deliberately excluded: those two
// states are order-linkage states, not review states, and must only be
// reached through approve_finance_payment_request, link_finance_payment_to_order,
// or unlink_finance_payment_from_order (20260690000000 / 20260691000000) — each
// locks the row and keeps status/order_id/order_number in lock-step. A generic
// correction here would let status diverge from order_id/order_number without
// any of those guarantees.

const STATUS_CORRECTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending_approval',    label: 'Pending Review' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]

// ── Details modal (read-only for creators; includes status correction for admin) ──

function DetailsModal({
  request: r,
  onClose,
  isAdmin,
  mayCorrectPayments,
  mayApprovePayments,
  userId,
  supabase,
  onCorrected,
  onEdit,
  onDelete,
}: {
  request: PaymentRequest
  onClose: () => void
  /**
   * Still used for the OWNERSHIP rules and for the creator-facing copy
   * ("Reapply" vs "Edit"), which are about who submitted a request, not about
   * who may correct one.
   */
  isAdmin?: boolean
  /**
   * May correct or reverse a recorded payment — the finance.manage authority.
   * Separate from isAdmin because an employee can now hold it without being an
   * admin, and an admin holds it through the capability helper's short-circuit.
   */
  mayCorrectPayments?: boolean
  /**
   * May VERIFY a pending payment — the finance.approve authority, and a
   * different one from mayCorrectPayments. Correcting rewrites a record that has
   * already been decided; verifying is the decision.
   *
   * This modal previously had no verification control at all, which meant an
   * admin who opened a pending payment through the row's View button — the
   * obvious action in the row — could send it back or reject it but could not
   * confirm it. The only route to verification was clicking the row itself, and
   * its only affordance was a small "Review" chip. See the panel below.
   */
  mayApprovePayments?: boolean
  userId?: string
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
  onEdit?: (r: PaymentRequest) => void
  onDelete?: (r: PaymentRequest) => void
}) {
  // Order-linkage states are out of this control's jurisdiction entirely —
  // neither entering nor leaving approved_unlinked/approved_linked may happen
  // here, since either direction would move status without the RPCs' row
  // locking, eligibility checks, and order_id/order_number bookkeeping.
  const isLinkageStatus = isApproved(r.status)

  // Same rule the table's action buttons use, so the two surfaces can never
  // disagree about whether a request is still manageable from this page.
  const canManage = canManageRequest(r, !!isAdmin, userId ?? '')
  // DELETE IS A SEPARATE, NARROWER RULE (20261011000000 §3a): admin-only, for
  // any status. Self-delete by the submitter of an unapproved request — which
  // canManage still grants for Edit/Reapply — is withdrawn for Delete alone.
  const canDelete = canDeletePayment(r, { isAdmin: !!isAdmin })

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  // ── Verification ──
  // Only a PENDING payment can be verified, and only by somebody holding the
  // approval authority. Both are re-derived inside
  // approve_finance_payment_request under a row lock on every call, so this
  // decides whether a control is DRAWN and never whether it is allowed.
  const canVerify = canVerifyPayment(r.status, mayApprovePayments)
  const [verifyArmed, setVerifyArmed] = useState(false)
  const [verifyNote,  setVerifyNote]  = useState('')
  const [verifying,   setVerifying]   = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  // Verification is not idempotent from the caller's side — a second click
  // would race the first — so the guard is a ref set BEFORE the await, not a
  // state update that only lands on the next render.
  const verifyingRef = useRef(false)

  const handleVerify = async () => {
    if (!canVerify || !supabase || !onCorrected) return
    if (verifyingRef.current) return
    verifyingRef.current = true
    setVerifying(true)
    setVerifyError(null)

    // THE EXISTING BACKEND, UNCHANGED. approve_finance_payment_request
    // (20260690000000, re-gated onto finance.approve by 20260901000000) already
    // handles every route: a new_order payment — which is what a PI-recorded
    // payment is — lands in approved_unlinked with order_id left null, and an
    // existing_order payment links straight to the order it already carries.
    // Its PI allocation is not touched by any of that: the allocation names the
    // payment, and the payment's id does not change.
    const { error: rpcError } = await supabase.rpc('approve_finance_payment_request', {
      p_request_id: r.id,
      p_admin_note: verifyNote.trim() || null,
    })

    if (rpcError) {
      verifyingRef.current = false
      setVerifying(false)
      setVerifyError(friendlyDbErrorMessage(rpcError))
      return
    }

    void notifyFinance(
      r.payment_against === 'new_order'
        ? { event: 'finance_approved_suspense', requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name }
        : { event: 'finance_approved_linked',   requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name, orderNumber: r.order_number },
    )

    // Closes this modal and reloads the list, so the row, the tab counts and the
    // status chip all reflect the new state. The ref is deliberately NOT reset:
    // the modal is going away, and leaving it armed makes a late second click
    // a no-op rather than a second call.
    onCorrected()
  }

  const noteRequiredForCorrection = newStatus === 'needs_clarification' || newStatus === 'rejected'
  const statusChanged = newStatus !== r.status
  const canCorrect = statusChanged && (!noteRequiredForCorrection || correctionNote.trim())

  const handleCorrect = async () => {
    if (!canCorrect || !supabase || !onCorrected) return
    setCorrecting(true)
    setCorrectionError(null)
    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        status:     newStatus,
        admin_note: correctionNote.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setCorrecting(false)
    if (dbError) { setCorrectionError(friendlyDbErrorMessage(dbError)); return }

    // The status genuinely changed (canCorrect requires it) — tell the creator.
    void notifyFinance({
      event: 'finance_status_corrected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
      statusLabel: STATUS_META[newStatus]?.label ?? newStatus,
    })

    onCorrected()
  }

  // Status-specific decision/clarification block. Shown only when a stored
  // admin_note exists; tinted with the request's own status colours.
  const decision = r.admin_note
    ? (() => {
        const m = STATUS_META[r.status] ?? { bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
        const title =
          r.status === 'rejected'            ? 'Rejection reason' :
          r.status === 'needs_clarification' ? 'Clarification required' :
          (isLinkageStatus)                  ? 'Approval note' :
                                               'Admin note'
        return { title, bg: m.bg, border: m.border, color: m.color, note: r.admin_note }
      })()
    : null

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  // ── WHAT THIS PAYMENT IS FOR, from the ledger and the intent ──
  //
  // This popup used to read order_number, then order_request_number, then
  // payment_target_type — and printed a plain "New Order" whenever all three
  // were empty, which is every request the current form writes. Every one of
  // those columns became provenance at 20261012000000. It reads
  // finance_payment_destinations now: the pending INTENT before Finance
  // approves, the ACTIVE ALLOCATIONS afterwards.
  const destination  = usePaymentDestination(supabase, r.id)
  const againstLine  = paymentAgainstDisplay(destination)
  const orderNoLine  = orderNoCell(destination)

  const left = (
    <>
      {/* A. Primary summary card — amount + client lead, payment details below */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(r.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {customerDisplayName(r.client_name)}
            </div>
          </div>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px',
          borderTop: `1px solid ${colors.border}`, paddingTop: '14px',
        }}>
          <MetaItem label="Payment Date"    value={fmtDate(r.payment_date)} />
          <MetaItem label="Payment Against" value={againstLine} muted={!destination || destination.kind === 'suspense'} />
          <MetaItem label="Order Number"    value={orderNoLine.value} muted={orderNoLine.muted} />
          {/* ONE destination row, spanning both columns, in place of the
              Payment Mode + Received In pair that was printing the same
              account name twice ("Paytm" over "Paytm"). Spanning is what keeps
              the grid from ending on a lone empty cell. */}
          <div style={{ gridColumn: '1 / -1' }}>
            <PaymentDestinationLine payment_mode={r.payment_mode} received_in={r.received_in} />
          </div>
        </div>
      </div>

      {/* B. Decision block — compact status-tinted note, only when one exists */}
      {decision && (
        <div style={{ padding: '12px 14px', borderRadius: '10px', background: decision.bg, border: `1px solid ${decision.border}` }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: decision.color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '5px' }}>
            {decision.title}
          </div>
          <div style={{ fontSize: '13.5px', color: decision.color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {decision.note}
          </div>
        </div>
      )}

      {/* B2. WHAT THIS PAYMENT IS FOR, in full: the kind, the record, and which
          of the two sources answered — a promise (the pending intent) reads
          differently from a fact (the allocations), and a person deciding
          anything about this payment needs to know which they are looking at. */}
      <PaymentDestinationSummary destination={destination} clientName={r.client_name} />

      {/* C. WHO PHYSICALLY CARRIED IT. Shown for PNB and Paytm, and for any
          payment that already has a trail — a request corrected onto a bank
          account keeps its history visible, because the money really did pass
          through somebody's hands.

          THE SUBMITTER MAY STILL ADD TO IT while the request is unapproved,
          which is what makes "collect today, hand over tomorrow" work. That is a
          DRAWING rule: append_payment_custody_events re-derives the authority
          itself and refuses anyone else. */}
      {supabase && (
        <PaymentCustodyTrail
          supabase={supabase}
          payment={r}
          canAppend={mayApprovePayments || mayCorrectPayments || r.submitted_by === userId}
          formatDateTime={fmtDateTime}
          onAppended={onCorrected}
        />
      )}

      {/* D. PAYMENT PROOF / REFERENCE — the attachment, the reference and the
          notes, under ONE heading and in one frame. They are three parts of the
          same question ("what backs this payment up?") and they are asked
          together on all three entry forms, so they are answered together here.
          The database keeps them in separate columns because they mean separate
          things; this is a grouping, not a merge. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <SectionHeader>Payment Proof / Reference</SectionHeader>
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '104px', flexShrink: 0 }}>Payment proof</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {supabase
                ? <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline emptyLabel="No payment proof attached" />
                : <span style={{ fontSize: '13px', color: colors.muted }}>No payment proof attached</span>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '104px', flexShrink: 0, paddingTop: '1px' }}>Reference</span>
            <span style={{ fontSize: '13.5px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
              {r.proof_note || 'No reference provided'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '104px', flexShrink: 0, paddingTop: '1px' }}>Notes</span>
            <span style={{ fontSize: '13.5px', color: r.sales_note ? colors.secondary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
              {r.sales_note || 'No notes provided'}
            </span>
          </div>
        </div>
      </div>
    </>
  )

  const right = (
    <>
      {/* E. Activity panel — subtle bordered panel; the timeline keeps its
          own "Activity" heading, query, ordering, and event text. */}
      {supabase && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
          <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
        </div>
      )}

      {/* E2. Verify Payment — the decision, and the one this modal was missing.
          
          WHY IT IS HERE AND NOT IN THE CORRECTION DROPDOWN BELOW: moving a row
          into approved_unlinked/approved_linked requires the RPC's row locking,
          eligibility checks and order_id/order_number bookkeeping, which is
          exactly why 20260692000000 removed both approved statuses from
          STATUS_CORRECTION_OPTIONS. A protected server action gets its own
          primary button; it never becomes an option in a status <select>.
          
          Needs Clarification and Rejected stay where they are, as separate
          decisions in the correction panel below. */}
      {canVerify && supabase && onCorrected && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <div>
            <SectionHeader>Verification</SectionHeader>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
              Confirm that Finance has checked this payment. It will be verified
              as received{r.payment_against === 'new_order'
                ? ' and held until an order is linked.'
                : ` against ${r.order_number ?? 'the linked order'}.`}
            </div>
          </div>

          {!verifyArmed ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setVerifyArmed(true); setVerifyError(null) }}
                className="boe-btn boe-btn-primary"
                style={{ padding: '7px 16px', fontSize: '13px' }}
              >
                Verify Payment
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* The concise confirmation step the review flow already uses, so
                  a single stray click cannot record money as received. */}
              <div style={{
                fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
                background: colors.greenTint, border: '1px solid rgba(69,168,112,0.2)',
                borderRadius: '8px', padding: '10px 12px',
              }}>
                Verify {fmtAmount(r.amount)} from {customerDisplayName(r.client_name)}? This
                confirms the money was checked and cannot be undone from this page.
              </div>
              <textarea
                className="boe-input"
                aria-label="Verification note"
                value={verifyNote}
                onChange={e => setVerifyNote(e.target.value)}
                placeholder="Note for the salesperson (optional)"
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
              {verifyError && <ErrorBanner message={verifyError} />}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { setVerifyArmed(false); setVerifyNote(''); setVerifyError(null) }}
                  disabled={verifying}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '7px 16px', fontSize: '13px' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleVerify}
                  disabled={verifying}
                  className="boe-btn boe-btn-primary"
                  style={{ padding: '7px 16px', fontSize: '13px' }}
                >
                  {verifying ? 'Verifying…' : 'Confirm Verification'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* F. Admin controls — compact action panel. Never for
          approved_unlinked/approved_linked rows; those are managed only via
          Verify Payment and Allocate Funds. */}
      {mayCorrectPayments && supabase && onCorrected && !isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <div>
            <SectionHeader>Admin controls</SectionHeader>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
              Administrative correction. This action will be recorded in activity history.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <select
              className="boe-input"
              aria-label="Correct status"
              value={newStatus}
              onChange={e => { setNewStatus(e.target.value); setCorrectionNote(''); setCorrectionError(null) }}
              style={{ fontSize: '13px', maxWidth: '260px' }}
            >
              {STATUS_CORRECTION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!statusChanged && (
              <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
                Select a different status to make a correction.
              </div>
            )}
            {statusChanged && noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label={newStatus === 'needs_clarification' ? 'Clarification note' : 'Rejection reason'}
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder={newStatus === 'needs_clarification' ? 'Clarification note (required)' : 'Rejection reason (required)'}
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {statusChanged && !noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label="Admin note"
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder="Admin note (optional)"
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {correctionError && <ErrorBanner message={correctionError} />}
            {statusChanged && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={handleCorrect}
                  disabled={!canCorrect || correcting}
                  className="boe-btn boe-btn-primary"
                  style={{ padding: '7px 16px', fontSize: '13px' }}
                >
                  {correcting ? 'Saving…' : 'Save Correction'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Approved requests are view-only on this page for every role. The note
          says where the record now lives instead of offering a disabled
          control; the admin-only linkage sentence is kept alongside it. */}
      {isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          fontSize: '12px', color: colors.muted, lineHeight: 1.5,
        }}>
          {APPROVED_LOCK_NOTE}
          {isAdmin && ' Funds are attached to a PI Draft or an Order there, with Allocate Funds.'}
        </div>
      )}
    </>
  )

  // Actions live in the shell's pinned footer so they stay reachable while the
  // body scrolls. Delete and Edit/Reapply are gated SEPARATELY — canDelete
  // (admin-only) and canManage (edit/reapply) — so the footer renders whenever
  // either offers something, not only when both do.
  const footer = ((canManage && onEdit) || (canDelete && onDelete)) ? (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {onDelete && canDelete && (
        <button
          onClick={() => onDelete(r)}
          style={{
            padding: '7px 16px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.red}`, background: colors.redTint, color: colors.red, cursor: 'pointer',
          }}
        >
          Delete
        </button>
      )}
      {onEdit && canManage && (
        <button onClick={() => onEdit(r)} className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
          {!isAdmin && r.status === 'rejected' ? 'Reapply' : 'Edit'}
        </button>
      )}
    </div>
  ) : undefined

  return (
    <RequestModalShell
      requestNumber={r.human_payment_id}
      submittedLine={submittedLine}
      statusBadge={<StatusBadge status={r.status} />}
      onClose={onClose}
      left={left}
      right={right}
      footer={footer}
    />
  )
}

// ── New Payment Request modal ─────────────────────────────────────────────────
//
// THREE DESTINATIONS, THE SAME THREE RECORD PAYMENT OFFERS. PI Draft, Confirmed
// Order, Suspense Entry — one list, one component (PaymentEntryFields), so the
// two forms cannot drift into asking the same question in different words.
//
// THE CUSTOMER IS NOT TYPED, AND IS NOT SENT. submit_payment_request derives it
// from the record this form validates against (20261013000000 §3): a name from
// the browser would be a claim the browser is in no position to make, so the RPC
// has no parameter for one. A Suspense Entry has none at all, and the column is
// null rather than filled with something invented.
//
// AND IT IS NOT AN ALLOCATION. A payment request is unverified money. Submitting
// one writes the payment and a pending ALLOCATION INTENT in a single
// transaction; nothing reaches finance_payment_allocations until Finance
// approves, so nothing here moves an Order's received total, closes a balance or
// satisfies the 40% gate.
//
// ONE WRITE, ONE DOOR. The form used to INSERT into finance_payment_requests
// directly. Two writes that must both land — the payment and its intent —
// cannot be made atomic from a browser, so the insert is gone and the RPC is the
// only way in. Every gate is still the database's: module entry, RLS, the
// target's eligibility, the canonical five payment modes.

// Everything on the form that is NOT the destination and NOT the cash trail.
//
// There is no `clientName` here, and there is no `receivedIn`. The customer is
// derived server-side from the chosen record; the receiving account is no longer
// asked for at all, and null is stored rather than a fabricated one.
const EMPTY_FORM = {
  amount:          '',
  paymentDate:     '',
  proofNote:       '',
  salesNote:       '',
  paymentMode:     DEFAULT_PAYMENT_MODE as string,
}

type NewPaymentModalProps = {
  userId: string
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
  // Optional prefill, used when the form is opened from another module so the
  // salesperson does not retype what that module already knows. The note is an
  // ordinary editable field value; the client name only SEEDS THE SEARCH BOX —
  // see PaymentEntryFields' initialQuery.
  initialClientName?: string
  initialSalesNote?: string
  contextLabel?: string
}

function NewPaymentConfirmationModal({
  userId, supabase, onClose, onSaved,
  initialClientName, initialSalesNote, contextLabel,
}: NewPaymentModalProps) {
  useModalScrollLock()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, salesNote: initialSalesNote ?? '' }))
  const [entry, setEntry] = useState<PaymentEntryState>(EMPTY_PAYMENT_ENTRY)
  // THE CUSTODY TRAIL, as many activities as the money actually went through.
  // Empty until somebody adds one: a PNB payment that was collected and handed
  // over in one motion is one activity, and one that has not moved yet is none.
  const [custody, setCustody] = useState<CustodyDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // ONE SUBMISSION, NOT ONE PER CLICK. `saving` re-renders and a second click
  // can land inside the same tick; a ref is read and written synchronously, so
  // it is what actually closes the window.
  const submitting = useRef(false)

  // Optional payment-proof attachment (uploaded to the private payment-proofs bucket)
  const [attachFile,  setAttachFile]  = useState<File | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const set = (key: keyof typeof EMPTY_FORM) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  // ADDING AN ACTIVITY IS OPTIONAL; FINISHING ONE IS NOT. A half-entered
  // activity — a handover with nobody named, a collection with no time — blocks
  // the save, because the server would refuse it and take the whole request with
  // it. append_payment_custody_events_internal applies exactly these rules.
  const custodyError = custodyDraftsError(custody)

  const canSubmit = !!(
    isPaymentEntryComplete(entry) &&
    isValidAmount(form.amount) &&
    form.paymentDate &&
    isPaymentMode(form.paymentMode) &&
    !custodyError &&
    !attachError
  )

  // ── Not losing what was typed ──
  //
  // The payment mode starts at a value nobody chose, so it counts as dirty only
  // once it has been changed. A prefilled note does not count either: the person
  // did not type it.
  const isDirty = () =>
    form.amount.trim() !== '' ||
    form.paymentDate !== '' ||
    form.proofNote.trim() !== '' ||
    form.salesNote.trim() !== (initialSalesNote ?? '').trim() ||
    form.paymentMode !== EMPTY_FORM.paymentMode ||
    entry.destination !== EMPTY_PAYMENT_ENTRY.destination ||
    entry.target !== null ||
    custody.length > 0 ||
    attachFile !== null

  const guard = useDiscardGuard({ isDirty, onClose, disabled: saving })

  // The SAME search Record Payment and Allocate Funds use — same sources, same
  // RLS scoping, same eligibility filters — narrowed to the one kind this
  // destination admits.
  const searchTargets = async (kind: 'submission' | 'order', term: string): Promise<PaymentEntryTarget[]> => {
    const found = await searchAllocationTargets(supabase, term, kind)
    return found.map(c => ({
      id: c.id,
      reference: c.reference,
      clientName: c.clientName,
      totalValue: typeof c.value === 'string' ? Number(c.value) : c.value,
    }))
  }

  // Uploads the selected proof to the private bucket and records its metadata.
  // Returns null on success, or an error string. On any failure it removes a
  // partially-uploaded object so no orphaned file remains; the CALLER is then
  // responsible for removing the payment request it made, so the user is never
  // told success when the proof was not persisted.
  const persistProof = async (paymentRequestId: string): Promise<string | null> => {
    if (!attachFile) return null
    // Compression can change size/type, so re-validate the prepared file.
    const prepared = await compressImageFile(attachFile)
    const vErr = validateProofFile(prepared)
    if (vErr) return vErr

    // Upload under the type the bucket will actually accept. validateProofFile
    // guarantees this resolves, but fail closed rather than upload as octet-stream.
    const contentType = proofContentType(prepared)
    if (!contentType) return 'Only images (JPG, PNG, WEBP, GIF) or PDF files are allowed.'

    const path = buildProofPath(paymentRequestId, prepared.name)
    const { error: upErr } = await supabase.storage
      .from(PROOF_BUCKET)
      .upload(path, prepared, { upsert: false, contentType })
    if (upErr) return 'Could not upload the payment proof. Please try again.'

    const { error: metaErr } = await supabase
      .from('payment_proof_attachments')
      .insert({
        payment_request_id: paymentRequestId,
        storage_path:       path,
        file_name:          attachFile.name,
        file_type:          contentType,
        file_size:          prepared.size,
        created_by:         userId,
      })
    if (metaErr) {
      // Object uploaded but metadata failed — remove the object. The payment
      // request still exists here, so the storage delete policy authorizes this.
      await supabase.storage.from(PROOF_BUCKET).remove([path])
      return 'Could not save the payment proof. Please try again.'
    }
    return null
  }

  const handleSubmit = async () => {
    if (!canSubmit || saving || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError(null)

    // THE CUSTODY TRAIL IS SENT ONLY WHEN THE MODE CARRIES ONE — and the RPC
    // decides that again for itself, so this agreement is a convenience and not
    // the rule. A stale activity left over from a mode the person changed away
    // from is refused server-side rather than stored.
    const custodyEvents = modeRequiresCustodyTrail(form.paymentMode)
      ? toRpcCustodyEvents(custody)
      : []

    // ONE CALL, ONE TRANSACTION. The payment, its allocation intent and its
    // custody activities are written together or not at all. No client name is
    // sent: there is no parameter for one, deliberately.
    const { data, error: rpcError } = await supabase.rpc('submit_payment_request', {
      p_destination:     entry.destination,
      p_target_id:       entry.target?.id ?? null,
      p_amount:          Number(form.amount),
      p_payment_date:    form.paymentDate,
      p_payment_mode:    form.paymentMode,
      p_proof_note:      form.proofNote.trim() || null,
      p_sales_note:      form.salesNote.trim() || null,
      p_custody_events:  custodyEvents,
    })

    if (rpcError || !data) {
      submitting.current = false
      setError(paymentEntryErrorMessage(rpcError?.message))
      setSaving(false)
      return
    }

    const created = data as {
      payment_request_id: string
      request_number: string
      client_name: string | null
    }

    const proofErr = await persistProof(created.payment_request_id)
    if (proofErr) {
      // Compensation: don't leave a request claiming a proof that wasn't saved.
      // Deleting the payment cascades its intent away with it
      // (payment_request_id ... on delete cascade), so no orphaned intent is
      // left promising an allocation for a payment that no longer exists.
      const { error: delErr, count } = await supabase
        .from('finance_payment_requests')
        .delete({ count: 'exact' })
        .eq('id', created.payment_request_id)
      const cleaned = !delErr && count !== 0
      submitting.current = false
      setError(cleaned
        ? proofErr
        : `${proofErr} The draft request could not be cleaned up automatically — please ask an admin to remove the duplicate.`)
      setSaving(false)
      return
    }
    setSaving(false)

    // Notify approvers that a new request is waiting (non-blocking). The
    // customer named here is the one the SERVER derived, not one this form
    // guessed — and it is honestly absent for a Suspense Entry.
    void notifyFinance({
      event: 'finance_submitted',
      requestNumber: created.request_number,
      entityId: created.payment_request_id,
      clientName: customerDisplayName(created.client_name),
    })

    onSaved()
  }

  return (
    <>
      {/* Full-page overlay. INERT: this form holds unsaved input, and a
          backdrop click is frequently an accident — a missed target, a stray
          click while reading. There is no version of it that means "throw this
          away". Escape and ✕ still close, and ask first when there is
          something to lose. */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Send Payment Request"
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '660px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 40px)',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          zIndex: FINANCE_MODAL_DIALOG_Z, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          outline: 'none',
        }}>

        {/* ── Header ── */}
        <div style={{
          padding: '14px 20px 12px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
              Send Payment Request
            </div>
            {contextLabel && (
              <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                {contextLabel} · Finance verifies it before the money is attached
              </div>
            )}
          </div>
          <button
            onClick={guard.requestClose}
            disabled={saving}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{
          padding: '16px 20px', overflowY: 'auto', flex: 1,
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}>

          {/* 1. Where the money is for — and, for the two targeted
              destinations, 2. which record. The customer follows from it and is
              shown read-only; there is no field to type one into. */}
          <PaymentEntryFields
            state={entry}
            onChange={next => { setEntry(next); setError(null) }}
            onSearch={searchTargets}
            disabled={saving}
            initialQuery={initialClientName}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

            {/* 3. The payment itself. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <Field label="Amount (₹)" required>
                <AmountInput value={form.amount} onChange={v => setForm(prev => ({ ...prev, amount: v }))} />
              </Field>
              <Field label="Payment Date" required>
                <input className="boe-input" type="date" value={form.paymentDate}
                  onChange={set('paymentDate')} style={{ width: '100%' }} />
              </Field>
            </div>

            {/* THE FOUR ACCOUNTS, from the one shared list. There is no
                receiving-account question: the account picker answered
                payment_mode and received_in at once, and the mode IS the account
                now. What each account means internally is not printed. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <Field label="Payment Mode" required>
                <select className="boe-input" value={form.paymentMode}
                  onChange={set('paymentMode')} disabled={saving} style={{ width: '100%' }}>
                  {paymentModeOptionsFor(null).map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            {/* WHO CARRIED IT — for PNB and Paytm only, decided by the mode and
                decided again server-side. */}
            <CustodyTrailFields
              supabase={supabase}
              paymentMode={form.paymentMode}
              drafts={custody}
              onDraftsChange={setCustody}
              defaultActorId={userId}
              disabled={saving}
            />

            {/* 4. PAYMENT PROOF / REFERENCE — the attachment, the reference and
                the note to Finance, under ONE heading. Three parts of the same
                question, asked together; the database keeps three columns
                because they mean three things. */}
            <ProofReferenceSection>
              <ProofReferenceField
                label="Payment reference"
                hint={attachError
                  ? <span style={{ fontSize: '11px', color: colors.red }}>{attachError}</span>
                  : attachFile
                    ? <span style={{ fontSize: '11px', color: colors.muted }}>
                        Attached: {attachFile.name} — proof is optional and stored privately.
                      </span>
                    : undefined}
              >
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    className="boe-input"
                    value={form.proofNote}
                    onChange={set('proofNote')}
                    placeholder="UTR, cheque no., or short proof note (optional)"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null
                      if (!f) { setAttachFile(null); setAttachError(null); return }
                      const vErr = validateProofFile(f)
                      if (vErr) {
                        setAttachFile(null)
                        setAttachError(vErr)
                        if (fileInputRef.current) fileInputRef.current.value = ''
                        return
                      }
                      setAttachError(null)
                      setAttachFile(f)
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {attachFile ? '📎 ' + attachFile.name.slice(0, 14) + (attachFile.name.length > 14 ? '…' : '') : '📎 Attach'}
                  </button>
                </div>
              </ProofReferenceField>

              <ProofReferenceField label="Notes / remarks (optional)">
                <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
                  placeholder="Any additional context for admin"
                  rows={2} style={{ width: '100%', resize: 'vertical' }} />
              </ProofReferenceField>
            </ProofReferenceSection>


          </div>

          {error && <ErrorBanner message={error} />}

        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '10px 20px', borderTop: `1px solid ${colors.border}`,
          display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: 0,
        }}>
          <button onClick={guard.requestClose} disabled={saving}
            className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit || saving}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>

      </div>

      <DiscardConfirmation
        open={guard.asking}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discard}
      />
    </>
  )
}

// ── Edit Payment modal (creator only) ────────────────────────────────────────

type EditPaymentModalProps = {
  request: PaymentRequest
  isAdmin: boolean
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}

function EditPaymentModal({ request: r, isAdmin, supabase, onClose, onSaved }: EditPaymentModalProps) {
  useModalScrollLock()

  const [form, setForm] = useState({
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    proofNote:   r.proof_note ?? '',
    salesNote:   r.sales_note  ?? '',
  })

  // ── THE DESTINATION IS EDITABLE, THROUGH THE PROTECTED DOOR ──
  //
  // Since 20261013000000 a pending request's destination lives in its ALLOCATION
  // INTENT, not in the payment row's linkage columns — that is what keeps
  // unverified money out of finance_payment_allocations until Finance approves.
  // So a correction has to move the row AND the intent together, which a client
  // UPDATE cannot do atomically: edit_payment_request does it, re-derives the
  // customer from whichever record is chosen, and refuses outright once the
  // request has been approved.
  //
  // UNDEFINED IS NOT NULL HERE. `undefined` means the intent has not been read
  // back yet; `null` means the request carries none, which is what a Suspense
  // Entry is. Collapsing the two would show every request as Suspense for a
  // moment and let a Save land before the form knew what it was editing.
  const [entry, setEntry] = useState<PaymentEntryState | null>(null)

  // What the form OPENED with, so "has the destination changed?" compares
  // against the request rather than against a default.
  const loadedDestination = useRef<PaymentEntryDestination | null>(null)
  const loadedTargetId    = useRef<string | undefined>(undefined)

  useEffect(() => {
    let active = true
    ;(async () => {
      const found = await loadPaymentIntent(supabase, r.id)
      if (!active) return
      loadedDestination.current = found ? found.targetType : 'suspense'
      loadedTargetId.current    = found ? found.targetId : undefined
      setEntry(found
        ? {
            destination: found.targetType,
            target: {
              id: found.targetId,
              reference: found.reference ?? 'Not visible to you',
              // The customer already ON THE ROW: the server derived it from
              // this very record at submission. Nothing here re-reads or
              // re-guesses it.
              clientName: customerDisplayName(r.client_name),
            },
          }
        : { destination: 'suspense', target: null })
    })()
    return () => { active = false }
  }, [supabase, r.id, r.client_name])

  // The payment mode and its cash trail ARE editable, in exactly the window
  // every other field on this form is: the row is still pre-approval, which the
  // .in('status', UNAPPROVED_STATUSES) filter below re-checks server-side and
  // finance_payment_requests_guard_approved enforces independently. This is what
  // makes "collect today, hand over tomorrow, record it then" work — the
  // handover is filled in on a later visit to this same form.
  const [paymentMode, setPaymentMode] = useState<string>(r.payment_mode)

  // THE CUSTODY ACTIVITIES THIS CORRECTION ADDS — never the ones it already has.
  // A saved activity cannot be edited or removed by anybody, so this list starts
  // empty on every visit and holds only what has not been sent yet.
  const [custody, setCustody] = useState<CustodyDraft[]>([])

  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Set once an approval was detected mid-edit: the request is gone from this
  // page's jurisdiction, so retrying the save can only fail the same way.
  const [stale, setStale] = useState(false)

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  // ONE SUBMISSION, NOT ONE PER CLICK. Read and written synchronously, so a
  // second click inside the same tick finds the window already shut.
  const submitting = useRef(false)

  // Same single blocking rule as the submission form, and for the same reason:
  // a half-entered activity would be refused server-side and take the whole
  // correction with it.
  const custodyError = custodyDraftsError(custody)

  // Nothing may be saved before the destination has been read back: a Save that
  // landed while `entry` was still null would write Suspense over a targeted
  // request that had simply not loaded yet.
  const canSubmit = entry !== null && isPaymentEntryComplete(entry)
    && isValidAmount(form.amount) && !!form.paymentDate
    && isPaymentMode(paymentMode) && !custodyError

  // ── Not losing what was typed ──
  const isDirty = () =>
    form.amount !== String(r.amount) ||
    form.paymentDate !== r.payment_date ||
    form.proofNote.trim() !== (r.proof_note ?? '').trim() ||
    form.salesNote.trim() !== (r.sales_note ?? '').trim() ||
    paymentMode !== r.payment_mode ||
    custody.length > 0 ||
    (entry !== null && (entry.destination !== loadedDestination.current
      || entry.target?.id !== loadedTargetId.current))

  const guard = useDiscardGuard({ isDirty, onClose: stale ? onSaved : onClose, disabled: saving })

  // The SAME search the submission form and Allocate Funds use, narrowed to the
  // one kind the chosen destination admits.
  const searchTargets = async (kind: 'submission' | 'order', term: string): Promise<PaymentEntryTarget[]> => {
    const found = await searchAllocationTargets(supabase, term, kind)
    return found.map(c => ({
      id: c.id,
      reference: c.reference,
      clientName: c.clientName,
      totalValue: typeof c.value === 'string' ? Number(c.value) : c.value,
    }))
  }

  const handleSave = async () => {
    if (!canSubmit || !entry || saving || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError(null)
    const isCreatorReapply = !isAdmin && (r.status === 'needs_clarification' || r.status === 'rejected')

    // ONE CALL, ONE TRANSACTION. The payment row and its allocation intent move
    // together or not at all — which a client cannot do, and which is why the
    // direct UPDATE this form used to issue is gone. The RPC locks the payment
    // first, so an approval that landed while the modal was open is seen under
    // the lock and refused by name rather than half-applied.
    //
    // NO CUSTOMER IS SENT. There is no parameter for one: edit_payment_request
    // re-derives it from whichever record the destination now names, and sets
    // it NULL for Suspense.
    // THE ACTIVITIES BEING ADDED, and only those. Correcting a request away from
    // PNB or Paytm sends none and DELETES none: what was already recorded stays,
    // because the money really did pass through those hands.
    const custodyEvents = modeRequiresCustodyTrail(paymentMode)
      ? toRpcCustodyEvents(custody)
      : []

    const { data, error: rpcError } = await supabase.rpc('edit_payment_request', {
      p_payment_request_id: r.id,
      p_destination:     entry.destination,
      p_target_id:       entry.target?.id ?? null,
      p_amount:          Number(form.amount),
      p_payment_date:    form.paymentDate,
      p_payment_mode:    paymentMode,
      p_proof_note:      form.proofNote.trim() || null,
      p_sales_note:      form.salesNote.trim() || null,
      p_custody_events:  custodyEvents,
    })

    setSaving(false)
    if (rpcError || !data) {
      submitting.current = false
      // An approval that won the race is not a retryable failure: the request
      // has left this page's jurisdiction, so the form collapses to a single
      // dismissal that refreshes the table.
      if ((rpcError?.message ?? '').includes('PAYMENT_ALREADY_APPROVED')) {
        setStale(true)
        setError(APPROVED_RACE_MESSAGE)
        return
      }
      setError(paymentEntryErrorMessage(rpcError?.message))
      return
    }

    // A creator editing a needs_clarification or rejected request moves it
    // back to pending_approval — notify approvers it is ready for review again.
    // The customer named here is the one the SERVER just derived, not the one
    // the row carried before the correction.
    if (isCreatorReapply) {
      const saved = data as { client_name: string | null }
      void notifyFinance({
        event: 'finance_resubmitted',
        requestNumber: r.request_number,
        entityId: r.id,
        clientName: customerDisplayName(saved.client_name),
      })
    }

    onSaved()
  }

  return (
    // Once an approval has been detected, every dismissal path refreshes so the
    // table stops showing the request as still editable (see the same note on
    // DeleteConfirmModal).
    <FinanceModal
      title={!isAdmin && r.status === 'rejected' ? 'Reapply Payment Request' : 'Edit Payment Request'}
      /* ✕ and Escape ask before discarding; a backdrop click does nothing at
         all. The same rule both entry forms carry. */
      onClose={guard.requestClose}
      width="620px"
      closeOnBackdropClick={false}
    >
      {!isAdmin && r.status === 'needs_clarification' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#EFF6FF', border: '1px solid #BFDBFE',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#1E40AF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Clarification Required
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#1E3A8A', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '11px', color: '#3B82F6', marginTop: '4px' }}>
            Saving your changes will resubmit this request for admin review.
          </div>
        </div>
      )}
      {!isAdmin && r.status === 'rejected' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#FEF2F2', border: '1px solid #FECACA',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#991B1B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Rejection Reason
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#7F1D1D', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '11px', color: '#DC2626', marginTop: '4px' }}>
            Saving your changes will reapply this request for admin review. The rejection above stays visible in Activity history.
          </div>
        </div>
      )}
      {/* WHAT THIS PAYMENT IS FOR — the same three cards the submission form
          offers, preloaded with what was chosen. Changing one clears the target
          the old one carried; the customer beneath is read-only and is
          re-derived server-side from whichever record is picked. */}
      {entry === null ? (
        <div style={{
          padding: '11px 12px', borderRadius: '8px',
          border: `1px solid ${colors.border}`, background: colors.raised,
          fontSize: '13px', color: colors.muted,
        }}>
          Reading what this payment is for…
        </div>
      ) : (
        <PaymentEntryFields
          state={entry}
          onChange={next => { setEntry(next); setError(null) }}
          onSearch={searchTargets}
          disabled={saving}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Amount (₹)" required>
          <AmountInput value={form.amount} onChange={v => setForm(prev => ({ ...prev, amount: v }))} />
        </Field>
        <Field label="Payment Date" required>
          <input className="boe-input" type="date" value={form.paymentDate}
            onChange={set('paymentDate')} style={{ width: '100%' }} />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Payment Mode" required>
          <select className="boe-input" value={paymentMode} disabled={saving}
            onChange={e => setPaymentMode(e.target.value)} style={{ width: '100%' }}>
            {/* A HISTORICAL ROW KEEPS ITS OWN VALUE AS AN OPTION. Without it,
                opening this form on a 2026 payment would silently move it onto
                HDFC the moment anything else was saved. paymentModeOptionsFor
                adds it, marked retired, and only ever for a row that already
                carries one — a new entry never sees it. */}
            {paymentModeOptionsFor(paymentMode).map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* WHO CARRIED IT. Adding an activity is possible for as long as the
          request is editable — which is what makes "collect today, hand over
          tomorrow, record it then" work. What is ALREADY saved is shown by the
          details popup and cannot be changed here or anywhere. */}
      <CustodyTrailFields
        supabase={supabase}
        paymentMode={paymentMode}
        drafts={custody}
        onDraftsChange={setCustody}
        // The submitter is who collected the cash, not whoever is editing — an
        // admin correcting someone else's request must not become the collector
        // by opening the form.
        defaultActorId={r.submitted_by}
        disabled={saving}
      />

      {/* PAYMENT PROOF / REFERENCE — one heading over the reference and the
          notes, exactly as the submission form and Record Payment ask them. */}
      <ProofReferenceSection>
        <ProofReferenceField label="Payment reference">
          <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
            placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office (optional)"
            rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </ProofReferenceField>
        <ProofReferenceField label="Notes / remarks (optional)">
          <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
            placeholder="Any additional context for admin"
            rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </ProofReferenceField>
      </ProofReferenceSection>
      {error && <ErrorBanner message={error} />}
      {/* Once an approval has been detected there is nothing left to save here,
          so the form's actions collapse to a single dismissal that also
          refreshes the table (onSaved) — never a retry that must fail again. */}
      {stale ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onSaved} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Close
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={guard.requestClose} disabled={saving}
            className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSubmit || saving}
            className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            {!isAdmin && r.status === 'rejected'
              ? (saving ? 'Reapplying…' : 'Save & Reapply')
              : (saving ? 'Saving…' : 'Save Changes')}
          </button>
        </div>
      )}

      <DiscardConfirmation
        open={guard.asking}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discard}
      />
    </FinanceModal>
  )
}

// ── Admin Review presentation primitives ─────────────────────────────────────
// The review modal is an approval workspace, not a detail view: an admin reads
// three facts (how much, from whom, when), checks the routing and the proof,
// and commits one of three decisions. These primitives exist so that hierarchy
// is expressed once — a heavy figure band at the top, quiet dense facts in the
// middle, and one deliberate decision control — instead of every block wearing
// the same 12px-radius card and competing for attention.

// Top figure band. One hairline grid: the container paints the divider colour
// and each cell paints over it, so the 1px rules survive the cells wrapping on
// a narrow dialog (a per-cell borderLeft would not).
function FigureBand({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden',
      background: colors.border,
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '1px',
    }}>
      {children}
    </div>
  )
}

// One cell of the figure band. `lead` carries the amount at display weight; the
// other cells sit a step below it so the money is unmistakably the headline.
function FigureCell({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    <div style={{ background: colors.raised, padding: '11px 14px', minWidth: 0 }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{
        marginTop: lead ? '3px' : '4px',
        fontSize: lead ? '26px' : '15px',
        fontWeight: lead ? 700 : 600,
        color: colors.primary,
        lineHeight: lead ? 1.1 : 1.35,
        fontVariantNumeric: 'tabular-nums',
        wordBreak: 'break-word',
      }}>
        {value}
      </div>
    </div>
  )
}

// The three review decisions, defined once. Order is deliberate: the outcome an
// admin reaches for most sits first, and the destructive one last. Labels are
// the established workflow wording and are not changed here.
const REVIEW_DECISIONS: {
  key: AdminAction
  label: string
  hint: string
  color: string
  tint: string
  Icon: LucideIcon
}[] = [
  { key: 'approve',             label: 'Verify Payment',        hint: 'Confirm Finance has checked this payment', color: colors.green, tint: colors.greenTint, Icon: CircleCheck },
  { key: 'needs_clarification', label: 'Needs Clarification',   hint: 'Send back with a question',            color: colors.blue,  tint: colors.blueTint,  Icon: MessageCircleQuestion },
  { key: 'reject',              label: 'Reject',                hint: 'Decline this payment request',         color: colors.red,   tint: colors.redTint,   Icon: CircleX },
]

// One decision as a full-width choice row rather than a chip in a wrapping bar.
// Three chips labelled "Verify Payment" / "Needs Clarification" /
// "Reject" cannot sit on one line in a side column, so they wrapped into an
// uneven cluster that read as three unrelated buttons. Stacked rows give each
// outcome equal width, room for a one-line consequence, and a selected state
// that is obvious at a glance.
//
// Keyboard: these carry real radio semantics, so the group is one tab stop and
// the arrow keys move between the three (roving tabIndex driven by the parent).
function DecisionRow({
  decision: d,
  selected,
  first,
  tabIndex,
  innerRef,
  onSelect,
  onKeyDown,
}: {
  decision: (typeof REVIEW_DECISIONS)[number]
  selected: boolean
  first: boolean
  tabIndex: number
  innerRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void
}) {
  const [hover, setHover] = useState(false)
  const { Icon } = d
  return (
    <button
      ref={innerRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%', textAlign: 'left',
        padding: '10px 12px', cursor: 'pointer',
        border: 'none', borderTop: first ? 'none' : `1px solid ${colors.border}`,
        background: selected ? d.tint : hover ? colors.raised : 'transparent',
        // The selected row is marked on its leading edge as well as by tint, so
        // the choice survives for anyone who cannot separate the three tints.
        boxShadow: selected ? `inset 3px 0 0 ${d.color}` : 'none',
        transition: 'background 0.16s ease',
      }}
    >
      <Icon
        size={15}
        strokeWidth={2.2}
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: '1px', color: selected ? d.color : colors.muted }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: '13px', fontWeight: 600, lineHeight: 1.35,
          color: selected ? d.color : colors.primary,
        }}>
          {d.label}
        </span>
        <span style={{ display: 'block', fontSize: '11.5px', color: colors.tertiary, marginTop: '2px', lineHeight: 1.4 }}>
          {d.hint}
        </span>
      </span>
    </button>
  )
}

// ── Admin Review modal ────────────────────────────────────────────────────────

type AdminReviewModalProps = {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onActioned: () => void
}

function AdminReviewModal({ request: r, supabase, onClose, onActioned }: AdminReviewModalProps) {
  const [action,    setAction]    = useState<AdminAction | null>(null)
  const [adminNote, setAdminNote] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const noteRequired = action === 'needs_clarification' || action === 'reject'
  const canConfirm   = action !== null && (!noteRequired || adminNote.trim())

  const handleConfirm = async () => {
    if (!action) return
    setSaving(true)
    setError(null)

    if (action === 'approve') {
      // Confirming receipt never creates an order — see
      // approve_finance_payment_request in 20260690000000. A new_order
      // request always lands in approved_unlinked (Suspense) with order_id
      // left null; an existing_order request links straight to the order it
      // already carries. The client never allocates or chooses an order
      // number either way.
      const { error: rpcError } = await supabase.rpc('approve_finance_payment_request', {
        p_request_id: r.id,
        p_admin_note: adminNote.trim() || null,
      })
      setSaving(false)
      if (rpcError) { setError(friendlyDbErrorMessage(rpcError)); return }

      // A new_order request lands in Suspense; an existing_order request links
      // straight to its order — notify the creator with the matching wording.
      void notifyFinance(
        r.payment_against === 'new_order'
          ? { event: 'finance_approved_suspense', requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name }
          : { event: 'finance_approved_linked',   requestNumber: r.request_number, entityId: r.id, creatorId: r.submitted_by, clientName: r.client_name, orderNumber: r.order_number },
      )

      onActioned()
      return
    }

    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        admin_note: adminNote.trim() || null,
        status:     action === 'needs_clarification' ? 'needs_clarification' : 'rejected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setSaving(false)
    if (dbError) { setError(friendlyDbErrorMessage(dbError)); return }

    // Notify the creator of the outcome (non-blocking).
    void notifyFinance({
      event: action === 'needs_clarification' ? 'finance_clarification' : 'finance_rejected',
      requestNumber: r.request_number,
      entityId: r.id,
      creatorId: r.submitted_by,
      clientName: r.client_name,
    })

    onActioned()
  }

  // The decision currently selected, resolved once — it drives the note
  // placeholder, the footer sentence and the confirm button's colour, so all
  // three can never describe different outcomes.
  const selected = REVIEW_DECISIONS.find(d => d.key === action) ?? null

  // Roving tabIndex for the decision radiogroup: the group is a single tab
  // stop (the selected row, or the first when nothing is chosen yet) and the
  // arrow keys move the selection, which is what `role="radio"` promises.
  const decisionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const decisionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const forward  = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    const backward = e.key === 'ArrowUp'   || e.key === 'ArrowLeft'
    if (!forward && !backward) return
    e.preventDefault()
    const next = (i + (forward ? 1 : -1) + REVIEW_DECISIONS.length) % REVIEW_DECISIONS.length
    setAction(REVIEW_DECISIONS[next].key)
    decisionRefs.current[next]?.focus()
  }

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  // WHAT APPROVING THIS WILL ATTACH THE MONEY TO, read from the same projection
  // the requester's popup and the table read. Before this approval it is the
  // pending intent; the moment Approve is clicked it becomes an allocation, and
  // this block is then reading that instead.
  const destination = usePaymentDestination(supabase, r.id)
  const orderNoLine = orderNoCell(destination)

  // ── Figure band — the three facts an approval actually turns on ────────────
  // How much, from whom, and when the money arrived. Lifted out of the old
  // summary card and given the full dialog width: they were previously sharing
  // a card with five routing fields, which flattened the amount into just
  // another value and left the card looking large and half-empty.
  const top = (
    <FigureBand>
      <FigureCell label="Amount"       value={fmtAmount(r.amount)} lead />
      {/* NEVER BLANK. A Suspense payment has no customer to name, and
          customerDisplayName is the one place that decides what that reads as
          — never an empty cell, a 'null' or an 'undefined'. */}
      <FigureCell label="Client"       value={customerDisplayName(r.client_name)} />
      <FigureCell label="Payment Date" value={fmtDate(r.payment_date)} />
    </FigureBand>
  )

  const left = (
    <>
      {/* WHAT APPROVING THIS WILL ATTACH THE MONEY TO. First, above the routing
          facts, because it is the one thing an approver is deciding about: the
          allocation intent becomes a real allocation the moment they click
          Approve, and until then the row's own linkage columns say nothing. */}
      <PaymentDestinationSummary destination={destination} clientName={r.client_name} />

      {/* Routing — where this payment is aimed and how it came in. Quiet,
          dense, and deliberately lighter than the band above it: these are
          facts to check, not the headline. Every field the previous layout
          showed is still here, minus the amount/client/date now in the band. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <SectionHeader>Routing</SectionHeader>
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.raised,
          // Exactly two columns at every width. auto-fit would find room for a
          // third once the dialog stacks to one column on a narrow viewport,
          // breaking the 2×2 into a lopsided 3 + 1.
          padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          columnGap: '18px', rowGap: '11px',
        }}>
          <MetaItem label="Payment Against" value={paymentAgainstDisplay(destination)}
                    muted={!destination || destination.kind === 'suspense'} />
          <MetaItem label="Order Number"    value={orderNoLine.value} muted={orderNoLine.muted} />
          {/* ONE destination row in place of the Payment Mode + Received In
              pair, which was printing the same account name twice ("Paytm"
              over "Paytm") — the second only because a raw received_in was
              being mapped back to an account by a separate local table.
              Spanning both columns keeps the grid from ending on a lone empty
              cell, and leaves room for the helper that says what the account
              MEANS, which is the whole point: "PNB" alone does not tell an
              admin that cash was involved. */}
          <div style={{ gridColumn: '1 / -1' }}>
            <PaymentDestinationLine payment_mode={r.payment_mode} received_in={r.received_in} />
          </div>
        </div>
      </div>

      {/* WHO IS HOLDING THIS MONEY RIGHT NOW. For PNB and Paytm the mode says
          somebody physically carried it, and an admin about to confirm receipt
          has to be able to see the whole chain — not one collection and one
          handover, but every hand it passed through.

          THE ADMIN MAY ADD TO IT HERE, including after approval: a custody event
          is a statement about who carried cash, not about how much money
          arrived, so the post-approval freeze that protects the FIGURES has
          nothing to say about it. append_payment_custody_events decides that
          again server-side. */}
      <PaymentCustodyTrail
        supabase={supabase}
        payment={r}
        canAppend
        formatDateTime={fmtDateTime}
      />

      {/* PAYMENT PROOF / REFERENCE — the attachment, the reference and the note
          from sales, in ONE frame under ONE heading. They are three parts of the
          same question and they are asked together on all three entry forms, so
          an approver reads them together too. The note used to sit in a section
          of its own below this one, which made a review dialog with something to
          say wear two headings where one belongs.

          THE THREE COLUMNS ARE STILL THREE COLUMNS. This is a grouping, not a
          merge: proof_note is the reference, sales_note is the note, and the
          attachment is a row in payment_proof_attachments. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <SectionHeader>Payment Proof / Reference</SectionHeader>
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 12px' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em', width: '68px', flexShrink: 0 }}>Proof</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '9px 12px', borderTop: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em', width: '68px', flexShrink: 0, paddingTop: '2px' }}>Reference</span>
            <span style={{ fontSize: '13px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
              {r.proof_note || 'Not provided'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '9px 12px', borderTop: `1px solid ${colors.border}` }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em', width: '68px', flexShrink: 0, paddingTop: '2px' }}>Notes</span>
            <span style={{ fontSize: '13px', color: r.sales_note ? colors.secondary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {r.sales_note || 'No notes provided'}
            </span>
          </div>
        </div>
      </div>
    </>
  )

  const right = (
    <>
      {/* ── Decision — the one thing this modal exists to capture, so it is the
             only bordered card in this column and the only element carrying a
             tint. Business logic (approve RPC, status update for
             clarification/rejection, notifications) is untouched: this is the
             same three-way choice and the same admin note as before. ── */}
      <div style={{ border: `1px solid ${colors.borderSoft}`, borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{
          padding: '9px 12px', background: colors.raised, borderBottom: `1px solid ${colors.border}`,
          fontSize: '10px', fontWeight: 700, color: colors.secondary, textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Decision
        </div>

        <div role="radiogroup" aria-label="Review decision">
          {REVIEW_DECISIONS.map((d, i) => (
            <DecisionRow
              key={d.key}
              decision={d}
              first={i === 0}
              selected={action === d.key}
              tabIndex={action ? (action === d.key ? 0 : -1) : (i === 0 ? 0 : -1)}
              innerRef={el => { decisionRefs.current[i] = el }}
              onSelect={() => setAction(d.key)}
              onKeyDown={e => decisionKeyDown(e, i)}
            />
          ))}
        </div>

        {action && (
          <div style={{
            borderTop: `1px solid ${colors.border}`, padding: '12px',
            display: 'flex', flexDirection: 'column', gap: '10px',
          }}>
            {action === 'approve' && (() => {
              // WHAT APPROVAL WILL ACTUALLY DO, read from the pending intent
              // rather than from payment_target_type — which reads 'unallocated'
              // for every request the current form writes, and would have told an
              // admin that a Confirmed-Order payment was going to Suspense.
              const linksToOrder = destination?.kind === 'confirmed_order'
              const goesSomewhere = !!destination && destination.kind !== 'suspense'
              return (
                <div style={{
                  padding: '9px 11px', borderRadius: '8px',
                  background: goesSomewhere ? '#F0FDF4' : '#FFF7ED',
                  border: `1px solid ${goesSomewhere ? '#BBF7D0' : '#FED7AA'}`,
                  fontSize: '11.5px', color: goesSomewhere ? '#166534' : '#9A3412',
                  lineHeight: 1.5,
                }}>
                  {linksToOrder
                    ? `This payment will be verified and allocated to Order ${destination?.orderNumber ?? orderNoLine.value}.`
                    : destination?.kind === 'pi_draft'
                      ? `This payment will be verified and allocated to PI Draft ${destination.reference ?? ''}.`.trim()
                      : destination?.kind === 'mixed'
                        ? 'This payment will be verified and allocated across every record it names.'
                        : 'This payment will be verified and left unallocated. Attach it to an Order or a PI Draft afterwards through Allocate Funds.'}
                </div>
              )
            })()}

            <Field label={`Admin Note${noteRequired ? '' : ' (optional)'}`} required={noteRequired}>
              <textarea className="boe-input" value={adminNote} onChange={e => setAdminNote(e.target.value)}
                placeholder={
                  action === 'approve'             ? 'Optional note for the salesperson' :
                  action === 'needs_clarification' ? 'Explain what clarification is needed' :
                                                     'Explain why this is being rejected'
                }
                rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '13px' }} />
            </Field>
          </div>
        )}
      </div>

      {/* Activity — history, so it is rendered bare on the dialog surface. It
          keeps its own heading, query, ordering and event text; dropping the
          card around it is what stops it reading as a second panel of equal
          rank to the decision above. */}
      <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
    </>
  )

  // ── Commit bar ──────────────────────────────────────────────────────────────
  // Pinned below the body so the decision is always one click away, and stating
  // what is about to happen beside the button that does it — the amount and the
  // outcome together, so Confirm is never an unlabelled commitment.
  const footerNote = !action
    ? 'Select a decision to continue.'
    : noteRequired && !adminNote.trim()
      ? 'A note is required for this decision.'
      : action === 'approve'
        ? `${fmtAmount(r.amount)} will be verified as received.`
        : action === 'needs_clarification'
          ? `Returns to ${r.submitted_by_name ?? 'the salesperson'} for clarification.`
          : 'This payment request will be rejected.'

  const confirmDisabled = !canConfirm || saving

  const footer = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Errors live in the pinned bar, not the scroller, so a failure can
          never be scrolled away from the button that produced it. */}
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '11.5px', color: action ? colors.tertiary : colors.muted, minWidth: 0, lineHeight: 1.45 }}>
          {footerNote}
        </div>
        <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
          {/* boe-btn-ghost has no disabled treatment of its own, so the
              in-flight state is stated inline rather than left looking live. */}
          <button
            onClick={onClose}
            disabled={saving}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '7px 16px', fontSize: '13px', opacity: saving ? 0.55 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600, border: 'none',
              // The commit button wears the chosen outcome's colour, so approve
              // and reject are never one identical click apart.
              background: confirmDisabled ? colors.float : (selected?.color ?? colors.amber),
              color: confirmDisabled ? colors.muted : '#FFFFFF',
              cursor: confirmDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? (action === 'approve' ? 'Verifying…' : 'Saving…') : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <RequestModalShell
      requestNumber={r.human_payment_id}
      submittedLine={submittedLine}
      statusBadge={<StatusBadge status={r.status} />}
      ariaLabel={`Review payment ${r.human_payment_id}`}
      onClose={onClose}
      top={top}
      left={left}
      right={right}
      footer={footer}
      // This modal holds unsaved input (the admin note) — BOE form-modal
      // dismissal rule: a backdrop click never discards it. Escape and × still
      // close. See docs 05_Business_Rules.md → "Form Modal Dismissal Rule".
      closeOnBackdropClick={false}
    />
  )
}

// ── Delete confirm modal (admin only) ────────────────────────────────────────
//
// THE SHARED MODAL NOW, not a bespoke copy. Deletion is admin-only for a
// payment of ANY status (20261011000000 §3), requires a reason and the typed
// Payment ID, and goes through the durable claim protocol at
// /api/finance/payments/delete — exactly what
// @/components/finance/DeletePaymentModal already implements, and what
// Received Payments uses too. This page used to keep its own DeleteConfirmModal
// calling the OLD 1-argument begin_finance_payment_deletion with no reason or
// confirmation; that shape no longer exists server-side, so the bespoke copy is
// retired in favour of the one shared implementation. See the render call site
// near the bottom of this file for the wiring.

// ── Payments table ────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: 700,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

// Exported for src/app/finance/paymentRequestsTable.render.test.tsx, which
// renders this table for real rather than pinning strings in this file: a
// source guard cannot prove that a column landed in the markup in the right
// place, that a removed badge is actually absent, or that a null payment mode
// came out as an em dash instead of the word "null".
export function PaymentsTable({
  rows,
  destinations,
  isAdmin,
  userId,
  cutoff,
  highlightId,
  onRowClick,
  onView,
  onEdit,
  onDelete,
}: {
  rows: PaymentRequest[]
  /**
   * What each payment is FOR, by payment id — read for the whole page in ONE
   * request (loadPaymentDestinations) rather than per row.
   *
   * A MISSING ENTRY IS NOT A SUSPENSE ENTRY. It means the destinations have not
   * arrived yet, and the cells say "Reading…" rather than claiming the payment
   * is attached to nothing.
   */
  destinations: Map<string, PaymentDestination> | null
  /** Ownership rules and creator-facing copy only — not approval authority. */
  isAdmin: boolean
  // NO APPROVAL CAPABILITY IS PASSED HERE ANY MORE. This table drew one
  // approver-only thing — a "Review" chip beside the client name — and that is
  // gone. Approval authority still gates the two places it is actually
  // exercised: the row-click review router (`caps.canApprovePayment && r.status
  // === 'pending_approval'`) and the review modal it opens. A table that took
  // the capability only to tint a cell was an invitation to grow a second,
  // weaker gate beside the real one.
  userId: string
  cutoff: number
  highlightId?: string | null
  onRowClick: (r: PaymentRequest) => void
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
  onDelete: (r: PaymentRequest) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    // overflowX:auto is retained only as a narrow-mobile fallback; at desktop
    // width the compact 9-column set fits without scrolling (no forced minWidth).
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        {/* ── WHY A COLGROUP, AND WHY PERCENTAGES ──────────────────────────
            Every cell in this table is `whiteSpace: nowrap`, so with nothing
            declared the browser gave each column its content width and then
            handed ALL the leftover page width to the widest one — which is
            Client. That is the large blank band between Client and Amount:
            not padding anybody chose, just the residue landing in one place.

            These are hints, not a fixed layout. `table-layout` stays `auto`,
            so a column whose content genuinely needs more than its share
            still takes it, and the three long-text cells keep their own
            ellipsis + title fallback underneath. A fixed layout would have
            clipped names on a 1280px laptop instead, which is the thing this
            change is not allowed to do. They total 100. */}
        <colgroup>
          <col style={{ width: '8%'  }} />{/* Payment ID   — monospace, fixed shape */}
          <col style={{ width: '15%' }} />{/* Client       — truncates past this */}
          <col style={{ width: '9%'  }} />{/* Amount */}
          <col style={{ width: '10%' }} />{/* Payment Date */}
          <col style={{ width: '10%' }} />{/* Payment Mode */}
          <col style={{ width: '16%' }} />{/* Against      — the longest prose */}
          <col style={{ width: '11%' }} />{/* Status */}
          <col style={{ width: '10%' }} />{/* Requested By */}
          <col style={{ width: '11%' }} />{/* Action */}
        </colgroup>
        <thead>
          <tr>
            <th style={TH_STYLE}>Payment ID</th>
            <th style={TH_STYLE}>Client</th>
            {/* Amount is LEFT-aligned, header and value together. Right
                alignment is for a column that is summed down its length;
                this one never is, and the ragged left edge it produced sat
                directly against the blank band above. tabular-nums keeps the
                digits in vertical register without it. */}
            <th style={TH_STYLE}>Amount</th>
            <th style={TH_STYLE}>Payment Date</th>
            <th style={TH_STYLE}>Payment Mode</th>
            <th style={TH_STYLE}>Against</th>
            <th style={TH_STYLE}>Status</th>
            <th style={TH_STYLE}>Requested By</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isPending  = r.status === 'pending_approval'
            const isClarif   = r.status === 'needs_clarification'
            const isRejected = r.status === 'rejected'
            const accentColor =
              isPending  ? '#F59E0B' :
              isClarif   ? colors.blue :
              isRejected ? colors.red :
              'transparent'

            // Approved requests are view-only here for everyone, admins
            // included — they belong to Received Payments from that point on.
            const canManage   = canManageRequest(r, isAdmin, userId)
            const showReapply = canManage && !isAdmin && isRejected
            const showEdit    = canManage && !showReapply
            // DELETE IS ADMIN-ONLY, FOR ANY STATUS (20261011000000 §3a) — a
            // narrower, separate rule from canManage, which still grants
            // Edit/Reapply to the submitter of their own unapproved request.
            const showDelete  = canDeletePayment(r, { isAdmin })
            const isHighlighted = r.id === highlightId

            // `undefined` while the page's destinations are still in flight;
            // `null` once they have arrived and this payment has none.
            const destination = destinations ? destinations.get(r.id) ?? null : undefined
            const against = paymentAgainstDisplay(destination)
            const hasDestination = !!destination && destination.kind !== 'suspense'

            return (
              <tr
                key={r.id}
                id={`payment-row-${r.id}`}
                onClick={() => onRowClick(r)}
                style={{ cursor: 'pointer', borderLeft: `3px solid ${accentColor}`, background: isHighlighted ? colors.amberTint : undefined }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = isHighlighted ? colors.amberTint : 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '11px', color: colors.muted, fontFamily: 'monospace, monospace', fontVariantNumeric: 'tabular-nums' }}>
                  {r.human_payment_id}
                </td>
                <td style={TD}>
                  {/* THE CLIENT CELL HOLDS THE CLIENT NAME, AND NOTHING ELSE.
                      It used to carry a "Review" chip for approvers on a
                      pending row. That said nothing the Status column two
                      across did not already say — it reads "Pending Approval"
                      on the same row — and it said it to only some viewers, so
                      the same record looked like two different records
                      depending on who opened it. Removed rather than restyled
                      or replaced: a second status badge beside a name is the
                      problem, not its colour.

                      Truncates instead of widening the table; full name via title. */}
                  <div
                    title={customerDisplayName(r.client_name)}
                    style={{
                      // Just under the column's own share (15% — about 200px on
                      // a 1366px laptop, 216px on a 1440px one), so the cap and
                      // the column agree instead of the cap truncating early
                      // and leaving the blank strip back where it started.
                      maxWidth: '200px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontSize: '13px', fontWeight: 600,
                      // A payment with no customer is named in the muted tone
                      // the rest of the page uses for "nothing recorded", so
                      // it never reads as a customer actually called that.
                      color: r.client_name ? colors.primary : colors.muted,
                    }}
                  >
                    {customerDisplayName(r.client_name)}
                  </div>
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmount(r.amount)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {fmtDate(r.payment_date)}
                </td>
                {/* PAYMENT MODE — the value the row already carries.
                    `payment_mode` has been in this page's bounded list select
                    since it was written, so this column adds no query, and no
                    per-row request. It is NOT derived from the destination:
                    that is the allocation ledger's answer to "what is this
                    payment FOR", a different question, and the Against column
                    two across is where it belongs.

                    paymentModeLabel is the one formatter every payment surface
                    already reads — it writes the four current modes as HDFC /
                    PNB / Paytm / Canara, the five retired ones as Bank
                    Transfer / Cash / UPI / Cheque / Other, an empty or null
                    value as an em dash, and anything neither list knows AS IT
                    IS STORED rather than inventing a label for it. */}
                <td style={{ ...TD, fontSize: '12px', color: r.payment_mode ? colors.secondary : colors.muted }}>
                  {paymentModeLabel(r.payment_mode)}
                </td>
                <td style={TD}>
                  {/* WHAT THIS PAYMENT IS FOR — the destination, from the
                      allocation ledger and the pending intent. This column used
                      to read order_number / order_request_number /
                      payment_against and printed "New Order — no order created
                      yet" for every request the current form writes. */}
                  <div
                    title={against}
                    style={{ maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: hasDestination ? colors.secondary : colors.muted, fontStyle: hasDestination ? 'normal' : 'italic' }}
                  >
                    {against}
                  </div>
                </td>
                <td style={TD}>
                  <StatusBadge status={r.status} destination={destination} />
                  {isStaleClarification(r, cutoff) && <StaleBadge />}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  <div
                    title={r.submitted_by_name ?? undefined}
                    style={{ maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {r.submitted_by_name ?? '—'}
                  </div>
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <div
                    style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onView(r)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                    >
                      View
                    </button>
                    {showEdit && (
                      <button
                        onClick={() => onEdit(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                      >
                        Edit
                      </button>
                    )}
                    {showReapply && (
                      <button
                        onClick={() => onEdit(r)}
                        className="boe-btn boe-btn-primary"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                      >
                        Reapply
                      </button>
                    )}
                    {showDelete && (
                      <button
                        onClick={() => onDelete(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.red }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <FinancePageInner />
    </Suspense>
  )
}

function FinancePageInner() {
  const [pageLoading, setPageLoading]   = useState(true)
  const [userId, setUserId]             = useState<string>('')
  const [isAdmin, setIsAdmin]           = useState(false)
  // Finance authority for the SIGNED-IN user, resolved from the permission
  // engine. Starts at "nothing" and is only ever widened once the resolver has
  // answered, so an administrative control cannot flash before it is
  // authorized. Admins short-circuit inside deriveFinanceCapabilities, so
  // their behaviour is unchanged.
  const [caps, setCaps]                 = useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)
  const [profile, setProfile]           = useState<UserProfile | null>(null)
  const [requests, setRequests]         = useState<PaymentRequest[]>([])
  // WHAT EACH ROW IS FOR, by payment id. `null` means "not read back yet", which
  // the table shows as such rather than as "attached to nothing".
  const [destinations, setDestinations]  = useState<Map<string, PaymentDestination> | null>(null)
  const [listLoading, setListLoading]   = useState(false)
  const [showForm, setShowForm]           = useState(false)
  // Prefill carried in from another module's "Add Payment" action (currently
  // the Order Requests details modal). Cleared with the form, so the plain
  // "+ New" button always opens an empty one.
  const [formPrefill, setFormPrefill]     = useState<{ clientName: string; salesNote: string; contextLabel: string } | null>(null)
  const [reviewRequest, setReviewRequest] = useState<PaymentRequest | null>(null)
  const [detailRequest, setDetailRequest] = useState<PaymentRequest | null>(null)
  const [editRequest,   setEditRequest]   = useState<PaymentRequest | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<PaymentRequest | null>(null)
  const [search, setSearch]             = useState('')
  const [highlightId, setHighlightId]   = useState<string | null>(null)
  // ── Paging ──
  // The list carried no range and no limit, and PostgREST truncates at 1000 rows
  // SILENTLY — no error, no warning, a plausible-looking array. This page looks
  // like a small queue because it is scoped to the three request-stage statuses,
  // but `rejected` accumulates forever: the Archive tab exists precisely because
  // it does, and Archive — the tab whose whole purpose is the OLDEST rejected
  // requests — is the first one that would empty while its badge kept counting.
  const [page,        setPage]        = useState(1)
  const [total,       setTotal]       = useState<number | null>(null)
  // The four counted tabs. 'all' is derived from three of them — see tabCounts.
  const [counts,      setCounts]      = useState<Record<string, number | null>>({})
  const [loadError,   setLoadError]   = useState<string | null>(null)

  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()
  const queryClient  = useQueryClient()

  // ?tab= from the Admin Action Queue selects the initial tab; manual tab
  // clicks below still just call setActiveTab and are otherwise untouched.
  const [activeTab, setActiveTab] = useState<FilterTab>(() => parseFilterTab(searchParams.get('tab')))

  // Guards the one-time ?request= deep-link resolution below so it can never
  // re-fire (StrictMode double-invoke, unrelated rerenders) and reopen a
  // modal the admin already closed.
  const deepLinkHandled = useRef(false)

  /**
   * The search the four badges were last counted against.
   *
   * THE BADGES DO NOT DEPEND ON THE ACTIVE TAB. loadCounts walks COUNTED_TABS —
   * a fixed list — and never reads activeTab, so every tab's badge is already
   * correct whichever tab is open. Re-running it on a tab click cost four head
   * requests to arrive at the four numbers already on screen.
   *
   * It DOES depend on the search, because the badges describe the searched set.
   * Selecting a tab also clears the search, so the two genuinely do move
   * together when a search was active — which is why this compares the value
   * rather than assuming a tab click never affects the counts.
   *
   * `undefined` until the first count, which no real filter value can equal, so
   * the first change after mount always counts.
   */
  const countedSearch = useRef<string | null | undefined>(undefined)

  // The narrowing, as the DATABASE will be asked it. One instant decides the
  // archive cutoff for the list AND for all four counts, so a record on the
  // boundary cannot be in one answer and out of the other.
  const filters = useMemo(() => ({
    tab: activeTab,
    search: paymentRequestsSearchFilter(search),
  }), [activeTab, search])

  /**
   * The archive cutoff the LOADED rows were selected against.
   *
   * Read from the clock inside the loader, never during render: a render is
   * required to be pure, and a cutoff that moved every time the component
   * re-drew could put a record on the boundary in one answer and out of the
   * next. Storing what the QUERY used also guarantees the in-memory gate below
   * tests rows against the same instant the database did.
   *
   * 0 until the first load, which archives nothing — the safe direction: a
   * record is shown in the active tab rather than hidden in Archive.
   */
  const [cutoffMs, setCutoffMs] = useState(0)

  // Guards against an out-of-order response. Each load claims a number; only the
  // newest may write to state. Without it a slow query for "REQ" can land after
  // a fast one for "REQ-2026" and repaint the wider result under a narrower box.
  const loadToken = useRef(0)

  /** The status scope and the narrowing, applied to any query over this table. */
  const scopedQuery = <T extends {
    in(column: string, values: string[]): T
    or(filters: string): T
    eq(column: string, value: string): T
    is(column: string, value: null): T
    not(column: string, op: string, value: null): T
  }>(query: T): T => {
    // Request-stage records ONLY. This replaces a .neq('approved_linked'),
    // which let approved_unlinked through and put confirmed money on the
    // Payment Requests page. Filtering positively means a status added later
    // has to be named here to appear, rather than appearing by default.
    let scoped = query.in('status', REQUEST_STAGE_STATUSES as unknown as string[])
    if (filters.search) scoped = scoped.or(filters.search)
    return scoped
  }

  /** The tab's own clauses, applied on top of the shared scope. */
  const applyTab = <T extends {
    or(filters: string): T
    eq(column: string, value: string): T
    is(column: string, value: null): T
    not(column: string, op: string, value: null): T
  }>(query: T, tab: FilterTab, cutoffIso: string): T => {
    let scoped = query
    for (const clause of tabClauses(tab, cutoffIso)) {
      if (clause.kind === 'or') scoped = scoped.or(clause.filters)
      else if (clause.kind === 'eq') scoped = scoped.eq(clause.column, clause.value)
      else if (clause.kind === 'isNull') scoped = scoped.is(clause.column, null)
      else if (clause.kind === 'notNull') scoped = scoped.not(clause.column, 'is', null)
    }
    return scoped
  }

  // ── Fetch — one page, narrowed in the database ───────────────────────────────
  //
  // EVERY TAB AND THE SEARCH MOVED SERVER-SIDE, and not for speed: a tab applied
  // in the browser over ONE PAGE narrows fifty rows and silently hides every
  // match on page two. Paging without moving them would have replaced a
  // truncation defect with a filtering one.
  //
  // The predicates are the SAME ONES tabMatches applies — see
  // paymentRequestsQuery.ts, where a test evaluates both forms against the same
  // rows and requires them to agree on every one. The in-memory gate is kept
  // below as a second, independent check.
  const loadRequests = async (cutoffIso: string) => {
    const token = ++loadToken.current
    setListLoading(true)

    const range = pageRange(page)
    const { data, count, error } = await applyTab(
      scopedQuery(
        supabase
          .from('finance_payment_requests')
          .select(`
            id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
            received_in, collected_by_user_id, collected_from_text,
            handed_over_to_user_id, handed_over_at, collection_handover_note,
            proof_note, order_number, order_id,
            order_request_id, order_request_number, sales_note,
            payment_against, payment_target_type, status, submitted_by, admin_note, created_at,
            updated_at, rejected_at, clarification_requested_at,
            submitted_by_user:users!submitted_by(full_name),
            collected_by_user:users!collected_by_user_id(full_name),
            handed_over_to_user:users!handed_over_to_user_id(full_name)
          `, { count: 'exact' }),
      ),
      activeTab,
      cutoffIso,
    )
      // ORDERED BY created_at AND THEN BY id. range() maps to LIMIT/OFFSET,
      // which promises nothing about row order unless the ordering is unique —
      // two requests created in the same instant could otherwise swap between
      // pages, showing one twice and hiding the other.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(range.from, range.to)

    // A newer load has been issued; this answer is stale and must not repaint
    // the screen underneath it.
    if (token !== loadToken.current) return

    if (error) {
      // The list keeps whatever it had rather than blanking: a failed refresh is
      // not evidence that the records are gone. The banner says which it is.
      setLoadError('Could not load payment requests. Check your connection and try again.')
      setListLoading(false)
      return
    }
    setLoadError(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PaymentRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      submitted_by_name:   r.submitted_by_user?.full_name   ?? undefined,
      collected_by_name:   r.collected_by_user?.full_name   ?? undefined,
      handed_over_to_name: r.handed_over_to_user?.full_name ?? undefined,
      submitted_by_user:   undefined,
      collected_by_user:   undefined,
      handed_over_to_user: undefined,
    }))
    setRequests(mapped)
    setTotal(count ?? null)
    setListLoading(false)

    // ── WHAT EACH OF THESE PAYMENTS IS FOR ──
    //
    // ONE request for the whole page, by id, after the rows are on screen. The
    // list draws immediately and the Against column fills in — a per-row read
    // would be fifty round trips for one table.
    //
    // The map is CLEARED FIRST so a stale page's destinations cannot be shown
    // beside a new page's rows, and the same token guard that protects the rows
    // protects this: a slow answer for page one never repaints page two.
    setDestinations(null)
    const found = await loadPaymentDestinations(supabase, mapped.map(m => m.id))
    if (token !== loadToken.current) return
    setDestinations(found)

    // A PAGE BEYOND THE END, corrected here rather than in an effect watching
    // the total. Switching to a tab with fewer records would otherwise leave the
    // reader on page four of a one-page result, staring at an empty table over a
    // filter that matches plenty. Setting it from this async callback — not from
    // a render or an effect the render caused — is what keeps the component
    // pure; the change re-runs the page effect once and settles.
    if (count !== null && count !== undefined) {
      const corrected = clampPage(page, count)
      if (corrected !== page) setPage(corrected)
    }
  }

  /**
   * The four tab badges, counted by the database.
   *
   * HEAD REQUESTS: `count: 'exact', head: true` transfers no rows at all, so
   * four of them cost four counts and no payload. They run TOGETHER, so the
   * badges cost one wait rather than four.
   *
   * FOUR AND NOT FIVE — 'all' is exactly pending + clarification + rejected and
   * is derived, which saves a round trip and cannot disagree with the tabs it is
   * the sum of. A count that fails leaves its badge unknown rather than zero: a
   * confident 0 on a tab holding records is worse than no number.
   */
  const loadCounts = async (cutoffIso: string) => {
    const token = loadToken.current
    const results = await Promise.all(COUNTED_TABS.map(async tab => {
      const { count, error } = await applyTab(
        scopedQuery(
          supabase
            .from('finance_payment_requests')
            .select('id', { count: 'exact', head: true }),
        ),
        tab,
        cutoffIso,
      )
      return [tab, error ? null : (count ?? null)] as const
    }))

    if (token !== loadToken.current) return
    setCounts(Object.fromEntries(results))
    // What the badges now describe. Recorded by the function that computes
    // them, so the two can never disagree about which narrowing they are for.
    // A discarded round (token moved) deliberately leaves it alone: the counts
    // on screen are still the previous search's, and the next change must
    // recount. Erring toward recounting is the safe direction.
    countedSearch.current = filters.search
  }

  /**
   * One round of reads: the page of rows and the four badges, against ONE
   * cutoff.
   *
   * The cutoff is read from the clock HERE — in an async function, never during
   * render — and handed to both. Two loaders each calling Date.now() could, for
   * a record sitting exactly on the 30-day boundary, put it in the list and out
   * of the count in the same breath.
   */
  const reload = async () => {
    const cutoffIso = archiveCutoffIso(Date.now())
    setCutoffMs(Date.parse(cutoffIso))
    await Promise.all([loadRequests(cutoffIso), loadCounts(cutoffIso)])
  }

  /**
   * After a mutation: the page of rows AND the badges.
   *
   * A review, a correction, a delete or a reapply can move a record between
   * tabs, so refreshing the list alone would leave a badge counting a record
   * that is no longer there. The two run together — the counts are head-only
   * requests and carry no payload.
   */
  const refreshAfterMutation = () => { reload() }

  // ── Auth + profile ───────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id
      setUserId(uid)

      // ── THE PROFILE, THE PERMISSIONS AND THE LIST, TOGETHER ──
      //
      // These ran one after the next, so the page waited for four latencies end
      // to end before it drew anything — and none of the last three needs
      // another's answer. Every row loadRequests reads is scoped by RLS, not by
      // the capabilities being resolved beside it. The same shape the Received
      // Payments pages and the Order detail now use.
      //
      // NOTHING ABOUT AUTHORITY CHANGED. `caps` still starts empty and is still
      // resolved by resolve_effective_permissions before anything can be
      // clicked: pageLoading is not cleared until all three have landed, and a
      // failed resolve still falls back to NO capabilities rather than to the
      // role.
      const [{ data: me }, financePerms] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', uid)
          .single(),
        getEffectivePermissions(supabase, uid, 'finance').catch(() => []),
        // The rows AND the four badge counts, in the same group. The counts are
        // head-only — `count: 'exact', head: true` transfers no rows — so they
        // cost four counts and no payload, and being in this group they cost no
        // additional wait.
        reload(),
      ])

      setProfile(me as UserProfile)
      setIsAdmin(me?.role === 'admin')
      setCaps(deriveFinanceCapabilities(me?.role, financePerms))

      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Re-read when the narrowing or the page changes ───────────────────────────
  //
  // The tab and the search are answered by the DATABASE now, so a change to
  // either is a new query rather than a re-filter of rows already in hand. The
  // search box is DEBOUNCED — without it every keystroke would be a round trip
  // and four count queries — while a tab click is a single deliberate action and
  // is not delayed.
  //
  // Skipped until the first load has finished, so the mount does not issue the
  // same query twice.
  useEffect(() => {
    if (pageLoading) return
    const delay = filters.search === null ? 0 : SEARCH_DEBOUNCE_MS
    const timer = setTimeout(() => {
      // The badges describe the SEARCHED set, so they move with the narrowing —
      // and with NOTHING else. A tab click that leaves the search where it was
      // re-reads the rows for the newly selected tab and keeps the four counts
      // already on screen, which are still exactly right (see countedSearch).
      // That turns a tab click from five round trips into one.
      if (countedSearch.current === filters.search) {
        loadRequests(new Date(cutoffMs).toISOString())
      } else {
        reload()
      }
    }, delay)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, activeTab])

  // A page change is one more page of the SAME narrowing, so the badges are
  // already right and only the rows are re-read — against the cutoff the badges
  // were counted with, so the page and its tab totals describe one instant.
  //
  // Deferred by a timer rather than fetched in the effect body: the loader sets
  // state on its first line, and doing that synchronously inside an effect is
  // the cascading-render pattern react-hooks/set-state-in-effect exists to
  // catch. The zero delay only moves it past the commit.
  useEffect(() => {
    if (pageLoading) return
    const timer = setTimeout(() => { loadRequests(new Date(cutoffMs).toISOString()) }, 0)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // ── Deep-link resolution (Admin Action Queue → ?tab=&request=) ───────────────
  // Runs exactly once, once `requests` is loaded. A missing, invalid, or
  // no-longer-pending id is a silent no-op — the normal tab still renders,
  // no fatal error, no claim that the action is still available.
  useEffect(() => {
    const resolveDeepLink = async () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      // ?new=1[&client=&note=] — another module asked for a new payment request
      // against a client it already knows. Opens THIS page's own submission
      // form prefilled; nothing is created until the user submits it here.
      if (searchParams.get('new') === '1') {
        const client = searchParams.get('client')?.trim() ?? ''
        const note   = searchParams.get('note')?.trim() ?? ''
        setFormPrefill({ clientName: client, salesNote: note, contextLabel: note })
        setShowForm(true)
        router.replace('/finance')
        return
      }

      const requestId = searchParams.get('request')
      if (!requestId) return

      // ── THE RECORD MAY NOT BE ON THIS PAGE ──
      //
      // Before the list was paged it held every request-stage record, so a deep
      // link's target was always among the loaded rows. Now it is one page of
      // fifty, and a link into an older request — exactly what the Admin Action
      // Queue sends for an ageing item — would silently do nothing: no modal, no
      // highlight, no explanation.
      //
      // So a miss is followed by ONE read for that ONE record, by its id, from
      // the same RLS-protected table the list reads. A record this caller may
      // not see comes back empty and the page simply renders its tab, which is
      // what a stale or unauthorized link has always done here. Nothing is
      // highlighted in that case, because the row is genuinely not on screen —
      // but the record the link was for does open.
      let match = requests.find(r => r.id === requestId) ?? null
      const onThisPage = match !== null

      if (!match) {
        const { data } = await supabase
          .from('finance_payment_requests')
          .select(`
            id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
            received_in, collected_by_user_id, collected_from_text,
            handed_over_to_user_id, handed_over_at, collection_handover_note,
            proof_note, order_number, order_id,
            order_request_id, order_request_number, sales_note,
            payment_against, payment_target_type, status, submitted_by, admin_note, created_at,
            updated_at, rejected_at, clarification_requested_at,
            submitted_by_user:users!submitted_by(full_name),
            collected_by_user:users!collected_by_user_id(full_name),
            handed_over_to_user:users!handed_over_to_user_id(full_name)
          `)
          .eq('id', requestId)
          // Request-stage only, exactly as the list is. A confirmed payment
          // reached through a stale link belongs to Received Payments and must
          // not open here.
          .in('status', REQUEST_STAGE_STATUSES as unknown as string[])
          .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = data as any
        match = row
          ? { ...row,
              submitted_by_name:   row.submitted_by_user?.full_name   ?? undefined,
              collected_by_name:   row.collected_by_user?.full_name   ?? undefined,
              handed_over_to_name: row.handed_over_to_user?.full_name ?? undefined,
              submitted_by_user:   undefined,
              collected_by_user:   undefined,
              handed_over_to_user: undefined } as PaymentRequest
          : null
      }

      if (match) {
        if (onThisPage) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`payment-row-${match.id}`)?.scrollIntoView({ block: 'center' })
        }
        if (caps.canApprovePayment && match.status === 'pending_approval') {
          setReviewRequest(match)
        } else {
          setDetailRequest(match)
        }
      }
      // Drop the record param so a refresh or back-navigation can't reopen
      // the modal; keep the tab so the deep link still lands correctly.
      router.replace(`/finance?tab=${activeTab}`)
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // ── The page's rows ──────────────────────────────────────────────────────────
  //
  // THE ROWS ARE THE ANSWER, not a starting point to filter. The tab and the
  // search are database predicates now; re-applying them here would narrow the
  // fifty rows in hand and silently hide every match on the next page.
  //
  // tabMatches IS STILL APPLIED, and deliberately: it is the SAME predicate the
  // query was built from, used as a second and independent gate over whatever is
  // in memory. A row approved by somebody else since this page loaded must not
  // linger in a tab the query would no longer return it for. It removes rows; it
  // can never add one, so it cannot disagree with the count beside it in the
  // direction that matters.
  const visible = useMemo(
    () => requests.filter(r => tabMatches(r, activeTab, cutoffMs)),
    [requests, activeTab, cutoffMs])

  // ── The tab badges ───────────────────────────────────────────────────────────
  // Counted by the DATABASE across the whole narrowed set — the old counts were
  // taken over the rows that happened to be loaded, which was every row only
  // while the query was unbounded. 'all' is derived from three of the four; a
  // count that failed leaves its badge unknown rather than a confident zero.
  const tabCount = useMemo(() => tabCounts(counts), [counts])
  const pages = pageCount(total)

  // ── Row click handler ────────────────────────────────────────────────────────
  const handleRowClick = (r: PaymentRequest) => {
    if (caps.canApprovePayment && r.status === 'pending_approval') {
      setReviewRequest(r)
    } else {
      setDetailRequest(r)
    }
  }

  if (pageLoading) return <LoadingScreen />

  return (
    <FinanceLayout
      profile={profile}
      title="Payment Requests"
      subtitle="Sales can submit customer payment details here for admin approval."
      onSignOut={handleSignOut}
      onRefresh={reload}
      actions={
        <button onClick={() => { setFormPrefill(null); setShowForm(true) }} className="boe-btn boe-btn-primary"
          style={{ padding: '6px 14px', fontSize: '12px' }}>
          + New
        </button>
      }
    >
      {/* ── Search toolbar ── sits above the card so the form control and the
          status navigation below never read as the same kind of control. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        marginBottom: '10px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: colors.raised, border: `1px solid ${colors.border}`,
          borderRadius: '8px', padding: '6px 10px',
          flex: 1, minWidth: '180px', maxWidth: '320px',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Client or order…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary, minWidth: 0 }}
          />
          {search && (
            <button onClick={() => { setSearch(''); setPage(1) }} aria-label="Clear search" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 0, lineHeight: 1, fontSize: '13px' }}>✕</button>
          )}
        </div>
      </div>

      <div className="boe-card" style={{ overflow: 'hidden' }}>

        {/* ── Status navigation ── */}
        <StatusTabs
          tabs={FILTER_TABS.map(t => ({ ...t, count: tabCount[t.key] }))}
          active={activeTab}
          onSelect={key => { setActiveTab(key); setSearch(''); setPage(1) }}
          summary={
            // The size of the WHOLE narrowed set, from the database's exact
            // count — not the length of the page in hand, which understates it
            // the moment there is more than one page.
            resultSummary({
              loading: listLoading,
              shown: visible.length,
              total,
              narrowed: search.trim() !== '',
              page,
              pages,
              noun: 'request',
            })
          }
        />

        {/* A FAILED REFRESH IS NOT EVIDENCE THE RECORDS ARE GONE. The rows
            already on screen stay, and this says which it is and offers the way
            back — rather than an empty table that reads as "no requests". */}
        {loadError && (
          <div
            role="alert"
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
              background: 'rgba(217,79,79,0.08)', color: '#C13030', fontSize: '12px',
            }}
          >
            <span style={{ flex: 1, minWidth: '200px' }}>{loadError}</span>
            <button onClick={refreshAfterMutation} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
              Retry
            </button>
          </div>
        )}

        {/* ── Table ── */}
        {listLoading ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          /* TWO DIFFERENT EMPTIES. "No pending payment requests" is a statement
             about the business; "no results for X" is a statement about the
             search, and it offers the way out. Confusing the two sends somebody
             hunting for a record that is merely filtered. */
          <div style={{ padding: '40px 20px', textAlign: 'center', color: colors.muted, fontSize: '13px', lineHeight: 1.6 }}>
            {search.trim() ? (
              <>
                No results for &ldquo;{search.trim()}&rdquo;.
                <div style={{ marginTop: '10px' }}>
                  <button onClick={() => { setSearch(''); setPage(1) }} className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }}>
                    Clear search
                  </button>
                </div>
              </>
            ) : EMPTY_MESSAGES[activeTab]}
          </div>
        ) : (
          <PaymentsTable
            destinations={destinations}
            rows={visible}
            isAdmin={isAdmin}
            userId={userId}
            cutoff={cutoffMs}
            highlightId={highlightId}
            onRowClick={handleRowClick}
            onView={r => setDetailRequest(r)}
            onEdit={r => setEditRequest(r)}
            onDelete={r => setDeleteRequest(r)}
          />
        )}

        {/* ── Paging ──
            Rendered only when there is more than one page, so a short queue
            looks exactly as it always has. ?tab= and ?request= deep links are
            unaffected: the tab is a filter, and a request that is not on the
            loaded page is fetched by its own id. */}
        {!listLoading && pages > 1 && (
          <nav
            aria-label="Payment request pages"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
              padding: '10px 12px', borderTop: `1px solid ${colors.border}`,
            }}
          >
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '5px 12px', fontSize: '12px', opacity: page <= 1 ? 0.5 : 1, cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
            >
              Previous
            </button>
            <span style={{ fontSize: '12px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
              Page {page} of {pages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '5px 12px', fontSize: '12px', opacity: page >= pages ? 0.5 : 1, cursor: page >= pages ? 'not-allowed' : 'pointer' }}
            >
              Next
            </button>
          </nav>
        )}

      </div>

      {/* ── Modals ── */}
      {showForm && (
        <NewPaymentConfirmationModal
          userId={userId}
          supabase={supabase}
          initialClientName={formPrefill?.clientName}
          initialSalesNote={formPrefill?.salesNote}
          contextLabel={formPrefill?.contextLabel}
          onClose={() => { setShowForm(false); setFormPrefill(null) }}
          onSaved={() => { setShowForm(false); setFormPrefill(null); refreshAfterMutation() }}
        />
      )}
      {reviewRequest && (
        <AdminReviewModal
          request={reviewRequest}
          supabase={supabase}
          onClose={() => setReviewRequest(null)}
          // Approval is the ONE action on this page that creates a received
          // payment — a new_order approval lands in suspense with no linkage, so
          // the sidebar's Non-Linked count changes the moment it commits.
          // Clarify and Reject keep the record at request stage and move no
          // count, but they share this callback and re-checking is free.
          onActioned={() => {
            setReviewRequest(null)
            refreshAfterMutation()
            queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
          }}
        />
      )}
      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          isAdmin={isAdmin}
          mayCorrectPayments={caps.canCorrectOrReversePayment}
          mayApprovePayments={caps.canApprovePayment}
          userId={userId}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); refreshAfterMutation() }}
          // Details hands off to the same two modals the table uses; only one
          // Finance modal is open at a time, so it closes as they open.
          onEdit={r => { setDetailRequest(null); setEditRequest(r) }}
          onDelete={r => { setDetailRequest(null); setDeleteRequest(r) }}
        />
      )}
      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          isAdmin={isAdmin}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); refreshAfterMutation() }}
        />
      )}
      {/* DELETE PAYMENT REQUEST — the shared modal (Requirement 4), admin-only
          for any status. This page tracks no allocation-links data of its own
          (that read lives on Received Payments), so allocationSummary is
          withheld rather than guessed. */}
      {deleteRequest && (
        <DeletePaymentModal
          payment={deleteRequest}
          allocationSummary={null}
          formatAmount={fmtAmount}
          formatDate={fmtDate}
          modeLabel={mode => paymentDestinationLabel(mode, deleteRequest.received_in)}
          onClose={() => setDeleteRequest(null)}
          onDeleted={() => { setDeleteRequest(null); refreshAfterMutation() }}
        />
      )}

    </FinanceLayout>
  )
}
