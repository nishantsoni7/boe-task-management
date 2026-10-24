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
  // "Not received" (stored as 'disputed') is final since 20270418000000.
  { key: 'closed',    label: 'Closed',       statuses: ['accepted', 'disputed', 'cancelled'] },
  { key: 'accepted',  label: 'Accepted',     statuses: ['accepted'] },
  { key: 'disputed',  label: 'Not received', statuses: ['disputed'] },
  { key: 'cancelled', label: 'Cancelled',    statuses: ['cancelled'] },
  { key: 'all',       label: 'Everything', statuses: null },
] as const

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
  const unclosed = useUnclosedFunds(true)
  const openCount = unclosed.data?.payments.length ?? 0

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
      <div className="boe-cj-tabs" role="tablist" aria-label="Cash journeys">
        <button type="button" role="tab" className="boe-cj-tab" aria-selected={view === 'open'} onClick={() => setView('open')}>
          Not yet with company
          {openCount > 0 && <span className="boe-cj-count">{openCount}</span>}
        </button>
        <button type="button" role="tab" className="boe-cj-tab" aria-selected={view === 'history'} onClick={() => setView('history')}>
          Handover history
        </button>
      </div>

      {view === 'open' ? <OpenJourneys q={unclosed} holderFilter={params.get('holder')} /> : <HandoverHistory />}
    </FinanceLayout>
  )
}

function OpenJourneys({ q, holderFilter }: { q: ReturnType<typeof useUnclosedFunds>; holderFilter: string | null }) {
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
      <div className="boe-cj-summary">
        <strong>{formatINR(total)}</strong>
        <span>
          {payments.length === 0
            ? 'Everything has reached the company.'
            : `${payments.length} ${payments.length === 1 ? 'payment' : 'payments'} not yet with the company${q.data?.scope === 'mine' ? ' (yours)' : ''}`}
        </span>
        {holders.length > 1 && (
          <select
            value={filter ?? ''}
            onChange={e => setFilter(e.target.value || null)}
            aria-label="Show one person"
            style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 8, border: '1px solid #8C8379', font: 'inherit', fontSize: 13 }}
          >
            <option value="">Everyone</option>
            {holders.map(h => <option key={h.holderId} value={h.holderId}>{h.holderName} · {formatINR(h.amount)}</option>)}
          </select>
        )}
      </div>

      {shownHolders.map(h => (
        <section key={h.holderId} className="boe-cj-group" aria-label={`With ${h.holderName}`}>
          <header className="boe-cj-group-head">
            <h2>With {h.holderName}</h2>
            <span>{h.count} {h.count === 1 ? 'payment' : 'payments'} · oldest {waitingAge(h.oldestAgeHours)}</span>
            <span className="boe-cj-group-total">{formatINR(h.amount)}</span>
          </header>
          <ul className="boe-cj-list">
            {payments.filter(p => (p.holderId ?? 'unknown') === h.holderId).map(p => (
              <li key={p.paymentId} className="boe-cj-row">
                <div className="boe-cj-row-main">
                  <div className="boe-cj-row-title">
                    <strong style={{ fontWeight: 600 }}>{p.humanPaymentId ?? 'Payment'}</strong> · {p.clientName ?? 'Suspense'}
                  </div>
                  <div className="boe-cj-row-sub">
                    {paymentModeLabel(p.paymentMode)}{p.paymentDate ? ` · paid ${formatFullDate(p.paymentDate)}` : ''}
                  </div>
                </div>
                <div className="boe-cj-row-amount">{formatINR(p.amount)}</div>
                <div className="boe-cj-row-status"><CashStateChip payment={p} quiet /></div>
                <CashPaymentActions payment={p} onHandOver={() => setHandOverOpen(true)} quietJourney />
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
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div className="boe-cj-seg" role="tablist" aria-label="Handover history">
          {HISTORY_TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === tab}
              onClick={() => { setTab(t.key); setPage(0) }}>
              {t.label}
            </button>
          ))}
        </div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: '#4C5352', cursor: 'pointer' }}>
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
        <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 14, color: '#686D6C' }}>
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
