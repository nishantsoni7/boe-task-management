'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { visibleRowActions } from '@/lib/finance/rowActions'
import { colors } from '@/lib/tokens'
import { PAYMENT_MODE_LABEL, customerDisplayName } from '@/lib/finance/paymentEntry'
import { CustomerName } from '@/components/finance/CustomerName'
import { ALLOCATED_AGAINST_LABEL, allocationBadgeState, type AllocatedAgainstView } from '@/lib/finance/allocatedAgainst'
import { confirmedListMode, conciseName } from '@/lib/finance/paymentSurfaces'
import { PaymentIdChip } from '../components/PaymentIdChip'
import { PaymentRequest, fmtDate, fmtAmount } from './receivedPaymentsModel'
import { VerificationBadge } from './receivedPaymentsAtoms'
import { TH_STYLE, canOfferAllocateFunds, ConfirmedAllocationBadge, AllocatedAgainstCell, ReceivedPaymentsTable } from './receivedPaymentsTable'
import { rowActionMeta, PaymentRowActions, RowActionsMenu } from './receivedPaymentsRowActions'

export function PaymentsToVerifyTable({ rows, canManage, highlightId, onView, onEdit }: {
  rows: PaymentRequest[]
  canManage: boolean
  highlightId?: string | null
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
}) {
  const TD: React.CSSProperties = {
    padding: '7px 10px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap',
  }
  const TH: React.CSSProperties = { ...TH_STYLE, padding: '7px 10px' }

  return (
    <div style={{ width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={TH}>Payment ID</th>
            <th style={TH}>Client</th>
            <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
            <th style={TH}>Mode</th>
            <th style={TH}>Date</th>
            <th style={TH}>Status</th>
            <th style={TH}>Initiated by</th>
            <th style={{ ...TH, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.id}
              id={`payment-row-${r.id}`}
              onClick={() => onView(r)}
              style={{ cursor: 'pointer', background: r.id === highlightId ? colors.amberTint : undefined }}
              onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
              onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = r.id === highlightId ? colors.amberTint : 'transparent' }}
            >
              <td style={TD}>
                <PaymentIdChip>{r.human_payment_id}</PaymentIdChip>
              </td>
              <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                <CustomerName name={r.client_name} />
              </td>
              <td style={{ ...TD, textAlign: 'right', fontSize: '13px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                {fmtAmount(r.amount)}
              </td>
              <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                {PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode}
              </td>
              <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                {fmtDate(r.payment_date)}
              </td>
              <td style={TD}>
                <VerificationBadge status={r.status} />
              </td>
              <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}
                  title={r.submitted_by_name ?? undefined}>
                {conciseName(r.submitted_by_name)}
              </td>
              <td style={{ ...TD, textAlign: 'right' }}>
                <div
                  style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    onClick={() => onView(r)}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '3px 8px', fontSize: '12px', fontWeight: 500 }}
                  >
                    Review
                  </button>
                  <RowActionsMenu
                    label={`Actions for ${customerDisplayName(r.client_name)}`}
                    actions={canManage ? [{ label: 'Edit', onSelect: () => onEdit(r), Icon: Pencil }] : []}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Payments to Verify, as cards — the same fields PaymentsToVerifyTable shows,
 *  stacked for a narrow viewport. A separate component from
 *  ReceivedPaymentsCards: that one is Confirmed Payments' own allocation
 *  presentation (Requirement 2) and would show a meaningless allocation badge
 *  for money nobody has verified yet. */
export function PaymentsToVerifyCards({ rows, canManage, highlightId, onView, onEdit }: {
  rows: PaymentRequest[]
  canManage: boolean
  highlightId?: string | null
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(r => (
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
            <CustomerName
              name={r.client_name}
              style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
            />
            <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {fmtAmount(r.amount)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <VerificationBadge status={r.status} />
            <span style={{ fontSize: '12px', color: colors.muted, fontFamily: 'monospace, monospace' }}>
              {r.human_payment_id}
            </span>
            <span style={{ fontSize: '12px', color: colors.muted }}>
              {PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode} · {fmtDate(r.payment_date)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: colors.muted, marginRight: 'auto' }} title={r.submitted_by_name ?? undefined}>
              {conciseName(r.submitted_by_name)}
            </span>
            {canManage && (
              <button
                onClick={e => { e.stopPropagation(); onEdit(r) }}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '3px 10px', fontSize: '12px', fontWeight: 500 }}
              >
                Edit
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── The mobile list ───────────────────────────────────────────────────────────
//
// The table has eleven columns and is honestly wide. On a phone it would either
// overflow the page horizontally — which the app's shell clips — or shrink into
// unreadable columns, so below the breakpoint the same rows are drawn as CARDS.
//
// SAME DATA, SAME DECISIONS. Nothing is hidden on mobile that a desktop reader
// is shown: Payment ID, customer, the allocation badge, the exact figures and
// the breakdown are all here — the breakdown sits inline rather than behind an
// expand toggle, since a card already stacks vertically with room to spare.

// EXPORTED FOR ITS RENDER TEST only — this page mounts it.
export function ReceivedPaymentsCards({
  rows, canAllocate, canManage, highlightId, onView, onEdit, onAllocateFunds,
  canDeleteRow, onDelete, allocatedAgainst, targetHref, onOpenTarget,
}: {
  rows: PaymentRequest[]
  allocatedAgainst: (r: PaymentRequest) => AllocatedAgainstView
  targetHref: (targetType: 'order' | 'pi_draft', targetId: string) => string | null
  onOpenTarget: (href: string) => void
  canAllocate: boolean
  /** finance.manage — Edit, which the cards used to leave out entirely. */
  canManage: boolean
  highlightId?: string | null
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
  onAllocateFunds: (r: PaymentRequest) => void
  canDeleteRow: (r: PaymentRequest) => boolean
  onDelete: (r: PaymentRequest) => void
}) {
  const meta = rowActionMeta({ onView, onAllocateFunds, onEdit, onDelete })
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(r => {
        // NO PER-ROW FIGURE COMPUTATION, same as the desktop table. Total
        // Allocated / Remaining / per-destination live in the detail modal the
        // card's own allocation badge opens, computed there from the
        // allocation ledger rather than pre-summed per row here.
        const offerAllocate = canAllocate && canOfferAllocateFunds(r)
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
            {/* PAYMENT ID LEADS, AND THE CUSTOMER IS NOT A CARD FIELD.
                The card follows the table's information priority exactly:
                identifier, amount, when, how, where the money went, and how
                much is spoken for. The customer name is in the detail modal, whole —
                on a phone it was the field most likely to be truncated, which
                is the worst place to abbreviate a name somebody is trying to
                match against a bank statement. */}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary, fontFamily: 'monospace, monospace', fontVariantNumeric: 'tabular-nums', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.human_payment_id}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {fmtAmount(r.amount)}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: colors.muted }}>
                {fmtDate(r.payment_date)} · {PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode}
              </span>
            </div>

            {/* ALLOCATED AGAINST, stacked — the same cell as the desktop
                column, at the card's full width, in the table's order (before
                the status). Initiated by / Approved by are no longer on the
                card; both are in the payment's details. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                {ALLOCATED_AGAINST_LABEL}
              </span>
              <AllocatedAgainstCell
                view={allocatedAgainst(r)}
                hrefFor={targetHref}
                onOpen={onOpenTarget}
                fill
              />
            </div>

            {/* The same control as the desktop cell, opening the same record —
                which is where the exact figures the card no longer prints live. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <ConfirmedAllocationBadge
                status={allocationBadgeState(allocatedAgainst(r))}
                paymentId={r.human_payment_id}
                onOpen={() => onView(r)}
              />
            </div>

            {/* THE SAME ACTIONS AS THE TABLE ROW, from the same rules and the
                same component: View and Allocate as words, Edit and Delete
                behind "More actions". The card used to offer Allocate and a
                full-width red Delete, and no Edit at all. */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PaymentRowActions
                row={r}
                actions={visibleRowActions({ offerAllocate, canManage, canDelete: canDeleteRow(r) })}
                meta={meta}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Table or cards, by the room actually available ────────────────────────────
//
// The Confirmed Payments list decides by the width of ITS OWN CONTAINER, not
// the viewport: the Finance sidebar is a fixed 260px down to 768px, so a 1024px
// window leaves a ~720px card, which the seven-column table does not fit (see
// CONFIRMED_TABLE_MIN_CONTAINER_PX). A ResizeObserver reports the container's
// width on mount and on every change — window resize, sidebar, zoom — and the
// cards are drawn whenever the table would not fit, so nothing is clipped and
// nothing scrolls sideways. Until the first measurement it draws the cards,
// which fit any width.
//
// EXPORTED FOR THE RESPONSIVE CHECK only — this page mounts it.
export type ConfirmedListProps =
  Parameters<typeof ReceivedPaymentsTable>[0] & Parameters<typeof ReceivedPaymentsCards>[0]

export function ConfirmedPaymentsList(props: ConfirmedListProps) {
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // Fires once on observe, then on every size change: no synchronous
    // setState in the effect body.
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setContainerWidth(Math.floor(width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // THE SAFETY NET. If the rendered table ever overflows its container anyway
  // (a value wider than any measured), remember that width and draw cards at
  // it and below. Checked a frame after paint, so no synchronous setState.
  const [overflowedAt, setOverflowedAt] = useState<number | null>(null)
  const tableFits = confirmedListMode(containerWidth, overflowedAt) === 'table'

  useEffect(() => {
    if (!tableFits) return
    const el = containerRef.current
    if (!el) return
    const frame = requestAnimationFrame(() => {
      if (el.scrollWidth > el.clientWidth + 1) {
        setOverflowedAt(prev => Math.max(prev ?? 0, el.clientWidth))
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [tableFits, containerWidth, props.rows])

  return (
    <div
      ref={containerRef}
      data-confirmed-list={tableFits ? 'table' : 'cards'}
      style={{ width: '100%', minWidth: 0 }}
    >
      {tableFits ? <ReceivedPaymentsTable {...props} /> : <ReceivedPaymentsCards {...props} />}
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
