'use client'

// THE OPERATIONS TEAM'S ORDERS DASHBOARD (20270401000000).
//
//   Running · Not aligned · Changes to answer · Revenue this month      (one strip)
//   Changes to review   — a revised PI on an order already in production, line by
//                         line: ✔ can do · ✖ cannot do · ? needs discussion
//   Not aligned for manufacturing
//   Orders and dispatches — last month, last six months
//   Revenue
//
// The answers are ADVICE to the approver and never touch the order: it stays aligned
// whatever is answered. Nothing is computed here — the database sent every figure.

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, MessageSquare, X } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  formatDate,
  formatInstantIst,
  formatRange,
  formatRupees,
  plural,
  type DashboardSummary,
} from '@/lib/orders/orderDashboardSummary'
import {
  BULK_NOTE_PLACEHOLDER,
  CHANGES_STAY_ALIGNED_NOTE,
  CHANGES_UNAVAILABLE_NOTE,
  DECISION_LABEL,
  DECISION_SYMBOL,
  NOTE_PLACEHOLDER,
  ORDERS_BASIS_NOTE,
  ORDERS_VS_DISPATCHES_TITLE,
  applyToAll,
  buildAnswers,
  changeText,
  describeAnswerFailure,
  dispatchGapNotes,
  emptyDraft,
  responseSummary,
  responseTone,
  tally,
  type ChangeDecision,
  type ChangeResponse,
  type DraftAnswers,
  type OperationsRead,
  type OrdersVsDispatches,
  type PendingChange,
} from '@/lib/orders/operationsDashboard'
import { boardRows } from '@/components/orders/dashboard/OverviewSection'
import { RevenueSection } from '@/components/orders/dashboard/RevenueSection'

const DECISIONS: readonly ChangeDecision[] = ['can_do', 'cannot_do', 'discuss']

function DecisionIcon({ d }: { d: ChangeDecision }) {
  if (d === 'can_do') return <Check size={14} strokeWidth={2.4} aria-hidden="true" />
  if (d === 'cannot_do') return <X size={14} strokeWidth={2.4} aria-hidden="true" />
  return <MessageSquare size={13} strokeWidth={2.2} aria-hidden="true" />
}

function OrderLink({ orderId, children }: { orderId: string; children: ReactNode }) {
  return (
    <Link href={withReturnTo(`/orders/${orderId}`, '/orders')} className="od-order-link" prefetch={false}>
      {children}
    </Link>
  )
}

// ── One revised PI, answered line by line ───────────────────────────────────

function PendingChangeCard({ item, supabase, onAnswered, readOnlyReason }: {
  item: PendingChange
  supabase: SupabaseClient
  onAnswered: () => void
  readOnlyReason: string | null
}) {
  const [draft, setDraft] = useState<DraftAnswers>(() => emptyDraft(item.lines))
  const [bulkNote, setBulkNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const counts = useMemo(() => tally(draft), [draft])
  const needsNote = counts.cannotDo + counts.discuss > 0

  const choose = (key: string, d: ChangeDecision) => {
    setError(null)
    setDraft(prev => ({ ...prev, [key]: { ...prev[key], decision: d } }))
  }
  const setNote = (key: string, note: string) => setDraft(prev => ({ ...prev, [key]: { ...prev[key], note } }))

  const send = async () => {
    const built = buildAnswers(item.lines, draft, bulkNote)
    if (!built.ok) { setError(built.message); return }
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('answer_order_pi_changes', {
      p_handoff_id: item.handoffId,
      p_answers: built.answers,
    })
    setBusy(false)
    if (rpcError) { setError(describeAnswerFailure(rpcError)); return }
    onAnswered()
  }

  return (
    <article className="ops-change" aria-label={`Changes to order ${item.displayNumber}`}>
      <header className="ops-change-head">
        <div className="ops-change-id">
          <OrderLink orderId={item.orderId}>{item.displayNumber}</OrderLink>
          <span className="ops-change-client">{item.clientName || 'Client not recorded'}</span>
          <span className="ops-chip">PI V{item.versionNumber}</span>
        </div>
        <span className="ops-change-when">
          Approved {formatInstantIst(item.approvedAt)}{item.approvedByName ? ` by ${item.approvedByName}` : ''}
        </span>
      </header>
      {item.revisionReason ? <p className="ops-change-reason">“{item.revisionReason}”</p> : null}

      {!item.available || item.lines.length === 0 ? (
        <p className="ops-change-unavailable">
          {CHANGES_UNAVAILABLE_NOTE}{' '}
          <OrderLink orderId={item.orderId}>Open the order</OrderLink>
        </p>
      ) : (
        <>
          <ul className="ops-lines">
            {item.lines.map(line => {
              const d = draft[line.key]
              return (
                <li key={line.key} className="ops-line">
                  <div className="ops-line-what">
                    <span className="ops-line-title">
                      {line.title}
                      {line.kind !== 'changed' ? <span className="ops-chip" data-kind={line.kind}>{line.kind === 'added' ? 'New product' : 'Removed'}</span> : null}
                    </span>
                    <ul className="ops-diffs">
                      {line.changes.map(c => {
                        const t = changeText(c)
                        return (
                          <li key={c.label} className="ops-diff">
                            <span className="ops-diff-label">{c.label}</span>
                            <span className="ops-diff-from">{t.from}</span>
                            <span className="ops-diff-arrow" aria-hidden="true">→</span>
                            <span className="ops-diff-to">{t.to}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                  <div className="ops-seg" role="radiogroup" aria-label={`Your answer for ${line.title}`}>
                    {DECISIONS.map(opt => (
                      <button
                        key={opt} type="button" role="radio"
                        aria-checked={d.decision === opt}
                        aria-label={DECISION_LABEL[opt]} title={DECISION_LABEL[opt]}
                        className="ops-seg-btn" data-decision={opt} data-on={d.decision === opt ? 'true' : undefined}
                        disabled={busy || !!readOnlyReason}
                        onClick={() => choose(line.key, opt)}
                      >
                        <DecisionIcon d={opt} />
                      </button>
                    ))}
                  </div>
                  {d.decision && d.decision !== 'can_do' ? (
                    <input
                      className="ops-line-note" type="text" maxLength={1000} value={d.note}
                      placeholder={bulkNote.trim() ? 'Uses the reason below unless you type one' : NOTE_PLACEHOLDER}
                      aria-label={`Why, for ${line.title}`}
                      disabled={busy}
                      onChange={e => setNote(line.key, e.target.value)}
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>

          <footer className="ops-change-foot">
            <div className="ops-bulk">
              <button type="button" className="ops-bulk-btn" data-decision="can_do" disabled={busy || !!readOnlyReason}
                onClick={() => { setError(null); setDraft(applyToAll(draft, 'can_do')) }}>
                <Check size={14} strokeWidth={2.4} aria-hidden="true" /> Accept all
              </button>
              <button type="button" className="ops-bulk-btn" data-decision="cannot_do" disabled={busy || !!readOnlyReason}
                onClick={() => { setError(null); setDraft(applyToAll(draft, 'cannot_do')) }}>
                <X size={14} strokeWidth={2.4} aria-hidden="true" /> Reject all
              </button>
            </div>
            {needsNote ? (
              <input
                className="ops-bulk-note" type="text" maxLength={1000} value={bulkNote}
                placeholder={BULK_NOTE_PLACEHOLDER} aria-label="One reason for every line without a note"
                disabled={busy} onChange={e => setBulkNote(e.target.value)}
              />
            ) : <span className="ops-bulk-spacer" />}
            <div className="ops-send">
              <span className="ops-tally" aria-live="polite">
                {counts.open > 0 ? `${counts.open} to answer` : `${counts.canDo} ✔ · ${counts.cannotDo} ✖ · ${counts.discuss} ?`}
              </span>
              <button type="button" className="boe-btn boe-btn-primary" disabled={busy || counts.open > 0 || !!readOnlyReason} onClick={send}
                title={readOnlyReason ?? undefined}>
                {busy ? 'Sending…' : 'Send answers'}
              </button>
            </div>
          </footer>
          {error ? <p className="ops-error" role="alert">{error}</p> : null}
        </>
      )}
    </article>
  )
}

export function ChangesToReview({ items, supabase, onAnswered, readOnlyReason }: {
  items: PendingChange[]
  supabase: SupabaseClient
  onAnswered: () => void
  readOnlyReason: string | null
}) {
  return (
    <section className="ops-section" aria-labelledby="ops-changes-h">
      <div className="ops-section-head">
        <h2 id="ops-changes-h" className="ops-section-title">Changes to review</h2>
        <span className="ops-count" data-zero={items.length === 0 ? 'true' : undefined}>{items.length}</span>
        <span className="ops-section-hint">Approved by the approver after the customer asked</span>
      </div>
      {items.length === 0 ? (
        <p className="ops-empty">No changes are waiting for your answer.</p>
      ) : (
        <>
          <p className="ops-note">{CHANGES_STAY_ALIGNED_NOTE}</p>
          <div className="ops-changes">
            {items.map(i => (
              <PendingChangeCard key={i.handoffId} item={i} supabase={supabase} onAnswered={onAnswered} readOnlyReason={readOnlyReason} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

// ── What Operations answered (also drawn on the approver's dashboard) ───────

export function OperationsResponses({ responses, title = 'Operations responses' }: {
  responses: ChangeResponse[]
  title?: string
}) {
  if (responses.length === 0) return null
  return (
    <section className="ops-section" aria-labelledby="ops-resp-h">
      <div className="ops-section-head">
        <h2 id="ops-resp-h" className="ops-section-title">{title}</h2>
        <span className="ops-count">{responses.length}</span>
        <span className="ops-section-hint">Advice on changes to orders in production — the order stays aligned</span>
      </div>
      <ul className="ops-resp-list">
        {responses.map(r => (
          <li key={r.handoffId} className="ops-resp" data-tone={responseTone(r)}>
            <div className="ops-resp-head">
              <OrderLink orderId={r.orderId}>{r.displayNumber}</OrderLink>
              <span className="ops-change-client">{r.clientName || 'Client not recorded'}</span>
              <span className="ops-chip">PI V{r.versionNumber}</span>
              {!r.stillCurrent ? <span className="ops-chip" data-kind="removed">Replaced by a later version</span> : null}
              <span className="ops-resp-sum">{responseSummary(r)}</span>
              <span className="ops-change-when">
                {r.answeredByName ? `${r.answeredByName} · ` : ''}{formatInstantIst(r.answeredAt)}
              </span>
            </div>
            <ul className="ops-resp-lines">
              {r.lines.map(l => (
                <li key={l.key} className="ops-resp-line">
                  <span className="ops-mark" data-decision={l.decision} title={DECISION_LABEL[l.decision]}>
                    <span aria-hidden="true">{DECISION_SYMBOL[l.decision]}</span>
                    <span className="ops-sr">{DECISION_LABEL[l.decision]}</span>
                  </span>
                  <span className="ops-resp-title">{l.title}</span>
                  {l.note ? <span className="ops-resp-note">{l.note}</span> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── Not aligned ─────────────────────────────────────────────────────────────

function NotAlignedSection({ summary }: { summary: DashboardSummary }) {
  const rows = boardRows(summary, 'not_aligned')
  return (
    <section className="ops-section" aria-labelledby="ops-na-h">
      <div className="ops-section-head">
        <h2 id="ops-na-h" className="ops-section-title">Not aligned for manufacturing</h2>
        <span className="ops-count" data-zero={rows.length === 0 ? 'true' : undefined}>{rows.length}</span>
        <span className="ops-section-hint">Longest waiting first</span>
      </div>
      {rows.length === 0 ? (
        <p className="ops-empty">Every running order is aligned for manufacturing.</p>
      ) : (
        <ul className="ops-table">
          {rows.map(r => (
            <li key={r.key} className="ops-row">
              <div className="ops-row-id">
                <OrderLink orderId={r.orderId}>{r.displayNumber}</OrderLink>
                <span className="ops-row-client">{r.clientName || 'Client not recorded'}</span>
              </div>
              <div className="ops-row-what">
                <span className="ops-row-strong">{r.headline}</span>
                <span className="ops-row-sub">{r.sub}</span>
              </div>
              <div className="ops-row-figure" title={r.figureLabel}>
                <span>{r.figure}</span>
                <span className="ops-row-figure-label">{r.figureLabel}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── Orders and dispatches ───────────────────────────────────────────────────

function PeriodPanel({ title, p }: { title: string; p: OrdersVsDispatches }) {
  const top = Math.max(p.orders.value, p.dispatches.value, 1)
  const row = (label: string, f: { count: number; value: number }, kind: 'orders' | 'dispatches') => (
    <div className="ops-period-row">
      <div className="ops-period-label">{label}</div>
      <div className="ops-period-count">{f.count}</div>
      <div className="ops-period-value">{formatRupees(f.value)}</div>
      <div className="ops-period-bar" aria-hidden="true"><span data-kind={kind} style={{ width: `${Math.round((f.value / top) * 100)}%` }} /></div>
    </div>
  )
  return (
    <div className="ops-period">
      <div className="ops-period-head">
        <h3 className="ops-period-title">{title}</h3>
        <span className="ops-period-range">{formatRange(p.from, p.to)}</span>
      </div>
      {row('Orders', p.orders, 'orders')}
      {row('Dispatches', p.dispatches, 'dispatches')}
    </div>
  )
}

function OrdersVsDispatchesSection({ read }: { read: OperationsRead }) {
  const notes = dispatchGapNotes(read.gaps)
  return (
    <section className="ops-section" aria-labelledby="ops-ovd-h">
      <div className="ops-section-head">
        <h2 id="ops-ovd-h" className="ops-section-title" title={ORDERS_BASIS_NOTE}>{ORDERS_VS_DISPATCHES_TITLE}</h2>
        <span className="ops-section-hint">Product value, excl. GST</span>
      </div>
      <div className="ops-periods">
        <PeriodPanel title="Last month" p={read.lastMonth} />
        <PeriodPanel title="Last 6 months" p={read.lastSixMonths} />
      </div>
      {notes.length > 0 ? <ul className="ops-gaps">{notes.map(n => <li key={n}>{n}</li>)}</ul> : null}
    </section>
  )
}

// ── The page ────────────────────────────────────────────────────────────────

export function OperationsDashboardView({ summary, read, supabase, onAnswered, readOnlyReason }: {
  summary: DashboardSummary
  read: OperationsRead
  supabase: SupabaseClient
  onAnswered: () => void
  readOnlyReason: string | null
}) {
  const ov = summary.overview
  const revenue = summary.revenue
  const notAligned = summary.notAligned.length
  const stats = [
    {
      key: 'running', label: 'Running orders',
      value: ov ? String(ov.running.orders) : '—',
      sub: ov ? (ov.running.value > 0 ? `${formatRupees(ov.running.value)} product value` : 'No value on record') : 'Not available yet',
    },
    {
      key: 'not-aligned', label: 'Not aligned', value: String(notAligned),
      sub: notAligned > 0 ? 'Waiting for manufacturing alignment' : 'Every running order is aligned',
      tone: notAligned > 0 ? 'attention' : undefined,
    },
    {
      key: 'changes', label: 'Changes to answer', value: String(read.pending.length),
      sub: read.pending.length > 0 ? plural(read.pending.reduce((n, p) => n + p.lines.length, 0), 'changed line') : 'Nothing waiting',
      tone: read.pending.length > 0 ? 'attention' : undefined,
    },
    {
      key: 'revenue', label: 'Revenue this month',
      value: revenue ? formatRupees(revenue.currentMonth.amount) : '—',
      sub: revenue
        ? `${formatRange(revenue.currentMonth.from, revenue.currentMonth.to)} · ${plural(revenue.currentMonth.orders, 'order')}`
        : 'Not shared with your account',
    },
  ]

  return (
    <div className="od-stack">
      <section className="ops-strip" aria-label="Orders at a glance">
        {stats.map(s => (
          <div key={s.key} className="ops-stat" data-tone={s.tone}>
            <span className="ops-stat-label">{s.label}</span>
            <span className="ops-stat-value">{s.value}</span>
            <span className="ops-stat-sub">{s.sub}</span>
          </div>
        ))}
      </section>

      <ChangesToReview items={read.pending} supabase={supabase} onAnswered={onAnswered} readOnlyReason={readOnlyReason} />
      <NotAlignedSection summary={summary} />
      <OrdersVsDispatchesSection read={read} />
      {revenue ? <RevenueSection revenue={revenue} /> : null}
      <OperationsResponses responses={read.responses} title="Your recent answers" />
      <p className="ops-foot">As of {formatDate(read.today)}</p>
    </div>
  )
}
