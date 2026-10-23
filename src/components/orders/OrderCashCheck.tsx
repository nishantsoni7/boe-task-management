'use client'

import { formatINR } from '@/lib/currency'
import { formatDateTime } from '@/lib/ui'
import { CashStateChip } from '@/components/finance/CashStateChip'
import {
  ORDER_CASH_REASON_MAX,
  type OrderCashAck,
  type OrderCashCheck as OrderCashCheckData,
} from '@/lib/orders/orderCashCheck'

/**
 * "Payments check" in the Approve dialog (20270414000000).
 *
 * Bank (HDFC) payments are counted only once Finance has verified them — the
 * existing gate still enforces that. Cash (PNB, Paytm, Canara) should also have
 * REACHED THE COMPANY. When some has not, the approver may go ahead only by
 * ticking "Approve without this cash" and saying why; the money stays on the
 * "not yet with the company" list, marked, until it arrives. The database
 * refuses the Order without that reason.
 */
export function OrderCashCheck({
  check,
  loading,
  ack,
  onAck,
  disabled,
}: {
  check: OrderCashCheckData | null | undefined
  loading: boolean
  ack: OrderCashAck
  onAck: (next: OrderCashAck) => void
  disabled: boolean
}) {
  const box: React.CSSProperties = {
    border: '1px solid #E4DED7', borderRadius: 10, padding: 12, background: '#FBFAF8',
    display: 'flex', flexDirection: 'column', gap: 8,
  }
  const title = <div style={{ fontSize: 13, fontWeight: 700, color: '#303536' }}>Payments check</div>
  const bankLine = (
    <div style={{ fontSize: 12.5, color: '#4C5352' }}>
      Bank payments (HDFC PRI / SEC) count once Finance has verified them.
    </div>
  )

  if (loading && !check) {
    return <div style={box}>{title}<div style={{ fontSize: 13, color: '#686D6C' }}>Checking where the cash is…</div></div>
  }
  if (!check) return null

  if (check.uncovered.length === 0) {
    return (
      <div style={box}>
        {title}
        {bankLine}
        <div style={{ fontSize: 13, fontWeight: 600, color: '#276247' }}>✓ No cash on this PI is waiting to reach the company.</div>
        {check.covered.map((c, i) => (
          <div key={i} style={{ fontSize: 12, color: '#686D6C' }}>
            Approved without cash earlier{c.byName ? ` by ${c.byName}` : ''}{c.at ? ` on ${formatDateTime(c.at)}` : ''}: “{c.reason}”
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ ...box, borderColor: 'rgba(210,105,30,0.6)', background: '#FFF8F1' }} role="group" aria-label="Payments check">
      {title}
      {bankLine}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#6A3208' }}>
        This cash has not reached the company yet:
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {check.uncovered.map(p => (
          <li key={p.paymentId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
            <strong>{p.humanPaymentId ?? 'Payment'}</strong>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(p.amount)}</span>
            <CashStateChip payment={p} />
          </li>
        ))}
      </ul>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
        <input type="checkbox" checked={ack.ticked} disabled={disabled}
          onChange={e => onAck({ ...ack, ticked: e.target.checked })} style={{ marginTop: 2 }} />
        Approve without this cash reaching the company
      </label>
      {ack.ticked && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, fontWeight: 600 }}>
          Why? (it stays on the “not yet with the company” list with this reason)
          <textarea
            value={ack.reason}
            maxLength={ORDER_CASH_REASON_MAX}
            rows={2}
            disabled={disabled}
            onChange={e => onAck({ ...ack, reason: e.target.value })}
            placeholder="e.g. Nishant has the cash and is out of town until Monday"
            style={{ font: 'inherit', fontWeight: 400, padding: 8, borderRadius: 8, border: '1px solid #686D6C', resize: 'vertical' }}
          />
        </label>
      )}
    </div>
  )
}
