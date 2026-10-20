'use client'

// ── PENDING FROM CLIENT, inside the Fabric & Finish card ─────────────────────
//
// Self-loading on purpose: the Order page's startup reads are counted and
// pinned (orderStartupShape.test.ts), and this is a small list nobody needs for
// first paint. It reads order_pendencies (RLS follows Order visibility) and
// writes only through the four RPCs of 20270325000000, which re-derive who may.
// `canManage` only decides whether the controls are drawn.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ORDER_PENDENCY_SELECT, PENDENCIES_EMPTY, PENDENCIES_TITLE, PENDENCY_MAX_LENGTH,
  addPendencyDraft, describePendencyError, splitPendencies, type PersistedPendency,
} from '@/lib/orders/orderPendencies'

export default function OrderPendencies({ orderId, canManage }: { orderId: string; canManage: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<PersistedPendency[] | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // The read itself touches no state; whoever calls it applies the answer.
  const fetchRows = useCallback(async () => {
    const { data, error } = await supabase
      .from('order_pendencies')
      .select(ORDER_PENDENCY_SELECT)
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
    return error ? null : ((data ?? []) as PersistedPendency[])
  }, [supabase, orderId])

  const apply = (next: PersistedPendency[] | null) => {
    setUnreadable(next === null)
    if (next !== null) setRows(next)
  }
  const load = async () => apply(await fetchRows())

  useEffect(() => {
    let live = true
    void fetchRows().then(next => { if (live) apply(next) })
    return () => { live = false }
  }, [fetchRows])

  const run = async (call: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setProblem(null)
    const { error } = await call()
    if (error) setProblem(describePendencyError(error.message))
    await load()
    setBusy(false)
  }

  const add = async () => {
    const { list, problem: why } = addPendencyDraft([], text)
    if (why) { setProblem(why); return }
    if (list.length === 0) return
    await run(() => supabase.rpc('add_order_pendencies', { p_order_id: orderId, p_labels: list }))
    setText('')
  }

  if (unreadable) return null
  if (rows === null) return null
  const { open, cleared } = splitPendencies(rows)
  // Nothing to show and nobody to add: draw nothing, not an empty heading.
  if (open.length === 0 && cleared.length === 0 && !canManage) return null

  return (
    <div className="order-ff-pend" role="group" aria-label={PENDENCIES_TITLE}>
      <p className="order-ff-pend-title">{PENDENCIES_TITLE}{open.length > 0 && <span className="order-ff-pend-count">{open.length}</span>}</p>
      {open.length === 0 ? (
        <p className="order-ff-pend-empty">{PENDENCIES_EMPTY}</p>
      ) : (
        <ul className="order-ff-pend-list">
          {open.map(p => (
            <li key={p.id} className="order-ff-pend-item">
              <span className="order-ff-pend-dot" aria-hidden="true" />
              <span className="order-ff-pend-label">{p.label}</span>
              {canManage && (
                <span className="order-ff-pend-actions">
                  <button type="button" className="order-ff-pend-btn" disabled={busy}
                    onClick={() => void run(() => supabase.rpc('clear_order_pendency', { p_pendency_id: p.id }))}>
                    Mark cleared
                  </button>
                  <button type="button" className="order-ff-pend-btn order-ff-pend-btn--quiet" disabled={busy}
                    aria-label={`Remove ${p.label}`}
                    onClick={() => void run(() => supabase.rpc('remove_order_pendency', { p_pendency_id: p.id }))}>
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form className="order-ff-pend-add" onSubmit={e => { e.preventDefault(); void add() }}>
          <input className="boe-input order-ff-pend-input" value={text} maxLength={PENDENCY_MAX_LENGTH}
            placeholder="Add a pendency, e.g. Fabric swatch from client" disabled={busy}
            aria-label="Add a pendency" onChange={e => setText(e.target.value)} />
          <button type="submit" className="boe-btn boe-btn-ghost order-status-action" disabled={busy || text.trim() === ''}>Add</button>
        </form>
      )}
      {problem && <p className="order-ff-pend-problem" role="alert">{problem}</p>}
      {cleared.length > 0 && (
        <details className="order-approval-history">
          <summary className="order-approval-history-summary">Cleared ({cleared.length})</summary>
          <ul className="order-ff-pend-list order-ff-pend-list--cleared">
            {cleared.map(p => (
              <li key={p.id} className="order-ff-pend-item">
                <span className="order-ff-pend-label">{p.label}</span>
                {canManage && (
                  <button type="button" className="order-ff-pend-btn order-ff-pend-btn--quiet" disabled={busy}
                    onClick={() => void run(() => supabase.rpc('reopen_order_pendency', { p_pendency_id: p.id }))}>
                    Reopen
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
