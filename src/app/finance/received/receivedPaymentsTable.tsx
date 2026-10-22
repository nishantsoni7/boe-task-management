'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { TABLE_CELL_PADDING_X_PX, visibleRowActions } from '@/lib/finance/rowActions'
import { colors } from '@/lib/tokens'
import { PAYMENT_MODE_LABEL } from '@/lib/finance/paymentEntry'
import { ALLOCATED_AGAINST_LABEL, ALLOCATION_DETAILS_UNAVAILABLE_TEXT, NOT_ALLOCATED_TEXT, UNALLOCATED_LINE_WORD, allocatedAgainstText, allocationBadgeState, allocationCountLabel, type AllocatedAgainstView } from '@/lib/finance/allocatedAgainst'
import { ALLOCATED_AGAINST_MIN_PX, CONFIRMED_PAYMENT_COLUMNS, CONFIRMED_ALLOCATION_BADGE, type ConfirmedAllocationStatus } from '@/lib/finance/paymentSurfaces'
import { customerDisplayName } from '@/lib/finance/paymentEntry'
import { PaymentIdChip } from '../components/PaymentIdChip'
import { FinancePerson } from '../components/FinanceListParts'
import { PaymentRequest, fmtDate, fmtAmount } from './receivedPaymentsModel'
import { rowActionMeta, PaymentRowActions, type RowActionMeta } from './receivedPaymentsRowActions'

// ── Table ─────────────────────────────────────────────────────────────────────

export const TH_STYLE: React.CSSProperties = {
  padding: '11px 12px',
  textAlign: 'left',
  fontSize: '12px',
  fontWeight: 600,
  color: '#4C5352',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

/**
 * Whether an "Allocate Funds" control belongs on this row at all.
 *
 * OFFERED FOR 'zero' AND 'partial' ONLY. A 'full' payment has nothing left to
 * give — allocateFundsRemaining would already read zero and every row would
 * be refused. An 'over' payment is deliberately EXCLUDED too, even though it
 * technically has no "remaining" figure to protect: it is already invalid
 * data (CONFIRMED_ALLOCATION_BADGE flags it for Admin review), and offering a
 * control that adds MORE allocations on top of an already-exceeded payment
 * would let that defect compound instead of surfacing it for a person to look
 * at. Delete Payment remains the offered action for an 'over' row.
 */
export function canOfferAllocateFunds(r: PaymentRequest): boolean {
  // The COMPLETE status (complete_allocation_status, 20261216000000 §4), not
  // the projection's RLS-limited one: for a reader without finance.view_all the
  // latter can read Partial for a payment that is fully allocated.
  return r.complete_allocation_status === 'zero' || r.complete_allocation_status === 'partial'
}

export const CONFIRMED_ALLOCATION_TONE_STYLE: Record<'neutral' | 'warning' | 'success' | 'danger', {
  bg: string; color: string; border: string
}> = {
  neutral: { bg: '#F1EEE9', color: '#4C5352', border: '#E4DED7' },
  warning: { bg: '#FAF0DA', color: '#805B0D', border: '#E6D2A0' },
  success: { bg: '#E8F2EC', color: '#276247', border: '#BCD8C8' },
  danger:  { bg: '#FBE9EC', color: '#B42332', border: '#E9B9C1' },
}

/**
 * The allocation-status badge (Requirement 2). EXACT figures live beside it in
 * the row/card — this only names the state, and an 'over' row gets a visibly
 * different (red/amber) tone and a tooltip explaining why, never the
 * reassuring green "Fully Allocated" look.
 */
export function ConfirmedAllocationBadge({ status, paymentId, onOpen }: {
  /**
   * From allocationBadgeState(): the status of the SAME complete read the
   * Allocated Against cell is drawn from, or 'loading' / 'unavailable' — never
   * a confident status while that read is in flight or after it failed.
   */
  status: ConfirmedAllocationStatus | 'loading' | 'unavailable' | null
  /** The human Payment ID, for the accessible name. Never the raw UUID. */
  paymentId?: string | null
  /** Opens the payment's detail record. Omit to render a plain, inert badge. */
  onOpen?: () => void
}) {
  if (status === 'loading') {
    return <span aria-label="Loading allocation status" style={{ fontSize: '12px', color: colors.muted }}>…</span>
  }
  if (!status || status === 'unavailable') {
    return (
      <span title="The complete allocation status could not be loaded. Open the payment for details."
            style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', whiteSpace: 'nowrap' }}>
        Status unavailable
      </span>
    )
  }
  const meta = CONFIRMED_ALLOCATION_BADGE[status]
  const style = CONFIRMED_ALLOCATION_TONE_STYLE[meta.tone]
  const overTitle = status === 'over'
    ? 'Allocated total exceeds payment amount — flagged for Admin review'
    : undefined

  // ── THE CHIP IS SMALL; THE TARGET IS NOT ──
  //
  // The coloured chip sits at the table's own muted-text size and a hair of
  // padding, so it reads as a status in a row of text rather than as a button
  // competing with the figures beside it. What makes it comfortably clickable
  // is the TRANSPARENT wrapper around it, which carries the extra few pixels of
  // target: the hit area grew while the colour shrank.
  //
  // `whiteSpace: nowrap` is load-bearing — "Partially Allocated" and
  // "Over-allocated" must never wrap inside a table cell.
  // REDESIGN 2026-10: a soft pill with a status dot (`.fin-pill`), the same
  // colour key as the view-bar tabs and the summary cards. No border.
  void style
  const chip: React.CSSProperties = { padding: '2px 10px', borderRadius: '999px' }
  const pillClass = `fin-pill fin-pill--${status}`

  if (!onOpen) return <span title={overTitle} className={pillClass} style={chip}>{meta.label}</span>

  return (
    <button
      type="button"
      // Enter and Space come free with a real <button>; hover and
      // focus-visible are in globals.css, because neither can be inline.
      className="boe-allocation-badge"
      // Names the RECORD, not the state: a screen reader hears which payment it
      // is about to open, which is the thing that distinguishes forty rows all
      // reading "Fully Allocated".
      aria-label={`View allocation details for ${paymentId ?? 'this payment'}`}
      title={overTitle ?? 'View allocation details'}
      onClick={event => {
        // The row itself opens the record too. It must not also fire from this
        // one deliberate click.
        event.stopPropagation()
        onOpen()
      }}
    >
      <span className={pillClass} style={chip}>{meta.label}</span>
    </button>
  )
}

// ── Allocated Against ─────────────────────────────────────────────────────────
//
// WHERE THE MONEY WENT, in the row itself: every active destination, each with
// its own amount, and what is left. Built by buildAllocatedAgainst() from the
// COMPLETE targets read (received_payment_allocation_targets, 20261216000000),
// never from allocated_order_number, the legacy order_id or the caller's own
// partial RLS read of the allocation table.
//
// A DESTINATION IS A LINK ONLY WHEN THIS READER MAY ALREADY OPEN IT. `hrefFor`
// answers null otherwise and the name is plain text — seeing that money went to
// an Order is not permission to open the Order. A link stops its click from
// reaching the row, so it opens the target and not the payment; anywhere else
// in the cell the row's own click opens the payment's details, as before. No
// control in this cell edits or reverses an allocation.
//
// EXPORTED FOR ITS RENDER TEST only.
export function AllocatedAgainstCell({ view, hrefFor, onOpen, fill }: {
  view: AllocatedAgainstView
  /** The target's page, when this reader may open it; null otherwise. */
  hrefFor: (targetType: 'order' | 'pi_draft', targetId: string) => string | null
  onOpen: (href: string) => void
  /** Mobile: take the card's width instead of the table column's cap. */
  fill?: boolean
}) {
  const text = allocatedAgainstText(view, fmtAmount)
  const small: React.CSSProperties = { fontSize: '12px', lineHeight: '17px' }

  if (view.kind === 'loading') {
    return <span aria-label={text} title={text} style={{ ...small, color: colors.muted }}>…</span>
  }
  if (view.kind === 'unavailable') {
    return (
      <span title="The complete allocation list could not be loaded. Open the payment for details."
            style={{ ...small, color: colors.muted, fontStyle: 'italic' }}>
        {ALLOCATION_DETAILS_UNAVAILABLE_TEXT}
      </span>
    )
  }
  if (view.kind === 'none') {
    return (
      // PLAIN MUTED TEXT, NOT A SECOND CHIP. The row's Allocation Status badge
      // already says "Zero Allocated" in colour; an amber chip here said the
      // same thing again and made every unallocated row shout twice.
      // An empty meter beside it reads as "nothing given a home yet" at a glance.
      <span className="fin-meter" style={{ ...small, color: colors.muted, alignSelf: 'flex-start' }}>
        <span className="fin-meter-bar" aria-hidden="true"><span style={{ width: '0%' }} /></span>
        <span style={{ whiteSpace: 'nowrap' }}>{NOT_ALLOCATED_TEXT}</span>
      </span>
    )
  }

  // One line per destination. The NAME truncates visually and keeps its full
  // text in `title` and in the list's accessible name; the AMOUNT never
  // truncates, because a clipped figure is a wrong figure.
  const lineStyle: React.CSSProperties = {
    ...small, display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0,
  }
  const nameStyle: React.CSSProperties = {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }
  const amountStyle: React.CSSProperties = {
    flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: colors.secondary,
  }

  return (
    <div
      role="list"
      aria-label={`${ALLOCATED_AGAINST_LABEL}: ${text}`}
      style={fill
        ? { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, maxWidth: '100%' }
        // In the table: fill the column, and never let a long name widen it —
        // `contain: inline-size` removes the content from the table's width
        // calculation, the 200px floor keeps every amount readable. Measured:
        // see CONFIRMED_TABLE_MIN_CONTAINER_PX.
        : { display: 'flex', flexDirection: 'column', gap: '1px', width: '100%', minWidth: `${ALLOCATED_AGAINST_MIN_PX}px`, contain: 'inline-size' }}
    >
      {view.lines.length > 1 && (
        <div style={{ fontSize: '12px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
          {allocationCountLabel(view.lines.length)}
        </div>
      )}
      {view.lines.map(line => {
        // An old order is not a record in this system: there is nothing to open.
        const href = line.targetType === 'legacy_order' || !line.targetId
          ? null
          : hrefFor(line.targetType, line.targetId)
        return (
          <div key={line.key} role="listitem" style={lineStyle}>
            {href ? (
              <a
                href={href}
                title={line.label}
                onClick={event => {
                  // Opens the TARGET. The row's own click must not also fire
                  // and open the payment underneath it.
                  event.stopPropagation()
                  // A modified click (new tab, new window) is the browser's to
                  // handle: it is a real link, and a reader cross-checking a
                  // payment against its Order wants both on screen.
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                  event.preventDefault()
                  onOpen(href)
                }}
                className="boe-record-link"
                style={{ ...nameStyle, fontWeight: 600 }}
              >
                {line.label}
              </a>
            ) : (
              <span title={line.label} style={{ ...nameStyle, color: colors.primary, fontWeight: 600 }}>
                {line.label}
              </span>
            )}
            <span aria-hidden="true" style={{ color: colors.muted, flexShrink: 0 }}>·</span>
            <span style={amountStyle}>{fmtAmount(line.amount)}</span>
          </div>
        )
      })}
      {view.unallocated && (
        <div role="listitem" style={{ ...lineStyle, color: '#805B0D', fontWeight: 600 }}>
          <span style={nameStyle}>{UNALLOCATED_LINE_WORD}</span>
          <span aria-hidden="true" style={{ flexShrink: 0 }}>·</span>
          <span style={{ ...amountStyle, color: '#805B0D' }}>{fmtAmount(view.unallocated)}</span>
        </div>
      )}
    </div>
  )
}

// THE ROW FIGURES ARE GONE, and so is confirmedFigures() with them.
//
// It computed four numbers — Total Allocated, Remaining, To Orders, To PI
// Drafts — for a table strip that no longer exists and then for a detail modal
// that printed the last two beside a list of the very allocations they were
// the totals of. The modal lists each allocation with its own amount and
// reconciles them to Allocated / Remaining, from the ALLOCATION LEDGER read
// rather than from the projection’s pre-summed columns.
//
// THE INVARIANT IT CARRIED IS NOT LOST. "Remaining is withheld, never guessed,
// when this reader’s view is incomplete" now lives where the figure itself is
// produced: summarizePaymentAllocations returns state 'unknown' with null
// totals for an unreadable allocation read, and AllocationPanel prints a
// sentence about the reader instead of a number. See paymentAllocations.ts.

// The Confirmed Payments table — EXACT figures, never a vague "Linked
// Against" concept (Requirement 2). The primary row is CONFIRMED_PAYMENT_
// COLUMNS, sized to fit 1024px with no horizontal scroll; the PI-Draft /
// Order breakdown (CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS) lives behind a
// per-row expand toggle instead of being crammed into the primary row.
// EXPORTED FOR ITS RENDER TEST only — this page mounts it.
export function ReceivedPaymentsTable({
  rows,
  canManage,
  canAllocate,
  highlightId,
  onView,
  onEdit,
  onAllocateFunds,
  canDeleteRow,
  onDelete,
  allocatedAgainst,
  onShowAllocation,
}: {
  rows: PaymentRequest[]
  /** The Allocated Against cell for one row — see AllocatedAgainstCell. */
  allocatedAgainst: (r: PaymentRequest) => AllocatedAgainstView
  targetHref: (targetType: 'order' | 'pi_draft', targetId: string) => string | null
  onOpenTarget: (href: string) => void
  /**
   * May edit a recorded payment — a correction of an approved financial
   * record, the finance.manage authority.
   */
  canManage: boolean
  /**
   * May allocate part of a payment to an Order or a PI Draft — finance.allocate,
   * the same action allocate_payment_to_targets() requires. A DRAWING rule: the
   * RPC re-derives it, so hiding the control protects nobody and showing it
   * grants nothing.
   */
  canAllocate: boolean
  highlightId?: string | null
  onView:   (r: PaymentRequest) => void
  onEdit:   (r: PaymentRequest) => void
  onAllocateFunds: (r: PaymentRequest) => void
  /**
   * Whether THIS reader may delete THIS payment — canDeletePayment's answer,
   * admin-only for any status. A drawing rule: row-level security and
   * finance_payment_requests_guard_approved_delete both re-derive it.
   */
  canDeleteRow: (r: PaymentRequest) => boolean
  onDelete: (r: PaymentRequest) => void
  /** Opens the allocation popup (the Allocation status pill). */
  onShowAllocation: (r: PaymentRequest) => void
}) {
  // COMPACT, AND NO minWidth. Eleven columns at these paddings fit 1024px with
  // room over; the breakdown that would not fit lives in the expandable row
  // instead of being squeezed in or forcing a sideways scroll.
  // ONE PLACE PER ACTION: its icon, how it names itself, what it runs, and
  // whether it is destructive. visibleRowActions() decides WHICH of these are
  // drawn; this decides what each one IS. Every label names the PAYMENT and not
  // just the verb, because the glyph is the whole control and forty identical
  // pencils are otherwise indistinguishable to a screen reader.
  const ROW_ACTION_META: RowActionMeta = {
    ...rowActionMeta({ onView, onAllocateFunds, onEdit, onDelete }),
  }

  // 8px a side — TABLE_CELL_PADDING_X_PX, which the column widths and the
  // Actions arithmetic both assume. Everything else about a cell (height,
  // hairlines, hover) is `.fin-table` in globals.css.
  const TD: React.CSSProperties = {
    padding: `12px ${TABLE_CELL_PADDING_X_PX}px`,
  }
  const TH: React.CSSProperties = { padding: `0 ${TABLE_CELL_PADDING_X_PX}px` }
  const align = (a: 'left' | 'right'): React.CSSProperties =>
    a === 'right' ? { textAlign: 'right' } : {}

  return (
    <div style={{ width: '100%' }}>
      {/* FIXED LAYOUT: every column but Client has a pixel width sized to its
          data, and Client takes the rest, so the columns sit where the header
          says they are whatever the rows contain. */}
      <table className="fin-table">
        <thead>
          <tr>
            {CONFIRMED_PAYMENT_COLUMNS.map(column => (
              <th key={column.key} style={{ ...TH, ...align(column.align), ...('width' in column ? { width: column.width } : {}) }}>
                {column.key === 'actions' ? <span className="boe-sr-only">{column.label}</span> : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            // NO PER-ROW FIGURE COMPUTATION. The allocation popup and the detail
            // modal compute the figures from the allocation read when they open.
            const isHighlighted = r.id === highlightId
            const offerAllocate = canAllocate && canOfferAllocateFunds(r)
            const mode = PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode
            const client = customerDisplayName(r.client_name)
            return (
              <tr
                  key={r.id}
                  id={`payment-row-${r.id}`}
                  onClick={() => onView(r)}
                  className={isHighlighted ? 'is-highlighted' : undefined}
                >
                  {/* PAYMENT ID — human_payment_id, never the raw UUID. */}
                  <td style={TD}>
                    <PaymentIdChip>{r.human_payment_id}</PaymentIdChip>
                  </td>

                  {/* RIGHT-ALIGNED, tabular figures: digits line up by place
                      value down the column. */}
                  <td style={TD} className="fin-num">
                    <span className="fin-amount">{fmtAmount(r.amount)}</span>
                  </td>

                  {/* WHO PAID. "Not identified" (muted) for a Suspense payment. */}
                  <td style={TD} title={client}>
                    <span className="fin-primary-text" style={r.client_name ? undefined : { color: colors.muted, fontWeight: 400 }}>
                      {client}
                    </span>
                  </td>

                  {/* THE PAYMENT DATE, not created_at — when the money moved. */}
                  <td style={TD} className="fin-muted">{fmtDate(r.payment_date)}</td>

                  <td style={TD} className="fin-muted" title={mode}>{mode}</td>

                  {/* WHO RECORDED IT. */}
                  <td style={TD}>
                    <FinancePerson name={r.submitted_by_name} />
                  </td>

                  {/* THE PILL IS THE DOOR TO WHERE THE MONEY WENT. It opens the
                      allocation popup: every Order / PI Draft it is allocated
                      to, with amounts, and what is left. */}
                  <td style={{ ...TD, overflow: 'visible' }} onClick={e => e.stopPropagation()}>
                    <ConfirmedAllocationBadge
                      status={allocationBadgeState(allocatedAgainst(r))}
                      paymentId={r.human_payment_id}
                      onOpen={() => onShowAllocation(r)}
                    />
                  </td>

                  {/* EVERY PERMITTED ACTION, AS AN ICON in a fixed slot: View,
                      Edit, Allocate, Delete. WHICH appear is decided by
                      visibleRowActions() in lib/finance/rowActions.ts; an
                      action a reader may not take is absent, not greyed. */}
                  <td style={{ ...TD, overflow: 'visible' }}>
                    <PaymentRowActions
                      row={r}
                      actions={visibleRowActions({
                        offerAllocate,
                        canManage,
                        canDelete: canDeleteRow(r),
                      })}
                      meta={ROW_ACTION_META}
                      slots
                    />
                  </td>
                </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The overflow menu, and why it is a real one.
 *
 * A <button> with aria-haspopup/aria-expanded gives the accessible name and the
 * state; Enter, Escape, outside-click and focus-out are wired below. Nothing is
 * hidden that a reader could not otherwise do — the same actions, behind one
 * control instead of beside each other.
 *
 * ── WHY THE PANEL IS PORTALLED ────────────────────────────────────────────────
 *
 * THE DEFECT THIS FIXES. The panel used to be `position: absolute` inside the
 * trigger. Both Finance tables sit inside `.boe-card`, which carries
 * `overflow: hidden` so rows cannot bleed past its rounded corners — and an
 * absolutely-positioned box is clipped by ANY ancestor whose overflow is not
 * `visible`. On the last row the panel was cut off at the card's bottom edge:
 * "Allocate Funds" showed, everything under it was rendered and unreachable.
 * It also pinned `top: 100%`, so it never opened upward however little room
 * was left.
 *
 * Widening the card's overflow was not an option — it is what keeps the corners
 * clean and, on other Finance surfaces, what contains a horizontal scroll. So
 * the panel leaves the container instead: it renders into `document.body`
 * through a portal, `position: fixed`, at coordinates decided by placeMenu(),
 * which prefers below, flips above when below does not fit, and clamps into the
 * viewport either way.
 *
 * This is the whole fix, and it is in ONE component, so both the Confirmed
 * Payments table and the Payments to Verify table get it — no call site
 * changes, and no third table can reintroduce the bug by copying a clipped
 * pattern.
 *
 * WHAT DID NOT CHANGE: the `actions` array is passed through untouched, in
 * order, including which entries are `danger`. This component decides where the
 * menu is drawn and never which actions exist — that is each call site's, and
 * remains permission-derived.
 */
/**
 * ONE PLACE PER ACTION: its icon, the words it shows, how it names itself to a
 * screen reader, what it runs, and whether it is destructive. visibleRowActions()
 * decides WHICH of these a row offers and rowActionLayout() decides WHERE each is
 * drawn; this decides what each one IS. Shared by the table and the cards, so a
 * phone offers exactly what a desktop offers.
 *
 * Every accessible name carries the PAYMENT as well as the verb — "Edit
 * P-AA-0002", not "Edit" — so forty rows of identical controls stay
 * distinguishable to a screen reader.
 */
// @split: src/app/finance/received/receivedPaymentsRowActions.tsx private=RowActionMeta,rowActionMeta,PaymentRowActions,RowActionsMenu
