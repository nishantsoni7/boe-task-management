'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Landmark } from 'lucide-react'
import { formatINR } from '@/lib/currency'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import { HandoverModal } from '@/components/finance/HandoverModal'
import { sumAmounts, totalsByHolder, waitingAge } from '@/lib/finance/cashJourney'

export const CASH_JOURNEYS_PATH = '/finance/handovers'

const AGE_COLOUR = (hours: number) => (hours >= 72 ? '#B42332' : hours >= 24 ? '#D2691E' : '#805B0D')

/**
 * "Money not yet with the company" — on every Finance page, under the
 * handover banner.
 *
 * For the people who receive cash for the company, admins and finance.view_all
 * holders: the total, and one line per person holding some, oldest first in
 * colour. For everybody else: how much THEY are holding, with Hand over.
 * Nothing at all when there is nothing to say.
 */
export function UnclosedFundsCard() {
  const q = useUnclosedFunds(true)
  const [handOverOpen, setHandOverOpen] = useState(false)
  const data = q.data
  if (!data || data.scope === 'none') return null

  const card: React.CSSProperties = {
    border: '1.5px solid rgba(210,105,30,0.55)', background: '#FFF8F1', borderRadius: 14,
    padding: '14px 16px', marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10,
  }

  if (data.scope === 'all') {
    if (data.payments.length === 0) return null
    const total = sumAmounts(data.payments)
    const holders = totalsByHolder(data.payments)
    return (
      <section style={card} aria-label="Money not yet with the company">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Landmark size={20} strokeWidth={1.8} aria-hidden="true" color="#6A3208" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#6A3208' }}>Money not yet with the company</h2>
          <span style={{ marginLeft: 'auto', fontSize: 24, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#6A3208' }}>{formatINR(total)}</span>
        </div>
        <div style={{ fontSize: 13, color: '#6A3208' }}>
          {data.payments.length} {data.payments.length === 1 ? 'payment' : 'payments'} with {holders.length} {holders.length === 1 ? 'person' : 'people'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {holders.map(h => (
            <Link key={h.holderId} href={`${CASH_JOURNEYS_PATH}?holder=${encodeURIComponent(h.holderId)}`}
              style={{ textDecoration: 'none', display: 'inline-flex', flexDirection: 'column', gap: 2, padding: '8px 12px', borderRadius: 10, background: '#FFFFFF', border: '1px solid #E4DED7', minWidth: 140 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#303536' }}>{h.holderName}</span>
              <span style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#303536' }}>{formatINR(h.amount)}</span>
              <span style={{ fontSize: 12, color: AGE_COLOUR(h.oldestAgeHours) }}>
                {h.count} {h.count === 1 ? 'payment' : 'payments'} · oldest {waitingAge(h.oldestAgeHours)}
              </span>
            </Link>
          ))}
        </div>
        <Link href={CASH_JOURNEYS_PATH} style={{ fontSize: 13, fontWeight: 700, color: '#963B27' }}>See every payment →</Link>
      </section>
    )
  }

  // Everybody else: only the money they hold themselves (what they must accept
  // is already in the handover banner above).
  const holding = data.payments.filter(p => p.canHandOver)
  if (holding.length === 0) return null
  const total = sumAmounts(holding)
  const oldest = Math.max(...holding.map(p => p.ageHours))
  return (
    <section style={card} aria-label="Money you are holding">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Landmark size={20} strokeWidth={1.8} aria-hidden="true" color="#6A3208" />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#6A3208' }}>
          You are holding {formatINR(total)} that has not reached the company
        </h2>
      </div>
      <div style={{ fontSize: 13, color: AGE_COLOUR(oldest) }}>
        {holding.length} {holding.length === 1 ? 'payment' : 'payments'} · oldest {waitingAge(oldest)}.
        {data.custodians.length > 0 ? ` Hand it to ${data.custodians.map(c => c.fullName).join(' or ')}, or to a senior.` : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="boe-btn boe-btn-primary" onClick={() => setHandOverOpen(true)}>Hand over</button>
        <Link href={CASH_JOURNEYS_PATH} className="boe-btn boe-btn-secondary" style={{ textDecoration: 'none' }}>See the payments</Link>
      </div>
      {handOverOpen && <HandoverModal onClose={() => setHandOverOpen(false)} />}
    </section>
  )
}
