'use client'

// ── "Money already received from this client" ────────────────────────────────
//
// Shown inside Add payment once the amount and the date are filled in
// (Payments counted once, 2026-10-29). When the client's money is already in
// the system — on a PI that was closed, or on nothing yet — the person taps
// "Use this money" instead of recording the same transfer again. Nothing shows
// when there is no match, so the form behaves exactly as before.
//
// The parent supplies the two database calls; this component asks, draws and
// waits. It never decides who may do what: the database does, at both doors.

import { useEffect, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import {
  canSearchAvailableMoney,
  describeAvailablePayment,
  type AvailablePayment,
} from '@/lib/finance/availableMoney'
import { PaymentTracker } from '@/components/finance/PaymentTracker'

export const AVAILABLE_MONEY_HEADING = 'Money already received from this client'
export const AVAILABLE_MONEY_HINT =
  'If the client’s payment is one of these, use it. Do not record the same money again.'
export const USE_THIS_MONEY_LABEL = 'Use this money'

/** How long the amount and date must stay still before the search runs. */
const SEARCH_DELAY_MS = 350

export function AvailableMoneyPanel({ amount, paymentDate, search, onUse, disabled = false }: {
  amount: string
  paymentDate: string
  search: (amount: string, paymentDate: string) => Promise<AvailablePayment[]>
  /** Resolves to an error sentence, or null when the money was used. */
  onUse: (paymentId: string) => Promise<string | null>
  disabled?: boolean
}) {
  const [matches, setMatches] = useState<AvailablePayment[]>([])
  const [using, setUsing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The answer to an older question is thrown away: only the latest one draws.
  const askedRef = useRef(0)

  const ready = canSearchAvailableMoney(amount, paymentDate)

  useEffect(() => {
    const asked = ++askedRef.current
    if (!ready) return
    const timer = setTimeout(() => {
      void search(amount, paymentDate).then(rows => {
        if (askedRef.current !== asked) return
        setMatches(rows)
        setError(null)
      })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [ready, amount, paymentDate, search])

  // An unfinished amount or date shows nothing, whatever an earlier search found.
  const shown = ready ? matches : []
  if (shown.length === 0) return null

  const use = async (paymentId: string) => {
    if (using || disabled) return
    setUsing(paymentId)
    setError(null)
    const failure = await onUse(paymentId)
    setUsing(null)
    if (failure) setError(failure)
  }

  return (
    <section className="available-money" aria-label={AVAILABLE_MONEY_HEADING} style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px',
      background: colors.raised, display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <strong style={{ fontSize: '13px', color: colors.primary }}>{AVAILABLE_MONEY_HEADING}</strong>
        <span style={{ fontSize: '12px', color: colors.muted }}>{AVAILABLE_MONEY_HINT}</span>
      </div>

      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {shown.map(row => {
          const d = describeAvailablePayment(row)
          return (
            <li key={row.payment_id} className="available-money-row" style={{
              background: colors.base, border: `1px solid ${colors.border}`, borderRadius: '8px',
              padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>{d.number}</span>
                <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>{d.amount}</span>
              </div>
              <PaymentTracker status={row.status} />
              <span style={{ fontSize: '12px', color: colors.tertiary }}>{d.facts}</span>
              <span style={{ fontSize: '12px', color: colors.tertiary }}>{d.where}</span>
              <button
                type="button"
                className="boe-btn boe-btn-primary"
                style={{ alignSelf: 'flex-start', padding: '6px 14px', fontSize: '13px' }}
                disabled={disabled || using !== null}
                onClick={() => { void use(row.payment_id) }}
              >
                {using === row.payment_id ? 'Using…' : USE_THIS_MONEY_LABEL}
              </button>
            </li>
          )
        })}
      </ul>

      {error && (
        <div role="alert" style={{
          fontSize: '12px', color: colors.red, background: colors.redTint,
          border: '1px solid rgba(180,35,50,0.2)', borderRadius: '6px', padding: '8px 10px',
        }}>
          {error}
        </div>
      )}
    </section>
  )
}
