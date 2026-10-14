'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { EmptyState, AlertBanner } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import {
  CATEGORY_META, loadActionQueue, pendingAgeLabel, type ActionQueueItem,
} from '@/lib/controlCenter/actionQueue'

// ── Types ─────────────────────────────────────────────────────────────────────

// The queue itself — rows, categories, links and the loader — lives in
// '@/lib/controlCenter/actionQueue', shared with the Control Center's Home.

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ActionQueuePage() {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ActionQueueItem[]>([])
  const [error, setError] = useState('')

  const supabase = useMemo(() => createClient(), [])

  const loadQueue = async () => {
    const res = await loadActionQueue(supabase)
    setError(res.error)
    setItems(res.items)
  }

  // Identity and the admin check are owned by control-center/layout.tsx; this
  // page mounts only for an admitted administrator. RLS still decides every
  // row the queries above may read.
  useEffect(() => {
    const init = async () => {
      await loadQueue()
      setLoading(false)
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) return <ControlCenterSkeleton />

  return (
    <>
      {error && (
        <div style={{ marginBottom: '16px' }}>
          <AlertBanner variant="red">{error}</AlertBanner>
        </div>
      )}

      {items.length === 0 && !error ? (
        <EmptyState message="No pending Finance or Order actions." />
      ) : (
        <ActionQueueTable items={items} />
      )}
    </>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '12px',
  fontWeight: 700,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

function ActionQueueTable({ items }: { items: ActionQueueItem[] }) {
  const router = useRouter()
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div className="boe-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '860px' }}>
          <thead>
            <tr>
              <th style={TH_STYLE}>Pending since</th>
              <th style={TH_STYLE}>Action needed</th>
              <th style={TH_STYLE}>Client</th>
              <th style={TH_STYLE}>Owner / submitted by</th>
              <th style={TH_STYLE}>Module</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Direct action</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr
                key={item.id}
                onClick={() => router.push(item.href)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {pendingAgeLabel(item.pendingSince)}
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {item.actionLabel}
                </td>
                <td style={{ ...TD, fontSize: '13px', color: colors.primary }}>
                  {item.clientName}
                  {item.amount != null && (
                    <span style={{ marginLeft: '8px', fontSize: '12px', color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {formatINR(item.amount)}
                    </span>
                  )}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {item.ownerName ?? '—'}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {item.module}
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <button
                    className="boe-btn boe-btn-ghost"
                    onClick={e => { e.stopPropagation(); router.push(item.href) }}
                    style={{ padding: '5px 12px', fontSize: '12px' }}
                  >
                    {CATEGORY_META[item.category].label} →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
