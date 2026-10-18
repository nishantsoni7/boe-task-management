'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { colors } from '@/lib/tokens'
import { ALLOCATION_STATE_LABEL, ALLOCATION_TARGET_WORD, type PaymentAllocationSummary } from '@/lib/finance/paymentAllocations'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { orderDetailHref, piSubmissionHref } from '@/lib/finance/crossModuleLinks'
import { fmtDate } from './receivedPaymentsModel'

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

// EXPORTED FOR ITS RENDER TEST, and for nothing else — one page mounts it. The
// figures it prints are the answer to "is any of this money still free", which
// is the question a detail modal exists to answer, so they are asserted against
// real markup rather than against the source that produces it.
export function AllocationPanel({ summary, amount, canOpenLinkedRecord, onOpen }: {
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

  // ZERO ALLOCATED — an empty state, not an empty panel. It still states the
  // figure that matters (how much is free), because "nothing allocated" and
  // "how much is there to allocate" are two different facts and the second is
  // the one somebody acts on.
  if (summary.targets.length === 0) {
    return (
      <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55 }}>
        <strong style={{ color: '#805B0D' }}>
          No funds from this payment have been allocated yet.
        </strong>{' '}
        The whole of {formatMoney(String(amount))} is still free to be assigned to a PI or an Order.
      </div>
    )
  }

  // THE SHARE OF THE PAYMENT ONE ALLOCATION TOOK, and only when there is one
  // allocation. On a split it would be three percentages the reader has to add
  // up, next to three amounts that already say the same thing.
  const onlyShare = summary.targets.length === 1 && amount > 0
    ? Math.round((Number(summary.targets[0].amount) / amount) * 100)
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {summary.targets.map(target => {
          const href = target.kind === 'order'
            ? orderDetailHref(target.targetId)
            : piSubmissionHref(target.targetId)
          // "A PI submission" is gone: the row above it now reads "PI Draft
          // 019", and one list must not call one kind of record by two names.
          const name = target.label ?? (target.kind === 'order' ? 'A Confirmed Order' : 'A PI Draft')
          const kindWord = ALLOCATION_TARGET_WORD[target.kind]
          return (
            <div key={target.allocationId}>
              <div style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px',
              }}>
                <div style={{ minWidth: 0, fontSize: '13.5px' }}>
                  {/* "Order 0425", but "PI Draft · Reserved Order 0431": the
                      same separator the Allocated Against column uses. */}
                  <span style={{ color: colors.secondary }}>{kindWord}{target.kind === 'submission' && target.label ? ' · ' : ' '}</span>
                  {/* Linked only when this reader holds Orders module entry AND
                      the target could be named. A link labelled "A Confirmed
                      Order" would be a door with no sign on it. */}
                  {canOpenLinkedRecord && target.label ? (
                    <button
                      onClick={() => onOpen(href)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        font: 'inherit', fontWeight: 600, color: colors.brandInk,
                        textDecoration: 'underline', textUnderlineOffset: '2px', wordBreak: 'break-word',
                      }}
                    >
                      {name}
                    </button>
                  ) : (
                    <span style={{ fontWeight: 600, color: colors.primary, wordBreak: 'break-word' }}>{name}</span>
                  )}
                </div>
                <span style={{ fontSize: '13.5px', fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {formatMoney(target.amount)}
                </span>
              </div>
              {/* The sub-line, and only when there is something to put on it.
                  WHAT SHARE OF THE PAYMENT this took, on a payment with one
                  allocation — on a split it would be three percentages next to
                  three amounts that already say the same thing. And WHEN the
                  money was assigned here, which is absent on a reader whose
                  select did not ask for it; absent is simply nothing, since it
                  is a display fact and no total depends on it. */}
              {(onlyShare !== null || target.allocatedAt) && (
                <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                  {onlyShare !== null && <>{onlyShare}% allocated</>}
                  {onlyShare !== null && target.allocatedAt && ' · '}
                  {target.allocatedAt && <>Allocated {fmtDate(target.allocatedAt)}</>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* The two totals, so the lines above visibly reconcile to the payment. */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '6px',
        borderTop: `1px solid ${colors.border}`, paddingTop: '10px', fontSize: '13px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: colors.secondary }}>Allocated</span>
          <strong style={{ color: colors.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {formatMoney(summary.allocated)}
          </strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: colors.secondary }}>
            {summary.state === 'over' ? 'Over the payment by' : 'Remaining'}
          </span>
          <strong style={{
            color: summary.state === 'over' ? colors.red
              : summary.unallocated && summary.unallocated !== '0' ? '#805B0D'
              : colors.muted,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {formatMoney(summary.unallocated)}
          </strong>
        </div>
      </div>
    </div>
  )
}
