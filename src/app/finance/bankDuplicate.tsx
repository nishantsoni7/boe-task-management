'use client'

// ── A pending request beside the payment that is already confirmed ───────────
//
// Drawn in the bank panel of the payment window for a holder of finance.reconcile, on a
// pending HDFC request, when an earlier payment looks like the same money. It says plainly
// that THIS is a request somebody sent, lays it beside the confirmed payment fact by fact,
// and offers MERGE: the request is closed (not rejected), what it asked for is applied to the
// payment that is already there, and that payment's activity records the merge. Nobody on the
// Sales side has anything to do.
//
// This only draws and asks. merge_payment_request (20270608000000) re-judges every rule under
// row locks; the rules in lib/finance/paymentDuplicates.ts decide what is drawn.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creditHref, paymentHref } from './bank/bankStatementsModel'
import {
  compareSides, loadDuplicates, mergeBlocker, mergeEffects, mergeRefusal, readMergeResult,
  type DuplicateCredit, type DuplicateSide, type MergeResult,
} from '@/lib/finance/paymentDuplicates'
import type { BankMark } from '@/lib/finance/bankMarks'

const NOTE_MAX = 200

/** What the panel hands in about the request. Everything past `id` is optional so older callers still compile. */
export type DuplicatePayment = {
  id: string
  amount: number
  client_name: string | null
  payment_date: string
  payment_mode: string
  proof_note: string | null
  human_payment_id?: string | null
  status?: string
  created_at?: string
  submitted_by_name?: string
}

export type DuplicateState =
  | { status: 'idle' | 'loading' | 'failed'; request: null; candidates: [] }
  | { status: 'ready'; request: DuplicateSide; candidates: DuplicateSide[] }

const IDLE: DuplicateState = { status: 'idle', request: null, candidates: [] }
const LOADING: DuplicateState = { status: 'loading', request: null, candidates: [] }

/** Only a pending request in an HDFC account, once its bank marks are read, has earlier payments to look for. */
export function useDuplicates(supabase: SupabaseClient, payment: DuplicatePayment, mark: BankMark | undefined, bankAccount: boolean): DuplicateState {
  const enabled = bankAccount && payment.status === 'pending_approval' && mark !== undefined
  const holderKey = mark?.kind === 'lookalike' ? mark.holders.map(h => h.paymentId).join(',') : ''
  const key = `${payment.id}|${holderKey}`
  const [done, setDone] = useState<{ key: string; value: DuplicateState } | null>(null)
  const { id, amount, client_name, payment_date, payment_mode, proof_note, human_payment_id, status, created_at, submitted_by_name } = payment

  useEffect(() => {
    if (!enabled) return
    let live = true
    loadDuplicates(supabase, {
      id, humanId: human_payment_id ?? null, status: status ?? 'pending_approval', amount: Number(amount), paymentDate: payment_date,
      paymentMode: payment_mode, clientName: client_name, reference: proof_note, addedByName: submitted_by_name ?? null, addedAt: created_at ?? payment_date,
    }, holderKey ? holderKey.split(',') : [])
      .then(r => { if (live) setDone({ key, value: { status: 'ready', request: r.request, candidates: r.candidates } }) })
      .catch(() => { if (live) setDone({ key, value: { status: 'failed', request: null, candidates: [] } }) })
    return () => { live = false }
  }, [enabled, key, supabase, id, amount, client_name, payment_date, payment_mode, proof_note, human_payment_id, status, created_at, submitted_by_name, holderKey])

  if (!enabled) return IDLE
  return done && done.key === key ? done.value : LOADING
}

const FACT_WORD: Record<string, string> = { amount: 'amount', date: 'date', account: 'account', credit: 'bank credit', utr: 'UTR', client: 'client' }
const joinWords = (w: string[]) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`)
const initials = (name: string | null | undefined) =>
  (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?'

function Tick() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
}
function MergeIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>
}
function Warn() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
}

export function DuplicatePanel({ supabase, payment, request, candidates, mark, canMerge, busyElsewhere, onMerged }: {
  supabase: SupabaseClient
  payment: DuplicatePayment
  request: DuplicateSide
  candidates: DuplicateSide[]
  mark: BankMark | undefined
  /** May decide this request (finance.approve, and not their own unless they may). */
  canMerge: boolean
  /** Something else on the panel is working. */
  busyElsewhere: boolean
  onMerged: (result: MergeResult) => void
}) {
  const [focusId, setFocusId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existing = candidates.find(c => c.id === focusId) ?? candidates[0]
  const blocker = mergeBlocker(request, existing)
  // The credit this request looks like, when it has no link of its own.
  const seen: DuplicateCredit | null = mark?.kind === 'lookalike'
    ? { lineId: mark.lineId, lineDate: mark.lineDate, statementNo: existing.credits.find(c => c.lineId === mark.lineId)?.statementNo ?? null }
    : null
  const rows = compareSides(request, existing, seen)
  const facts = rows.filter(r => r.tone === 'same' && FACT_WORD[r.key]).map(r => FACT_WORD[r.key])
  const oldId = existing.humanId ?? 'the confirmed payment'
  const reqId = request.humanId ?? 'this request'
  const sender = request.addedByName
  const creditLink = existing.credits.find(c => c.lineDate)

  const merge = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('merge_payment_request', {
      p_request_id: payment.id, p_into_payment_id: existing.id, p_note: note.trim() || null,
    })
    if (err) { setBusy(false); setError(mergeRefusal(err.message)); return }
    onMerged(readMergeResult(data))
  }

  return (
    <div className="bank-dup">
      <div className="bank-dup-origin">
        <span className="bank-tag bank-tag--request">Request</span>
        <span className="bank-avatar" aria-hidden="true">{initials(sender)}</span>
        <span>{sender ? `Sent by ${sender}` : 'Sent by someone'}</span>
      </div>

      <div className="bank-dup-alert" role="note">
        <Warn />
        <div>
          <strong>This may already be in Confirmed Payments.</strong>{' '}
          {facts.length > 0 ? `${oldId} has the same ${joinWords(facts)} as this request.` : `${oldId} looks like this request.`}{' '}
          {blocker ? 'Compare the two below.' : 'Check the details below. If it is the same money, merge this request into it.'}
        </div>
      </div>

      {candidates.length > 1 && (
        <div className="bank-others">
          <strong style={{ fontSize: 13, paddingBottom: 6 }}>{candidates.length} payments look like this one</strong>
          {candidates.map(c => (
            <div key={c.id} className="bank-other-row">
              <strong>{c.humanId ?? 'Payment'}</strong>
              <span>{c.clientName?.trim() || 'Not identified'}</span>
              <button className="boe-btn boe-btn-ghost" disabled={busy || c.id === existing.id} aria-pressed={c.id === existing.id}
                onClick={() => { setFocusId(c.id); setConfirming(false); setError(null) }}>
                {c.id === existing.id ? 'Comparing' : 'Compare'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="bank-dup-table" role="table" aria-label={`${reqId} compared with ${oldId}`}>
        <div className="bank-dup-row bank-dup-head" role="row">
          <span className="bank-dup-lab" role="columnheader" />
          <span className="bank-dup-s" role="columnheader">
            <span className="bank-tag bank-tag--request">Request</span>
            <b>{reqId}</b>
            <small>Waiting for Finance</small>
          </span>
          <span className="bank-dup-c" role="columnheader">
            <span className="bank-tag bank-tag--confirmed">Confirmed payment</span>
            <b>{oldId}</b>
            <small>{existing.status === 'approved_unlinked' || existing.status === 'approved_linked' ? 'Verified' : 'Not verified yet'}</small>
          </span>
          <span className="bank-dup-res" role="columnheader">Result</span>
        </div>
        {rows.map(r => (
          <div key={r.key} className={`bank-dup-row${r.tone === 'differs' ? ' is-differs' : ''}`} role="row">
            <span className="bank-dup-lab" role="rowheader">{r.label}</span>
            <span className={`bank-dup-s${r.request.muted ? ' is-muted' : ''}`} role="cell"><span className="bank-dup-m">Request</span>{r.request.text}{r.request.sub && <small>{r.request.sub}</small>}</span>
            <span className={`bank-dup-c${r.existing.muted ? ' is-muted' : ''}`} role="cell"><span className="bank-dup-m">Confirmed</span>{r.existing.text}{r.existing.sub && <small>{r.existing.sub}</small>}</span>
            <span className={`bank-dup-res is-${r.tone}`} role="cell">{r.tone === 'same' && <Tick />}{r.verdict}</span>
          </div>
        ))}
      </div>

      {mark?.kind === 'lookalike' && mark.narration && (
        <div className="bank-dup-narr"><small>What the bank statement says</small>{mark.narration}</div>
      )}

      {blocker && <p className="bank-dup-blocked" role="note">{blocker.text}</p>}
      {error && <div role="alert" className="bank-error">{error}</div>}

      {confirming && !blocker ? (
        <div className="bank-dup-confirm">
          <h3>Merge {reqId} into {oldId}?</h3>
          <p className="fin-muted" style={{ margin: 0, fontSize: 13 }}>You are saying these are the same money. {oldId} stays as the record.</p>
          <ul className="bank-dup-steps">
            {mergeEffects(request, existing).map(t => <li key={t}><Tick />{t}</li>)}
          </ul>
          <label className="bank-field"><span>Note for the activity (optional)</span>
            <input className="boe-input" value={note} maxLength={NOTE_MAX} placeholder="Why it is a duplicate" onChange={e => setNote(e.target.value)} />
          </label>
          <p className="bank-warn" style={{ fontSize: 13, margin: 0 }}>A merge cannot be undone from this window.</p>
          <div className="bank-compare-actions">
            <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => { setConfirming(false); setError(null) }}>Cancel</button>
            <button className="boe-btn boe-btn-primary" disabled={busy || busyElsewhere} onClick={merge}><MergeIcon />{busy ? 'Merging…' : `Merge into ${oldId}`}</button>
          </div>
        </div>
      ) : (
        <div className="bank-dup-actions">
          {!blocker && canMerge && (
            <div className="bank-dup-primary">
              <button className="boe-btn boe-btn-primary" disabled={busy || busyElsewhere} onClick={() => { setConfirming(true); setError(null) }}><MergeIcon />Merge into {oldId}</button>
              <p>{reqId} is closed as merged, not rejected.{sender ? ` ${sender} does not need to do anything.` : ''}</p>
            </div>
          )}
          <div className="bank-compare-actions">
            <Link className="boe-btn boe-btn-ghost" href={paymentHref(existing.id, existing.status)} target="_blank">Open {oldId}</Link>
            {creditLink && <Link className="boe-btn boe-btn-ghost" href={creditHref(creditLink.lineId, creditLink.lineDate)} target="_blank">Open the credit</Link>}
          </div>
        </div>
      )}
    </div>
  )
}
