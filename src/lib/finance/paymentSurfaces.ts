// WHICH PAGE A PAYMENT BELONGS ON, and the one status list that decides it.
//
// THE CANONICAL DEFINITION IS THE DATABASE'S, NOT THIS FILE'S.
// public.finance_payment_status_is_verified(text) — 20260918000000 §5 — says a
// payment is confirmed when its status is `approved_unlinked` or
// `approved_linked`, "and nothing else", and calls itself "the single
// definition of verified". CONFIRMED_PAYMENT_STATUSES below is that function's
// list, restated for the client with a test that reads the migration and fails
// if the two ever disagree. Nothing here invents a rule.
//
// THE FULL ENUM, from the CHECK on finance_payment_requests.status
// (20260628000200):
//
//   pending_approval      submitted, nobody has verified it yet
//   needs_clarification   a verifier asked the submitter something
//   rejected              a verifier refused it
//   approved_unlinked     CONFIRMED. Money received, no direct Order linkage
//   approved_linked       CONFIRMED. Money received, linked to an Order
//
// WHY TWO PAGES AND NOT ONE LIST WITH A FILTER
// --------------------------------------------
// The two halves are different work for different people. A verifier opens
// Payments to Verify to decide something; everybody else opens Confirmed
// Payments to read money that has actually arrived. Merging them meant the
// second audience scanned past rows that were not money yet, and every count,
// every search and every page number was computed over a set that mixed the
// two — so "142 payments" answered neither question.
//
// THE SPLIT IS EXHAUSTIVE AND DISJOINT, asserted in the tests: every status in
// the enum is on exactly one page. A status invented by a later phase belongs
// to neither until somebody decides, which is a visible failure rather than a
// row that quietly stops appearing anywhere.

/** Money that has arrived. The database's own definition, restated. */
export const CONFIRMED_PAYMENT_STATUSES = [
  'approved_unlinked',
  'approved_linked',
] as const

/** Everything that is not money yet, or is not money at all. */
export const TO_VERIFY_PAYMENT_STATUSES = [
  'pending_approval',
  'needs_clarification',
  'rejected',
] as const

/** Every status the CHECK constraint admits. Used to prove the split is total. */
export const ALL_PAYMENT_STATUSES = [
  ...CONFIRMED_PAYMENT_STATUSES,
  ...TO_VERIFY_PAYMENT_STATUSES,
] as const

export type PaymentStatus = (typeof ALL_PAYMENT_STATUSES)[number]

export type PaymentSurface = 'confirmed' | 'to_verify'

export const PAYMENT_SURFACE_STATUSES: Record<PaymentSurface, readonly string[]> = {
  confirmed: CONFIRMED_PAYMENT_STATUSES,
  to_verify: TO_VERIFY_PAYMENT_STATUSES,
}

export const CONFIRMED_PAYMENTS_PATH = '/finance/received'
export const PAYMENTS_TO_VERIFY_PATH = '/finance/payments-to-verify'

export const PAYMENT_SURFACE_PATH: Record<PaymentSurface, string> = {
  confirmed: CONFIRMED_PAYMENTS_PATH,
  to_verify: PAYMENTS_TO_VERIFY_PATH,
}

export const PAYMENT_SURFACE_TITLE: Record<PaymentSurface, string> = {
  confirmed: 'Confirmed Payments',
  to_verify: 'Payments to Verify',
}

export const PAYMENT_SURFACE_SUBTITLE: Record<PaymentSurface, string> = {
  confirmed: 'Money that has been received and verified.',
  to_verify: 'Awaiting verification, needing clarification, or rejected.',
}

/**
 * Which page this payment belongs on.
 *
 * Returns null for a status the enum does not contain — a row that belongs
 * nowhere is a schema change nobody told the screens about, and answering
 * "confirmed" or "to verify" for it would be a guess about money.
 */
export function surfaceForStatus(status: string | null | undefined): PaymentSurface | null {
  if ((CONFIRMED_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')) return 'confirmed'
  if ((TO_VERIFY_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')) return 'to_verify'
  return null
}

export function isConfirmedPaymentStatus(status: string | null | undefined): boolean {
  return surfaceForStatus(status) === 'confirmed'
}

/**
 * The overlapping views — All, Orders, PI Drafts, Available to Allocate — belong
 * to Confirmed Payments alone.
 *
 * They classify money by where it has been attributed, and a payment awaiting
 * verification has been attributed nowhere: "Available to Allocate" over money
 * nobody has confirmed arrived is an invitation to spend it twice.
 */
export function surfaceHasClassificationViews(surface: PaymentSurface): boolean {
  return surface === 'confirmed'
}

// ── The Confirmed Payments table ─────────────────────────────────────────────

/**
 * EIGHT COLUMNS, IN THIS ORDER, AND NO OTHERS.
 *
 * The table carried eleven and was honestly wide: at 1024px it either scrolled
 * sideways inside its own box or squeezed every figure into an unreadable
 * column. What survives is what a Finance reader scans a LIST for — how much,
 * when, how, how much of it is spoken for, who raised it, who confirmed it —
 * with everything else one click away on the row itself.
 *
 * WHAT WAS REMOVED AND WHERE IT WENT, so nothing is silently lost:
 *
 *   Payment (reference)  → the detail modal, and search still matches it
 *   Status               → the page IS the status now. Every row is confirmed.
 *   Goes To              → the detail modal's allocation breakdown
 *   Customer             → the detail modal, UNABRIDGED. It was the widest
 *                          column and the most often truncated, which made it
 *                          the one column that cost width and still could not
 *                          be trusted to be read in full.
 *   Total Allocated  }   → the detail modal, beside the per-target breakdown
 *   Remaining        }     they are the totals OF. Two money columns that only
 *                          make sense together, and neither of which can be
 *                          acted on from the row, are a detail view's job; the
 *                          Allocation Status badge is the row's summary of both
 *                          and is now the door to them.
 *
 * NOTHING WAS DROPPED FROM THE QUERY. Customer, both totals and every linkage
 * field are still selected by the one bounded read and still reach the modal —
 * this is a change to what the TABLE draws, not to what the page knows.
 *
 * `width` is a hint for the header cell, not a hard size: the table lays out
 * `auto`, so these keep the eight columns from drifting apart on a wide screen
 * while still letting a long name take the room it needs.
 */
export const CONFIRMED_PAYMENT_COLUMNS = [
  { key: 'payment_id',   label: 'Payment ID',        align: 'left',  width: '120px' },
  // Right-aligned with tabular figures, as every money column in the app is:
  // digits line up by place value, so magnitudes are comparable down the column.
  { key: 'amount',       label: 'Amount',            align: 'right', width: '130px' },
  { key: 'date',         label: 'Received Date',     align: 'left',  width: '120px' },
  { key: 'mode',         label: 'Mode',              align: 'left',  width: '110px' },
  // The widest of the remaining columns because its content is a badge that is
  // also a control, and because four different labels have to fit without wrap.
  { key: 'status',       label: 'Allocation Status', align: 'left',  width: '170px' },
  { key: 'initiated_by', label: 'Initiated By',      align: 'left'  },
  { key: 'approved_by',  label: 'Approved By',       align: 'left'  },
  { key: 'actions',      label: 'Actions',           align: 'right', width: '110px' },
] as const

/**
 * The breakdown fields shown only in the expandable row/card detail, so the
 * primary row stays scrollable-free at 1024px. "To Orders" / "To PI Draft"
 * are what "Allocated to Orders" / "Allocated to PI Drafts" mean per-row —
 * exact monetary figures, never the retired "Linked Against" phrasing.
 */
export const CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS = [
  { key: 'to_pi_draft', label: 'Allocated to PI Drafts', align: 'right' },
  { key: 'to_orders',   label: 'Allocated to Orders',    align: 'right' },
] as const

export type ConfirmedPaymentColumn = (typeof CONFIRMED_PAYMENT_COLUMNS)[number]['key']

/**
 * The pure allocation-ledger classification a Confirmed Payment row carries —
 * `confirmed_allocation_status` on `finance_received_payments`
 * (20261011000000 §5). Deliberately NOT the same as `allocation_state`, which
 * folds in the legacy direct-link fallback for a different purpose (Orders'
 * conservation law); this is the literal "how much of the ledger total is
 * allocated" figure Requirement 1's filters and badges read.
 */
export const CONFIRMED_ALLOCATION_STATUSES = ['zero', 'partial', 'full', 'over'] as const
export type ConfirmedAllocationStatus = (typeof CONFIRMED_ALLOCATION_STATUSES)[number]

export const CONFIRMED_ALLOCATION_FILTERS = ['all', ...CONFIRMED_ALLOCATION_STATUSES] as const
export type ConfirmedAllocationFilter = (typeof CONFIRMED_ALLOCATION_FILTERS)[number]

export const DEFAULT_CONFIRMED_ALLOCATION_FILTER: ConfirmedAllocationFilter = 'all'

export const CONFIRMED_ALLOCATION_FILTER_LABEL: Record<ConfirmedAllocationFilter, string> = {
  all: 'All',
  zero: 'Zero Allocated',
  partial: 'Partially Allocated',
  full: 'Fully Allocated',
  // 'over' has no filter chip of its own — see badge below; surfaced only as
  // a flag on the row it belongs to, for Admin review, never as a silent
  // reclassification into 'full'.
  over: 'Over-allocated',
}

/**
 * The badge text and tone for a Confirmed Payment's allocation status.
 *
 * 'over' IS NOT a filter choice — Requirement 1 defines exactly three filters
 * (Zero / Partially / Fully Allocated) plus All. It still needs a badge,
 * because a payment in that state must never be shown as confidently 'Fully
 * Allocated': it is invalid legacy data and is flagged for Admin review
 * wherever it appears, including under the "All" and "Fully Allocated"...
 * actually never under Fully Allocated — see classifyForFilter below.
 */
export const CONFIRMED_ALLOCATION_BADGE: Record<ConfirmedAllocationStatus, { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = {
  zero:    { label: 'Zero Allocated',       tone: 'neutral' },
  partial: { label: 'Partially Allocated',  tone: 'warning' },
  full:    { label: 'Fully Allocated',      tone: 'success' },
  over:    { label: 'Over-allocated — review', tone: 'danger' },
}

/**
 * Whether a row belongs under a given filter chip. "All" always matches.
 * An over-allocated row matches none of Zero/Partial/Full — it is flagged,
 * never folded into any of the three, and is still reachable through "All".
 */
export function matchesConfirmedAllocationFilter(
  status: ConfirmedAllocationStatus | null | undefined,
  filter: ConfirmedAllocationFilter,
): boolean {
  if (filter === 'all') return true
  return status === filter
}

/**
 * The customer name shown in a Finance table or card: at most ~20 characters
 * including spaces, cleanly ellipsized, with the untouched full name kept
 * alongside for a tooltip. THE ONE PLACE this truncation rule lives — no
 * other component should re-derive it. The stored value is never touched;
 * this only shapes what is rendered.
 */
export const CUSTOMER_NAME_DISPLAY_LIMIT = 20

export function formatCustomerName(
  full: string | null | undefined,
  limit: number = CUSTOMER_NAME_DISPLAY_LIMIT,
): { display: string; full: string; truncated: boolean } {
  const name = (full ?? '').trim().replace(/\s+/g, ' ')
  if (name === '') return { display: '—', full: '', truncated: false }
  if (name.length <= limit) return { display: name, full: name, truncated: false }
  // Trim to the limit minus the ellipsis, then back off to the last full
  // word so the cut never lands mid-word.
  const cut = name.slice(0, Math.max(1, limit - 1))
  const lastSpace = cut.lastIndexOf(' ')
  const clean = lastSpace > Math.floor(limit / 2) ? cut.slice(0, lastSpace) : cut
  return { display: `${clean}…`, full: name, truncated: true }
}

/**
 * Below this the table becomes cards.
 *
 * NINE COMPACT COLUMNS FIT 1024px; eleven did not. The number is the practical
 * table breakpoint rather than a device: the requirement is that a 1024px
 * viewport shows the whole table with no horizontal scrolling anywhere, and
 * that anything narrower gets cards instead of a table turned sideways.
 */
export const PAYMENTS_TABLE_BREAKPOINT = 1024

/**
 * A person's name, short enough for a column.
 *
 * FIRST NAME AND AN INITIAL, never a truncation with an ellipsis: "Priyanka
 * S." is a name a colleague recognises, "Priyanka Sriniv…" is a bug report.
 * A single-word name is returned whole.
 */
export function conciseName(full: string | null | undefined): string {
  const name = (full ?? '').trim().replace(/\s+/g, ' ')
  if (name === '') return '—'
  const parts = name.split(' ')
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}
