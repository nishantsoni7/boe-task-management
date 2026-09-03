'use client'

// The employee's own BOE Credits, in one line on My Payroll: "17 credits
// spendable", the pending figure when there is one, and a way to the full
// credits page.
//
// Deliberately NOT a dashboard tile with a trend, a chart or a target. It is a
// compact read-only item dropped into the self-service payroll page: it
// self-fetches with the bearer token the page already holds, and the route
// pins a non-admin to their own ledger, so there is no employee id here to
// tamper with.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { colors } from '@/lib/tokens'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { MY_CREDITS_PATH } from '@/lib/boeCredits/paths'

type LedgerResponse = {
  employee_id: string
  available_credits: number
  provisional_credits?: number
  spendable_credits?: number
}

export function CreditsSummaryCard({ token }: { token: string }) {
  const [ledger, setLedger] = useState<LedgerResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const load = async () => {
      // One row is enough: this card shows balances, not history.
      const res = await fetch('/api/boe-credits/ledger?limit=1', {
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => null)
      if (cancelled) return
      if (!res || !res.ok) { setFailed(true); return }
      const json = (await res.json().catch(() => null)) as LedgerResponse | null
      if (cancelled) return
      if (!json) { setFailed(true); return }
      setLedger(json)
    }
    void load()
    return () => { cancelled = true }
  }, [token])

  const spendable   = ledger?.spendable_credits ?? ledger?.available_credits ?? 0
  const provisional = ledger?.provisional_credits ?? 0

  return (
    <div style={{
      background: '#fff', borderRadius: 12,
      border: '1px solid rgba(0,0,0,0.08)',
      padding: '12px 16px', marginBottom: 16,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.09em', color: colors.muted, marginBottom: 2,
        }}>
          BOE Credits
        </div>
        <div style={{
          fontSize: 19, fontWeight: 600, color: colors.primary,
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em', lineHeight: 1.15,
        }}>
          {failed ? 'Unavailable' : ledger == null ? '…' : `${formatCredits(spendable)} spendable`}
        </div>
        <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 3 }}>
          {failed
            ? 'Your credits could not be loaded right now.'
            : provisional > 0
              ? `${formatCredits(provisional)} pending this month’s review target · credits carry forward`
              : 'Earned from verified reviews. Credits carry forward month to month.'}
        </div>
      </div>
      <button
        onClick={() => router.push(MY_CREDITS_PATH)}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '4px 12px', fontSize: 12.5, whiteSpace: 'nowrap' }}
      >
        Open credits
      </button>
    </div>
  )
}
