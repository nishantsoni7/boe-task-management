'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
  const pathname = usePathname()
  const [handOverOpen, setHandOverOpen] = useState(false)
  const data = q.data
  // The Cash journeys page IS this list; repeating it above itself is noise.
  if (!data || data.scope === 'none' || pathname === CASH_JOURNEYS_PATH) return null

  // One quiet line, not a block: the page the link opens has the detail.
  const card: React.CSSProperties = {
    border: '1px solid #E4DED7', borderLeft: '3px solid #D2691E', background: '#FFFFFF', borderRadius: 8,
    minHeight: 34, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: '#4C5352',
  }

  if (data.scope === 'all') {
    if (data.payments.length === 0) return null
    const total = sumAmounts(data.payments)
    const holders = totalsByHolder(data.payments)
    return (
      <section style={card} aria-label="Money not yet with the company">
        <Landmark size={16} strokeWidth={1.8} aria-hidden="true" color="#6A3208" />
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#303536' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatINR(total)}</span> not yet with the company
        </h2>
        <span>
          {data.payments.length} {data.payments.length === 1 ? 'payment' : 'payments'} with {holders.length} {holders.length === 1 ? 'person' : 'people'}
          {holders.slice(0, 3).map(h => (
            <span key={h.holderId}>
              {' · '}
              <Link href={`${CASH_JOURNEYS_PATH}?holder=${encodeURIComponent(h.holderId)}`} style={{ color: '#303536', textDecoration: 'none' }}>
                {h.holderName} <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatINR(h.amount)}</strong>
                <span style={{ color: AGE_COLOUR(h.oldestAgeHours) }}> ({waitingAge(h.oldestAgeHours)})</span>
              </Link>
            </span>
          ))}
          {holders.length > 3 ? ` · +${holders.length - 3} more` : ''}
        </span>
        <Link href={CASH_JOURNEYS_PATH} style={{ marginLeft: 'auto', fontWeight: 600, color: '#963B27' }}>See every payment →</Link>
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
      <div style={{ display: 'contents' }}>
        <Landmark size={16} strokeWidth={1.8} aria-hidden="true" color="#6A3208" />
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#303536' }}>
          You are holding {formatINR(total)} that has not reached the company
        </h2>
      </div>
      <div style={{ color: AGE_COLOUR(oldest) }}>
        {holding.length} {holding.length === 1 ? 'payment' : 'payments'} · oldest {waitingAge(oldest)}.
        {data.custodians.length > 0 ? ` Hand it to ${data.custodians.map(c => c.fullName).join(' or ')}, or to a senior.` : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
        <button type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 32, padding: '4px 12px' }} onClick={() => setHandOverOpen(true)}>Hand over</button>
        <Link href={CASH_JOURNEYS_PATH} className="boe-btn boe-btn-secondary" style={{ textDecoration: 'none', minHeight: 32, padding: '4px 12px' }}>See the payments</Link>
      </div>
      {handOverOpen && <HandoverModal onClose={() => setHandOverOpen(false)} />}
    </section>
  )
}
