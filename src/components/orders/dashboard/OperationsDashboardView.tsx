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
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, MessageSquare, X } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  formatDate,
  formatInstantIst,
  formatRange,
  formatRupees,
  formatWaiting,
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
  NOT_ALIGNED_FILTER_LABEL,
  describeAnswerFailure,
  dispatchGapNotes,
  emptyDraft,
  lateLabel,
  notAlignedStatus,
  responseSummary,
  responseTone,
  tally,
  waitShare,
  type ChangeDecision,
  type ChangeResponse,
  type DraftAnswers,
  type OperationsRead,
  type OrdersVsDispatches,
  type PendingChange,
} from '@/lib/orders/operationsDashboard'
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
    <section className="ops-section" aria-label="Changes to review">
      <p className="ops-tab-hint">Approved by the approver after the customer asked.</p>
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
//
// A table, not a list: order and client, a short status, salesperson, due date, value, and how long
// it has waited (with a bar against the longest wait). The whole row opens the order. Filter chips
// appear only for a reason that has orders behind it. Nothing is computed here beyond layout: who an
// order waits on, and since when, are the database's answers.

function NotAlignedSection({ summary, read }: { summary: DashboardSummary; read: OperationsRead }) {
  const router = useRouter()
  const [filter, setFilter] = useState<string>('all')
  const rows = summary.notAligned
  const chips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) {
      const f = notAlignedStatus(r).filter
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    return [...counts.entries()]
  }, [rows])
  const active = filter === 'all' || chips.some(([k]) => k === filter) ? filter : 'all'
  const shown = active === 'all' ? rows : rows.filter(r => notAlignedStatus(r).filter === active)
  const longest = rows.reduce((m, r) => Math.max(m, r.waitingSeconds), 0)

  return (
    <section className="ops-section" aria-label="Not aligned for manufacturing">
      <p className="ops-tab-hint">Longest waiting first.</p>
      {rows.length === 0 ? (
        <p className="ops-empty">Every running order is aligned for manufacturing.</p>
      ) : (
        <div className="ops-na">
          {chips.length > 1 ? (
            <div className="ops-na-filters" role="group" aria-label="Filter by status">
              <button type="button" className="ops-na-chip" aria-pressed={active === 'all'} onClick={() => setFilter('all')}>All {rows.length}</button>
              {chips.map(([k, n]) => (
                <button key={k} type="button" className="ops-na-chip" aria-pressed={active === k} onClick={() => setFilter(k)}>
                  {NOT_ALIGNED_FILTER_LABEL[k] ?? k} {n}
                </button>
              ))}
            </div>
          ) : null}
          <table className="ops-na-table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Status</th>
                <th scope="col">Salesperson</th>
                <th scope="col">Due</th>
                <th scope="col" className="ops-r">Value</th>
                <th scope="col" className="ops-r">Waiting</th>
                <th scope="col"><span className="ops-sr">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const st = notAlignedStatus(r)
                const d = read.orderDetails[r.orderId]
                const late = lateLabel(d?.dueDate ?? null, read.today)
                const open = () => router.push(withReturnTo(`/orders/${r.orderId}`, '/orders'))
                return (
                  <tr key={r.orderId} className="ops-na-row" onClick={open}>
                    <td data-label="Order">
                      <OrderLink orderId={r.orderId}>{r.displayNumber}</OrderLink>
                      <span className="ops-na-client">{r.clientName || 'Client not recorded'}</span>
                    </td>
                    <td data-label="Status">
                      <span className="ops-status" data-tone={st.tone} title={r.detail ?? undefined}>{st.label}</span>
                    </td>
                    <td data-label="Salesperson" className="ops-na-sp">{d?.salesperson ?? '—'}</td>
                    <td data-label="Due" className="ops-na-due">
                      {d?.dueDate ? formatDate(d.dueDate) : '—'}
                      {late ? <span className="ops-late">{late}</span> : null}
                    </td>
                    <td data-label="Value" className="ops-r ops-na-value">{d?.value != null ? formatRupees(d.value) : '—'}</td>
                    <td data-label="Waiting" className="ops-r ops-na-wait">
                      <span className="ops-na-time">{formatWaiting(r.waitingSeconds)}</span>
                      <span className="ops-wbar" aria-hidden="true"><i style={{ width: `${waitShare(r.waitingSeconds, longest)}%` }} /></span>
                    </td>
                    <td className="ops-na-go" aria-hidden="true">›</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
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

type OpsTab = 'changes' | 'aligned'

export function OperationsDashboardView({ summary, read, supabase, onAnswered, readOnlyReason }: {
  summary: DashboardSummary
  read: OperationsRead
  supabase: SupabaseClient
  onAnswered: () => void
  readOnlyReason: string | null
}) {
  const ov = summary.overview
  const revenue = summary.revenue
  const [picked, setPicked] = useState<OpsTab | null>(null)
  const counts = { changes: read.pending.length, aligned: summary.notAligned.length }
  // Opens on what needs an answer; otherwise on what is waiting for alignment.
  const active: OpsTab = picked ?? (counts.changes > 0 ? 'changes' : 'aligned')
  const tabs: { key: OpsTab; label: string }[] = [
    { key: 'changes', label: 'Changes to review' },
    { key: 'aligned', label: 'Not aligned for manufacturing' },
  ]

  return (
    <div className="od-stack">
      <section className="ops-tabs-wrap" aria-label="Orders that need Operations">
        <div className="ops-tabs-bar">
          <div className="ops-tabs" role="tablist" aria-label="Operations lists">
            {tabs.map(t => (
              <button
                key={t.key} type="button" role="tab" id={`ops-tab-${t.key}`}
                aria-selected={active === t.key} aria-controls={`ops-panel-${t.key}`}
                className="ops-tab" data-active={active === t.key ? 'true' : undefined}
                onClick={() => setPicked(t.key)}
              >
                {t.label}
                <span className="ops-tab-count" data-zero={counts[t.key] === 0 ? 'true' : undefined}>{counts[t.key]}</span>
              </button>
            ))}
          </div>
          {ov ? (
            <span className="ops-running">
              {plural(ov.running.orders, 'running order')}
              {ov.running.value > 0 ? ` · ${formatRupees(ov.running.value)}` : ''}
            </span>
          ) : null}
        </div>
        <div id={`ops-panel-${active}`} role="tabpanel" aria-labelledby={`ops-tab-${active}`} className="ops-tab-panel">
          {active === 'changes' ? (
            <ChangesToReview items={read.pending} supabase={supabase} onAnswered={onAnswered} readOnlyReason={readOnlyReason} />
          ) : (
            <NotAlignedSection summary={summary} read={read} />
          )}
        </div>
      </section>

      <OrdersVsDispatchesSection read={read} />
      {revenue ? <RevenueSection revenue={revenue} /> : null}
      <OperationsResponses responses={read.responses} title="Your recent answers" />
      <p className="ops-foot">As of {formatDate(read.today)}</p>
    </div>
  )
}
