'use client'
import { colors } from '@/lib/tokens'
import { paymentDisplayStateMeta, type PaymentDestination } from '@/lib/finance/paymentDestination'
import { PAYMENT_VERIFICATION_LABEL, paymentRowFigures } from '@/lib/finance/paymentClassification'
import type { ConfirmedListEmptyKind } from '@/app/finance/receivedPaymentsQuery'
import { ErrorBanner, STATUS_META } from './receivedPaymentsModel'
import { FinanceEmpty } from '../components/FinanceListParts'


// Display atoms of Received Payments (empty state, section headers, detail rows, status and
// verification badges), split out of ReceivedPaymentsView.tsx. Nothing here changed.

/**
 * The list's empty state, for each of confirmedListEmptyKind's answers.
 * EXPORTED FOR ITS RENDER TEST only — this page mounts it.
 */
export function ConfirmedListEmptyState({
  kind, noneText, errorMessage, statusLabel, searchOrDateNarrowed, onRetry, onShowAll,
}: {
  kind: ConfirmedListEmptyKind
  /** The business statement for a list nothing constrained: "No payments received yet." */
  noneText: string
  errorMessage: string | null
  /** The selected allocation-status tab's name, when it is not All. */
  statusLabel: string | null
  searchOrDateNarrowed: boolean
  onRetry: () => void
  onShowAll: () => void
}) {
  const box: React.CSSProperties = {
    padding: '56px 20px', textAlign: 'center', color: colors.muted, fontSize: '14px', lineHeight: 1.6,
  }
  if (kind === 'loading') {
    return <div role="status" style={box}>Loading…</div>
  }
  if (kind === 'error') {
    return (
      <div style={box}>
        <div style={{ maxWidth: '420px', margin: '0 auto', textAlign: 'left' }}>
          <ErrorBanner message={`Could not load payments: ${errorMessage ?? 'unknown error'}`} />
          <div style={{ marginTop: '10px', textAlign: 'center' }}>
            <button type="button" onClick={onRetry} className="boe-btn boe-btn-ghost" style={{ padding: '5px 12px', fontSize: '12px' }}>
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (kind === 'no-match') {
    // Names exactly what constrained the list, so the reader knows it is a
    // statement about their view, not about the business.
    const message = statusLabel && searchOrDateNarrowed
      ? `No ${statusLabel} payments match the current search or dates.`
      : statusLabel
        ? `No payments are ${statusLabel} right now.`
        : 'No payments match the current search or dates.'
    return (
      <FinanceEmpty
        icon="search"
        title={message}
        body="Clear the search, dates or status to see every payment."
        action={
          <button type="button" onClick={onShowAll} className="boe-btn boe-btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }}>
            Show all payments
          </button>
        }
      />
    )
  }
  return <FinanceEmpty title={noneText} body="Payments appear here once they are verified." />
}

// Compact uppercase section label used inside RequestModalShell cards —
// matches the Payment Requests page's DetailsModal styling exactly.
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

/**
 * One label-and-value line in the detail modal.
 *
 * A LABEL COLUMN, not a label above every value. Six stacked label/value pairs
 * used two lines each and left the eye no column to run down; aligned labels
 * read as a list, which is what they are. The label column is fixed and the
 * value takes the rest, so a long client name wraps under itself instead of
 * pushing the layout wider.
 *
 * THERE IS NO EMPTY VARIANT. A value that does not exist is not rendered as a
 * muted dash — the caller omits the row. "Not provided" is a sentence that
 * costs a line and tells nobody anything.
 */
export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: '12px', alignItems: 'baseline' }}>
      <span style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.45 }}>{label}</span>
      <span style={{ fontSize: '14px', color: colors.primary, lineHeight: 1.45, wordBreak: 'break-word', minWidth: 0 }}>
        {children}
      </span>
    </div>
  )
}

/**
 * The one rule that separates the detail modal's full-width sections.
 *
 * A hairline and some space, rather than a bordered card each. The modal was
 * five rounded boxes deep in places — a card inside a column inside the dialog
 * — and every border it drew was one more edge competing with the numbers.
 */
export const DIVIDED_SECTION: React.CSSProperties = {
  borderTop: `1px solid ${colors.border}`,
  paddingTop: '16px',
}

// THE BADGE IS NOT THE STATUS COLUMN. For the three request-stage statuses it is
// the same thing; for the two verified ones the label is decided by whether the
// ALLOCATION LEDGER actually attaches this payment to anything — so a fully
// allocated payment reads "Received Payment", and reversing that allocation
// takes the label with it rather than leaving a stale claim behind.
//
// THE ORDER-REQUEST BRANCH IS GONE with the workflow it described
// (20261007000000): a payment parked on a retired request has no active
// allocation, so it is Received — Unallocated, which is exactly what it is.
export function StatusBadge({ status, destination }: {
  status: string
  destination?: PaymentDestination | null
}) {
  const meta = destination !== undefined
    ? paymentDisplayStateMeta(status, destination)
    : STATUS_META[status] ?? { label: status, bg: '#F1EEE9', color: '#4C5352', border: '#E4DED7' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '6px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

/** The verification state, as a badge. The OTHER axis, never folded into money. */
export function VerificationBadge({ status, destination }: {
  status: string
  destination?: PaymentDestination | null
}) {
  const meta = destination !== undefined
    ? paymentDisplayStateMeta(status, destination)
    : STATUS_META[status] ?? { label: status, bg: '#F1EEE9', color: '#4C5352', border: '#E4DED7' }
  return (
    <span
      title={PAYMENT_VERIFICATION_LABEL[paymentRowFigures({
        id: '', amount: null, status, order_id: null,
      }).verification]}
      style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: '6px',
        background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
        fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  )
}

// MoneyCell IS GONE with the last figure it drew. It rendered one aggregate —
// a zero as a dash, a withheld figure as a muted dash — for the expandable row
// strip and then for the detail modal's "to PI Drafts / to Orders" pair. Both
// are retired: the modal lists each allocation with its own amount, and those
// amounts are never dashes, never withheld one-by-one, and always add up to the
// Allocated total printed beneath them. AllocationPanel says "Not visible to
// you" in a sentence when the ledger could not be read, which is the case the
// muted dash was standing in for.

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

