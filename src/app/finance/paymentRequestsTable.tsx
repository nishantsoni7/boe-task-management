'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import React from 'react'
import Link from 'next/link'
import { colors } from '@/lib/tokens'
import { canDeletePayment } from '@/lib/finance/paymentDeletion'
import { canDeleteOwnPaymentRequest } from '@/lib/finance/ownPaymentRequestDeletion'
import { customerDisplayName, paymentModeLabel } from '@/lib/finance/paymentEntry'
import { paymentAgainstDisplay, type PaymentDestination } from '@/lib/finance/paymentDestination'
import { fmtDate, fmtAmount, canManageRequest, isStaleClarification, type PaymentRequest } from './paymentRequestsModel'
import { StatusBadge, StaleBadge } from './paymentRequestsAtoms'
import { PaymentIdChip } from './components/PaymentIdChip'
import { FinancePerson } from './components/FinanceListParts'

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

export const TH_STYLE: React.CSSProperties = {
  // Notion-style header (redesign 2026-10): 36px, quiet grey, no fill. The
  // global table rule still forces sentence case on screen.
  height: '36px',
  padding: '0 10px',
  textAlign: 'left',
  fontSize: '12px',
  fontWeight: 500,
  color: '#686D6C',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid #ECE7E0',
  background: '#FFFFFF',
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
  againstHref = () => null,
  salesView = false,
  totals = null,
}: {
  /**
   * THE SALESPERSON'S LIST (not an admin, not a payment approver, not a company-
   * wide Finance viewer): Payment ID, Client, Against, Total Before GST, Payment
   * Request Amount, Payment Date, Payment Mode, Actions. Status stays in the tabs
   * and in the request details, and Requested By is always the viewer themself.
   * Every other reader keeps the review columns.
   */
  salesView?: boolean
  /**
   * Total Before GST of the PI or Order each payment is for, by payment id, read
   * for the whole page in one batch (loadPaymentTotals). `null` = not read yet;
   * an entry of `null` (or no entry once read) = unavailable.
   */
  totals?: Map<string, number | null> | null
  /**
   * The page of the single Order or PI Draft a payment is for — ONLY when this
   * reader may open it (Orders module entry AND the destination named a record
   * their own RLS returned). Otherwise null, and the cell stays plain text: a
   * visible reference is not permission to open the record.
   */
  againstHref?: (destination: PaymentDestination | null | undefined) => string | null
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
  // Height, hairlines and hover are `.fin-table` (globals.css).
  const TD: React.CSSProperties = { padding: '6px 10px', whiteSpace: 'nowrap', verticalAlign: 'middle' }
  // Money in the salesperson's list: right aligned, tabular digits, two decimals
  // (fmtAmount is formatMoney: ₹ + en-IN grouping + exactly two decimals).
  const TD_MONEY: React.CSSProperties = { ...TD, textAlign: 'right', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }

  return (
    // overflowX:auto is retained only as a narrow-mobile fallback; at desktop
    // width the compact 9-column set fits without scrolling (no forced minWidth).
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table className="fin-table" style={{ tableLayout: 'auto' }}>
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
        {salesView ? (
          <colgroup>
            <col style={{ width: '9%'  }} />{/* Payment ID */}
            <col style={{ width: '17%' }} />{/* Client */}
            <col style={{ width: '20%' }} />{/* Against */}
            <col style={{ width: '12%' }} />{/* Total Before GST */}
            <col style={{ width: '12%' }} />{/* Payment Request Amount */}
            <col style={{ width: '9%'  }} />{/* Payment Date */}
            <col style={{ width: '9%'  }} />{/* Payment Mode */}
            <col style={{ width: '12%' }} />{/* Actions */}
          </colgroup>
        ) : (
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
        )}
        <thead>
          <tr>
            {salesView ? (<>
              <th style={TH_STYLE}>Payment ID</th>
              <th style={TH_STYLE}>Client</th>
              <th style={TH_STYLE}>Against</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Total Before GST</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Payment Request Amount</th>
              <th style={TH_STYLE}>Payment Date</th>
              <th style={TH_STYLE}>Payment Mode</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Actions</th>
            </>) : (<>
            <th style={TH_STYLE}>Payment ID</th>
            <th style={TH_STYLE}>Client</th>
            {/* Amount is LEFT-aligned, header and value together. Right
                alignment is for a column that is summed down its length;
                this one never is, and the ragged left edge it produced sat
                directly against the blank band above. tabular-nums keeps the
                digits in vertical register without it. */}
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
            <th style={TH_STYLE}>Payment Date</th>
            <th style={TH_STYLE}>Payment Mode</th>
            <th style={TH_STYLE}>Against</th>
            <th style={TH_STYLE}>Status</th>
            <th style={TH_STYLE}>Requested By</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Action</th>
            </>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isPending  = r.status === 'pending_approval'
            const isClarif   = r.status === 'needs_clarification'
            const isRejected = r.status === 'rejected'
            const accentColor =
              isPending  ? '#C48A1A' :
              isClarif   ? colors.brand :
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
            // THE SUBMITTER'S OWN, NEVER-APPROVED REQUEST (soft delete,
            // 20270226000000). Separate from showDelete, which is the admin's
            // hard delete; an admin keeps that one. The database makes the final
            // call on ownership, status and approval history.
            const showDeleteOwn = !showDelete && canDeleteOwnPaymentRequest(r, userId)
            const isHighlighted = r.id === highlightId

            // `undefined` while the page's destinations are still in flight;
            // `null` once they have arrived and this payment has none.
            const destination = destinations ? destinations.get(r.id) ?? null : undefined
            const against = paymentAgainstDisplay(destination)
            const hasDestination = !!destination && destination.kind !== 'suspense'
            const againstLink = againstHref(destination)

            const idCell = (
              <td style={TD}>
                <PaymentIdChip>{r.human_payment_id}</PaymentIdChip>
              </td>
            )
            // THE CLIENT CELL HOLDS THE CLIENT NAME, AND NOTHING ELSE (no status
            // chip beside it). Truncates instead of widening the table; the full
            // name is in the title.
            const clientCell = (
              <td style={TD}>
                <div
                  title={customerDisplayName(r.client_name)}
                  style={{
                    // Just under the column's own share (15% — about 200px on a
                    // 1366px laptop), so the cap and the column agree.
                    maxWidth: '200px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontSize: '13px', fontWeight: 600,
                    // A payment with no customer is named in the muted tone the
                    // page uses for "nothing recorded".
                    color: r.client_name ? colors.primary : colors.muted,
                  }}
                >
                  {customerDisplayName(r.client_name)}
                </div>
              </td>
            )
            const dateCell = (
              <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                {fmtDate(r.payment_date)}
              </td>
            )
            // PAYMENT MODE — the value the row already carries (payment_mode is in
            // the bounded list select), through the one formatter every payment
            // surface reads. NOT derived from the destination.
            const modeCell = (
              <td style={{ ...TD, fontSize: '12px', color: r.payment_mode ? colors.secondary : colors.muted }}>
                {paymentModeLabel(r.payment_mode)}
              </td>
            )
            // WHAT THIS PAYMENT IS FOR — the destination, from the allocation
            // ledger and the pending intent, linked to the PI Draft or Order when
            // the reader may open it.
            const againstCell = (
              <td style={TD}>
                <div
                  title={against}
                  style={{ maxWidth: salesView ? '270px' : '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: hasDestination ? colors.secondary : colors.muted, fontStyle: hasDestination ? 'normal' : 'italic' }}
                >
                  {againstLink ? (
                    // The row's own click must not also open the payment.
                    <Link
                      href={againstLink}
                      prefetch={false}
                      className="boe-record-link"
                      onClick={e => e.stopPropagation()}
                    >
                      {against}
                    </Link>
                  ) : against}
                </div>
              </td>
            )
            const actionButtons = (
              <div
                style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                onClick={e => e.stopPropagation()}
              >
                <button
                  onClick={() => onView(r)}
                  className="boe-btn boe-btn-ghost"
                  style={{ padding: '3px 9px', fontSize: '12px', fontWeight: 500 }}
                >
                  View
                </button>
                {showEdit && (
                  <button
                    onClick={() => onEdit(r)}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '3px 9px', fontSize: '12px', fontWeight: 500 }}
                  >
                    Edit
                  </button>
                )}
                {showReapply && (
                  <button
                    onClick={() => onEdit(r)}
                    className="boe-btn boe-btn-primary"
                    style={{ padding: '3px 9px', fontSize: '12px', fontWeight: 500 }}
                  >
                    Reapply
                  </button>
                )}
                {(showDelete || showDeleteOwn) && (
                  <button
                    onClick={() => onDelete(r)}
                    aria-label={`Delete payment request ${r.human_payment_id}`}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '3px 9px', fontSize: '12px', fontWeight: 600, color: colors.red, border: `1px solid ${colors.red}` }}
                  >
                    Delete
                  </button>
                )}
              </div>
            )
            const actionCell = <td style={{ ...TD, textAlign: 'right' }}>{actionButtons}</td>

            // TOTAL BEFORE GST. Until the page's one batched read settles it says
            // so; once settled, a PI/Order that cannot be resolved (mixed or
            // suspense destination, a record this reader cannot open, no stored
            // total) reads "Unavailable" — never a misleading ₹0.
            const total = totals === null ? undefined : (totals.get(r.id) ?? null)
            const totalCell = (
              <td
                style={{ ...TD_MONEY, color: total === null ? colors.muted : colors.secondary, fontStyle: total === null ? 'italic' : 'normal' }}
                title={total === null
                  ? 'The total before GST of the linked PI or Order could not be resolved'
                  : destination && destination.cancelled
                    ? 'Total before GST of the PI or Order this request was linked to before it was rejected (the link is cancelled)'
                    : undefined}
              >
                {total === undefined ? '…' : total === null ? 'Unavailable' : fmtAmount(total)}
              </td>
            )

            return (
              <tr
                key={r.id}
                id={`payment-row-${r.id}`}
                onClick={() => onRowClick(r)}
                // Status colour now lives in the pill (and its dot), not in a
                // coloured left edge; hover and highlight are .fin-table's.
                data-accent={accentColor}
                className={isHighlighted ? 'is-highlighted' : undefined}
              >
                {salesView ? (
                  <>
                    {idCell}
                    {clientCell}
                    {againstCell}
                    {totalCell}
                    {/* ONLY the amount requested in THIS row — never cumulative. */}
                    <td style={{ ...TD_MONEY, fontWeight: 700, color: colors.primary }}>{fmtAmount(r.amount)}</td>
                    {dateCell}
                    {modeCell}
                    {actionCell}
                  </>
                ) : (
                  <>
                    {idCell}
                    {clientCell}
                    <td style={TD} className="fin-num">
                      <span className="fin-amount">{fmtAmount(r.amount)}</span>
                    </td>
                    {dateCell}
                    {modeCell}
                    {againstCell}
                    <td style={TD}>
                      <StatusBadge status={r.status} destination={destination} />
                      {isStaleClarification(r, cutoff) && <StaleBadge />}
                    </td>
                    <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                      <FinancePerson name={r.submitted_by_name} />
                    </td>
                    {actionCell}
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
