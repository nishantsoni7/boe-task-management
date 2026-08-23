'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { isValidAmount } from '@/lib/currency'
import { notifyFinance } from '@/lib/notify'
import { FinanceModal, RequestModalShell } from '@/app/finance/components/FinanceModalShell'
import {
  CONFIRMED_PAYMENT_STATUSES,
  RECEIVED_PAYMENTS_SOURCE,
  applyLinkageScope,
  resolveLinkedAgainst,
  type LinkedAgainst,
} from '@/app/finance/paymentRouting'
import {
  ALLOCATION_FILTER_OPTIONS,
  LINKAGE_FILTER_OPTIONS,
  allocationFilterAvailable,
  allocationFilterClauses,
  ALLOCATED_TOTAL_COLUMN,
  dateRange,
  isNarrowed,
  linkageFilterClauses,
  pageCount,
  pageRange,
  resultSummary,
  receivedPaymentsSearchFilter,
  type AllocationFilter,
  type LinkageFilter,
} from '@/app/finance/receivedPaymentsQuery'
import {
  ALLOCATION_STATE_LABEL,
  PENDING_ALLOCATION_SUMMARY,
  summarizePaymentAllocations,
  type PaymentAllocationRow,
  type PaymentAllocationSummary,
} from '@/lib/finance/paymentAllocations'
import { formatMoney } from '@/lib/finance/piPaymentView'
import {
  canOpenOrderRecord,
  orderDetailHref,
  piSubmissionHref,
} from '@/lib/finance/crossModuleLinks'
import { deriveOrdersCapabilities, NO_ORDERS_CAPABILITIES } from '@/lib/permissions/orders'
import { useQueryClient } from '@tanstack/react-query'
import { RECEIVED_PAYMENTS_COUNTS_KEY } from '@/hooks/queries/useReceivedPaymentsCounts'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRequest = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string | null
  proof_note: string | null
  order_number: string | null
  order_id: string | null
  order_request_id: string | null
  order_request_number: string | null
  /** The Confirmed Order an ACTIVE allocation names, from the projection's
   *  lateral (20260921000000 §8a). Null when no active allocation points at an
   *  Order — which is every payment that predates Phase 3's move. Read only for
   *  classification and the "Linked Against" label; never written. */
  allocated_order_id: string | null
  allocated_order_number: string | null
  /** allocated_order_id IS NOT NULL, computed in the projection so the same
   *  fact can be filtered server-side by applyLinkageScope. */
  is_order_allocated: boolean
  sales_note: string | null
  status: string
  payment_against: string
  submitted_by: string
  submitted_by_name?: string
  /** The admin who approved the payment — finance_payment_requests.approved_by,
   *  set by approve_finance_payment_request. Undefined on legacy rows approved
   *  before the column was populated. */
  approved_by_name?: string
  admin_note: string | null
  created_at: string
}

// Combined Link-modal search result: a Confirmed Order or an eligible Order
// Request, tagged so the two are never confused. A payment links to exactly
// one of them (enforced server-side by the 20260698 CHECK + RPCs).
type LinkTarget =
  | {
      kind: 'order'
      id: string
      display_number: string
      client_name: string
      total_value: number | null
      status: string
      confirm_date: string | null
    }
  | {
      kind: 'request'
      id: string
      request_number: string
      client_name: string
      assignee_name: string | null
      total_value: number | null
      status: string
    }

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * How long the search box waits before asking the database.
 *
 * Search is answered server-side now, so without this every keystroke would be
 * a round trip. 250ms is below the threshold at which typing feels laggy and
 * comfortably above the interval between keystrokes, so an ordinary search term
 * costs ONE query rather than one per character.
 */
const SEARCH_DEBOUNCE_MS = 250

const PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
}

const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'HDFC',
  cash_in_hand:    'Paytm',
  savings_account: 'Canara',
  other:           'PNB',
}

/**
 * The account a payment landed in, for display.
 *
 * NULL is a real, expected value since 20260919000000: a payment recorded
 * against a PI requires only amount, date and mode, so the account is genuinely
 * not stated. It reads as "Not stated" rather than rendering blank — a blank
 * cell looks like a bug, and naming an account would be worse.
 */
function receivedInLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not stated'
  return RECEIVED_IN_LABEL[value] ?? value
}

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending',             bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

// ── Modes ─────────────────────────────────────────────────────────────────────
// Received Payments is two sibling pages, not one page with a tab strip. The
// split axis is ALLOCATION — see linkageModeFor in ../paymentRouting:
//
//   linked   → order_id IS NOT NULL  OR  order_request_id IS NOT NULL
//   unlinked → order_id IS NULL     AND  order_request_id IS NULL
//
// An Order Request linkage counts as LINKED. The money has been allocated to a
// piece of business; conversion later moves it onto the Order by itself. What
// makes Non-Linked worth its own page is the opposite case — money with nothing
// at all pointing at it, which is the only set that needs someone to act.
//
// The two predicates are exhaustive and mutually exclusive over the pair of
// columns, so the pair covers exactly the approved rows the single page used to
// load (approved_linked / approved_unlinked) and nothing is invisible.

export type ReceivedPaymentsMode = 'linked' | 'unlinked'

const MODE_META: Record<ReceivedPaymentsMode, {
  path: string
  title: string
  subtitle: string
  empty: string
  searchPlaceholder: string
}> = {
  linked: {
    path:     '/finance/received/linked',
    title:    'Linked Payments',
    subtitle: 'Received payments linked to either an Order or an Order Request.',
    empty:    'No linked payments yet.',
    searchPlaceholder: 'Client, order or request…',
  },
  unlinked: {
    path:     '/finance/received/unlinked',
    title:    'Non-Linked Payments',
    subtitle: 'Received payments linked to neither an Order nor an Order Request.',
    empty:    'No unallocated payments. Every received payment is linked.',
    searchPlaceholder: 'Client…',
  },
}

// Linked Payments only: narrows the two linkage targets apart. A plain form
// control alongside search — deliberately not a revived tab strip. Non-Linked
// Payments needs none: every row there is linked to nothing by definition, so
// there is nothing left to narrow.
//
// THE FILTER AND ITS PREDICATES NOW LIVE IN ../receivedPaymentsQuery, with the
// paging, the search columns and the date bounds. They moved out of this file
// because the narrowing had drifted from the badge beside it: this page tested
// `order_id` alone, while resolveLinkedAgainst had learned in Phase 3 to read a
// Confirmed Order out of an ACTIVE ALLOCATION. A payment attached to an Order by
// allocation — which is every payment PI conversion moves — displayed
// "Order ORD-…" in its row and then matched NEITHER narrowing. Stating the rule
// once, in a module with tests, is what stops that happening again.

const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  running:            { label: 'Running',             color: '#1E40AF' },
  on_hold:            { label: 'On Hold',             color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',          color: '#166534' },
  cancelled:          { label: 'Cancelled',           color: '#991B1B' },
}

// Order Request statuses eligible to receive a payment link (the RPC enforces
// the same pair server-side).
const REQUEST_STATUS_META: Record<string, { label: string; color: string }> = {
  submitted:           { label: 'Submitted',           color: '#92400E' },
  needs_clarification: { label: 'Needs Clarification', color: '#1E40AF' },
}

const PAYMENT_MODE_OPTIONS = [
  { label: 'Bank Transfer', value: 'bank_transfer' },
  { label: 'Cash',          value: 'cash' },
  { label: 'UPI',           value: 'upi' },
  { label: 'Cheque',        value: 'cheque' },
  { label: 'Other',         value: 'other' },
]

const RECEIVED_IN_OPTIONS = [
  // First, and empty-valued: a payment recorded against a PI states no account,
  // and the form must show that truthfully instead of defaulting to the first
  // real one. Choosing a real option is how Finance supplies it later.
  { label: 'Not stated', value: '' },
  { label: 'HDFC',   value: 'company_account' },
  { label: 'PNB',    value: 'other' },
  { label: 'Paytm',  value: 'cash_in_hand' },
  { label: 'Canara', value: 'savings_account' },
]

// approved_unlinked and approved_linked are deliberately excluded — see
// isLinkageStatus below and 20260691000000: those two states may only be
// reached through approve_finance_payment_request, link_finance_payment_to_order,
// or unlink_finance_payment_from_order.
const STATUS_CORRECTION_OPTIONS = [
  { value: 'pending_approval',    label: 'Pending' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
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

// Maps the approved_linked-requires-order_id CHECK constraint violation to a
// clear message instead of surfacing the raw Postgres error.
function friendlyDbErrorMessage(dbError: { code?: string; message: string } | null): string {
  if (!dbError) return ''
  if (dbError.code === '23514' || dbError.message?.includes('finance_payment_requests_approved_linked_requires_order_id')) {
    return 'Select a valid order before marking this payment as linked.'
  }
  return dbError.message
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────
// FinanceModal and RequestModalShell (the shared Finance modal layering
// system) live in src/app/finance/components/FinanceModalShell.tsx — shared
// with the Payment Requests page so both use one consistent set of overlay/
// dialog z-index values instead of each page picking its own.

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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: '13px', color: colors.primary }}>{value}</span>
    </div>
  )
}

// Compact uppercase section label used inside RequestModalShell cards —
// matches the Payment Requests page's DetailsModal styling exactly.
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

function StatusBadge({ status, requestLinked }: { status: string; requestLinked?: boolean }) {
  // A payment parked on an Order Request stays approved_unlinked in the
  // database (it is not an order advance yet) but must read as its own state,
  // not as plain "Order No. Pending".
  const meta = (requestLinked && status === 'approved_unlinked')
    ? { label: 'Awaiting Order Confirmation', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' }
    : STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// ── Linked Against cell ───────────────────────────────────────────────────────
// One badge for all three outcomes of resolveLinkedAgainst (../paymentRouting),
// so a reader never has to work out which of two differently-shaped cells they
// are looking at. The TYPE is spelled out in words next to the number —
// "Order ORD-…" / "Order Request REQ-…" — because colour alone cannot carry it,
// and the number alone cannot say what it is a number OF.
//
// Palette is unchanged from the badges this replaces: blue for a Confirmed
// Order, violet for an Order Request, amber for neither.
const LINKED_AGAINST_STYLE: Record<LinkedAgainst['kind'], { bg: string; color: string; border: string }> = {
  order:   { bg: colors.blueTint, color: colors.blue, border: 'rgba(85,133,232,0.25)' },
  request: { bg: '#F5F3FF',       color: '#5B21B6',   border: '#DDD6FE' },
  none:    { bg: '#FFF7ED',       color: '#9A3412',   border: '#FED7AA' },
}

function LinkedAgainstBadge({ target, interactive }: { target: LinkedAgainst; interactive?: boolean }) {
  const s = LINKED_AGAINST_STYLE[target.kind]
  return (
    <span
      title={target.label}
      style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
        background: s.bg, color: s.color, border: `1px solid ${s.border}`,
        fontSize: '11px', fontWeight: target.kind === 'none' ? 600 : 700, whiteSpace: 'nowrap',
        // Underlined only when it is actually a door, so a badge never looks
        // clickable to a reader who has nowhere to go.
        textDecoration: interactive ? 'underline' : undefined,
        textUnderlineOffset: interactive ? '2px' : undefined,
      }}
    >
      {target.kind === 'none' ? (
        target.label
      ) : (
        <>
          <span style={{ fontWeight: 600, opacity: 0.85 }}>{target.prefix}</span>
          {' '}
          {target.number}
        </>
      )}
    </span>
  )
}

// ── Allocation cell ───────────────────────────────────────────────────────────
//
// How much of one payment has been given a home, in one small cell. Finance's
// question and only Finance's: an Order screen reads its own allocations, so it
// can never say what the REST of a payment is doing.
//
// The four real states get a coloured word; `unknown` gets a muted sentence
// about the reader rather than about the money. That asymmetry is the point —
// see paymentAllocations.ts on why "we cannot show you" must never be rendered
// as "Unallocated".

const ALLOCATION_STATE_STYLE: Record<PaymentAllocationSummary['state'], { color: string; weight: number }> = {
  unknown:     { color: colors.muted, weight: 500 },
  unallocated: { color: '#9A3412',    weight: 700 },
  partial:     { color: colors.blue,  weight: 700 },
  full:        { color: colors.green, weight: 700 },
  over:        { color: colors.red,   weight: 700 },
}

function AllocationCell({ summary }: { summary: PaymentAllocationSummary }) {
  const style = ALLOCATION_STATE_STYLE[summary.state]
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '11.5px', fontWeight: style.weight, color: style.color, whiteSpace: 'nowrap' }}>
        {ALLOCATION_STATE_LABEL[summary.state]}
      </div>
      {/* The figure only where it adds something the word does not. "Fully
          allocated" and "Unallocated" already state the whole amount; a
          part-allocated payment is the one case where the reader needs the
          number, because the remainder is what needs acting on. */}
      {summary.state === 'partial' && summary.unallocated && (
        <div style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(summary.unallocated)} free
        </div>
      )}
      {summary.state === 'over' && summary.allocated && (
        <div style={{ fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(summary.allocated)} allocated
        </div>
      )}
    </div>
  )
}

// ── Allocation panel ──────────────────────────────────────────────────────────
//
// The claims against ONE payment, listed inside its detail modal.
//
// IT DOES NOT RESTATE THE PAYMENT. The amount, the date, the mode, the proof and
// the client are all in the panel beside this one; repeating them per allocation
// would read as several payments where there is one. Each line is a share of a
// sum already on screen, and the totals underneath reconcile to it.
//
// A TARGET IS NAMED ONLY WHEN THE READER COULD NAME IT. Whether money is
// allocated is derived from the ALLOCATION, so somebody who may not open the
// Order still sees that the money is spoken for and loses only its number —
// the same choice the finance_received_payments projection makes.

function AllocationPanel({ summary, amount, canOpenLinkedRecord, onOpen }: {
  summary: PaymentAllocationSummary
  amount: number
  canOpenLinkedRecord: boolean
  onOpen: (href: string) => void
}) {
  if (summary.state === 'unknown') {
    return (
      <div style={{ fontSize: '12.5px', color: colors.muted, lineHeight: 1.55 }}>
        {ALLOCATION_STATE_LABEL.unknown}. Allocations are shown to Finance users who can
        see every payment record; this payment&apos;s own details are unaffected.
      </div>
    )
  }

  if (summary.targets.length === 0) {
    return (
      <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55 }}>
        <strong style={{ color: '#9A3412' }}>{ALLOCATION_STATE_LABEL.unallocated}.</strong>{' '}
        The whole of {formatMoney(String(amount))} is still free to be assigned to a PI or an Order.
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {summary.targets.map(target => {
          const href = target.kind === 'order'
            ? orderDetailHref(target.targetId)
            : piSubmissionHref(target.targetId)
          const name = target.label ?? (target.kind === 'order' ? 'A Confirmed Order' : 'A PI submission')
          return (
            <div
              key={target.allocationId}
              style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                gap: '12px', flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '6px' }}>
                  {target.kind === 'order' ? 'Order' : 'PI'}
                </span>
                {/* Linked only when this reader holds Orders module entry AND the
                    target could be named. A link labelled "A Confirmed Order"
                    would be a door with no sign on it. */}
                {canOpenLinkedRecord && target.label ? (
                  <button
                    onClick={() => onOpen(href)}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      fontSize: '13px', fontWeight: 600, color: colors.blue,
                      textDecoration: 'underline', textUnderlineOffset: '2px', wordBreak: 'break-word',
                    }}
                  >
                    {name}
                  </button>
                ) : (
                  <span style={{ fontSize: '13px', color: colors.primary, wordBreak: 'break-word' }}>{name}</span>
                )}
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {formatMoney(target.amount)}
              </span>
            </div>
          )
        })}
      </div>

      {/* The two totals, so the lines above visibly reconcile to the payment. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
        borderTop: `1px solid ${colors.border}`, paddingTop: '10px',
        fontSize: '12px', color: colors.secondary,
      }}>
        <span>
          Allocated{' '}
          <strong style={{ color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
            {formatMoney(summary.allocated)}
          </strong>
        </span>
        <span>
          {summary.state === 'over' ? 'Over the payment by ' : 'Unallocated '}
          <strong style={{
            color: summary.state === 'over' ? colors.red
              : summary.unallocated && summary.unallocated !== '0' ? '#9A3412'
              : colors.muted,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {formatMoney(summary.unallocated)}
          </strong>
        </span>
      </div>
    </>
  )
}

// ── Details modal ─────────────────────────────────────────────────────────────

function DetailsModal({
  request: r,
  onClose,
  mayCorrectPayments,
  supabase,
  onCorrected,
  allocation,
  canOpenLinkedRecord,
  onOpenLinked,
}: {
  request: PaymentRequest
  onClose: () => void
  /** May correct or reverse a recorded payment — the finance.manage authority. */
  mayCorrectPayments?: boolean
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
  /** This payment's live allocations, from the list's one bounded read. */
  allocation: PaymentAllocationSummary
  /** orders.view — module entry, so a target is a door rather than a dead link. */
  canOpenLinkedRecord: boolean
  onOpenLinked: (href: string) => void
}) {
  // Every row on this page is approved_linked or approved_unlinked (the page
  // query is scoped to exactly those two statuses), so this is always true
  // here — the generic correction control below never renders on this page.
  // Kept as an explicit, named check (rather than deleting the block) so the
  // same guard reads identically to finance/page.tsx.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

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
    onCorrected()
  }

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  const left = (
    <>
      {/* Primary summary card — amount + client lead, payment details below.
          Same shell as the Payment Requests page's detail modal. */}
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
              {r.client_name}
            </div>
          </div>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px',
          borderTop: `1px solid ${colors.border}`, paddingTop: '14px',
        }}>
          <MetaItem label="Payment Date" value={fmtDate(r.payment_date)} />
          <MetaItem label="Payment Mode" value={PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode} />
          <MetaItem label="Received In"  value={receivedInLabel(r.received_in)} />
          {r.order_request_number && !r.order_number ? (
            <MetaItem label="Linked Order Request" value={r.order_request_number} />
          ) : (
            <MetaItem label="Order Number" value={r.order_number ?? '—'} muted={!r.order_number} />
          )}
        </div>
      </div>

      {/* Proof and reference — same compact bordered block as the Payment
          Requests page's detail modal. */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0 }}>Proof</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {supabase
              ? <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline />
              : <span style={{ fontSize: '13px', color: colors.muted }}>Not attached</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0, paddingTop: '1px' }}>Reference</span>
          <span style={{ fontSize: '13.5px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
            {r.proof_note || 'Not provided'}
          </span>
        </div>
      </div>

      {/* Notes — only when a sales note exists */}
      {r.sales_note && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <SectionHeader>Notes</SectionHeader>
          <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {r.sales_note}
          </div>
        </div>
      )}
    </>
  )

  const right = (
    <>
      {/* ── Where this money went ──
          The payment is ONE record; this lists the claims against it without
          restating the payment itself. A payment split across two Orders appears
          here as two allocations of one sum — never as two payments, which is
          exactly the duplication the allocation table exists to avoid. */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <SectionHeader>Allocation</SectionHeader>
        <AllocationPanel
          summary={allocation}
          amount={r.amount}
          canOpenLinkedRecord={canOpenLinkedRecord}
          onOpen={onOpenLinked}
        />
      </div>

      {/* Activity panel — same bordered shell as the Payment Requests page's
          detail modal. */}
      {supabase && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
          <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
        </div>
      )}

      {/* Admin controls — never renders on this page in practice (every row
          here is approved_unlinked/approved_linked), kept for parity with the
          Payment Requests page's guard structure. */}
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
      {mayCorrectPayments && isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          fontSize: '12px', color: colors.muted, lineHeight: 1.5,
        }}>
          Order linkage is managed with Link / Unlink, not here.
        </div>
      )}
    </>
  )

  return (
    <RequestModalShell
      requestNumber={r.request_number}
      submittedLine={submittedLine}
      statusBadge={<StatusBadge status={r.status} requestLinked={!!r.order_request_id} />}
      onClose={onClose}
      left={left}
      right={right}
    />
  )
}

// ── Edit Payment modal ────────────────────────────────────────────────────────

function EditPaymentModal({
  request: r,
  supabase,
  onClose,
  onSaved,
}: {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    clientName:  r.client_name,
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    paymentMode: r.payment_mode,
    receivedIn:  r.received_in ?? '',
    proofNote:   r.proof_note ?? '',
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Every row on this page is approved_unlinked or approved_linked (see the
  // page-level query), so this is always true here — order_number for those
  // states is owned exclusively by link_finance_payment_to_order /
  // unlink_finance_payment_from_order (20260691000000), never by this form.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && isValidAmount(form.amount) && form.paymentDate

  const handleSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        client_name:  form.clientName.trim(),
        amount:       Number(form.amount),
        payment_date: form.paymentDate,
        payment_mode: form.paymentMode,
        // '' is the not-stated sentinel and is stored as NULL. A payment
        // recorded against a PI arrives with no account, and correcting some
        // other field here must not invent one.
        received_in:  form.receivedIn === '' ? null : form.receivedIn,
        proof_note:   form.proofNote.trim() || null,
        ...(isLinkageStatus ? {} : { order_number: form.orderNumber.trim() || null }),
        sales_note:   form.salesNote.trim()   || null,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', r.id)
      .select('id')
      .single()
    setSaving(false)
    if (dbError) { setError(friendlyDbErrorMessage(dbError)); return }
    if (!updated) { setError('No row was updated. Check permissions.'); return }
    onSaved()
  }

  return (
    <FinanceModal title="Edit Received Payment" onClose={onClose}>
      <Field label="Client Name" required>
        <input className="boe-input" value={form.clientName} onChange={set('clientName')}
          placeholder="e.g. Raj Enterprises" style={{ width: '100%' }} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Amount (₹)" required>
          <input className="boe-input" type="number" min="0" value={form.amount}
            onChange={set('amount')} placeholder="0" style={{ width: '100%' }} />
        </Field>
        <Field label="Payment Date" required>
          <input className="boe-input" type="date" value={form.paymentDate}
            onChange={set('paymentDate')} style={{ width: '100%' }} />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Payment Mode" required>
          <select className="boe-input" value={form.paymentMode} onChange={set('paymentMode')} style={{ width: '100%' }}>
            {PAYMENT_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Received In" required>
          <select className="boe-input" value={form.receivedIn} onChange={set('receivedIn')} style={{ width: '100%' }}>
            {RECEIVED_IN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Payment Proof / Reference Note">
        <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
          placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office (optional)"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      <Field label="Order Number">
        <input className="boe-input" value={form.orderNumber} onChange={set('orderNumber')}
          placeholder="Order number" style={{ width: '100%' }}
          readOnly={isLinkageStatus} disabled={isLinkageStatus} />
        {isLinkageStatus && (
          <span style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
            Managed by Link / Unlink.
          </span>
        )}
      </Field>
      <Field label="Sales Note (optional)">
        <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
          placeholder="Any additional context"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
        <button onClick={handleSave} disabled={!canSubmit || saving}
          className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── Link to Order modal ───────────────────────────────────────────────────────

function LinkOrderModal({
  payment,
  supabase,
  onClose,
  onLinked,
}: {
  payment: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onLinked: () => void
}) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<LinkTarget[]>([])
  const [searching, setSearching] = useState(false)
  const [selected,  setSelected]  = useState<LinkTarget | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Only a new_order-origin payment may be parked on an Order Request — the
  // link RPC rejects anything else (20260698), so the search doesn't offer
  // request targets for other payments at all.
  const canLinkToRequest = payment.payment_against === 'new_order'

  // One search field, two sources: Confirmed Orders (as before) plus active
  // Order Requests ('submitted' / 'needs_clarification' — the same pair the
  // link RPC enforces server-side). Results are tagged and rendered with an
  // explicit type badge so the two can never be confused.
  const handleSearch = async (q: string) => {
    setQuery(q)
    setSelected(null)
    const trimmed = q.trim()
    if (!trimmed) { setResults([]); return }

    setSearching(true)
    const [ordersRes, requestsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('id, display_number, client_name, total_value, status, confirm_date')
        .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
        .not('status', 'in', '(cancelled)')
        .order('created_at', { ascending: false })
        .limit(20),
      canLinkToRequest
        ? supabase
            .from('order_requests')
            .select('id, request_number, client_name, total_value, status, assigned_to_user:users!assigned_to(full_name)')
            .or(`request_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
            .in('status', ['submitted', 'needs_clarification'])
            // Never surface an upload-stage draft (finalized_at IS NULL) as a
            // linkable request — it has no verified Main PI and is not a real
            // submission. RLS already hides other users' drafts; this covers the
            // edge where the searcher is the draft's own creator.
            .not('finalized_at', 'is', null)
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [] }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderTargets: LinkTarget[] = ((ordersRes.data ?? []) as any[]).map(o => ({
      kind: 'order',
      id: o.id,
      display_number: o.display_number,
      client_name: o.client_name,
      total_value: o.total_value,
      status: o.status,
      confirm_date: o.confirm_date ?? null,
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestTargets: LinkTarget[] = ((requestsRes.data ?? []) as any[]).map(r => ({
      kind: 'request',
      id: r.id,
      request_number: r.request_number,
      client_name: r.client_name,
      total_value: r.total_value,
      status: r.status,
      assignee_name: r.assigned_to_user?.full_name ?? null,
    }))

    setResults([...orderTargets, ...requestTargets])
    setSearching(false)
  }

  // Routed entirely through the guarded RPCs (link_finance_payment_to_order,
  // 20260691000000, and link_finance_payment_to_order_request, 20260698000000):
  // each locks its rows, revalidates eligibility server-side, and writes the
  // activity rows itself. No client-side .update() of finance_payment_requests
  // or the activity tables remains.
  const handleLink = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = selected.kind === 'order'
      ? await supabase.rpc('link_finance_payment_to_order', {
          p_payment_request_id: payment.id,
          p_order_id:           selected.id,
        })
      : await supabase.rpc('link_finance_payment_to_order_request', {
          p_payment_request_id: payment.id,
          p_order_request_id:   selected.id,
        })

    setSaving(false)
    if (rpcError) { setError(friendlyDbErrorMessage(rpcError)); return }

    // Tell the request creator their payment is now attached. Reuses the
    // existing finance_linked event for both targets; the number in the
    // message makes the target type obvious (BOE-… vs ORD-REQ-…).
    void notifyFinance({
      event: 'finance_linked',
      requestNumber: payment.request_number,
      entityId: payment.id,
      creatorId: payment.submitted_by,
      clientName: payment.client_name,
      orderNumber: selected.kind === 'order' ? selected.display_number : selected.request_number,
    })

    onLinked()
  }

  const isSuspense = !payment.order_id

  return (
    <FinanceModal title={isSuspense ? 'Link to Order' : 'Change Linked Order'} onClose={onClose}>
      {/* Payment summary */}
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        border: `1px solid ${colors.border}`,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
      }}>
        <DetailRow label="Client" value={payment.client_name} />
        <DetailRow label="Amount" value={fmtAmount(payment.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(payment.payment_date)} />
        <DetailRow label="Mode" value={PAYMENT_MODE_LABEL[payment.payment_mode] ?? payment.payment_mode} />
      </div>

      {/* Search */}
      <Field label="Search Orders & Order Requests">
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: colors.raised, border: `1px solid ${colors.border}`,
          borderRadius: '6px', padding: '6px 10px',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            autoFocus
            placeholder="Order / request number or client name…"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
          />
          {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
        </div>
      </Field>

      {/* Results — Confirmed Orders first, then eligible Order Requests, each
          carrying an explicit type badge. */}
      {results.length > 0 && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
          maxHeight: '240px', overflowY: 'auto',
        }}>
          {results.map((t, idx) => {
            const isSelected = selected?.kind === t.kind && selected?.id === t.id
            const number = t.kind === 'order' ? t.display_number : t.request_number
            const statusMeta = t.kind === 'order'
              ? (ORDER_STATUS_META[t.status] ?? { label: t.status, color: colors.muted })
              : (REQUEST_STATUS_META[t.status] ?? { label: t.status, color: colors.muted })
            const typeBadge = t.kind === 'order'
              ? { label: 'Confirmed Order', bg: colors.blueTint, color: colors.blue, border: 'rgba(85,133,232,0.25)' }
              : { label: 'Order Request',   bg: '#F5F3FF',      color: '#5B21B6',   border: '#DDD6FE' }
            const subline = t.kind === 'order'
              ? [t.client_name, t.confirm_date ? `Confirmed ${fmtDate(t.confirm_date)}` : null].filter(Boolean).join(' · ')
              : [t.client_name, t.assignee_name ? `Assignee: ${t.assignee_name}` : null].filter(Boolean).join(' · ')
            return (
              <div
                key={`${t.kind}-${t.id}`}
                onClick={() => setSelected(isSelected ? null : t)}
                style={{
                  padding: '10px 14px',
                  borderBottom: idx < results.length - 1 ? `1px solid ${colors.border}` : 'none',
                  cursor: 'pointer',
                  background: isSelected ? colors.blueTint : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = colors.raised }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{
                      display: 'inline-block', padding: '1px 6px', borderRadius: '4px',
                      background: typeBadge.bg, color: typeBadge.color, border: `1px solid ${typeBadge.border}`,
                      fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                      {typeBadge.label}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{number}</span>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: statusMeta.color }}>{statusMeta.label}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {subline}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                    {t.total_value != null ? fmtAmount(t.total_value) : '—'}
                  </div>
                  {t.kind === 'request' && (
                    <div style={{ fontSize: '10px', color: colors.muted, marginTop: '2px' }}>Expected value</div>
                  )}
                  {isSelected && (
                    <div style={{ fontSize: '10px', color: colors.blue, fontWeight: 600, marginTop: '2px' }}>Selected</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {query.trim() && !searching && results.length === 0 && (
        <div style={{ fontSize: '13px', color: colors.muted, textAlign: 'center', padding: '12px 0' }}>
          No orders or order requests found for &ldquo;{query.trim()}&rdquo;.
        </div>
      )}

      {selected?.kind === 'request' && (
        <div style={{
          fontSize: '12px', color: '#5B21B6', background: '#F5F3FF',
          border: '1px solid #DDD6FE', borderRadius: '6px', padding: '8px 12px', lineHeight: 1.5,
        }}>
          Linking does not convert this request. When it is converted to an
          official Order, this payment will transfer to that Order automatically.
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        <button
          onClick={handleLink}
          disabled={!selected || saving}
          className="boe-btn boe-btn-primary"
          style={{ padding: '8px 18px', fontSize: '13px', opacity: (!selected || saving) ? 0.6 : 1, cursor: (!selected || saving) ? 'not-allowed' : 'pointer' }}
        >
          {saving
            ? 'Linking…'
            : !selected
              ? 'Link'
              : selected.kind === 'order'
                ? `Link to Order ${selected.display_number}`
                : `Link to Request ${selected.request_number}`}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

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

// Compact operational column set, identical on both Received Payments pages:
// which request the money came in on, who it is from, how much, when, WHAT IT IS
// LINKED AGAINST, how it arrived, who confirmed it, and what can be done to it.
//
// Received In, Submitted By, Submitted On and the status badge were dropped from
// the row to make room without widening the table. None of them left the system
// — all four are in the details modal one click away, and the page itself (and
// the Linked Against cell) now carries what the status badge used to say.
function ReceivedPaymentsTable({
  rows,
  canManage,
  canOpenLinkedRecord,
  allocations,
  highlightId,
  onView,
  onEdit,
  onLink,
  onUnlink,
  onOpenLinked,
}: {
  rows: PaymentRequest[]
  /**
   * May link, unlink, and edit a recorded payment. Every one of those is a
   * correction of an approved financial record — the finance.manage authority.
   */
  canManage: boolean
  /**
   * May open Order Management at all — orders.view, the same module entry
   * /orders/layout.tsx enforces. A DRAWING rule and never an authorization one:
   * the Order page re-reads its own row under this reader's RLS and shows "not
   * available" for one they may not open, so the link grants nothing.
   */
  canOpenLinkedRecord: boolean
  /** How much of each payment has a home. Absent until the second read lands. */
  allocations: Map<string, PaymentAllocationSummary>
  highlightId?: string | null
  onView:   (r: PaymentRequest) => void
  onEdit:   (r: PaymentRequest) => void
  onLink:   (r: PaymentRequest) => void
  onUnlink: (r: PaymentRequest) => void
  onOpenLinked: (href: string) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '880px' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Payment Request #</th>
            <th style={TH_STYLE}>Client</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
            <th style={TH_STYLE}>Payment Date</th>
            <th style={TH_STYLE}>Linked Against</th>
            <th style={TH_STYLE}>Allocation</th>
            <th style={TH_STYLE}>Payment Mode</th>
            <th style={TH_STYLE}>Confirmed By</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const target = resolveLinkedAgainst(r)
            const isLinked = target.kind === 'order'
            const isRequestLinked = target.kind === 'request'
            const isHighlighted = r.id === highlightId
            // The Order this row names, by the SAME priority resolveLinkedAgainst
            // uses: the legacy link first, then an active allocation. Null when
            // the row is attached to an Order Request or to nothing.
            const linkedOrderId = isLinked ? (r.order_id ?? r.allocated_order_id) : null
            return (
              <tr
                key={r.id}
                id={`payment-row-${r.id}`}
                onClick={() => onView(r)}
                style={{ cursor: 'pointer', background: isHighlighted ? colors.amberTint : undefined }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = isHighlighted ? colors.amberTint : 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '11px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {r.request_number}
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {r.client_name}
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 700, color: colors.primary, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmount(r.amount)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {fmtDate(r.payment_date)}
                </td>
                {/* Linked Against — Confirmed Order first, then Order Request,
                    then "Not linked". Never blank, and never a pending label
                    while a real request number is available. */}
                <td style={TD}>
                  {/* THE DOOR INTO THE OTHER MODULE. A payment attached to a
                      Confirmed Order — by the legacy link OR by an active
                      allocation, which is how PI conversion moves money —
                      becomes a button to that Order. An Order Request has no
                      detail route of its own here, so it stays a plain badge
                      rather than a link that goes nowhere. */}
                  {linkedOrderId && canOpenLinkedRecord ? (
                    <button
                      onClick={e => { e.stopPropagation(); onOpenLinked(orderDetailHref(linkedOrderId)) }}
                      title={`Open ${target.label}`}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        font: 'inherit', textAlign: 'left',
                      }}
                    >
                      <LinkedAgainstBadge target={target} interactive />
                    </button>
                  ) : (
                    <LinkedAgainstBadge target={target} />
                  )}
                </td>
                {/* How much of this payment has been given a home — the
                    question Finance asks that no Order screen can answer, since
                    an Order reads only its own allocations. "Not visible to
                    you" when this reader may not see every allocation: an empty
                    list is not evidence that money is unallocated. */}
                <td style={TD}>
                  <AllocationCell summary={allocations.get(r.id) ?? PENDING_ALLOCATION_SUMMARY(r.id)} />
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {r.approved_by_name ?? '—'}
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
                    {canManage && (
                      <>
                        {/* Link action for fully unlinked suspense payments */}
                        {!isLinked && !isRequestLinked && (
                          <button
                            onClick={() => onLink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 600, color: colors.blue }}
                          >
                            Link
                          </button>
                        )}
                        {/* Unlink from an Order Request — same reason-required
                            flow, routed through
                            unlink_finance_payment_from_order_request
                            (20260698000000), same new_order-origin gate. */}
                        {isRequestLinked && r.payment_against === 'new_order' && (
                          <button
                            onClick={() => onUnlink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.muted }}
                          >
                            Unlink
                          </button>
                        )}
                        {/* Unlink action — only for payments that originated as a new
                            order. An existing_order payment was validated against a
                            real order at submission and unlink_finance_payment_from_order
                            (20260691000000) rejects it outright, so the option is not
                            offered here at all. */}
                        {isLinked && r.payment_against === 'new_order' && (
                          <button
                            onClick={() => onUnlink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.muted }}
                          >
                            Unlink
                          </button>
                        )}
                        <button
                          onClick={() => onEdit(r)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                        >
                          Edit
                        </button>
                        {/* No Delete. A row on this page is a Received Payment —
                            money that actually arrived — and is permanent bank
                            payment history (20260705000000). The database
                            refuses the delete regardless of what the UI offers:
                            the admin policy is now unapproved-only and
                            finance_payment_requests_guard_approved_delete no
                            longer exempts admins or the service role. */}
                      </>
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
// One component, two routes: /finance/received/linked and
// /finance/received/unlinked each render it with their own `mode`. The table,
// the detail modal and every link/unlink action are shared verbatim — only the
// query predicate, the copy and the filter row differ.

export function ReceivedPaymentsView({ mode }: { mode: ReceivedPaymentsMode }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReceivedPaymentsViewInner mode={mode} />
    </Suspense>
  )
}

function ReceivedPaymentsViewInner({ mode }: { mode: ReceivedPaymentsMode }) {
  const [pageLoading,    setPageLoading]    = useState(true)
  // Finance authority for the SIGNED-IN user. Starts empty and is only
  // widened once the resolver answers, so no correction control can flash
  // before it is authorized. Admins short-circuit inside the helper.
  const [caps,           setCaps]           = useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [requests,       setRequests]       = useState<PaymentRequest[]>([])
  const [listLoading,    setListLoading]    = useState(false)
  const [detailRequest,  setDetailRequest]  = useState<PaymentRequest | null>(null)
  const [editRequest,    setEditRequest]    = useState<PaymentRequest | null>(null)
  const [linkRequest,    setLinkRequest]    = useState<PaymentRequest | null>(null)
  const [unlinkTarget,   setUnlinkTarget]   = useState<PaymentRequest | null>(null)
  const [unlinkReason,   setUnlinkReason]   = useState('')
  const [unlinking,      setUnlinking]      = useState(false)
  const [unlinkError,    setUnlinkError]    = useState<string | null>(null)
  const [search,         setSearch]         = useState('')
  const [linkage,        setLinkage]        = useState<LinkageFilter>('all')
  const [dateFrom,       setDateFrom]       = useState('')
  const [dateTo,         setDateTo]         = useState('')
  // ── The allocation narrowing ──
  // How much of a payment has been given a home — the queue that needs somebody
  // to act. Answered by the DATABASE, because a state computed over the fifty
  // rows in hand would narrow those fifty and hide every match on page two.
  //
  // GATED TWICE, and both gates matter. The projection gains `allocation_state`
  // only when 20261004000000 is applied, so `allocationReady` probes for it and
  // the control is not drawn until it is there — an un-migrated database behaves
  // exactly as it did before, with no query ever built against a missing column.
  // And the control is offered only to a reader who can see EVERY allocation,
  // because the view is security_invoker: a reader who may see a payment but not
  // its allocations sums to zero and would read "Unallocated" for money that is
  // fully spoken for.
  const [allocation,     setAllocation]     = useState<AllocationFilter>('all')
  const [allocationReady, setAllocationReady] = useState(false)
  const [highlightId,    setHighlightId]    = useState<string | null>(null)
  // ── Paging ──
  // The list was UNBOUNDED, and PostgREST truncates silently at 1000 rows: no
  // error, no warning, a plausible-looking array. Ordered created_at DESC, the
  // 1001st approved payment would have started pushing the OLDEST ones out of
  // Finance with the count beside them reading a confident "1000". `total` is
  // the database's exact count, so the line under the toolbar describes the
  // whole set rather than the length of what happened to load.
  const [page,           setPage]           = useState(1)
  const [total,          setTotal]          = useState<number | null>(null)
  // How much of each payment on THIS PAGE has been given a home. A second
  // bounded read keyed on the ids already on screen — one query for the page,
  // never one per row. Absent until it lands, and absent is `unknown`, never
  // "Unallocated": see paymentAllocations.ts on why those must not collapse.
  const [allocations,    setAllocations]    = useState<Map<string, PaymentAllocationSummary>>(new Map())
  // Orders authority, resolved beside the Finance one in the same parallel
  // group. It decides ONE thing: whether a linked row offers a door into the
  // Order or PI it names. It grants nothing — the destination re-reads its own
  // record under this reader's RLS and refuses anything they may not open.
  const [ordersCaps,     setOrdersCaps]     = useState(NO_ORDERS_CAPABILITIES)

  const meta         = MODE_META[mode]
  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()
  const queryClient  = useQueryClient()

  // Guards the one-time ?payment= deep-link resolution below (see effect near
  // the bottom of init) so it can never re-fire and reopen a closed modal.
  const deepLinkHandled = useRef(false)

  // The narrowing, as the DATABASE will be asked it. Held in a ref as well as
  // in state so the loader always reads the CURRENT filters rather than the ones
  // its closure was created with — a search typed quickly would otherwise
  // re-issue an older query and paint a stale page over a newer one.
  /**
   * Whether the allocation control is offered at all.
   *
   * BOTH GATES. The column has to exist (the migration is applied) AND this
   * reader has to be able to see every allocation, so that the security_invoker
   * sum behind the state IS the true sum for them. A reader holding
   * finance.view without finance.view_all would otherwise be shown a filter
   * that calls fully-allocated money "Unallocated" — the exact confusion
   * paymentAllocations.ts refuses to make on the per-payment panel.
   */
  const allocationOffered = allocationReady && caps.canViewAllFinance

  const filters = useMemo(() => {
    const dates = dateRange(dateFrom, dateTo)
    return {
      search: receivedPaymentsSearchFilter(search),
      linkage,
      dateFrom: dates.from,
      dateTo: dates.to,
      // Never sent unless the column is there AND this reader may trust it.
      allocation: allocationOffered ? allocation : ('all' as AllocationFilter),
    }
  }, [search, linkage, dateFrom, dateTo, allocation, allocationOffered])

  // Guards against an out-of-order response. Each load claims a number; only the
  // newest one is allowed to write to state. Without this, a slow query for
  // "REQ" can land after a fast one for "REQ-2026" and repaint the wider result
  // under a narrower search box.
  const loadToken = useRef(0)

  /**
   * Whether an EMPTY allocation list is conclusive for this reader — resolved
   * once, held as a PROMISE so the allocation read can await it instead of
   * racing it. Defaults to a resolved `false`, which is the safe answer: a
   * payment is only ever called "Unallocated" on evidence, never on a gap.
   */
  const canViewAllRef = useRef<Promise<boolean>>(Promise.resolve(false))

  const loadRequests = async () => {
    const token = ++loadToken.current
    setListLoading(true)
    // Same approved-only scope as before the split; the linkage predicate is
    // what makes the two pages disjoint. Filtered in the database rather than
    // in the browser so neither page ever holds the other's rows.
    //
    // RECEIVED_PAYMENTS_SOURCE, not the base table: it is the same payments, one
    // row each, plus the ACTIVE-allocation columns this page needs to classify
    // money that PI approval moved onto a Confirmed Order without touching the
    // payment record. It is security_invoker, so RLS still decides what loads.
    // EVERY MUTATION ON THIS PAGE STILL WRITES TO finance_payment_requests by
    // the row's own id, which the projection carries through unchanged.
    //
    // `count: 'exact'` so the toolbar states the size of the WHOLE narrowed set
    // rather than the length of the page in hand.
    const base = supabase
      .from(RECEIVED_PAYMENTS_SOURCE)
      .select(`
        id, request_number, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, order_number, order_id,
        order_request_id, order_request_number, sales_note,
        status, payment_against, submitted_by, admin_note, created_at,
        submitted_by_name, approved_by_name,
        allocated_order_id, allocated_order_number, is_order_allocated
      `, { count: 'exact' })
      .in('status', CONFIRMED_PAYMENT_STATUSES as unknown as string[])

    // Either linkage counts. Filtered in the database rather than in the browser
    // so neither page ever holds the other's rows — and through the SAME
    // applyLinkageScope the sidebar counts use, so the list and the number
    // beside its nav entry are one predicate, not two that must be kept in step.
    let scoped = applyLinkageScope(base, mode)

    // ── THE NARROWING, IN THE DATABASE ──
    //
    // Search and the linkage filter used to run in the BROWSER, over whatever
    // the unbounded query happened to return. Both had to move here the moment
    // the list became paged: filtering a page after the fact narrows only the
    // fifty rows in hand and silently hides every match on page two.
    //
    // Every clause narrows a set RLS has ALREADY decided this caller may see —
    // RECEIVED_PAYMENTS_SOURCE is security_invoker — so no filter here can widen
    // anything. The search term is sanitized into a literal before it reaches a
    // filter group (see sanitizeSearchTerm): a comma or a bracket in a term
    // would otherwise be parsed as MORE FILTER rather than as text to match.
    if (filters.search) scoped = scoped.or(filters.search)

    for (const clause of linkageFilterClauses(mode === 'linked' ? filters.linkage : 'all')) {
      if (clause.kind === 'or') scoped = scoped.or(clause.filters)
      else if (clause.kind === 'isNull') scoped = scoped.is(clause.column, null)
      else scoped = scoped.not(clause.column, 'is', null)
    }

    if (filters.dateFrom) scoped = scoped.gte('payment_date', filters.dateFrom)
    if (filters.dateTo)   scoped = scoped.lte('payment_date', filters.dateTo)

    for (const clause of allocationFilterClauses(filters.allocation)) {
      if (clause.kind === 'eq') scoped = scoped.eq(clause.column, clause.value)
    }

    // ORDERED BY created_at AND THEN BY id. range() maps to LIMIT/OFFSET, which
    // makes no promise about row order unless the ordering is deterministic —
    // two payments recorded in the same instant could otherwise swap between
    // pages, showing one twice and hiding the other.
    const range = pageRange(page)
    const { data, count } = await scoped
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(range.from, range.to)

    // A newer load has already been issued; this answer is stale and must not
    // repaint the screen underneath it.
    if (token !== loadToken.current) return

    // The two submitter/approver names arrive already flattened — the projection
    // joins users itself, so what used to be two embedded resources to unwrap is
    // now two plain columns. Same values, same nulls: approved_by_name is set by
    // approve_finance_payment_request (20260688/20260690) and is null only on a
    // row approved before that column existed. `?? undefined` keeps the optional
    // fields optional so every consumer below reads exactly as before.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PaymentRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      submitted_by_name: r.submitted_by_name ?? undefined,
      approved_by_name:  r.approved_by_name  ?? undefined,
    }))
    setRequests(mapped)
    setTotal(count ?? null)
    setListLoading(false)

    // ── HOW MUCH OF EACH PAYMENT HAS A HOME ──
    //
    // Started AFTER the list, because it is keyed on the ids the list just
    // returned — and deliberately NOT awaited before the table paints. The rows
    // are already correct without it; this only fills one column and one panel
    // in the details modal, and blocking the whole list on it would trade a
    // visible table for a spinner.
    //
    // ONE QUERY FOR THE PAGE, never one per row, and bounded twice over: the
    // page is at most 50 ids, and the read is anchored to exactly those.
    loadAllocations(mapped, token)
  }

  /**
   * The allocations behind one page of payments.
   *
   * finance_payment_allocations under its own RLS — admin, finance.view_all, the
   * payment's own submitter, a PI participant or an Order participant. It is not
   * read through finance_received_payments, which exposes no allocated amount
   * and no split by design; and being able to SEE an allocation grants no
   * authority over one, because that table carries no INSERT, UPDATE or DELETE
   * policy for any role.
   *
   * A REFUSAL IS NOT AN ANSWER ABOUT THE MONEY. When the read fails, or when
   * this reader cannot see every allocation, each payment reports `unknown`
   * rather than `unallocated` — see paymentAllocations.ts. Telling a Finance
   * user that verified money is sitting in suspense when it is merely invisible
   * to them would be the worse failure by far.
   */
  const loadAllocations = async (rows: readonly PaymentRequest[], token: number) => {
    if (rows.length === 0) {
      if (token === loadToken.current) setAllocations(new Map())
      return
    }

    const [{ data, error }, emptyIsConclusive] = await Promise.all([
      supabase
        .from('finance_payment_allocations')
        .select('id, payment_request_id, allocated_amount, status, order_id, order_submission_id')
        .in('payment_request_id', rows.map(r => r.id))
        .eq('status', 'active'),
      canViewAllRef.current,
    ])

    if (token !== loadToken.current) return

    setAllocations(summarizePaymentAllocations(
      // `hasDirectLink` carries the payment's own order_id into the rule: a
      // linked payment with no allocations is attributed in full to that Order
      // by the canonical fallback, so it is not free money and must not read
      // "Unallocated" here while the Order counts it.
      rows.map(r => ({ id: r.id, amount: r.amount, hasDirectLink: r.order_id !== null })),
      (data ?? []) as PaymentAllocationRow[], {
      readable: !error,
      // Only a reader who can see EVERY allocation may be told "unallocated" on
      // the strength of an empty list. This is the protected finance.view_all
      // action, with admins short-circuiting inside deriveFinanceCapabilities —
      // exactly the two cases whose RLS returns the complete set.
      emptyIsConclusive,
      // The Confirmed Order number the projection already resolved, so naming an
      // allocation's target costs no additional read. A PI submission has no
      // number on this row and is named by its target only when the reader can
      // open it, which the PI page decides for itself.
      labels: new Map(
        rows
          .filter(r => r.allocated_order_id && r.allocated_order_number)
          .map(r => [r.allocated_order_id as string, r.allocated_order_number as string]),
      ),
    }))
  }

  // Every mutation on this page — link, unlink, edit, status correction — can
  // move a row between the two Received Payments pages or in or out of them
  // entirely, so each re-reads the list AND invalidates the sidebar counts. The
  // initial load deliberately does not: the counts query is mounting alongside
  // it and would only be told to fetch twice.
  const refreshAfterMutation = () => {
    loadRequests()
    queryClient.invalidateQueries({ queryKey: RECEIVED_PAYMENTS_COUNTS_KEY })
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // ── THE PROFILE, BOTH PERMISSION SETS AND THE LIST, TOGETHER ──
      //
      // This ran one after the next — session, then profile, then permissions,
      // then the list — so the page waited for four latencies end to end before
      // it drew anything, and none of the last three needs another's answer.
      // Every row the list reads is scoped by RLS, not by the capabilities being
      // resolved beside it.
      //
      // NOTHING ABOUT AUTHORITY CHANGED. `caps` still starts empty and is still
      // widened only once resolve_effective_permissions answers, so no
      // correction control can flash before it is authorized: pageLoading is not
      // cleared until every one of these has landed. A failed resolve still
      // falls back to NO capabilities rather than to the role.
      const profilePromise = supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()
      const financePromise = getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => [])
      const ordersPromise = getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => [])

      // ── IS THE ALLOCATION COLUMN THERE? ──
      //
      // One row, two columns, asked once. The projection gains allocation_state
      // only when 20261004000000 is applied; until then this errors and the
      // control is never drawn, so an un-migrated database behaves exactly as it
      // did before and no query is ever built against a column that does not
      // exist. A filter that silently matched nothing, or a request PostgREST
      // refused outright, would both be worse than an absent control.
      //
      // In this group, so it costs no wait.
      const allocationProbe = supabase
        .from(RECEIVED_PAYMENTS_SOURCE)
        .select(`id, ${ALLOCATED_TOTAL_COLUMN}, allocation_state`)
        .limit(1)
        .then((result: { error: unknown }) => allocationFilterAvailable(
          result.error ? null : { columns: [ALLOCATED_TOTAL_COLUMN, 'allocation_state'] }))
        .catch(() => false)

      // THE ALLOCATION READ'S SAFETY FLAG, PUBLISHED BEFORE IT IS NEEDED.
      // loadAllocations must know whether an EMPTY allocation list is conclusive
      // for this reader, and that answer depends on both calls above. Handing it
      // the PROMISE rather than the value is what lets the list start now: the
      // allocation read already runs after the list, so by the time it awaits
      // this, the answer is in flight or already there, and it never has to
      // guess.
      canViewAllRef.current = Promise.all([profilePromise, financePromise])
        .then(([{ data: who }, perms]) =>
          deriveFinanceCapabilities((who as UserProfile | null)?.role, perms).canViewAllFinance)
        .catch(() => false)

      const [{ data: me }, financePerms, ordersPerms, allocationAvailable] = await Promise.all([
        profilePromise,
        financePromise,
        ordersPromise,
        allocationProbe,
        loadRequests(),
      ])

      setAllocationReady(allocationAvailable)
      setProfile(me as UserProfile)
      setCaps(deriveFinanceCapabilities(me?.role, financePerms))
      setOrdersCaps(deriveOrdersCapabilities(me?.role, ordersPerms))

      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Re-read when the narrowing or the page changes ───────────────────────────
  //
  // Search and the filters are answered by the DATABASE now, so a change to any
  // of them is a new query rather than a re-filter of rows already in hand. The
  // search box is DEBOUNCED — `filters.search` is derived from the raw term, so
  // without this every keystroke would be a round trip — and the other controls
  // are not, because each is a single deliberate click.
  //
  // Skipped entirely until the first load has finished, so the mount does not
  // issue the same query twice.
  useEffect(() => {
    if (pageLoading) return
    const timer = setTimeout(() => { loadRequests() }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search, filters.linkage, filters.dateFrom, filters.dateTo, filters.allocation, page])

  // A narrowing change moves the reader back to page one — staying on page four
  // of a result set that now has one page would show an empty table over a
  // filter that matches plenty.
  //
  // Done in the EVENT HANDLER rather than in an effect watching the filters.
  // An effect would set state during a render it also caused, which is the
  // cascading-render pattern react-hooks/set-state-in-effect exists to catch;
  // here the page reset is simply part of what changing a filter means.
  const narrowBy = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(1) }
  const applySearch   = narrowBy(setSearch)
  const applyLinkage  = narrowBy(setLinkage)
  const applyDateFrom = narrowBy(setDateFrom)
  const applyDateTo   = narrowBy(setDateTo)
  const applyAllocation = narrowBy(setAllocation)

  // ── Deep-link resolution (?payment=&action=link|edit) ────────────────────────
  // Runs exactly once, once `requests` is loaded. Sources: the Admin Action
  // Queue (action=link) and the Order Requests details modal's per-payment Edit
  // action (action=edit). Each modal auto-opens only when the loaded payment
  // still satisfies the same rule the manual button uses — a stale, already
  // linked, or not-permitted payment is simply highlighted, never a fatal error.
  useEffect(() => {
    const resolveDeepLink = async () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      const paymentId = searchParams.get('payment')
      const action     = searchParams.get('action')
      if (!paymentId) return

      // ── THE ROW MAY NOT BE ON THIS PAGE ──
      //
      // Before the list was paged it held every approved payment, so a deep
      // link's target was always among the loaded rows. Now it is one page of
      // fifty, and a link into a payment recorded months ago would silently do
      // nothing — no modal, no highlight, and no explanation.
      //
      // So a miss is followed by ONE read for that ONE payment, by its id. It is
      // the same security_invoker projection the list reads, so RLS decides
      // exactly as it does for the list: a payment this reader may not see comes
      // back empty and the page simply shows its first page, which is what a
      // stale or unauthorized link has always done here. Nothing is highlighted
      // in that case, because the row is genuinely not on screen — but the
      // record the link was for does open.
      let match = requests.find(r => r.id === paymentId) ?? null
      const onThisPage = match !== null

      if (!match) {
        const { data } = await supabase
          .from(RECEIVED_PAYMENTS_SOURCE)
          .select(`
            id, request_number, client_name, amount, payment_date, payment_mode,
            received_in, proof_note, order_number, order_id,
            order_request_id, order_request_number, sales_note,
            status, payment_against, submitted_by, admin_note, created_at,
            submitted_by_name, approved_by_name,
            allocated_order_id, allocated_order_number, is_order_allocated
          `)
          .eq('id', paymentId)
          .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = data as any
        match = row
          ? { ...row,
              submitted_by_name: row.submitted_by_name ?? undefined,
              approved_by_name:  row.approved_by_name  ?? undefined } as PaymentRequest
          : null
      }

      if (match) {
        if (onThisPage) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`payment-row-${match.id}`)?.scrollIntoView({ block: 'center' })
        }
        if (caps.canManageFinance && action === 'link' && !match.order_id && !match.order_request_id) {
          setLinkRequest(match)
        } else if (caps.canManageFinance && action === 'edit') {
          // Editing a received payment is admin-only here, exactly as the
          // table's own Edit button is.
          setEditRequest(match)
        } else if (action === 'edit' || action === 'link') {
          // Not permitted (or no longer eligible): fall back to the read-only
          // view rather than silently doing nothing.
          setDetailRequest(match)
        } else if (!onThisPage) {
          // A bare ?payment= link used to be answered by highlighting the row.
          // When the row is on another page there is nothing to highlight, so
          // the record itself is opened instead of nothing happening at all.
          setDetailRequest(match)
        }
      }

      // Drop the deep-link params so a refresh or back-navigation can't
      // reopen the modal.
      router.replace(meta.path)
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Unlink a payment — routed entirely through the guarded RPCs
  // (unlink_finance_payment_from_order, 20260691000000, or
  // unlink_finance_payment_from_order_request, 20260698000000, depending on
  // which linkage the row carries — the DB guarantees it is never both): each
  // locks the payment row, requires a non-empty reason, enforces the
  // new_order-origin gate, and records the activity rows itself. No
  // client-side .update() of finance_payment_requests or the activity tables
  // remains.
  const handleUnlink = async () => {
    if (!unlinkTarget) return
    const reason = unlinkReason.trim()
    if (!reason) { setUnlinkError('A reason is required to unlink this payment.'); return }
    setUnlinking(true)
    setUnlinkError(null)

    const { error: rpcError } = unlinkTarget.order_id
      ? await supabase.rpc('unlink_finance_payment_from_order', {
          p_payment_request_id: unlinkTarget.id,
          p_reason:             reason,
        })
      : await supabase.rpc('unlink_finance_payment_from_order_request', {
          p_payment_request_id: unlinkTarget.id,
          p_reason:             reason,
        })

    setUnlinking(false)
    if (rpcError) { setUnlinkError(friendlyDbErrorMessage(rpcError)); return }

    setUnlinkTarget(null)
    setUnlinkReason('')
    refreshAfterMutation()
  }

  // THE ROWS ARE THE ANSWER, not a starting point to filter.
  //
  // This used to hold a client-side search and linkage filter over whatever the
  // unbounded query returned. Both were wrong in their own way — the search
  // could not find a payment by the request number the table leads with, and the
  // linkage filter tested `order_id` alone, so a payment attached to an Order by
  // ALLOCATION matched neither narrowing while displaying that Order in its own
  // row. Both now run in the database, where they also survive paging: filtering
  // a page after the fact would narrow fifty rows and silently hide every match
  // on page two.
  const visible = requests
  const narrowed = isNarrowed({ search, linkage, dateFrom: filters.dateFrom, dateTo: filters.dateTo, allocation: filters.allocation })
  const pages = pageCount(total)

  const clearFilters = () => {
    setSearch('')
    setLinkage('all')
    setDateFrom('')
    setDateTo('')
    setAllocation('all')
    setPage(1)
  }

  if (pageLoading) return <LoadingScreen />

  return (
    <FinanceLayout
      profile={profile}
      title={meta.title}
      subtitle={meta.subtitle}
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
    >
      {/* ── Toolbar ── search, the Linked-only linkage filter, and the result
          count. Which linkage a page shows is now the route, so there is no
          status navigation left inside the card below. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
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
            placeholder={meta.searchPlaceholder}
            value={search}
            onChange={e => applySearch(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary, minWidth: 0 }}
          />
          {search && (
            <button onClick={() => applySearch('')} aria-label="Clear search" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 0, lineHeight: 1, fontSize: '13px' }}>✕</button>
          )}
        </div>

        {/* Linked Payments only — a payment is attached to a Confirmed Order or
            to an Order Request, never both, so this simply narrows to one.
            Non-Linked Payments holds one kind by definition, so it needs no
            filter — one that could never match would be worse than none. */}
        {mode === 'linked' && (
          <select
            className="boe-input"
            aria-label="Filter by linkage type"
            value={linkage}
            onChange={e => applyLinkage(e.target.value as LinkageFilter)}
            style={{ fontSize: '12px', padding: '6px 10px', width: 'auto', flexShrink: 0 }}
          >
            {LINKAGE_FILTER_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}

        {/* ── How much of it has a home ──
            Answered by the database across the WHOLE narrowed set, so it
            composes correctly with search, the date range, the linkage filter
            and paging — a state computed over the loaded page would narrow
            fifty rows and hide every match on page two.

            Drawn only when the projection carries the column AND this reader can
            see every allocation. Both gates are load-bearing; see
            `allocationOffered`. */}
        {allocationOffered && (
          <select
            className="boe-input"
            aria-label="Filter by allocation state"
            value={allocation}
            onChange={e => applyAllocation(e.target.value as AllocationFilter)}
            style={{ fontSize: '12px', padding: '6px 10px', width: 'auto', flexShrink: 0 }}
          >
            {ALLOCATION_FILTER_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}

        {/* ── When the money arrived ──
            Bounds the list by payment_date, which is the date Finance
            reconciles against — not created_at, which is when somebody typed it
            in. Either bound alone is a valid open-ended range, and a pair typed
            the wrong way round is read as the range between them rather than
            answered with an empty table. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          <label htmlFor="payment-date-from" style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
            Paid
          </label>
          <input
            id="payment-date-from"
            type="date"
            className="boe-input"
            aria-label="Payments on or after"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={e => applyDateFrom(e.target.value)}
            style={{ fontSize: '12px', padding: '5px 8px', width: 'auto' }}
          />
          <span style={{ fontSize: '11px', color: colors.muted }}>to</span>
          <input
            id="payment-date-to"
            type="date"
            className="boe-input"
            aria-label="Payments on or before"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={e => applyDateTo(e.target.value)}
            style={{ fontSize: '12px', padding: '5px 8px', width: 'auto' }}
          />
        </div>

        {narrowed && (
          <button
            onClick={clearFilters}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '5px 10px', fontSize: '11px', flexShrink: 0 }}
          >
            Clear filters
          </button>
        )}

        {/* The size of the WHOLE narrowed set, from the database's exact count —
            not the length of the page in hand, which would understate it the
            moment there is more than one page. */}
        <div
          aria-live="polite"
          style={{ marginLeft: 'auto', fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}
        >
          {resultSummary({ loading: listLoading, shown: visible.length, total, narrowed, page, pages })}
        </div>
      </div>

      <div className="boe-card" style={{ overflow: 'hidden' }}>
        {/* Table */}
        {listLoading ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          /* TWO DIFFERENT EMPTIES, said differently. "No payments" is a
             statement about the business; "nothing matches" is a statement
             about the filter, and it offers the way out. Confusing the two
             sends somebody hunting for a payment that is merely filtered. */
          <div style={{ padding: '40px 20px', textAlign: 'center', color: colors.muted, fontSize: '13px', lineHeight: 1.6 }}>
            {narrowed ? (
              <>
                No payments match the current filters.
                <div style={{ marginTop: '10px' }}>
                  <button onClick={clearFilters} className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }}>
                    Clear filters
                  </button>
                </div>
              </>
            ) : meta.empty}
          </div>
        ) : (
          <ReceivedPaymentsTable
            rows={visible}
            canManage={caps.canManageFinance}
            canOpenLinkedRecord={canOpenOrderRecord(ordersCaps.canAccessOrdersModule)}
            allocations={allocations}
            highlightId={highlightId}
            onView={r  => setDetailRequest(r)}
            onEdit={r  => setEditRequest(r)}
            onLink={r  => setLinkRequest(r)}
            onUnlink={r => { setUnlinkTarget(r); setUnlinkReason(''); setUnlinkError(null) }}
            onOpenLinked={href => router.push(href)}
          />
        )}

        {/* ── Paging ──
            Rendered only when there is more than one page, so a short list
            looks exactly as it always has. Deep-linkable navigation is
            unchanged: ?payment= still resolves to whichever page holds the row
            through the parent /finance/received route. */}
        {!listLoading && pages > 1 && (
          <nav
            aria-label="Payment pages"
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

      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          mayCorrectPayments={caps.canCorrectOrReversePayment}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); refreshAfterMutation() }}
          allocation={allocations.get(detailRequest.id) ?? PENDING_ALLOCATION_SUMMARY(detailRequest.id)}
          canOpenLinkedRecord={canOpenOrderRecord(ordersCaps.canAccessOrdersModule)}
          onOpenLinked={href => router.push(href)}
        />
      )}

      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); refreshAfterMutation() }}
        />
      )}



      {linkRequest && (
        <LinkOrderModal
          payment={linkRequest}
          supabase={supabase}
          onClose={() => setLinkRequest(null)}
          onLinked={() => { setLinkRequest(null); refreshAfterMutation() }}
        />
      )}

      {/* Unlink confirmation — same shared modal shell as every other Finance
          dialog; closing (backdrop, header ✕, or Escape) is guarded exactly
          as before so it can't be dismissed mid-request. */}
      {unlinkTarget && (
        <FinanceModal
          title="Unlink Payment?"
          width="380px"
          onClose={() => { if (!unlinking) { setUnlinkTarget(null); setUnlinkReason(''); setUnlinkError(null) } }}
        >
          <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
            This will remove the link between{' '}
            <strong>{unlinkTarget.client_name}</strong> ({fmtAmount(unlinkTarget.amount)}) and{' '}
            {unlinkTarget.order_id ? 'order' : 'order request'}{' '}
            <strong>
              {unlinkTarget.order_id
                ? (unlinkTarget.order_number ?? unlinkTarget.order_id)
                : (unlinkTarget.order_request_number ?? unlinkTarget.order_request_id)}
            </strong>.
            <br /><br />
            The payment will return to suspense status.
          </div>
          <Field label="Reason" required>
            <textarea
              className="boe-input"
              value={unlinkReason}
              onChange={e => { setUnlinkReason(e.target.value); setUnlinkError(null) }}
              placeholder="Why is this payment being unlinked? (required)"
              rows={2}
              disabled={unlinking}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </Field>
          {unlinkError && <ErrorBanner message={unlinkError} />}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setUnlinkTarget(null); setUnlinkReason(''); setUnlinkError(null) }}
              disabled={unlinking}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              Cancel
            </button>
            <button
              onClick={handleUnlink}
              disabled={unlinking || !unlinkReason.trim()}
              style={{
                padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
                border: `1px solid ${colors.border}`, background: colors.raised,
                color: colors.primary,
                cursor: (unlinking || !unlinkReason.trim()) ? 'not-allowed' : 'pointer',
                opacity: (unlinking || !unlinkReason.trim()) ? 0.6 : 1,
              }}
            >
              {unlinking ? 'Unlinking…' : 'Yes, Unlink'}
            </button>
          </div>
        </FinanceModal>
      )}

    </FinanceLayout>
  )
}
