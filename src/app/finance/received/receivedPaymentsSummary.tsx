'use client'

import type { ConfirmedSummary } from '@/lib/finance/confirmedSummary'
import type { ConfirmedAllocationFilter } from '@/lib/finance/paymentSurfaces'
import { fmtAmount } from './receivedPaymentsModel'

const plural = (n: number) => `${n} payment${n === 1 ? '' : 's'}`

/**
 * The four summary cards above Confirmed Payments. Each card is also a shortcut
 * to its tab: pressing "Waiting to allocate" shows the Zero Allocated list.
 * `summary` null = not known yet (or the read failed): the cards are not drawn,
 * rather than drawn as zeros.
 */
export function ConfirmedSummaryCards({ summary, active, onSelect }: {
  summary: ConfirmedSummary | null
  active: ConfirmedAllocationFilter
  onSelect: (filter: ConfirmedAllocationFilter) => void
}) {
  if (!summary) return null
  const cards: { filter: ConfirmedAllocationFilter; label: string; tone: string; bucket: ConfirmedSummary['all'] }[] = [
    { filter: 'all',     label: 'Received',             tone: 'neutral', bucket: summary.all },
    { filter: 'zero',    label: 'Waiting to allocate',  tone: 'zero',    bucket: summary.zero },
    { filter: 'partial', label: 'Partially allocated',  tone: 'partial', bucket: summary.partial },
    { filter: 'full',    label: 'Fully allocated',      tone: 'full',    bucket: summary.full },
  ]
  return (
    <>
      <div className="fin-stats" role="group" aria-label="Confirmed money at a glance">
        {cards.map(c => (
          <button
            key={c.filter}
            type="button"
            className="fin-stat"
            aria-pressed={active === c.filter}
            onClick={() => onSelect(c.filter)}
          >
            <span className="fin-stat-label">
              <span aria-hidden="true" className={`fin-dot fin-dot--${c.tone}`} />
              {c.label}
            </span>
            <span className="fin-stat-value" style={{ display: 'block' }}>{fmtAmount(c.bucket.amount)}</span>
            <span className="fin-stat-sub" style={{ display: 'block' }}>{plural(c.bucket.count)}</span>
          </button>
        ))}
      </div>
      {summary.over.count > 0 && (
        <p className="fin-stats-note">
          {plural(summary.over.count)} allocated beyond the amount received.{' '}
          <button
            type="button"
            onClick={() => onSelect('over')}
            aria-pressed={active === 'over'}
            style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
          >
            Show them
          </button>
        </p>
      )}
    </>
  )
}
