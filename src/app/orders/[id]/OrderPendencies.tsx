'use client'

// ── PENDING FROM CLIENT, inside the Fabric & Finish card ─────────────────────
//
// Self-loading on purpose: the Order page's startup reads are counted and
// pinned (orderStartupShape.test.ts), and this is a small list nobody needs for
// first paint. It reads order_pendencies (RLS follows Order visibility) and
// writes only through the RPCs of 20270325000000 / 20270421000000, which
// re-derive who may. `canManage` only decides whether the controls are drawn.
//
// APPROVING (owner, 2026-10-27): the salesperson updates the ERP, chooses the
// ERP screenshot here and presses Approved. The file is uploaded first (the RPC
// refuses a path that names no object), then approve_order_pendency() files it;
// a refusal removes the orphan upload, which the bucket's DELETE policy allows
// only for a file no approval stands on.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ORDER_PENDENCY_SELECT, PENDENCIES_EMPTY, PENDENCIES_TITLE, PENDENCY_MAX_LENGTH, PENDENCY_NO_PROOF_NOTE,
  addPendencyDraft, checkPendencyScreenshot, describePendencyError, pendencyEvidencePath, splitPendencies,
  type PersistedPendency,
} from '@/lib/orders/orderPendencies'
import {
  APPROVAL_EVIDENCE_BUCKET, EVIDENCE_ACCEPT, EVIDENCE_FIELD_LABEL, EVIDENCE_NOT_VERIFIED_NOTE, EVIDENCE_VIEW_LABEL,
} from '@/lib/orders/orderApprovals'

const approvedOn = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

export default function OrderPendencies({ orderId, canManage }: { orderId: string; canManage: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<PersistedPendency[] | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The pendency whose approval panel is open, and the screenshot chosen for it.
  const [approving, setApproving] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)

  // The read itself touches no state; whoever calls it applies the answer.
  const fetchRows = useCallback(async () => {
    const { data, error } = await supabase
      .from('order_pendencies')
      .select(ORDER_PENDENCY_SELECT)
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
    return error ? null : ((data ?? []) as unknown as PersistedPendency[])
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

  const closeApproval = () => { setApproving(null); setFile(null); setProblem(null) }

  const approve = async (pendencyId: string) => {
    const why = checkPendencyScreenshot(file)
    if (why || !file) { setProblem(why); return }
    setBusy(true); setProblem(null)
    const path = pendencyEvidencePath({ orderId, objectId: crypto.randomUUID(), fileName: file.name })
    const { error: uploadError } = await supabase.storage
      .from(APPROVAL_EVIDENCE_BUCKET)
      .upload(path, file, { contentType: file.type })
    if (uploadError) {
      setProblem('The screenshot could not be uploaded. Try again.')
      setBusy(false)
      return
    }
    const { error } = await supabase.rpc('approve_order_pendency', { p_pendency_id: pendencyId, p_evidence_path: path })
    if (error) {
      // The orphan this press just made, and nothing else: the key is a fresh uuid.
      await supabase.storage.from(APPROVAL_EVIDENCE_BUCKET).remove([path])
      setProblem(describePendencyError(error.message))
    } else {
      closeApproval()
    }
    await load()
    setBusy(false)
  }

  const viewProof = async (path: string) => {
    const { data, error } = await supabase.storage.from(APPROVAL_EVIDENCE_BUCKET).createSignedUrl(path, 300)
    if (error || !data?.signedUrl) { setProblem('The screenshot could not be opened.'); return }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  if (unreadable) return null
  if (rows === null) return null
  const { open, cleared } = splitPendencies(rows)
  // Nothing to show and nobody to add: draw nothing, not an empty heading.
  if (open.length === 0 && cleared.length === 0 && !canManage) return null

  return (
    <div className="order-ff-pend" role="group" aria-label={PENDENCIES_TITLE} id="order-pendencies">
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
                    onClick={() => { setProblem(null); setFile(null); setApproving(approving === p.id ? null : p.id) }}>
                    Approve
                  </button>
                  <button type="button" className="order-ff-pend-btn order-ff-pend-btn--quiet" disabled={busy}
                    aria-label={`Remove ${p.label}`}
                    onClick={() => void run(() => supabase.rpc('remove_order_pendency', { p_pendency_id: p.id }))}>
                    Remove
                  </button>
                </span>
              )}
              {canManage && approving === p.id && (
                <div className="order-ff-pend-approve" style={{ flexBasis: '100%' }}>
                  <label className="order-approval-label" htmlFor={`pend-proof-${p.id}`}>{EVIDENCE_FIELD_LABEL}</label>
                  <input id={`pend-proof-${p.id}`} type="file" accept={EVIDENCE_ACCEPT} disabled={busy}
                    onChange={e => { setProblem(null); setFile(e.target.files?.[0] ?? null) }} />
                  <p className="order-ff-pend-empty">{EVIDENCE_NOT_VERIFIED_NOTE}</p>
                  <span className="order-ff-pend-actions">
                    <button type="button" className="boe-btn boe-btn-primary order-status-action" disabled={busy || !file}
                      onClick={() => void approve(p.id)}>
                      {busy ? 'Approving…' : 'Approved'}
                    </button>
                    <button type="button" className="order-ff-pend-btn order-ff-pend-btn--quiet" disabled={busy} onClick={closeApproval}>
                      Cancel
                    </button>
                  </span>
                </div>
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
          <summary className="order-approval-history-summary">Approved ({cleared.length})</summary>
          <ul className="order-ff-pend-list order-ff-pend-list--cleared">
            {cleared.map(p => (
              <li key={p.id} className="order-ff-pend-item">
                <span className="order-ff-pend-label">
                  {p.label}
                  <span className="order-ff-pend-empty">
                    {' '}· {p.approver?.full_name ?? 'Unknown user'}, {approvedOn(p.cleared_at)}
                    {p.evidence_path ? '' : ` · ${PENDENCY_NO_PROOF_NOTE}`}
                  </span>
                </span>
                <span className="order-ff-pend-actions">
                  {p.evidence_path && (
                    <button type="button" className="order-ff-pend-btn" onClick={() => void viewProof(p.evidence_path as string)}>
                      {EVIDENCE_VIEW_LABEL}
                    </button>
                  )}
                  {canManage && (
                    <button type="button" className="order-ff-pend-btn order-ff-pend-btn--quiet" disabled={busy}
                      onClick={() => void run(() => supabase.rpc('reopen_order_pendency', { p_pendency_id: p.id }))}>
                      Reopen
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
