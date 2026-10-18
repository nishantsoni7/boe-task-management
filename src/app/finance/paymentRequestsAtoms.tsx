'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import React from 'react'
import { colors } from '@/lib/tokens'
import { destinationFromDb, paymentDestinationLabel } from './paymentDestinations'
import { DESTINATION_ICON } from './components/AccountIcons'
import { paymentDisplayStateMeta, type PaymentDestination } from '@/lib/finance/paymentDestination'
import { STATUS_META } from './paymentRequestsModel'

// ── Shared modal shell ────────────────────────────────────────────────────────
// FinanceModal, RequestModalShell, and useModalScrollLockAndEscape live in
// src/app/finance/components/FinanceModalShell.tsx — shared with Received
// Payments so both pages use one Finance modal layering system.

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


// Compact uppercase section label used throughout the details modal.
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '12px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

// Label-over-value metadata item; muted styling for empty/placeholder values.
export function MetaItem({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
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
export function PaymentDestinationLine({ payment_mode, received_in }: { payment_mode: string; received_in: string | null }) {
  const d    = destinationFromDb(payment_mode, received_in)
  const Icon = d ? DESTINATION_ICON[d.iconKey] : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
export function StatusBadge({ status, destination }: {
  status: string
  destination?: PaymentDestination | null
}) {
  const meta = destination !== undefined
    ? paymentDisplayStateMeta(status, destination)
    : STATUS_META[status] ?? { label: status, bg: '#F1EEE9', color: '#4C5352', border: '#E4DED7' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 10px', borderRadius: '999px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '12px', fontWeight: 600, lineHeight: '16px', whiteSpace: 'nowrap',
    }}>
      <span aria-hidden="true" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
      {meta.label}
    </span>
  )
}

// Display-only indicator for a needs_clarification request that has been waiting
// at least 30 days. Purely visual — it never changes the request's status.
export function StaleBadge() {
  return (
    <span style={{
      display: 'inline-block', marginLeft: '6px', padding: '2px 8px', borderRadius: '6px',
      background: '#FAF0DA', color: '#805B0D', border: '1px solid #E6D2A0',
      fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
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

export const STATUS_CORRECTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending_approval',    label: 'Pending Review' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]
