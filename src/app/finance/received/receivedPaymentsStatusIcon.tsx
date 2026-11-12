import type { ConfirmedAllocationStatus } from '@/lib/finance/paymentSurfaces'

/**
 * The mark inside the compact allocation-status icon (Confirmed Payments table,
 * owner 2026-11-12): a different SHAPE per state — empty ring (zero),
 * half-filled (partial), tick (full), exclamation (over) — so the four read
 * apart without colour. Colour comes from `.fin-status-icon--<state>` in
 * globals.css, the same key as the status pill and the summary cards.
 *
 * Kept out of receivedPaymentsTable.tsx on purpose: a source test there pins
 * that the badge never branches on WHICH status it shows.
 */
export function StatusIcon({ status }: { status: ConfirmedAllocationStatus }) {
  return (
    <svg
      width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      {status === 'partial' && <path d="M8 1.8 A6.2 6.2 0 0 0 8 14.2 Z" fill="currentColor" stroke="none" />}
      {status === 'full' && <path d="M5.2 8.2 7.2 10.2 10.8 6" />}
      {status === 'over' && <path d="M8 4.8V8.6M8 11.1V11.2" />}
    </svg>
  )
}
