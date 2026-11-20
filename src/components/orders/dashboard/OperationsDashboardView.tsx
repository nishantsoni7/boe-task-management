'use client'

// THE OPERATIONS TEAM'S ORDERS DASHBOARD (20270401000000; redrawn 2026-11-20 in the approver's design, owner-approved preview).
//
//   Needs your action   New orders to accept · Changes on running orders. A revised PI opens its line-by-line answer form
//                       under the row: ✔ can do · ✖ cannot do · ? needs discussion.
//   Watching            PIs Operations flagged that wait on the approver or on Sales.
//
// Orders and dispatches, Revenue, the not-aligned table and the list of recent answers are no longer on this page.
// Which row sits where is lib/orders/operationsCards.ts; the rows, the sheet and the watching list are the approver's own pieces
// (DecisionCards.tsx). The answers are ADVICE to the approver and never touch the order: it stays aligned whatever is answered.

import { useMemo, useState, type ReactNode } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { Check, CircleCheck, MessageSquare, X } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import { formatInstantIst, type DashboardSummary } from '@/lib/orders/orderDashboardSummary'
import {
  BULK_NOTE_PLACEHOLDER,
  CHANGES_UNAVAILABLE_NOTE,
  DECISION_LABEL,
  DECISION_SYMBOL,
  NOTE_PLACEHOLDER,
  applyToAll,
  buildAnswers,
  changeText,
  describeAnswerFailure,
  emptyDraft,
  responseSummary,
  responseTone,
  tally,
  type ChangeDecision,
  type ChangeResponse,
  type DraftAnswers,
  type OperationsRead,
  type PendingChange,
} from '@/lib/orders/operationsDashboard'
import { BACK_WITH_OPERATIONS_NOTE } from '@/lib/orders/backWithOperations'
import { OPS_GROUPS, OPS_WATCHING_HINT, operationsRows, type OpsHandoffInfo } from '@/lib/orders/operationsCards'
import { ActionSheet, DecisionRowLink, WatchingSection } from './DecisionCards'
import styles from './adminDashboard.module.css'

const DECISIONS: readonly ChangeDecision[] = ['can_do', 'cannot_do', 'discuss']

/** An order that has come back to Operations (owner, 2026-11-15): the Confirmed Orders list's blue "New update". */
function NewUpdateTag() {
  return (
    <span className="ops-new">
      <span className="order-update-dot" aria-hidden="true" />
      {BACK_WITH_OPERATIONS_NOTE}
    </span>
  )
}

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

export function PendingChangeCard({ item, isNew, supabase, onAnswered, readOnlyReason }: {
  item: PendingChange
  isNew: boolean
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
          {isNew ? <NewUpdateTag /> : null}
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

// ── The page ────────────────────────────────────────────────────────────────

/** Who holds the PIs Operations flagged, and who approved them: read after the page draws, so it may not be there yet. */
export type OpsHandoffsState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; byOrder: ReadonlyMap<string, OpsHandoffInfo> }

export function OperationsDashboardView({ summary, read, backWithOps, handoffs, supabase, onAnswered, readOnlyReason }: {
  summary: DashboardSummary
  read: OperationsRead
  /** Orders that have come back to Operations (lib/orders/backWithOperations.ts): marked "New update". */
  backWithOps: ReadonlySet<string>
  handoffs: OpsHandoffsState
  supabase: SupabaseClient
  onAnswered: () => void
  readOnlyReason: string | null
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  // The read's own time, so the waits are the database's and the render stays pure.
  const parsed = Date.parse(summary.now)
  const nowMs = Number.isNaN(parsed) ? 0 : parsed
  const byOrder = handoffs.kind === 'ready' ? handoffs.byOrder : null
  const rows = useMemo(
    () => operationsRows({ alignment: summary.notAligned, pending: read.pending, details: read.orderDetails, today: read.today, backWithOps, handoffs: byOrder }, nowMs),
    [summary.notAligned, read.pending, read.orderDetails, read.today, backWithOps, byOrder, nowMs],
  )
  const groups = OPS_GROUPS.map(g => ({ ...g, rows: rows.groups[g.key] })).filter(g => g.rows.length > 0)

  const renderRow = (r: (typeof groups)[number]['rows'][number], solid: boolean) => {
    const item = rows.changeItems.get(r.key)
    if (!item) return <DecisionRowLink r={r} solid={solid} />
    const open = openKey === r.key
    return (
      <>
        <DecisionRowLink r={r} solid={solid} expanded={open} onToggle={() => setOpenKey(k => (k === r.key ? null : r.key))} />
        {open ? (
          <div className={styles.answer}>
            <PendingChangeCard item={item} isNew={backWithOps.has(item.orderId)} supabase={supabase} onAnswered={onAnswered} readOnlyReason={readOnlyReason} />
          </div>
        ) : null}
      </>
    )
  }

  const watching = rows.watching
  const nothing = groups.length === 0 && handoffs.kind === 'ready' && (watching?.length ?? 0) === 0
  return (
    <div className={styles.root}>
      <div className={styles.cardsWrap}>
        {handoffs.kind === 'failed' ? (
          <section className={styles.card}><p className={styles.note} role="alert">Who holds the PIs you flagged could not be loaded, so that list is not shown. Refresh to try again.</p></section>
        ) : null}
        {groups.length > 0 ? <ActionSheet groups={groups} renderRow={renderRow} /> : null}
        {watching && watching.length > 0 ? <WatchingSection rows={watching} hint={OPS_WATCHING_HINT} /> : null}
        {nothing ? (
          <div className={styles.clear}><CircleCheck size={20} aria-hidden="true" /><span>Nothing is waiting on you, and nobody is holding anything for you.</span></div>
        ) : null}
      </div>
    </div>
  )
}
