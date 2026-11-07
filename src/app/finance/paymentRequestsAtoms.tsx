'use client'

// Split out of page.tsx (it had grown past 3,000 lines). Nothing here changed.

import React from 'react'
import { colors } from '@/lib/tokens'
import { paymentDisplayStateMeta, type PaymentDestination } from '@/lib/finance/paymentDestination'
import { STATUS_META } from './paymentRequestsModel'

// ── Shared modal shell ────────────────────────────────────────────────────────
// FinanceModal, RequestModalShell, and useModalScrollLockAndEscape live in
// src/app/finance/components/FinanceModalShell.tsx — shared with Received
// Payments so both pages use one Finance modal layering system.

export function Field({ label, required, quiet, children }: { label: string; required?: boolean; quiet?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: quiet ? '6px' : '4px' }}>
      <label style={quiet
        ? { fontSize: '12px', fontWeight: 500, color: colors.muted }
        : { fontSize: '12px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
  { value: 'pending_approval',    label: 'Waiting for Finance' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]
