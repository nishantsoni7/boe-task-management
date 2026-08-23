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
import { RECEIVED_PAYMENTS_SOURCE } from '@/app/finance/paymentRouting'
import {
  ALLOCATION_FILTER_OPTIONS,
  PAYMENT_VIEW_OPTIONS,
  RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS,
  allocationFilterAvailable,
  allocationFilterClauses,
  ALLOCATED_TOTAL_COLUMN,
  CLASSIFIED_PAYMENT_STATUSES,
  dateRange,
  isNarrowed,
  paymentViewFilterClauses,
  pageCount,
  pageRange,
  resultSummary,
  receivedPaymentsSearchFilter,
  type AllocationFilter,
  type PaymentView,
} from '@/app/finance/receivedPaymentsQuery'
import {
  PAYMENT_VERIFICATION_LABEL,
  paymentRowFigures,
  paymentClassificationAvailable,
  type ClassifiablePayment,
} from '@/lib/finance/paymentClassification'
import {
  directOrderOf,
  linkCounts,
  paymentLinks,
  type PaymentLink,
} from '@/lib/finance/paymentLinks'
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
import {
  ALLOCATE_ACTION_LABEL,
  AllocatePaymentModal,
} from './AllocatePaymentModal'
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
  /** allocated_order_id IS NOT NULL, computed in the projection. */
  is_order_allocated: boolean
  // ── The canonical classification, from the projection (20261008000000) ──
  //
  // READ, NEVER RE-DERIVED. These are the figures the database filtered and
  // counted this page by; computing them again in the browser from the
  // allocation rows in hand would produce a second answer that disagrees with
  // the narrowing the reader just applied.
  order_allocated_total: string | number | null
  pi_allocated_total: string | number | null
  allocated_total: string | number | null
  attributed_total: string | number | null
  available_balance: string | number | null
  active_allocation_count: number | null
  attribution_complete: boolean | null
  is_linked_to_order: boolean | null
  is_linked_to_pi: boolean | null
  is_available_to_allocate: boolean | null
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

// A Link-modal search result. ONE KIND, because there is now one kind of direct
// linkage a payment may carry: a Confirmed Order. The Order Request branch that
// sat beside it is retired (20261007000000) — the database refuses the write, so
// offering the choice would be an invitation to a submission that cannot land.
type LinkTarget = {
  kind: 'order'
  id: string
  display_number: string
  client_name: string
  total_value: number | null
  status: string
  confirm_date: string | null
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

/**
 * Below this the eleven-column table becomes cards.
 *
 * The table is honestly wide and the app shell clips horizontal overflow, so a
 * phone would either lose columns off the edge or squeeze them into
 * unreadability. 768px is the same breakpoint PI Drafts uses for the same
 * decision.
 */
const PAYMENTS_TABLE_BREAKPOINT = 768

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

// ── The four views ────────────────────────────────────────────────────────────
//
// Received Payments is ONE list with four views, not two sibling pages. The old
// pair — Linked and Non-Linked — split every payment by whether any of three
// columns was set, and both halves of that are now wrong:
//
//   * a payment divided between a Confirmed Order and a PI Draft belongs in BOTH
//     linked views at once, and in Available too if anything is left over. A
//     partition has to pick one, and picking one is how a mixed payment becomes
//     invisible from the other side.
//   * an Order Request linkage counted as "linked", on the reasoning that
//     conversion would move the money onto an Order by itself. That workflow is
//     retired (20261007000000), nothing will convert, and the canonical
//     attribution rule has never attributed a rupee through that column.
//
// The copy below is per-view; everything else on the page is shared verbatim.
// The narrowing itself lives in paymentClassification.ts and is applied by the
// DATABASE, so a view survives paging and its count describes the whole set.

const VIEW_META: Record<PaymentView, {
  title: string
  subtitle: string
  empty: string
  searchPlaceholder: string
}> = {
  all: {
    title:    'Received Payments',
    subtitle: 'Every payment received, and what each one is attached to.',
    empty:    'No payments received yet.',
    searchPlaceholder: 'Payment, client or order…',
  },
  orders: {
    title:    'Payments · Orders',
    subtitle: 'Money attributed to one or more Confirmed Orders.',
    empty:    'No payment is attributed to a Confirmed Order yet.',
    searchPlaceholder: 'Payment, client or order…',
  },
  pi_drafts: {
    title:    'Payments · PI Drafts',
    subtitle: 'Money attributed to one or more PI Drafts awaiting approval.',
    empty:    'No payment is attributed to a PI Draft yet.',
    searchPlaceholder: 'Payment or client…',
  },
  available: {
    title:    'Payments · Available',
    subtitle: 'Money with an unallocated balance, waiting to be given a home.',
    empty:    'Nothing is waiting to be allocated. Every payment has a home.',
    searchPlaceholder: 'Payment or client…',
  },
}

/** The one list route. Its view is a `?view=`. */
const RECEIVED_PATH = '/finance/received'

function viewHref(view: PaymentView): string {
  return `${RECEIVED_PATH}?view=${view}`
}

const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  running:            { label: 'Running',             color: '#1E40AF' },
  on_hold:            { label: 'On Hold',             color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',          color: '#166534' },
  cancelled:          { label: 'Cancelled',           color: '#991B1B' },
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

// ── Destinations cell ─────────────────────────────────────────────────────────
//
// EVERY place one payment's money went, and a door to each — but only where the
// reader may actually open it. A payment split three ways shows three
// destinations; a payment attributed in full to one Order by the canonical rule's
// direct-link fallback shows that one; a payment with nothing pointing at it
// shows the plain statement that nothing does.
//
// A DESTINATION THE READER MAY NOT OPEN IS NAMED BY ITS KIND AND NOTHING ELSE.
// "A PI Draft" — no number, no client, no id, no link. That the money is split
// is the reader's own business (it is their payment); whose business the other
// share is, is not. paymentLinks decides that from whether RLS returned the
// record, which is a strictly more accurate answer than any capability check
// here could be.
//
// Palette: blue for a Confirmed Order, violet for a PI Draft, amber for nothing
// at all — unchanged from the badges this replaces.

const DESTINATION_STYLE: Record<'order' | 'submission' | 'none', { bg: string; color: string; border: string }> = {
  order:      { bg: colors.blueTint, color: colors.blue, border: 'rgba(85,133,232,0.25)' },
  submission: { bg: '#F5F3FF',       color: '#5B21B6',   border: '#DDD6FE' },
  none:       { bg: '#FFF7ED',       color: '#9A3412',   border: '#FED7AA' },
}

export const NO_DESTINATION_LABEL = 'Not allocated'

function DestinationBadge({ link, onOpen }: { link: PaymentLink; onOpen?: (href: string) => void }) {
  const style = DESTINATION_STYLE[link.kind]
  const openable = link.href !== null && onOpen !== undefined
  const body = (
    <span
      title={link.named ? link.label : 'You cannot open this record'}
      style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
        background: style.bg, color: style.color, border: `1px solid ${style.border}`,
        fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
        // Underlined only when it is actually a door, so a badge never looks
        // clickable to a reader who has nowhere to go.
        textDecoration: openable ? 'underline' : undefined,
        textUnderlineOffset: openable ? '2px' : undefined,
        opacity: link.named ? 1 : 0.75,
      }}
    >
      <span style={{ fontWeight: 600, opacity: 0.85 }}>
        {link.kind === 'order' ? 'Order' : 'PI'}
      </span>
      {' '}
      {link.label}
    </span>
  )

  if (!openable) return body
  return (
    <button
      onClick={e => { e.stopPropagation(); onOpen(link.href as string) }}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
    >
      {body}
    </button>
  )
}

function DestinationsCell({ links, onOpen }: { links: readonly PaymentLink[]; onOpen?: (href: string) => void }) {
  if (links.length === 0) {
    return (
      <span style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
        background: DESTINATION_STYLE.none.bg, color: DESTINATION_STYLE.none.color,
        border: `1px solid ${DESTINATION_STYLE.none.border}`,
        fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
      }}>
        {NO_DESTINATION_LABEL}
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
      {links.map(link => <DestinationBadge key={link.key} link={link} onOpen={onOpen} />)}
    </span>
  )
}

/** The verification state, as a badge. The OTHER axis, never folded into money. */
function VerificationBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span
      title={PAYMENT_VERIFICATION_LABEL[paymentRowFigures({
        id: '', amount: null, status, order_id: null,
      }).verification]}
      style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
        background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
        fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  )
}

/**
 * One money figure in the table, right-aligned and tabular.
 *
 * A ZERO IS PRINTED AS A DASH, and a withheld figure as "—" too but muted and
 * titled: "no money went here" and "you may not be told" are both usefully
 * quiet, and neither should shout a 0.00 that draws the eye away from the
 * figures that matter.
 */
function MoneyCell({ value, title }: { value: string | null; title?: string }) {
  const zero = value !== null && Number(value) === 0
  return (
    <span
      title={title ?? (value === null ? 'Not visible to you' : undefined)}
      style={{
        fontVariantNumeric: 'tabular-nums',
        color: value === null || zero ? colors.muted : colors.primary,
        fontWeight: value === null || zero ? 400 : 600,
      }}
    >
      {value === null || zero ? '—' : formatMoney(value)}
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

// THE ALLOCATION CELL IS GONE, and so is the state word it printed.
//
// "Partly allocated" told a reader that SOMETHING was left without saying how
// much, to whom the rest had gone, or whether they could act on it. The table
// now prints the three figures themselves — to Orders, to PI Drafts, available —
// beside the destinations they went to, which answers all three questions at
// once. ALLOCATION_STATE_LABEL still names the state in the details modal's
// panel below, where the per-allocation split is shown in full.

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

  // ── ONE SEARCH, AND ONLY CONFIRMED ORDERS ──
  //
  // An Order Request branch used to sit beside this, searching `order_requests`
  // for a linkage the retirement now refuses (20261007000000 §3). It is gone
  // rather than left to fail on submit.
  //
  // LINKING IS NOT ALLOCATING. This writes the payment's own `order_id` — the
  // legacy direct linkage, which the canonical rule uses as a fallback only when
  // nothing is allocated. Money that should be SPLIT, or that belongs to a PI
  // Draft, goes through Allocate instead.
  const handleSearch = async (q: string) => {
    setQuery(q)
    setSelected(null)
    const trimmed = q.trim()
    if (!trimmed) { setResults([]); return }

    setSearching(true)
    const { data } = await supabase
      .from('orders')
      .select('id, display_number, client_name, total_value, status, confirm_date')
      .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
      .not('status', 'in', '(cancelled)')
      .order('created_at', { ascending: false })
      .limit(20)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setResults(((data ?? []) as any[]).map(o => ({
      kind: 'order' as const,
      id: o.id,
      display_number: o.display_number,
      client_name: o.client_name,
      total_value: o.total_value,
      status: o.status,
      confirm_date: o.confirm_date ?? null,
    })))
    setSearching(false)
  }

  // Routed entirely through the guarded RPC (link_finance_payment_to_order,
  // 20260691000000): it locks its rows, revalidates eligibility server-side, and
  // writes the activity rows itself. No client-side .update() of
  // finance_payment_requests or the activity tables remains.
  const handleLink = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('link_finance_payment_to_order', {
      p_payment_request_id: payment.id,
      p_order_id:           selected.id,
    })

    setSaving(false)
    if (rpcError) { setError(friendlyDbErrorMessage(rpcError)); return }

    // Tell the submitter their payment is now attached.
    void notifyFinance({
      event: 'finance_linked',
      requestNumber: payment.request_number,
      entityId: payment.id,
      creatorId: payment.submitted_by,
      clientName: payment.client_name,
      orderNumber: selected.display_number,
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
      <Field label="Search Confirmed Orders">
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
            placeholder="Order number or client name…"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
          />
          {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
        </div>
      </Field>

      {results.length > 0 && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
          maxHeight: '240px', overflowY: 'auto',
        }}>
          {results.map((t, idx) => {
            const isSelected = selected?.id === t.id
            const statusMeta = ORDER_STATUS_META[t.status] ?? { label: t.status, color: colors.muted }
            const subline = [t.client_name, t.confirm_date ? `Confirmed ${fmtDate(t.confirm_date)}` : null]
              .filter(Boolean).join(' · ')
            return (
              <div
                key={t.id}
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
                      background: colors.blueTint, color: colors.blue, border: '1px solid rgba(85,133,232,0.25)',
                      fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                      Confirmed Order
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{t.display_number}</span>
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
          No orders found for &ldquo;{query.trim()}&rdquo;.
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
          {saving ? 'Linking…' : !selected ? 'Link' : `Link to Order ${selected.display_number}`}
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
  canAllocate,
  canOpenLinkedRecord,
  allocations,
  labels,
  highlightId,
  onView,
  onEdit,
  onLink,
  onUnlink,
  onAllocate,
  onOpenLinked,
}: {
  rows: PaymentRequest[]
  /**
   * May link, unlink, and edit a recorded payment. Every one of those is a
   * correction of an approved financial record — the finance.manage authority.
   */
  canManage: boolean
  /**
   * May allocate part of a payment to an Order or a PI Draft — finance.allocate,
   * the same action allocate_payment_to_target() requires. A DRAWING rule: the
   * RPC re-derives it, so hiding the control protects nobody and showing it
   * grants nothing.
   */
  canAllocate: boolean
  /**
   * May open Order Management at all — orders.view, the same module entry
   * /orders/layout.tsx enforces. A DRAWING rule and never an authorization one:
   * the destination re-reads its own row under this reader's RLS and refuses
   * anything they may not open.
   */
  canOpenLinkedRecord: boolean
  /** How much of each payment has a home. Absent until the second read lands. */
  allocations: Map<string, PaymentAllocationSummary>
  /** Display numbers for allocation targets, by id, for records RLS returned. */
  labels: ReadonlyMap<string, string>
  highlightId?: string | null
  onView:   (r: PaymentRequest) => void
  onEdit:   (r: PaymentRequest) => void
  onLink:   (r: PaymentRequest) => void
  onUnlink: (r: PaymentRequest) => void
  onAllocate: (r: PaymentRequest) => void
  onOpenLinked: (href: string) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1040px' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Payment</th>
            <th style={TH_STYLE}>Client</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Received</th>
            <th style={TH_STYLE}>Status</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>To Orders</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>To PI Drafts</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Available</th>
            <th style={TH_STYLE}>Goes To</th>
            <th style={TH_STYLE}>Paid On</th>
            <th style={TH_STYLE}>Mode</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const view = rowView(r, allocations, labels, canOpenLinkedRecord)
            const isHighlighted = r.id === highlightId
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
                {/* VERIFICATION, ITS OWN COLUMN. Whether the money arrived and
                    whose business it belongs to are different questions decided
                    by different people; a screen that merged them would have to
                    invent a precedence nobody chose. */}
                <td style={TD}>
                  <VerificationBadge status={r.status} />
                </td>
                <td style={{ ...TD, textAlign: 'right', fontSize: '12px' }}>
                  <MoneyCell value={view.figures.orderLinked} />
                </td>
                <td style={{ ...TD, textAlign: 'right', fontSize: '12px' }}>
                  <MoneyCell value={view.figures.piLinked} />
                </td>
                {/* THE BALANCE, NOT A YES/NO BADGE. A ₹10L payment with ₹4L
                    allocated has ₹6L that still needs somebody, and a flag would
                    hide it behind a confident "yes". An over-allocated row is
                    marked rather than capped — the excess is a defect in stored
                    data and is the only evidence of it. */}
                <td style={{ ...TD, textAlign: 'right', fontSize: '12px' }}>
                  {view.figures.overAllocated ? (
                    <span title="Attribution exceeds the payment. This needs a person." style={{ color: colors.red, fontWeight: 700, fontSize: '11px' }}>
                      Over-allocated
                    </span>
                  ) : (
                    <MoneyCell value={view.figures.available} />
                  )}
                </td>
                {/* Every destination, and a door to each the reader may open.
                    One the reader may NOT open is named by its kind alone. */}
                <td style={TD}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <DestinationsCell links={view.links} onOpen={onOpenLinked} />
                    {view.counts.total > 1 && (
                      <span
                        title={`${view.counts.total} allocations`}
                        style={{ fontSize: '10.5px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}
                      >
                        ×{view.counts.total}
                      </span>
                    )}
                  </span>
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {fmtDate(r.payment_date)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode}
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
                    {/* ALLOCATE — offered only where there is a balance to
                        spend AND the reader may be told what it is. A withheld
                        balance is null, and allocating against a figure nobody
                        can vouch for is how the same rupees get spent twice. */}
                    {canAllocate && view.canAllocate && (
                      <button
                        onClick={() => onAllocate(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 600, color: colors.blue }}
                      >
                        {ALLOCATE_ACTION_LABEL}
                      </button>
                    )}
                    {canManage && (
                      <>
                        {/* Link action for a payment with no Order behind it. */}
                        {!r.order_id && (
                          <button
                            onClick={() => onLink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.blue }}
                          >
                            Link
                          </button>
                        )}
                        {/* Unlink — only for a payment that originated as a new
                            order. An existing_order payment was validated
                            against a real Order at submission and
                            unlink_finance_payment_from_order (20260691000000)
                            rejects it outright, so the option is not offered.
                            A retired Order Request linkage is unlinkable for
                            the same reason it must be: it is the one way that
                            money reaches a real target. */}
                        {(r.order_id || r.order_request_id) && r.payment_against === 'new_order' && (
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
                            refuses the delete regardless of what the UI offers. */}
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

// ── The mobile list ───────────────────────────────────────────────────────────
//
// The table has eleven columns and is honestly wide. On a phone it would either
// overflow the page horizontally — which the app's shell clips — or shrink into
// unreadable columns, so below the breakpoint the same rows are drawn as CARDS.
//
// SAME DATA, SAME rowView, SAME DECISIONS. Nothing is hidden on mobile that a
// desktop reader is shown: the three money figures, the verification state, the
// destinations and their doors are all here. What changes is the shape.

function ReceivedPaymentsCards({
  rows, canAllocate, canOpenLinkedRecord, allocations, labels, highlightId, onView, onAllocate, onOpenLinked,
}: {
  rows: PaymentRequest[]
  canAllocate: boolean
  canOpenLinkedRecord: boolean
  allocations: Map<string, PaymentAllocationSummary>
  labels: ReadonlyMap<string, string>
  highlightId?: string | null
  onView: (r: PaymentRequest) => void
  onAllocate: (r: PaymentRequest) => void
  onOpenLinked: (href: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(r => {
        const view = rowView(r, allocations, labels, canOpenLinkedRecord)
        return (
          <div
            key={r.id}
            id={`payment-row-${r.id}`}
            onClick={() => onView(r)}
            style={{
              padding: '12px 14px',
              borderBottom: `1px solid ${colors.border}`,
              background: r.id === highlightId ? colors.amberTint : undefined,
              cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.client_name}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {fmtAmount(r.amount)}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <VerificationBadge status={r.status} />
              <span style={{ fontSize: '11px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
                {r.request_number} · {fmtDate(r.payment_date)}
              </span>
            </div>

            {/* The three figures, wrapped rather than scrolled. */}
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '11.5px' }}>
              <span>
                <span style={{ color: colors.muted }}>Orders </span>
                <MoneyCell value={view.figures.orderLinked} />
              </span>
              <span>
                <span style={{ color: colors.muted }}>PI Drafts </span>
                <MoneyCell value={view.figures.piLinked} />
              </span>
              <span>
                <span style={{ color: colors.muted }}>Available </span>
                {view.figures.overAllocated
                  ? <span style={{ color: colors.red, fontWeight: 700 }}>Over-allocated</span>
                  : <MoneyCell value={view.figures.available} />}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <DestinationsCell links={view.links} onOpen={onOpenLinked} />
              {canAllocate && view.canAllocate && (
                <button
                  onClick={e => { e.stopPropagation(); onAllocate(r) }}
                  className="boe-btn boe-btn-ghost"
                  style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: '11px', fontWeight: 600, color: colors.blue }}
                >
                  {ALLOCATE_ACTION_LABEL}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Everything one row needs, decided once for both the table and the cards.
 *
 * THE FIGURES ARE THE PROJECTION'S, read through the canonical classification
 * rather than recomputed from the allocation rows in hand. The database filtered
 * and counted this page by those columns, and a second answer derived in the
 * browser would disagree with the narrowing the reader just applied.
 */
function rowView(
  r: PaymentRequest,
  allocations: Map<string, PaymentAllocationSummary>,
  labels: ReadonlyMap<string, string>,
  canOpenOrders: boolean,
) {
  const figures = paymentRowFigures(r as unknown as ClassifiablePayment)
  const summary = allocations.get(r.id) ?? PENDING_ALLOCATION_SUMMARY(r.id)
  const links = paymentLinks({
    summary,
    directOrder: directOrderOf(r),
    labels,
    canOpenOrders,
  })
  return {
    figures,
    summary,
    links,
    counts: linkCounts(links),
    // A BALANCE THAT WAS WITHHELD IS NOT A BALANCE TO SPEND. `available` is null
    // when this reader cannot see every allocation of this payment, and the
    // control is not offered — the RPC would compute the true balance under a
    // lock and could refuse, but offering a control on a figure nobody can
    // vouch for invites exactly the double-spend the withholding prevents.
    canAllocate: figures.available !== null
      && Number(figures.available) > 0
      && r.status !== 'rejected',
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────
// One component, two routes: /finance/received/linked and
// /finance/received/unlinked each render it with their own `mode`. The table,
// the detail modal and every link/unlink action are shared verbatim — only the
// query predicate, the copy and the filter row differ.

export function ReceivedPaymentsView({ view }: { view: PaymentView }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReceivedPaymentsViewInner view={view} />
    </Suspense>
  )
}

function ReceivedPaymentsViewInner({ view }: { view: PaymentView }) {
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
  // ── The page, and which view it belongs to ──
  //
  // HELD TOGETHER, deliberately. Changing the view is a different set entirely,
  // so page four of the old one means nothing in the new one — but the view
  // arrives as a PROP from the route, not from a control this component owns,
  // so there is no click to hang a reset on. Resetting it in an effect would set
  // state during a render it also caused, which is the cascading-render pattern
  // react-hooks/set-state-in-effect exists to catch. Deriving it instead costs
  // nothing and cannot render twice.
  const [pageState, setPageState] = useState<{ view: PaymentView; page: number }>({ view, page: 1 })
  const page = pageState.view === view ? pageState.page : 1
  const setPage = (next: number | ((current: number) => number)) =>
    setPageState({ view, page: typeof next === 'function' ? next(page) : next })
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
  // Display numbers for the Orders and PI Drafts this page's allocations name,
  // read under the reader's OWN RLS. A target whose row did not come back is
  // named by its kind alone and offers no door — see paymentLinks.ts.
  const [targetLabels,   setTargetLabels]   = useState<Map<string, string>>(new Map())
  const [allocateTarget, setAllocateTarget] = useState<PaymentRequest | null>(null)
  // Whether the projection carries the classification at all. Fails closed: the
  // columns arrive with 20261008000000, and until then the tabs are not drawn
  // and no query is built against a column that does not exist.
  const [classificationReady, setClassificationReady] = useState(false)
  // Below this the eleven-column table becomes cards. Same data, same decisions.
  const [isMobile,       setIsMobile]       = useState(false)

  const meta         = VIEW_META[view]
  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()
  const queryClient  = useQueryClient()

  // Guards the one-time ?payment= deep-link resolution below (see effect near
  // the bottom of init) so it can never re-fire and reopen a closed modal.
  const deepLinkHandled = useRef(false)

  // ── Wide table, or cards ──
  //
  // Measured rather than guessed at from a user-agent string, and re-measured on
  // resize so rotating a tablet lands on the right shape. Starts false, which is
  // the desktop table: the first paint on a phone swaps to cards within a frame,
  // and starting with cards would flash them on every desktop load instead.
  useEffect(() => {
    const measure = () => setIsMobile(window.innerWidth < PAYMENTS_TABLE_BREAKPOINT)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

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
      // The VIEW is not a filter the reader applied; it is where they are. It is
      // in this object because the loader has to send it, and out of isNarrowed
      // for the same reason — see receivedPaymentsQuery.ts.
      view,
      dateFrom: dates.from,
      dateTo: dates.to,
      // Never sent unless the column is there AND this reader may trust it.
      allocation: allocationOffered ? allocation : ('all' as AllocationFilter),
    }
  }, [search, view, dateFrom, dateTo, allocation, allocationOffered])

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
        allocated_order_id, allocated_order_number, is_order_allocated,
        ${RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS.join(', ')}
      `, { count: 'exact' })
      // The classified scope: every payment that is not rejected. Rejected money
      // is not money, and the projection's own booleans refuse it a second time.
      .in('status', CLASSIFIED_PAYMENT_STATUSES as unknown as string[])

    let scoped = base

    // ── THE NARROWING, IN THE DATABASE ──
    //
    // Search and the classification both used to run in the BROWSER, over
    // whatever the unbounded query happened to return. Both had to move here the
    // moment the list became paged: filtering a page after the fact narrows only
    // the fifty rows in hand and silently hides every match on page two.
    //
    // Every clause narrows a set RLS has ALREADY decided this caller may see —
    // RECEIVED_PAYMENTS_SOURCE is security_invoker — so no filter here can widen
    // anything. The search term is sanitized into a literal before it reaches a
    // filter group (see sanitizeSearchTerm): a comma or a bracket in a term
    // would otherwise be parsed as MORE FILTER rather than as text to match.
    if (filters.search) scoped = scoped.or(filters.search)

    // THE VIEW, as the SAME predicate the sidebar counts use — one definition in
    // paymentClassification.ts, so the list and the number beside its nav entry
    // cannot describe different sets.
    for (const clause of paymentViewFilterClauses(filters.view)) {
      if (clause.kind === 'eq') scoped = scoped.eq(clause.column, clause.value)
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

    const allocationRows = (data ?? []) as PaymentAllocationRow[]

    // ── WHICH DESTINATIONS THIS READER MAY OPEN ──
    //
    // Two bounded reads over the ids this page's allocations name, under the
    // reader's OWN RLS. A record that comes back has a name and a door; one that
    // does not has neither, and paymentLinks names it by its kind alone.
    //
    // ASKING THE DATABASE IS THE POINT. A capability check here would be a
    // second, coarser answer than RLS's per-record one, and would offer a door
    // into a record RLS refuses. Bounded twice over: the page is at most fifty
    // payments, and these are keyed to exactly the targets they name.
    void loadTargetLabels(allocationRows, rows, token)

    setAllocations(summarizePaymentAllocations(
      // `hasDirectLink` carries the payment's own order_id into the rule: a
      // linked payment with no allocations is attributed in full to that Order
      // by the canonical fallback, so it is not free money and must not read
      // "Unallocated" here while the Order counts it.
      rows.map(r => ({ id: r.id, amount: r.amount, hasDirectLink: r.order_id !== null })),
      allocationRows, {
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

  /**
   * The display numbers for every Order and PI Draft this page's payments point
   * at, for the records this reader may actually read.
   *
   * A MISS IS THE ANSWER, NOT A FAILURE. An id that comes back with no row is a
   * record RLS refused, and paymentLinks turns that into an unnamed destination
   * with no door — the reader learns that their payment is split without
   * learning whose business the other share is.
   *
   * A PI HAS NO ALLOCATED NUMBER, so it is named by what its workbook carries.
   * An approved PI's money belongs to the Order, so a PI naming money here is by
   * definition still a draft and still has no number of its own.
   */
  const loadTargetLabels = async (
    allocationRows: readonly PaymentAllocationRow[],
    rows: readonly PaymentRequest[],
    token: number,
  ) => {
    const orderIds = new Set<string>()
    const submissionIds = new Set<string>()
    for (const row of allocationRows) {
      if (row.status !== 'active') continue
      if (row.order_id) orderIds.add(row.order_id)
      if (row.order_submission_id) submissionIds.add(row.order_submission_id)
    }
    // The direct-link fallback's Order is a destination too, and its number is
    // often already on the projection row — but not always, so it is asked for
    // here rather than assumed.
    for (const row of rows) {
      if (row.order_id) orderIds.add(row.order_id)
    }

    if (orderIds.size === 0 && submissionIds.size === 0) {
      if (token === loadToken.current) setTargetLabels(new Map())
      return
    }

    const [ordersRes, submissionsRes] = await Promise.all([
      orderIds.size > 0
        ? supabase.from('orders').select('id, display_number').in('id', [...orderIds])
        : Promise.resolve({ data: [] }),
      submissionIds.size > 0
        ? supabase.from('order_submissions')
            .select('id, source_order_number, source_workbook_name')
            .in('id', [...submissionIds])
        : Promise.resolve({ data: [] }),
    ])

    if (token !== loadToken.current) return

    const labels = new Map<string, string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of ((ordersRes.data ?? []) as any[])) {
      if (row.display_number) labels.set(row.id, row.display_number)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of ((submissionsRes.data ?? []) as any[])) {
      labels.set(row.id, row.source_order_number || row.source_workbook_name || 'Draft')
    }
    setTargetLabels(labels)
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

      // ── IS THE CLASSIFICATION THERE? ──
      //
      // The same shape, for the same reason. The four views exist only once
      // 20261008000000 is applied; until then the tab strip is not drawn and no
      // query is built against a column that does not exist. A strip whose tabs
      // all returned the same rows would look like a working control that
      // quietly does nothing.
      //
      // In this group, so it costs no wait.
      const classificationProbe = supabase
        .from(RECEIVED_PAYMENTS_SOURCE)
        .select(`id, ${RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS.join(', ')}`)
        .limit(1)
        .then((result: { error: unknown }) => paymentClassificationAvailable(
          result.error ? null : { columns: [...RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS] }))
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

      const [{ data: me }, financePerms, ordersPerms, allocationAvailable, classificationAvailable] =
        await Promise.all([
          profilePromise,
          financePromise,
          ordersPromise,
          allocationProbe,
          classificationProbe,
          loadRequests(),
        ])

      setAllocationReady(allocationAvailable)
      setClassificationReady(classificationAvailable)
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
  }, [filters.search, filters.view, filters.dateFrom, filters.dateTo, filters.allocation, page])

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
  const applyDateFrom = narrowBy(setDateFrom)
  const applyDateTo   = narrowBy(setDateTo)
  const applyAllocation = narrowBy(setAllocation)

  // ── Deep-link resolution (?payment=&action=link|edit) ────────────────────────
  // Runs exactly once, once `requests` is loaded. Sources: the Admin Action
  // Queue (action=link) and Finance notifications. Each modal auto-opens only when the loaded payment
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
      router.replace(viewHref(view))
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
  const narrowed = isNarrowed({ search, dateFrom: filters.dateFrom, dateTo: filters.dateTo, allocation: filters.allocation })
  const pages = pageCount(total)

  const clearFilters = () => {
    setSearch('')
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
      activeReceivedView={view}
    >
      {/* ── The four views ──
          Where the reader IS, not a filter they applied — so this is a tab
          strip and not another control in the toolbar, and it is absent from
          isNarrowed. Each tab is a route, so a view is deep-linkable, shareable
          and survives a refresh; the narrowing itself is the database's.

          NOT DRAWN AT ALL until the projection carries the classification
          (20261008000000). A strip whose tabs all returned the same rows would
          be worse than no strip: it would look like a working control that
          quietly does nothing. */}
      {classificationReady && (
        <div
          role="tablist"
          aria-label="Payment views"
          style={{
            display: 'flex', gap: '4px', flexWrap: 'wrap',
            marginBottom: '12px', overflowX: 'auto', WebkitOverflowScrolling: 'touch',
          }}
        >
          {PAYMENT_VIEW_OPTIONS.map(option => {
            const active = option.value === view
            return (
              <button
                key={option.value}
                role="tab"
                aria-selected={active}
                title={option.description}
                onClick={() => router.push(viewHref(option.value))}
                style={{
                  padding: '6px 12px', borderRadius: '8px', flexShrink: 0,
                  fontSize: '12px', fontWeight: active ? 700 : 500,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  border: active ? '1.5px solid #DC1F2E' : `1px solid ${colors.border}`,
                  background: active ? 'rgba(220,31,46,0.04)' : colors.raised,
                  color: active ? '#DC1F2E' : colors.secondary,
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )}
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

        {/* ── How much of it has a home ──
            Answered by the database across the WHOLE narrowed set, so it
            composes correctly with search, the date range, the view
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
          isMobile ? (
            <ReceivedPaymentsCards
              rows={visible}
              canAllocate={caps.canAllocatePayment}
              canOpenLinkedRecord={canOpenOrderRecord(ordersCaps.canAccessOrdersModule)}
              allocations={allocations}
              labels={targetLabels}
              highlightId={highlightId}
              onView={r => setDetailRequest(r)}
              onAllocate={r => setAllocateTarget(r)}
              onOpenLinked={href => router.push(href)}
            />
          ) : (
            <ReceivedPaymentsTable
              rows={visible}
              canManage={caps.canManageFinance}
              canAllocate={caps.canAllocatePayment}
              canOpenLinkedRecord={canOpenOrderRecord(ordersCaps.canAccessOrdersModule)}
              allocations={allocations}
              labels={targetLabels}
              highlightId={highlightId}
              onView={r  => setDetailRequest(r)}
              onEdit={r  => setEditRequest(r)}
              onLink={r  => setLinkRequest(r)}
              onUnlink={r => { setUnlinkTarget(r); setUnlinkReason(''); setUnlinkError(null) }}
              onAllocate={r => setAllocateTarget(r)}
              onOpenLinked={href => router.push(href)}
            />
          )
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



      {/* ── Allocate ──
          The one control that spends part of a payment, offering exactly the
          two targets the business has: a permitted Confirmed Order or a
          permitted PI Draft. Every gate is allocate_payment_to_target()'s. */}
      {allocateTarget && (
        <AllocatePaymentModal
          payment={{
            id: allocateTarget.id,
            request_number: allocateTarget.request_number,
            client_name: allocateTarget.client_name,
            amount: allocateTarget.amount,
            available_balance: allocateTarget.available_balance,
          }}
          supabase={supabase}
          onClose={() => setAllocateTarget(null)}
          onAllocated={() => { setAllocateTarget(null); refreshAfterMutation() }}
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
