'use client'

import { useMemo } from 'react'
import { useOpenHandovers } from '@/hooks/queries/useHandovers'
import { HandoverCard } from '@/components/finance/HandoverCard'
import { sortMyHandovers } from '@/lib/finance/handover'

/**
 * Every open (pending or disputed) cash handover the viewer is part of, drawn as
 * a full-width card above the page. THERE IS NO DISMISS: a card goes away only
 * when the handover is accepted or cancelled. Administrators and finance.view_all
 * holders additionally see other people's open handovers, quieter, underneath.
 *
 * Mounted once in FinanceLayout, so it appears on every Finance page.
 */
export function HandoverBanner() {
  const { viewerId, mine, others, isError, refetch } = useOpenHandovers()
  const sortedMine = useMemo(() => sortMyHandovers(mine, viewerId), [mine, viewerId])
  const sortedOthers = useMemo(() => sortMyHandovers(others, viewerId), [others, viewerId])

  if (isError && mine.length === 0 && others.length === 0) {
    return (
      <div className="boe-handover-stack">
        <div className="boe-handover-error" role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          Cash handovers could not be loaded, so any waiting for you may not be shown.
          <button type="button" className="boe-btn boe-btn-secondary" onClick={() => void refetch()}>Try again</button>
        </div>
      </div>
    )
  }

  if (sortedMine.length === 0 && sortedOthers.length === 0) return null

  return (
    <div className="boe-handover-stack" data-testid="handover-banner">
      {sortedMine.map(h => (
        <HandoverCard key={h.id} handover={h} viewerId={viewerId} />
      ))}

      {sortedOthers.length > 0 && (
        <details>
          <summary className="boe-handover-observers-title" style={{ cursor: 'pointer' }}>
            Other open handovers ({sortedOthers.length})
          </summary>
          <div className="boe-handover-stack" style={{ marginTop: 10, marginBottom: 0 }}>
            {sortedOthers.map(h => (
              <HandoverCard key={h.id} handover={h} viewerId={viewerId} />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
