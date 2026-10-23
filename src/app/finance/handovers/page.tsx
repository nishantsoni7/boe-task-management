'use client'

// ── /finance/handovers ───────────────────────────────────────────────────────
//
// The HISTORY of cash handovers. Open ones (waiting for acceptance, or disputed)
// are drawn by HandoverBanner at the top of every Finance page, so this list
// leads with the closed ones and does not repeat the banner. It sits inside
// src/app/finance/layout.tsx, so ModuleGuard has already decided Finance entry.
//
// Everyone sees their own handovers (as giver or recipient). An administrator or
// a finance.view_all holder can switch to Everyone; for anybody else the
// database simply answers with their own rows whatever the switch says.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { HandoverCard } from '@/components/finance/HandoverCard'
import { CashInHandPanel } from '@/components/finance/CashInHandPanel'
import { HANDOVERS_KEY, useHandoverHistory } from '@/hooks/queries/useHandovers'
import { useQueryClient } from '@tanstack/react-query'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'

const PAGE_SIZE = 25

const TABS = [
  { key: 'closed',    label: 'Closed',     statuses: ['accepted', 'cancelled'] },
  { key: 'accepted',  label: 'Accepted',   statuses: ['accepted'] },
  { key: 'cancelled', label: 'Cancelled',  statuses: ['cancelled'] },
  { key: 'all',       label: 'Everything', statuses: null },
] as const

export default function HandoversPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: userId } = useSignedInUserId()
  const [tab, setTab] = useState<typeof TABS[number]['key']>('closed')
  const [onlyMine, setOnlyMine] = useState(true)
  const [page, setPage] = useState(0)

  const active = TABS.find(t => t.key === tab) ?? TABS[0]
  const history = useHandoverHistory(active.statuses ? [...active.statuses] : null, onlyMine, page, PAGE_SIZE)
  const rows = history.data ?? []
  const hasNext = rows.length > PAGE_SIZE
  const visible = rows.slice(0, PAGE_SIZE)

  const handleSignOut = async () => {
    await createClient().auth.signOut()
    router.replace('/login')
  }

  const pill = (selected: boolean): React.CSSProperties => ({
    padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${selected ? '#B9472E' : '#CFC8BF'}`,
    background: selected ? '#F8EAE4' : '#FFFFFF',
    color: selected ? '#963B27' : '#4C5352',
  })

  return (
    <FinanceLayout
      profile={null}
      title="Cash Handovers"
      subtitle="Cash handed between people, who accepted it, and who holds what"
      onSignOut={handleSignOut}
      onRefresh={async () => { await queryClient.invalidateQueries({ queryKey: HANDOVERS_KEY }) }}
    >
      <CashInHandPanel />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }} role="tablist" aria-label="Handover history">
        {TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === tab} style={pill(t.key === tab)}
            onClick={() => { setTab(t.key); setPage(0) }}>
            {t.label}
          </button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={!onlyMine} onChange={e => { setOnlyMine(!e.target.checked); setPage(0) }} />
          Show everyone&apos;s (if you are allowed)
        </label>
      </div>

      <p style={{ margin: '0 0 14px', fontSize: 13, color: '#686D6C' }}>
        Handovers still waiting for acceptance are shown at the top of every Finance page until they are accepted or cancelled.
      </p>

      {history.isPending && <div style={{ fontSize: 14 }}>Loading…</div>}
      {history.isError && (
        <div className="boe-handover-error" role="alert">
          Handovers could not be loaded. <button type="button" className="boe-btn boe-btn-secondary" onClick={() => void history.refetch()}>Try again</button>
        </div>
      )}
      {history.data && visible.length === 0 && (
        <div style={{ padding: 24, borderRadius: 12, background: '#FFFFFF', border: '1px solid #E4DED7', textAlign: 'center', fontSize: 14, color: '#4C5352' }}>
          No handovers here yet.
        </div>
      )}

      <div className="boe-handover-stack">
        {visible.map(h => <HandoverCard key={h.id} handover={h} viewerId={userId ?? null} />)}
      </div>

      {(page > 0 || hasNext) && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}>
          <button type="button" className="boe-btn boe-btn-secondary" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</button>
          <span style={{ fontSize: 13 }}>Page {page + 1}</span>
          <button type="button" className="boe-btn boe-btn-secondary" disabled={!hasNext} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </FinanceLayout>
  )
}
