'use client'


import { dateParam, enumParam, pageParam, textParam } from '@/lib/listState'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { PAYMENT_DISPLAY_STATE_META } from '@/lib/finance/paymentDestination'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { paymentCashLockErrorMessage } from '@/lib/finance/paymentCashLock'
import { bankVerifyRefusal } from '@/lib/finance/bankMarks'
import { CONFIRMED_ALLOCATION_FILTERS, DEFAULT_CONFIRMED_ALLOCATION_FILTER, type ConfirmedAllocationFilter, type ConfirmedAllocationStatus } from '@/lib/finance/paymentSurfaces'

// The data model, constants and small display helpers of Received Payments, split out of
// ReceivedPaymentsView.tsx (which had grown past 3,800 lines). Nothing here changed.

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaymentRequest = {
  id: string
  request_number: string
  /** P-AA-0001 style, database-generated, immutable, unique. THE user-facing
   *  Payment ID — request_number is retained in the database and in this type
   *  only because other logic still reads it; it is never the primary label. */
  human_payment_id: string
  /** The pure allocation-ledger classification (20261011000000 §5): zero |
   *  partial | full | over. Null only when amount itself is null. */
  confirmed_allocation_status: ConfirmedAllocationStatus | null
  /** The COMPLETE status — complete_allocation_status, a computed field over
   *  the whole active ledger (20261216000000 §4). What the allocation filter,
   *  its count and the Allocate Funds offer use. Null on Payments to Verify,
   *  which does not select it. */
  complete_allocation_status?: ConfirmedAllocationStatus | null
  /**
   * NULLABLE since 20261013000000 §1. Null means no customer could be derived
   * — the payment names no PI Draft and no Order. Rendered through
   * <CustomerName>, which never prints a blank.
   */
  client_name: string | null
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string | null
  /**
   * THE FIVE LEGACY CUSTODY COLUMNS (20260716000000), frozen as history since
   * 20261014000000 §2. Nothing writes them any more; they are read so that a
   * payment recorded before the activity trail existed still shows who was
   * carrying its money, projected into the same event shape by
   * legacyCustodyEvents.
   */
  collected_by_user_id: string | null
  collected_from_text: string | null
  handed_over_to_user_id: string | null
  handed_over_at: string | null
  collection_handover_note: string | null
  /** Stamped at INSERT while Test Data Cleanup was enabled; immutable. Read
   *  from the base table with the custody columns. No longer gates Delete:
   *  an admin may delete a verified payment since 20270331000000. */
  is_test_data?: boolean
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

// ── The five legacy custody columns: not on the projection ──────────────────
//
// RECEIVED_PAYMENTS_SOURCE (finance_received_payments) never carried
// collected_by_user_id / collected_from_text / handed_over_to_user_id /
// handed_over_at / collection_handover_note — they exist only on the base
// table, finance_payment_requests. Asking the PROJECTION to select a column
// it does not have is PostgREST error 42703, and that fails the WHOLE
// request, not just these five fields: the entire Confirmed Payments list
// query used to come back empty for every reader, with the sidebar count
// (a separate, narrower query) still reading correctly beside it.
//
// Fetched separately, by id, straight from finance_payment_requests — the
// same table the projection is security_invoker over, so this grants no
// reader anything the projection would not already have shown them.
export const LEGACY_CUSTODY_COLUMNS = [
  'collected_by_user_id',
  'collected_from_text',
  'handed_over_to_user_id',
  'handed_over_at',
  'collection_handover_note',
] as const

export type LegacyCustodyFields = Pick<PaymentRequest,
  | 'collected_by_user_id'
  | 'collected_from_text'
  | 'handed_over_to_user_id'
  | 'handed_over_at'
  | 'collection_handover_note'
  | 'is_test_data'>

export const NO_LEGACY_CUSTODY: LegacyCustodyFields = {
  collected_by_user_id: null,
  collected_from_text: null,
  handed_over_to_user_id: null,
  handed_over_at: null,
  collection_handover_note: null,
  // Unknown is treated as REAL: a verified payment then offers no Delete.
  is_test_data: false,
}

/** The five legacy custody columns for a bounded set of payment ids, keyed by id. */
export async function fetchLegacyCustodyFields(
  supabase: ReturnType<typeof createClient>,
  ids: readonly string[],
): Promise<Map<string, LegacyCustodyFields>> {
  const map = new Map<string, LegacyCustodyFields>()
  if (ids.length === 0) return map
  const { data } = await supabase
    .from('finance_payment_requests')
    // is_test_data rides the same base-table read: whether a VERIFIED payment
    // may be deleted at all (20261218000000). Not on the projection.
    .select(`id, ${LEGACY_CUSTODY_COLUMNS.join(', ')}, is_test_data`)
    .in('id', [...ids])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of ((data ?? []) as any[])) {
    map.set(row.id, {
      collected_by_user_id:     row.collected_by_user_id ?? null,
      collected_from_text:      row.collected_from_text ?? null,
      handed_over_to_user_id:   row.handed_over_to_user_id ?? null,
      handed_over_at:           row.handed_over_at ?? null,
      collection_handover_note: row.collection_handover_note ?? null,
      is_test_data:             row.is_test_data === true,
    })
  }
  return map
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
export const SEARCH_DEBOUNCE_MS = 250


export const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'HDFC PRI',
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
export function receivedInLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not stated'
  return RECEIVED_IN_LABEL[value] ?? value
}

// THE SHARED DISPLAY PALETTE, not a second copy of it. approved_unlinked used
// to read "Order No. Pending", which a Confirmed-Order payment wore even after
// Finance had approved it and the Order had received its allocation in full —
// because that status is derived from order_id, which the payment-entry doors
// deliberately leave NULL. The two verified labels are decided live from the
// ALLOCATION LEDGER now, through finance_payment_destinations.
export const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    PAYMENT_DISPLAY_STATE_META.pending,
  approved_unlinked:   PAYMENT_DISPLAY_STATE_META.received_unallocated,
  approved_linked:     PAYMENT_DISPLAY_STATE_META.received,
  needs_clarification: PAYMENT_DISPLAY_STATE_META.needs_clarification,
  rejected:            PAYMENT_DISPLAY_STATE_META.rejected,
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

/**
 * Payments to Verify names itself.
 *
 * SEPARATE COPY, not a fifth entry in VIEW_META, because it is not a view: the
 * four views narrow confirmed money by where it went, and this page is the
 * money that has not been confirmed at all. Sharing the record would have made
 * it look like one more tab on a strip it does not belong to.
 */
export const TO_VERIFY_META = {
  title:    'Payments to Verify',
  subtitle: 'Awaiting verification, needing clarification, or rejected.',
  empty:    'Nothing is waiting to be verified.',
  searchPlaceholder: 'Payment, client or order…',
}

export const VIEW_META: Record<'all', {
  title: string
  subtitle: string
  empty: string
  searchPlaceholder: string
}> = {
  all: {
    // THE SIDEBAR'S NAME. The entry that leads here says "Confirmed Payments";
    // a page that answers to a different name makes a reader wonder whether
    // they landed where they meant to.
    title:    'Confirmed Payments',
    subtitle: 'Confirmed money, and exactly where each payment is allocated.',
    empty:    'No payments received yet.',
    searchPlaceholder: 'Payment, client or order…',
  },
  // THE THREE NARROWED VIEWS HAVE NO WORDS OF THEIR OWN ANY MORE. The list
  // stopped narrowing by ?view= when the allocation-status tabs replaced the
  // four sub-views, but their titles survived — so /finance/received/unlinked
  // (forwarded as ?view=available) announced "Payments · Available" above every
  // payment there is. A retired address now lands on the real page under its
  // real name; the tabs are how a reader narrows it.
}

/**
 * The list's working context in the query string — the same shared codecs the
 * Task and Confirmed Orders lists use. A value that is not recognised reads as
 * the default; a default is never written.
 */
export const RECEIVED_LIST_PARAMS = {
  status: enumParam<ConfirmedAllocationFilter>(CONFIRMED_ALLOCATION_FILTERS, DEFAULT_CONFIRMED_ALLOCATION_FILTER),
  q:      textParam(),
  from:   dateParam(),
  to:     dateParam(),
  page:   pageParam(),
}



export const RECEIVED_IN_OPTIONS = [
  // First, and empty-valued: a payment recorded against a PI states no account,
  // and the form must show that truthfully instead of defaulting to the first
  // real one. Choosing a real option is how Finance supplies it later.
  { label: 'Not stated', value: '' },
  { label: 'HDFC PRI', value: 'company_account' },
  { label: 'PNB',    value: 'other' },
  { label: 'Paytm',  value: 'cash_in_hand' },
  { label: 'Canara', value: 'savings_account' },
]

// approved_unlinked and approved_linked are deliberately excluded — see
// isLinkageStatus below and 20260691000000: those two states may only be
// reached through the guarded RPCs, never through a status correction. Today
// the only one of those RPCs the app still calls is
// approve_finance_payment_request; the link/unlink pair remains in the database
// with no caller, because retiring the UI is not a migration.
export const STATUS_CORRECTION_OPTIONS = [
  { value: 'pending_approval',    label: 'Pending' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

// A custody activity happens at a TIME, not on a day. Read in the reader's own
// zone, which is where the person entering it was standing.
export function fmtDateTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export function fmtDate(iso: string) {
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
export const fmtAmount = formatMoney

// Maps the approved_linked-requires-order_id CHECK constraint violation to a
// clear message instead of surfacing the raw Postgres error.
export function friendlyDbErrorMessage(dbError: { code?: string; message: string } | null): string {
  if (!dbError) return ''
  // 20270415000000: the payment is in an open or accepted cash handover.
  const cashLocked = paymentCashLockErrorMessage(dbError.message)
  if (cashLocked) return cashLocked
  // 20270516000000: an edit may not leave a verified payment short of the bank.
  const bank = bankVerifyRefusal(dbError.message)
  if (bank) return bank
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

export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '12px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}{required && <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(180,35,50,0.1)', color: '#B42332', fontSize: '12px' }}>
      {message}
    </div>
  )
}

