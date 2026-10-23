'use client'

import { useRef, useState } from 'react'
import { Wallet } from 'lucide-react'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { AmountInput } from '@/app/finance/components/AmountInput'
import { formatINR } from '@/lib/currency'
import { formatDateTime } from '@/lib/ui'
import { useCashBalances, useHandoverActions, useMyCashBalance } from '@/hooks/queries/useHandovers'
import {
  CASH_OUT_KINDS,
  CASH_OUT_KIND_LABEL,
  adjustmentError,
  cashEntryLabel,
  cashOutError,
  type CashBalanceRow,
  type CashOutKind,
} from '@/lib/finance/handover'

/**
 * CASH IN HAND (20270412000000), at the top of /finance/handovers.
 *
 * Your own balance (what typed-cash handovers left with you), what is reserved
 * in handovers you have offered, and what is available; Record cash out for
 * money that left your hands (bank deposit, paid out, other). Administrators and
 * finance.view_all holders also see everyone's balance; an administrator can
 * adjust one with a reason. Every number is the database's
 * (finance_my_cash_balance / finance_cash_balances); every write is re-checked
 * there (record_cash_out / adjust_cash_balance).
 */
export function CashInHandPanel() {
  const mine = useMyCashBalance(true)
  const everyone = useCashBalances(true)
  const [cashOutOpen, setCashOutOpen] = useState(false)
  const [adjusting, setAdjusting] = useState<CashBalanceRow | null>(null)
  const [showAll, setShowAll] = useState(false)

  // The migration is not applied yet: say nothing rather than an error.
  if (mine.data === null) return null

  const card: React.CSSProperties = { background: '#FFFFFF', border: '1px solid #E4DED7', borderRadius: 12, padding: 16, marginBottom: 16 }
  const figure = (label: string, value: number, strong = false) => (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#686D6C' }}>{label}</div>
      <div style={{ fontSize: strong ? 26 : 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#303536' }}>{formatINR(value)}</div>
    </div>
  )

  const entries = mine.data?.entries ?? []
  const shown = showAll ? entries : entries.slice(0, 5)

  return (
    <>
      <section style={card} aria-label="Your cash in hand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <Wallet size={20} strokeWidth={1.8} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Your cash in hand</h2>
          {mine.data && mine.data.available > 0 && (
            <button type="button" className="boe-btn boe-btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setCashOutOpen(true)}>
              Record cash out
            </button>
          )}
        </div>

        {mine.isPending && <div style={{ fontSize: 14 }}>Loading…</div>}
        {mine.isError && <div className="boe-handover-error" role="alert">Your cash in hand could not be loaded.</div>}

        {mine.data && (
          <>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {figure('Balance', mine.data.balance, true)}
              {figure('In open handovers', mine.data.reserved)}
              {figure('Available', mine.data.available)}
            </div>
            {entries.length === 0 ? (
              <p style={{ margin: '12px 0 0', fontSize: 13, color: '#686D6C' }}>
                Cash typed into a handover is added here when you accept it, and leaves when you hand it on or record it as cash out.
              </p>
            ) : (
              <>
                <ul style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, borderTop: '1px solid #F1EEE9' }}>
                  {shown.map(e => (
                    <li key={e.id} style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 0', borderBottom: '1px solid #F1EEE9', fontSize: 13 }}>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {cashEntryLabel(e)}
                        <span style={{ display: 'block', fontSize: 12, color: '#686D6C' }}>{e.createdAt ? formatDateTime(e.createdAt) : ''}</span>
                      </span>
                      <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: e.delta < 0 ? '#B42332' : '#276247' }}>
                        {e.delta < 0 ? '−' : '+'}{formatINR(Math.abs(e.delta))}
                      </span>
                    </li>
                  ))}
                </ul>
                {entries.length > 5 && (
                  <button type="button" className="boe-handover-toggle" style={{ marginLeft: 0, color: '#4C5352' }} onClick={() => setShowAll(v => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${entries.length}`}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </section>

      {everyone.data?.allowed && (
        <section style={card} aria-label="Cash in hand by person">
          <h2 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700 }}>Cash in hand by person</h2>
          {everyone.data.rows.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: '#686D6C' }}>Nobody is holding typed cash right now.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#686D6C' }}>
                    <th style={{ padding: '6px 8px' }}>Person</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Balance</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>In open handovers</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Available</th>
                    {everyone.data.canAdjust && <th style={{ padding: '6px 8px' }} aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {everyone.data.rows.map(r => (
                    <tr key={r.userId} style={{ borderTop: '1px solid #F1EEE9' }}>
                      <td style={{ padding: '8px' }}>{r.fullName}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatINR(r.balance)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(r.reserved)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(r.available)}</td>
                      {everyone.data?.canAdjust && (
                        <td style={{ padding: '8px', textAlign: 'right' }}>
                          <button type="button" className="boe-btn boe-btn-secondary" style={{ minHeight: 32, padding: '4px 10px' }} onClick={() => setAdjusting(r)}>Adjust</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {everyone.data.canAdjust && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: '#686D6C' }}>
              To set an opening balance for someone not in this list, hand them the cash as new cash in a handover.
            </p>
          )}
        </section>
      )}

      {cashOutOpen && mine.data && (
        <CashOutDialog available={mine.data.available} onClose={() => setCashOutOpen(false)} />
      )}
      {adjusting && (
        <AdjustDialog row={adjusting} onClose={() => setAdjusting(null)} />
      )}
    </>
  )
}

function CashOutDialog({ available, onClose }: { available: number; onClose: () => void }) {
  const { recordCashOut } = useHandoverActions()
  const keyRef = useRef<string>(crypto.randomUUID())
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<CashOutKind>('bank_deposit')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const problem = cashOutError({ amount, kind, note, available })
    if (problem) { setError(problem); return }
    setError(null)
    try {
      await recordCashOut.mutateAsync({ amount: Number(amount), kind, note, idempotencyKey: keyRef.current })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    }
  }

  return (
    <FinanceModal title="Record cash out" onClose={onClose} width="440px" closeOnBackdropClick={false}>
      <p style={{ margin: 0, fontSize: 13, color: '#4C5352' }}>Available: <strong>{formatINR(available)}</strong></p>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
        Amount
        <AmountInput value={amount} onChange={setAmount} prefix="₹" autoFocus />
      </label>
      <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>What happened to it</legend>
        {CASH_OUT_KINDS.map(k => (
          <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
            <input type="radio" name="cash-out-kind" checked={kind === k} onChange={() => setKind(k)} />
            {CASH_OUT_KIND_LABEL[k]}
          </label>
        ))}
      </fieldset>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
        Note
        <input type="text" value={note} maxLength={500} onChange={e => setNote(e.target.value)}
          placeholder="e.g. deposited in HDFC PRI, slip 4471"
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontWeight: 400 }} />
      </label>
      {error && <div className="boe-handover-error" role="alert">{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={recordCashOut.isPending}>Cancel</button>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => void submit()} disabled={recordCashOut.isPending} aria-busy={recordCashOut.isPending}>
          {recordCashOut.isPending ? 'Saving…' : 'Record cash out'}
        </button>
      </div>
    </FinanceModal>
  )
}

function AdjustDialog({ row, onClose }: { row: CashBalanceRow; onClose: () => void }) {
  const { adjustBalance } = useHandoverActions()
  const keyRef = useRef<string>(crypto.randomUUID())
  const [direction, setDirection] = useState<'add' | 'remove'>('remove')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const problem = adjustmentError({ amount, direction, reason, available: row.available })
    if (problem) { setError(problem); return }
    setError(null)
    try {
      const n = Number(amount)
      await adjustBalance.mutateAsync({
        userId: row.userId, delta: direction === 'add' ? n : -n, reason, idempotencyKey: keyRef.current,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    }
  }

  return (
    <FinanceModal title={`Adjust ${row.fullName}'s cash in hand`} onClose={onClose} width="440px" closeOnBackdropClick={false}>
      <p style={{ margin: 0, fontSize: 13, color: '#4C5352' }}>
        Balance <strong>{formatINR(row.balance)}</strong> · available <strong>{formatINR(row.available)}</strong>
      </p>
      <div role="radiogroup" aria-label="Direction" style={{ display: 'flex', gap: 16 }}>
        {(['remove', 'add'] as const).map(d => (
          <label key={d} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
            <input type="radio" name="adjust-direction" checked={direction === d} onChange={() => setDirection(d)} />
            {d === 'remove' ? 'Reduce' : 'Increase'}
          </label>
        ))}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
        Amount
        <AmountInput value={amount} onChange={setAmount} prefix="₹" autoFocus />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 }}>
        Reason
        <input type="text" value={reason} maxLength={500} onChange={e => setReason(e.target.value)}
          placeholder="e.g. counted short at month end"
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontWeight: 400 }} />
      </label>
      {error && <div className="boe-handover-error" role="alert">{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} disabled={adjustBalance.isPending}>Cancel</button>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => void submit()} disabled={adjustBalance.isPending} aria-busy={adjustBalance.isPending}>
          {adjustBalance.isPending ? 'Saving…' : 'Save adjustment'}
        </button>
      </div>
    </FinanceModal>
  )
}
