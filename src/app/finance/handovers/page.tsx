'use client'

// ── /finance/handovers — Cash journeys ───────────────────────────────────────
//
// THE FOUNDERS' BOARD for every PNB, Paytm and Canara payment: money that does
// not land in an HDFC account is carried by people until it reaches a company
// cash custodian (admin setting; Nitish Bansal today). This page is where that
// is tracked so that no trail can be missed.
//
// FOUR FIGURES, ONE BOARD.
//   * Outside the company    — every tracked payment not yet with a custodian,
//                              grouped by who holds it (the default list);
//   * Needs attention        — the ones that are late, overdue or flagged, most
//                              urgent first, each with its reason in words;
//   * Waiting for acceptance — handovers offered and not yet accepted;
//   * Reached the company    — what arrived, newest first, with when and how
//                              long it took.
// Each figure is a button that narrows the board. A second tab, Handover log,
// lists every handover (open or closed) with its status.
//
// EVERY ROW says where the money is, how long it has been there, who recorded
// the payment, whether Finance has verified it, and what is wrong — and opens
// its full trail inline. Colour is never the only signal.
//
// Reads: finance_unclosed_funds (the database decides the scope: everyone's
// for admins, custodians and finance.view_all, otherwise the viewer's own),
// the payment records under RLS (recorder, verification, Order),
// finance_payment_custody_status for the records that are NOT in the unclosed
// list (that is how "Reached the company" is found with no new RPC),
// finance_payment_journey per opened trail, finance_handover_list for the log.
// NOTHING HERE AUTHORIZES ANYTHING: every action button is drawn from the
// server's can_* flags and re-checked when pressed.
//
// It sits inside src/app/finance/layout.tsx, so ModuleGuard has already decided
// Finance entry. Open handovers the viewer is part of are also drawn by
// HandoverBanner above this page, as on every Finance page (owner's rule).

import { Suspense, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { HandoverCard } from '@/components/finance/HandoverCard'
import { HandoverModal } from '@/components/finance/HandoverModal'
import { CashStateChip } from '@/components/finance/CashStateChip'
import { CashPaymentActions } from '@/components/finance/CashPaymentActions'
import { CustodiansSetting } from '@/components/finance/CustodiansSetting'
import { FinanceEmpty, FinancePerson } from '@/app/finance/components/FinanceListParts'
import { PaymentIdChip } from '@/app/finance/components/PaymentIdChip'
import { HANDOVERS_KEY, useHandoverHistory } from '@/hooks/queries/useHandovers'
import {
  usePaymentCustodyStatus,
  usePaymentJourney,
  useTrackedPaymentRecords,
  useUnclosedFunds,
} from '@/hooks/queries/useCashJourneys'
import { useSignedInUserId, usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { formatINR } from '@/lib/currency'
import { formatDateTime, formatFullDate } from '@/lib/ui'
import { paymentModeLabel } from '@/lib/finance/paymentEntry'
import {
  totalsByHolder,
  waitingAge,
  type CashPayment,
  type JourneyStepKind,
} from '@/lib/finance/cashJourney'
import {
  TRACKED_RECORDS_LIMIT,
  VERIFICATION_LABEL,
  ageTone,
  boardSummary,
  daysBetween,
  handoverMatches,
  plural,
  rowMatches,
  sortByAttention,
  sortByReached,
  toBoardRows,
  trailStepLabel,
  type BoardRow,
  type BoardSummary,
  type VerificationState,
} from '@/lib/finance/cashJourneyBoard'

const PAGE_SIZE = 25

type PaymentView = 'outside' | 'attention' | 'waiting' | 'reached'
type Board = 'payments' | 'log'

const PAYMENT_VIEWS: readonly PaymentView[] = ['outside', 'attention', 'waiting', 'reached']

const HISTORY_TABS = [
  { key: 'all',       label: 'Everything',   statuses: null },
  { key: 'open',      label: 'Waiting',      statuses: ['pending'] },
  { key: 'accepted',  label: 'Accepted',     statuses: ['accepted'] },
  // "Not received" (stored as 'disputed') is final since 20270418000000.
  { key: 'disputed',  label: 'Not received', statuses: ['disputed'] },
  { key: 'cancelled', label: 'Cancelled',    statuses: ['cancelled'] },
  { key: 'closed',    label: 'Closed',       statuses: ['accepted', 'disputed', 'cancelled'] },
] as const

/** Verification, in the Finance list's own pill tones. */
const VERIFY_TONE: Record<VerificationState, string> = {
  verified: 'full', not_verified: 'zero', clarification: 'partial', unknown: 'neutral',
}

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
  const { role } = usePermissionContext()

  const initialView = params.get('view')
  const [board, setBoard] = useState<Board>(initialView === 'log' ? 'log' : 'payments')
  const [view, setView] = useState<PaymentView>(
    (PAYMENT_VIEWS as readonly string[]).includes(initialView ?? '') ? initialView as PaymentView : 'outside')
  const [holderFilter, setHolderFilter] = useState<string | null>(params.get('holder'))
  const [query, setQuery] = useState('')
  const [handOverOpen, setHandOverOpen] = useState(false)

  const unclosedQ = useUnclosedFunds(true)
  const recordsQ = useTrackedPaymentRecords(true)

  // The records that are not in the unclosed list are the ones that may have
  // reached the company; their cash state is asked once both reads are in, so
  // the question is asked once, not twice.
  const unclosedIds = useMemo(() => new Set((unclosedQ.data?.payments ?? []).map(p => p.paymentId)), [unclosedQ.data])
  const closedCandidateIds = useMemo(
    () => (unclosedQ.isSuccess && recordsQ.isSuccess
      ? (recordsQ.data ?? []).filter(r => !unclosedIds.has(r.paymentId)).map(r => r.paymentId)
      : []),
    [unclosedQ.isSuccess, recordsQ.isSuccess, recordsQ.data, unclosedIds],
  )
  const statesQ = usePaymentCustodyStatus(closedCandidateIds)

  const recordMap = useMemo(() => new Map((recordsQ.data ?? []).map(r => [r.paymentId, r])), [recordsQ.data])
  const unclosedRows = useMemo(
    () => toBoardRows(unclosedQ.data?.payments ?? [], recordMap),
    [unclosedQ.data, recordMap],
  )
  const reachedRows = useMemo(() => {
    const arrived = [...(statesQ.data?.values() ?? [])].filter(p => p.state === 'with_company')
    return sortByReached(toBoardRows(arrived, recordMap))
  }, [statesQ.data, recordMap])
  const summary = useMemo(() => boardSummary(unclosedRows, reachedRows), [unclosedRows, reachedRows])

  const custodianNames = (unclosedQ.data?.custodians ?? []).map(c => c.fullName).join(' or ') || 'the company'
  const scopeMine = unclosedQ.data?.scope === 'mine'
  const reachedReady = statesQ.isSuccess || (unclosedQ.isSuccess && recordsQ.isSuccess && closedCandidateIds.length === 0)

  const handleSignOut = async () => {
    await createClient().auth.signOut()
    router.replace('/login')
  }

  const pick = (v: PaymentView) => { setBoard('payments'); setView(v); if (v !== 'outside') setHolderFilter(null) }

  return (
    <FinanceLayout
      profile={null}
      title="Cash journeys"
      subtitle="Every PNB, Paytm and Canara payment, from the person who collected it until it reaches the company"
      onSignOut={handleSignOut}
      onRefresh={async () => { await queryClient.invalidateQueries({ queryKey: HANDOVERS_KEY }) }}
    >
      <Figures summary={summary} ready={unclosedQ.isSuccess} reachedReady={reachedReady} board={board} view={view} onPick={pick} />
      {scopeMine && (
        <p className="boe-cj-note">Showing only the cash you hold or must accept. Administrators and the people who receive cash for the company see everyone&apos;s.</p>
      )}

      <section className="fin-board boe-cj-board" aria-label="Cash journeys">
        <div className="fin-viewbar">
          <div className="fin-tabs" role="tablist" aria-label="Board">
            <button type="button" role="tab" className="fin-tab" aria-selected={board === 'payments'} onClick={() => setBoard('payments')}>
              Payments
              {unclosedQ.isSuccess && <span className="fin-tab-count">{summary.outside.count}</span>}
            </button>
            <button type="button" role="tab" className="fin-tab" aria-selected={board === 'log'} onClick={() => setBoard('log')}>
              Handover log
            </button>
          </div>
          <div className="fin-tools" role="search" aria-label="Search">
            <label className="boe-list-search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#686D6C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                aria-label={board === 'log' ? 'Search handovers' : 'Search payments'}
                placeholder={board === 'log' ? 'Handover, person or Payment ID' : 'Payment ID, client, person or Order'}
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>
              )}
            </label>
          </div>
        </div>

        {board === 'payments' ? (
          <PaymentsBoard
            view={view}
            unclosed={unclosedRows}
            reached={reachedRows}
            query={query}
            holderFilter={holderFilter}
            onClearHolder={() => setHolderFilter(null)}
            custodianNames={custodianNames}
            loading={unclosedQ.isPending || (view === 'reached' && !reachedReady && !recordsQ.isError && !statesQ.isError)}
            error={unclosedQ.isError ? 'This list could not be loaded.'
              : view === 'reached' && (recordsQ.isError || statesQ.isError) ? 'The payments that reached the company could not be loaded.'
              : null}
            retry={() => { void unclosedQ.refetch(); void recordsQ.refetch(); void statesQ.refetch() }}
            recordsMissing={recordsQ.isError && view !== 'reached'}
            recordsCapped={(recordsQ.data?.length ?? 0) >= TRACKED_RECORDS_LIMIT}
            onHandOver={() => setHandOverOpen(true)}
          />
        ) : (
          <HandoverLog query={query} />
        )}
      </section>

      {unclosedQ.data && <CustodiansSetting current={unclosedQ.data.custodians} isAdmin={role === 'admin'} />}
      {handOverOpen && <HandoverModal onClose={() => setHandOverOpen(false)} />}
    </FinanceLayout>
  )
}

// ── The four figures ─────────────────────────────────────────────────────────

function Figures({ summary: s, ready, reachedReady, board, view, onPick }: {
  summary: BoardSummary
  ready: boolean
  reachedReady: boolean
  board: Board
  view: PaymentView
  onPick: (v: PaymentView) => void
}) {
  const pressed = (v: PaymentView) => board === 'payments' && view === v
  return (
    <div className="fin-stats" role="group" aria-label="Cash journeys at a glance">
      <Figure tone="zero" pressed={pressed('outside')} onClick={() => onPick('outside')}
        label="Outside the company"
        value={ready ? formatINR(s.outside.amount) : '—'}
        sub={ready ? `${plural(s.outside.count, 'payment')} · ${plural(s.outside.people, 'person', 'people')}` : 'loading'} />
      <Figure tone="over" alert={ready && s.attention.count > 0} pressed={pressed('attention')} onClick={() => onPick('attention')}
        label="Needs attention"
        value={ready ? String(s.attention.count) : '—'}
        sub={!ready ? 'loading' : s.attention.count === 0 ? 'nothing is stuck'
          : s.attention.overdue > 0 ? `${plural(s.attention.overdue, 'payment')} overdue` : 'late or flagged'} />
      <Figure tone="partial" pressed={pressed('waiting')} onClick={() => onPick('waiting')}
        label="Waiting for acceptance"
        value={ready ? formatINR(s.waiting.amount) : '—'}
        sub={ready ? `${plural(s.waiting.count, 'payment')} offered, not yet accepted` : 'loading'} />
      <Figure tone="full" pressed={pressed('reached')} onClick={() => onPick('reached')}
        label="Reached the company"
        value={reachedReady ? formatINR(s.reached.amount) : '—'}
        sub={reachedReady ? `${plural(s.reached.count, 'payment')} in the last ${s.reached.days} days` : 'loading'} />
    </div>
  )
}

function Figure({ tone, label, value, sub, pressed, onClick, alert = false }: {
  tone: 'zero' | 'partial' | 'full' | 'over'
  label: string
  value: string
  sub: string
  pressed: boolean
  onClick: () => void
  alert?: boolean
}) {
  return (
    <button type="button" className={`fin-stat${alert ? ' boe-cj-stat--alert' : ''}`} aria-pressed={pressed} onClick={onClick}>
      <span className="fin-stat-label">
        <span aria-hidden="true" className={`fin-dot fin-dot--${tone}`} />
        {label}
      </span>
      <span className="fin-stat-value" style={{ display: 'block' }}>{value}</span>
      <span className="fin-stat-sub" style={{ display: 'block' }}>{sub}</span>
    </button>
  )
}

// ── The payments board ───────────────────────────────────────────────────────

function PaymentsBoard({
  view, unclosed, reached, query, holderFilter, onClearHolder, custodianNames,
  loading, error, retry, recordsMissing, recordsCapped, onHandOver,
}: {
  view: PaymentView
  unclosed: BoardRow[]
  reached: BoardRow[]
  query: string
  holderFilter: string | null
  onClearHolder: () => void
  custodianNames: string
  loading: boolean
  error: string | null
  retry: () => void
  recordsMissing: boolean
  recordsCapped: boolean
  onHandOver: () => void
}) {
  const q = query.trim()

  const rows = useMemo(() => {
    const base = view === 'reached' ? reached
      : view === 'attention' ? sortByAttention(unclosed.filter(r => r.flags.length > 0))
      : view === 'waiting' ? [...unclosed.filter(r => r.payment.state === 'waiting')]
          .sort((a, b) => Date.parse(a.payment.openHandover?.createdAt ?? '') - Date.parse(b.payment.openHandover?.createdAt ?? ''))
      : unclosed
    return q ? base.filter(r => rowMatches(r, q)) : base
  }, [view, unclosed, reached, q])

  const holders = useMemo(() => totalsByHolder(rows.map(r => r.payment)), [rows])
  const shownHolders = holderFilter ? holders.filter(h => h.holderId === holderFilter) : holders
  const filteredHolderName = holderFilter ? holders.find(h => h.holderId === holderFilter)?.holderName ?? null : null
  const total = rows.reduce((acc, r) => acc + Math.round(r.payment.amount * 100), 0) / 100

  const head: Record<PaymentView, { title: string; rule: string }> = {
    outside:   { title: 'Outside the company', rule: `Every PNB, Paytm and Canara payment that has not reached ${custodianNames}, by who holds it. Oldest first within a person.` },
    attention: { title: 'Needs attention', rule: 'Late, overdue or flagged journeys, most urgent first. Each row says why.' },
    waiting:   { title: 'Waiting for acceptance', rule: 'Handovers offered and not yet accepted. The cash stays with the giver until the receiver accepts.' },
    reached:   { title: 'Reached the company', rule: `Payments whose money reached ${custodianNames}, newest arrival first.` },
  }

  return (
    <>
      <div className="boe-cj-viewhead">
        <strong>{head[view].title}</strong>
        <span>{head[view].rule}</span>
        {view === 'outside' && filteredHolderName && (
          <span className="boe-cj-viewhead-filter">
            Only {filteredHolderName} ·{' '}
            <button type="button" className="boe-cj-link" onClick={onClearHolder}>Show everyone</button>
          </span>
        )}
        {rows.length > 0 && <span className="boe-cj-viewhead-count">{plural(rows.length, 'payment')} · {formatINR(total)}</span>}
      </div>

      {recordsMissing && (
        <div className="boe-cj-warning" role="status">
          Who recorded each payment and whether Finance verified it could not be loaded.{' '}
          <button type="button" className="boe-cj-link" onClick={retry}>Try again</button>
        </div>
      )}

      {loading && <div className="boe-cj-loading">Loading…</div>}

      {!loading && error && (
        <div className="boe-cj-error-wrap">
          <div className="boe-handover-error" role="alert">
            {error}{' '}
            <button type="button" className="boe-btn boe-btn-secondary" onClick={retry}>Try again</button>
          </div>
        </div>
      )}

      {!loading && !error && rows.length === 0 && <EmptyView view={view} query={q} custodianNames={custodianNames} />}

      {!loading && !error && rows.length > 0 && view === 'outside' && shownHolders.map(h => (
        <section key={h.holderId} aria-label={`With ${h.holderName}`}>
          <header className="boe-cj-group">
            <h2>With {h.holderName}</h2>
            <span>
              {plural(h.count, 'payment')} · oldest{' '}
              <span className={`boe-cj-age boe-cj-age--${ageTone(h.oldestAgeHours)}`}>{waitingAge(h.oldestAgeHours)}</span>
            </span>
            <span className="boe-cj-group-total">{formatINR(h.amount)}</span>
          </header>
          <ul className="boe-cj-rows">
            {rows.filter(r => (r.payment.holderId ?? 'unknown') === h.holderId).map(r => (
              <PaymentRow key={r.payment.paymentId} row={r} view={view} onHandOver={onHandOver} />
            ))}
          </ul>
        </section>
      ))}

      {!loading && !error && rows.length > 0 && view !== 'outside' && (
        <ul className="boe-cj-rows">
          {rows.map(r => <PaymentRow key={r.payment.paymentId} row={r} view={view} onHandOver={onHandOver} />)}
        </ul>
      )}

      {view === 'reached' && !loading && !error && (
        <div className="fin-footer">
          <span>
            {recordsCapped
              ? `The latest ${TRACKED_RECORDS_LIMIT} tracked payments were read; older arrivals are not listed here.`
              : 'Every tracked payment that reached the company is listed.'}
          </span>
          {rows.some(r => r.verification === 'not_verified') && (
            <span>{plural(rows.filter(r => r.verification === 'not_verified').length, 'payment')} not verified by Finance yet</span>
          )}
        </div>
      )}
    </>
  )
}

function EmptyView({ view, query, custodianNames }: { view: PaymentView; query: string; custodianNames: string }) {
  if (query) {
    return <FinanceEmpty icon="search" title={`Nothing matches “${query}”`} body="Try a Payment ID, a client, a person or an Order number." />
  }
  switch (view) {
    case 'outside':
      return <FinanceEmpty icon="check" title="Everything has reached the company" body="No PNB, Paytm or Canara payment is outside the company right now." />
    case 'attention':
      return <FinanceEmpty icon="check" title="Nothing needs attention" body="No journey is late, overdue or flagged." />
    case 'waiting':
      return <FinanceEmpty icon="check" title="No cash is waiting to be accepted" body="Every handover offered has been answered." />
    case 'reached':
      return <FinanceEmpty icon="box" title="No tracked payment has reached the company yet" body={`A journey closes when ${custodianNames} accepts or receives the cash.`} />
  }
}

// ── One payment ──────────────────────────────────────────────────────────────

function PaymentRow({ row, view, onHandOver }: { row: BoardRow; view: PaymentView; onHandOver: () => void }) {
  const [open, setOpen] = useState(false)
  const p = row.payment
  const r = row.record
  const handoverHours = row.handoverHours
  const tookDays = view === 'reached' ? daysBetween(r?.paymentDate ?? p.paymentDate, p.holderSince) : null

  const toggle = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, label')) return
    setOpen(v => !v)
  }

  return (
    <li className={`boe-cj-row${open ? ' is-open' : ''}`}>
      <div className="boe-cj-main" onClick={toggle}>
        <div className="boe-cj-cell boe-cj-id">
          <PaymentIdChip>{p.humanPaymentId}</PaymentIdChip>
          <span className="boe-cj-client">{p.clientName ?? 'Suspense'}{r?.orderNumber ? ` · ${r.orderNumber}` : ''}</span>
        </div>
        <div className="boe-cj-cell boe-cj-amount">{formatINR(p.amount)}</div>
        <div className="boe-cj-cell boe-cj-route">
          <span>{paymentModeLabel(p.paymentMode)}</span>
          <span className="boe-cj-sub">{p.paymentDate ? `paid ${formatFullDate(p.paymentDate)}` : 'paid date not given'}</span>
        </div>
        <div className="boe-cj-cell boe-cj-recorded">
          <FinancePerson name={r?.recordedByName} />
          <span className="boe-cj-sub">{p.recordedAt ? `recorded ${formatFullDate(p.recordedAt)}` : ''}</span>
        </div>
        <div className="boe-cj-cell boe-cj-where">
          {view === 'reached' ? (
            <>
              <span className="boe-cj-state boe-cj-state--company">
                <CheckCircle2 size={13} strokeWidth={2} aria-hidden="true" /> With {p.holderName ?? 'the company'}
              </span>
              <span className="boe-cj-sub">
                since {p.holderSince ? formatDateTime(p.holderSince) : '—'}
                {tookDays !== null ? ` · ${tookDays <= 0 ? 'the day it was paid' : `${plural(tookDays, 'day')} after payment`}` : ''}
              </span>
            </>
          ) : (
            <>
              <CashStateChip payment={{ ...p, orderException: null }} quiet showAge={false} />
              <span className={`boe-cj-sub boe-cj-age boe-cj-age--${ageTone(p.state === 'waiting' ? handoverHours : p.ageHours)}`}>
                {p.state === 'waiting'
                  ? `offered ${waitingAge(handoverHours ?? 0)} ago · with ${p.openHandover?.giverName ?? p.holderName ?? 'the giver'} for ${waitingAge(p.ageHours)}`
                  : `for ${waitingAge(p.ageHours)}`}
              </span>
            </>
          )}
        </div>
        <div className="boe-cj-cell boe-cj-verify">
          <span className={`fin-pill fin-pill--${VERIFY_TONE[row.verification]}`}>{VERIFICATION_LABEL[row.verification]}</span>
        </div>
        <div className="boe-cj-cell boe-cj-actions">
          <CashPaymentActions payment={p} onHandOver={onHandOver} hideJourney />
          <button type="button" className="boe-cj-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
            {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            Trail
          </button>
        </div>
      </div>

      {row.flags.length > 0 && (
        <ul className="boe-cj-flags" aria-label="What needs attention">
          {row.flags.map(f => <li key={f.kind} className={`boe-cj-flag boe-cj-flag--${f.severity}`}>{f.text}</li>)}
        </ul>
      )}

      {open && <Trail payment={p} />}
    </li>
  )
}

const STEP_TONE: Record<JourneyStepKind, 'good' | 'bad' | 'neutral' | 'open'> = {
  recorded: 'neutral',
  collected: 'neutral',
  handed_over: 'good',
  received_directly: 'good',
  handover_created: 'open',
  handover_accepted: 'good',
  handover_disputed: 'bad',
  handover_cancelled: 'bad',
}

/** The full trail of one payment, inline under its row. */
function Trail({ payment: p }: { payment: CashPayment }) {
  const q = usePaymentJourney(p.paymentId)
  const journey = q.data ?? null
  return (
    <div className="boe-cj-trail" aria-label={`Trail of ${p.humanPaymentId ?? 'this payment'}`}>
      {q.isPending && <div className="boe-cj-sub">Loading the trail…</div>}
      {q.isError && <div className="boe-handover-error" role="alert">The trail could not be loaded.</div>}
      {q.data === null && !q.isPending && <div className="boe-cj-sub">This trail is not available to you.</div>}
      {journey && (
        <ol className="boe-cj-steps">
          {journey.steps.map((s, i) => (
            <li key={i} className={`boe-cj-step boe-cj-step--${STEP_TONE[s.kind]}`}>
              <div>{trailStepLabel(s, journey.steps)}</div>
              <div className="boe-cj-sub">
                {s.at ? formatDateTime(s.at) : ''}
                {s.handoverHumanId ? ` · ${s.handoverHumanId}` : ''}
              </div>
              {s.note && <div className="boe-cj-quote">“{s.note}”</div>}
            </li>
          ))}
          {p.state !== 'with_company' && (
            <li className="boe-cj-step boe-cj-step--open">
              <div>
                Now: {p.state === 'waiting' && p.openHandover
                  ? `waiting for ${p.openHandover.recipientName} to accept`
                  : `with ${p.holderName ?? 'someone'}, not yet with the company`}
              </div>
            </li>
          )}
        </ol>
      )}
      {p.orderException && p.state !== 'with_company' && (
        <div className="boe-cj-exception">
          <strong>Order approved without this cash</strong>
          {p.orderException.byName ? ` by ${p.orderException.byName}` : ''}
          {p.orderException.at ? ` on ${formatDateTime(p.orderException.at)}` : ''}: “{p.orderException.reason}”
        </div>
      )}
    </div>
  )
}

// ── The handover log ─────────────────────────────────────────────────────────

function HandoverLog({ query }: { query: string }) {
  const { data: userId } = useSignedInUserId()
  const [tab, setTab] = useState<typeof HISTORY_TABS[number]['key']>('all')
  const [page, setPage] = useState(0)

  const active = HISTORY_TABS.find(t => t.key === tab) ?? HISTORY_TABS[0]
  // Everyone's where the database allows it (admins, finance.view_all); the
  // RPC answers with the viewer's own otherwise, so nothing is ever over-shown.
  const history = useHandoverHistory(active.statuses ? [...active.statuses] : null, false, page, PAGE_SIZE)
  const rows = history.data ?? []
  const hasNext = rows.length > PAGE_SIZE
  const q = query.trim()
  const visible = rows.slice(0, PAGE_SIZE).filter(h => handoverMatches(h, q))

  return (
    <div className="boe-cj-log">
      <div className="boe-cj-log-bar">
        <div className="boe-cj-seg" role="tablist" aria-label="Handover status">
          {HISTORY_TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === tab}
              onClick={() => { setTab(t.key); setPage(0) }}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="boe-cj-sub">Every handover: who gave it, who received it, and what they said.</span>
      </div>

      {history.isPending && <div className="boe-cj-loading">Loading…</div>}
      {history.isError && (
        <div className="boe-handover-error" role="alert">
          Handovers could not be loaded.{' '}
          <button type="button" className="boe-btn boe-btn-secondary" onClick={() => void history.refetch()}>Try again</button>
        </div>
      )}
      {history.data && visible.length === 0 && (
        q
          ? <FinanceEmpty icon="search" title={`Nothing matches “${q}”`} body="Try a handover number, a person or a Payment ID." />
          : <FinanceEmpty icon="box" title="No handovers here yet" body="A handover appears here the moment somebody hands cash to somebody else." />
      )}

      <div className="boe-handover-stack">
        {visible.map(h => <HandoverCard key={h.id} handover={h} viewerId={userId ?? null} />)}
      </div>

      {(page > 0 || hasNext) && (
        <div className="boe-cj-pager">
          <button type="button" className="boe-btn boe-btn-secondary" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="boe-btn boe-btn-secondary" disabled={!hasNext} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
