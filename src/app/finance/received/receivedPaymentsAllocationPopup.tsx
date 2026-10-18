'use client'

import { CONFIRMED_ALLOCATION_BADGE } from '@/lib/finance/paymentSurfaces'
import { ALLOCATION_DETAILS_UNAVAILABLE_TEXT, allocationBadgeState, type AllocatedAgainstView } from '@/lib/finance/allocatedAgainst'
import { customerDisplayName, PAYMENT_MODE_LABEL } from '@/lib/finance/paymentEntry'
import { exactToString, sumExact } from '@/lib/finance/exactMoney'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '../components/FinanceModalShell'
import { ALLOCATE_FUNDS_ACTION_LABEL } from './AllocateFundsModal'
import { PaymentRequest, fmtAmount, fmtDate } from './receivedPaymentsModel'

/**
 * WHERE THE MONEY WENT — the popup the Allocation status pill opens.
 *
 * The payment at the top (ID, amount, client, date, account), then every Order
 * and PI Draft it is allocated to with its own amount (a link when this reader
 * may open the record), then the allocated total and what is left. Built from
 * the SAME complete allocation read as the row's pill, so the two never
 * disagree; nothing here edits or reverses an allocation.
 */
export function AllocationDetailsPopup({ payment, view, hrefFor, onOpenTarget, onAllocate, onClose }: {
  payment: PaymentRequest
  view: AllocatedAgainstView
  hrefFor: (targetType: 'order' | 'pi_draft', targetId: string) => string | null
  onOpenTarget: (href: string) => void
  /** Present only when this reader may allocate AND money is left. */
  onAllocate?: () => void
  onClose: () => void
}) {
  const status = allocationBadgeState(view)
  const lines = view.kind === 'targets' ? view.lines : []
  const allocated = exactToString(sumExact(lines.map(l => l.amount)))
  const left = view.kind === 'targets' ? (view.unallocated ?? '0') : view.kind === 'none' ? String(payment.amount) : null
  const statusLabel = status && status !== 'loading' && status !== 'unavailable' ? CONFIRMED_ALLOCATION_BADGE[status].label : null

  const label: React.CSSProperties = { fontSize: '12px', color: colors.muted }
  const value: React.CSSProperties = { fontSize: '14px', color: colors.primary, fontWeight: 500 }

  return (
    <FinanceModal title={`Allocation · ${payment.human_payment_id ?? 'Payment'}`} onClose={onClose} width="520px">
      {/* The payment itself. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px 16px', padding: '14px 16px', background: '#FAF8F5', border: '1px solid #ECE7E0', borderRadius: '10px' }}>
        <div><div style={label}>Amount</div><div style={{ ...value, fontSize: '18px', fontWeight: 600 }}>{fmtAmount(payment.amount)}</div></div>
        <div><div style={label}>Status</div><div style={{ marginTop: '2px' }}>{statusLabel ? <span className={`fin-pill fin-pill--${status}`}>{statusLabel}</span> : <span style={label}>—</span>}</div></div>
        <div style={{ minWidth: 0 }}><div style={label}>Client</div><div style={{ ...value, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{customerDisplayName(payment.client_name)}</div></div>
        <div><div style={label}>Received on</div><div style={value}>{fmtDate(payment.payment_date)} · {PAYMENT_MODE_LABEL[payment.payment_mode] ?? payment.payment_mode}</div></div>
      </div>

      {/* Where it went. */}
      <div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, marginBottom: '8px' }}>Allocated to</div>
        {view.kind === 'loading' && <div style={label}>Loading…</div>}
        {view.kind === 'unavailable' && <div style={{ ...label, fontStyle: 'italic' }}>{ALLOCATION_DETAILS_UNAVAILABLE_TEXT}. Open the payment for details.</div>}
        {view.kind === 'none' && <div style={label}>Not allocated to any Order or PI Draft yet.</div>}
        {lines.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid #ECE7E0', borderRadius: '10px', overflow: 'hidden' }}>
            {lines.map((line, i) => {
              const href = hrefFor(line.targetType, line.targetId)
              return (
                <li key={line.key} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: i === 0 ? 'none' : '1px solid #ECE7E0' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, background: '#F3F0EB', borderRadius: '6px', padding: '2px 6px', flexShrink: 0 }}>
                    {line.targetType === 'order' ? 'Order' : 'PI Draft'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }} title={line.label}>
                    {href ? (
                      <a
                        href={href}
                        className="boe-record-link"
                        style={{ fontWeight: 600 }}
                        onClick={event => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                          event.preventDefault()
                          onOpenTarget(href)
                        }}
                      >
                        {line.label}
                      </a>
                    ) : <span style={{ fontWeight: 600 }}>{line.label}</span>}
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtAmount(line.amount)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* The totals. */}
      {left !== null && (
        <div style={{ display: 'flex', gap: '24px', paddingTop: '4px' }}>
          <div><div style={label}>Allocated</div><div style={{ ...value, fontVariantNumeric: 'tabular-nums' }}>{fmtAmount(allocated)}</div></div>
          <div><div style={label}>Left to allocate</div><div style={{ ...value, fontVariantNumeric: 'tabular-nums', color: Number(left) > 0 ? '#805B0D' : colors.primary }}>{fmtAmount(left)}</div></div>
          {view.kind === 'targets' && view.over && (
            <div style={{ fontSize: '12px', color: '#A12438', alignSelf: 'flex-end' }}>Allocated beyond the amount received — flagged for Admin review.</div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '4px' }}>
        <button type="button" onClick={onClose} className="boe-btn boe-btn-secondary">Close</button>
        {onAllocate && (
          <button type="button" onClick={onAllocate} className="boe-btn boe-btn-primary">{ALLOCATE_FUNDS_ACTION_LABEL}</button>
        )}
      </div>
    </FinanceModal>
  )
}
