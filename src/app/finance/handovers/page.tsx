'use client'

// ── /finance/handovers — Cash journeys ───────────────────────────────────────
//
// Two views:
//   * NOT YET WITH COMPANY (default): every PNB, Paytm and Canara payment whose
//     money has not reached the company, grouped by who holds it, each with its
//     one action (Accept / Receive / Hand over) and its journey. Admins, the
//     people who receive cash for the company and finance.view_all holders see
//     everyone's; everybody else sees what they hold or must accept
//     (finance_unclosed_funds decides, 20270413000000).
//   * HANDOVER HISTORY: closed handovers, as before.
//
// It sits inside src/app/finance/layout.tsx, so ModuleGuard has already decided
// Finance entry. Open handovers are also drawn by HandoverBanner on every
// Finance page.

import { Suspense, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { HandoverCard } from '@/components/finance/HandoverCard'
import { HandoverModal } from '@/components/finance/HandoverModal'
import { CashStateChip } from '@/components/finance/CashStateChip'
import { CashPaymentActions } from '@/components/finance/CashPaymentActions'
import { CustodiansSetting } from '@/components/finance/CustodiansSetting'
import { HANDOVERS_KEY, useHandoverHistory } from '@/hooks/queries/useHandovers'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import { useSignedInUserId, usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { formatINR } from '@/lib/currency'
import { formatFullDate } from '@/lib/ui'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import { sumAmounts, totalsByHolder, waitingAge } from '@/lib/finance/cashJourney'

const PAGE_SIZE = 25

const HISTORY_TABS = [
  { key: 'closed',    label: 'Closed',     statuses: ['accepted', 'cancelled'] },
  { key: 'accepted',  label: 'Accepted',   statuses: ['accepted'] },
  { key: 'cancelled', label: 'Cancelled',  statuses: ['cancelled'] },
  { key: 'all',       label: 'Everything', statuses: null },
] as const

const pill = (selected: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${selected ? '#B9472E' : '#CFC8BF'}`,
  background: selected ? '#F8EAE4' : '#FFFFFF',
  color: selected ? '#963B27' : '#4C5352',
})

export default function CashJourneysPage() {
  return (
    <Suspense fallback={null}>
      <CashJourneysView />
    </Suspense>
  )
}

function CashJourneysView() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const params = useSearchParams()
  const [view, setView] = useState<'open' | 'history'>('open')

  const handleSignOut = async () => {
    await createClient().auth.signOut()
    router.replace('/login')
  }

  return (
    <FinanceLayout
      profile={null}
      title="Cash journeys"
      subtitle="Where cash and non-HDFC money is, until it reaches the company"
      onSignOut={handleSignOut}
      onRefresh={async () => { await queryClient.invalidateQueries({ queryKey: HANDOVERS_KEY }) }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }} role="tablist" aria-label="Cash journeys">
        <button type="button" role="tab" aria-selected={view === 'open'} style={pill(view === 'open')} onClick={() => setView('open')}>
          Not yet with company
        </button>
        <button type="button" role="tab" aria-selected={view === 'history'} style={pill(view === 'history')} onClick={() => setView('history')}>
          Handover history
        </button>
      </div>

      {view === 'open' ? <OpenJourneys holderFilter={params.get('holder')} /> : <HandoverHistory />}
    </FinanceLayout>
  )
}

function OpenJourneys({ holderFilter }: { holderFilter: string | null }) {
  const q = useUnclosedFunds(true)
  const { role } = usePermissionContext()
  const [handOverOpen, setHandOverOpen] = useState(false)
  const [filter, setFilter] = useState<string | null>(holderFilter)

  const payments = useMemo(() => q.data?.payments ?? [], [q.data])
  const holders = useMemo(() => totalsByHolder(payments), [payments])
  const shownHolders = filter ? holders.filter(h => h.holderId === filter) : holders

  if (q.isPending) return <div style={{ fontSize: 14 }}>Loading…</div>
  if (q.isError) {
    return (
      <div className="boe-handover-error" role="alert">
        This list could not be loaded. <button type="button" className="boe-btn boe-btn-secondary" onClick={() => void q.refetch()}>Try again</button>
      </div>
    )
  }

  const total = sumAmounts(payments)

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatINR(total)}</div>
        <div style={{ fontSize: 13, color: '#4C5352' }}>
          {payments.length === 0
            ? 'Everything has reached the company.'
            : `${payments.length} ${payments.length === 1 ? 'payment' : 'payments'} not yet with the company${q.data?.scope === 'mine' ? ' (yours)' : ''}`}
        </div>
        {holders.length > 1 && (
          <select
            value={filter ?? ''}
            onChange={e => setFilter(e.target.value || null)}
            aria-label="Show one person"
            style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 8, border: '1px solid #686D6C', font: 'inherit', fontSize: 13 }}
          >
            <option value="">Everyone</option>
            {holders.map(h => <option key={h.holderId} value={h.holderId}>{h.holderName} · {formatINR(h.amount)}</option>)}
          </select>
        )}
      </div>

      {shownHolders.map(h => (
        <section key={h.holderId} style={{ background: '#FFFFFF', border: '1px solid #E4DED7', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: '#FBFAF8', borderBottom: '1px solid #E4DED7' }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>With {h.holderName}</h2>
            <span style={{ fontSize: 13, color: '#4C5352' }}>{h.count} {h.count === 1 ? 'payment' : 'payments'} · oldest {waitingAge(h.oldestAgeHours)}</span>
            <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatINR(h.amount)}</span>
          </header>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {payments.filter(p => (p.holderId ?? 'unknown') === h.holderId).map(p => (
              <li key={p.paymentId} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid #F1EEE9' }}>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>
                    <strong>{p.humanPaymentId ?? 'Payment'}</strong> · {p.clientName ?? 'Suspense'}
                  </div>
                  <div style={{ fontSize: 12, color: '#686D6C' }}>
                    {paymentModeLabel(p.paymentMode)}{p.paymentDate ? ` · paid ${formatFullDate(p.paymentDate)}` : ''}
                  </div>
                </div>
                <div style={{ flex: '0 0 auto', fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatINR(p.amount)}</div>
                <div style={{ flex: '1 1 220px' }}><CashStateChip payment={p} /></div>
                <CashPaymentActions payment={p} onHandOver={() => setHandOverOpen(true)} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {q.data && <CustodiansSetting current={q.data.custodians} isAdmin={role === 'admin'} />}
      {handOverOpen && <HandoverModal onClose={() => setHandOverOpen(false)} />}
    </>
  )
}

function HandoverHistory() {
  const { data: userId } = useSignedInUserId()
  const [tab, setTab] = useState<typeof HISTORY_TABS[number]['key']>('closed')
  const [onlyMine, setOnlyMine] = useState(true)
  const [page, setPage] = useState(0)

  const active = HISTORY_TABS.find(t => t.key === tab) ?? HISTORY_TABS[0]
  const history = useHandoverHistory(active.statuses ? [...active.statuses] : null, onlyMine, page, PAGE_SIZE)
  const rows = history.data ?? []
  const hasNext = rows.length > PAGE_SIZE
  const visible = rows.slice(0, PAGE_SIZE)

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }} role="tablist" aria-label="Handover history">
        {HISTORY_TABS.map(t => (
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
    </>
  )
}
