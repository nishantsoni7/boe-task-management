'use client'

// Ask a senior (owner, 20 Nov 2026): the salesperson sends THEIR OWN quotation to the owner or Nitish, either to get the prices or to have
// their prices checked. The senior sees it in Quotations › Requests, edits the prices in this same builder, and sends it back with a note.
// One slim strip above the top row; it shows only what applies: nothing to do and nothing asked = a single "Ask a senior" button.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, UserCheck } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import {
  ASK_LABEL, answerRequest, askKeys, errorText, fetchAskState, fetchDeskPeople, sendRequest, withdrawRequest, type AskKind, type Quotation,
} from '@/lib/quotations/api'
import { quotationWait } from '@/lib/tasks/quotationWait'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
const PICK_KEY = 'boe.quotationAsk.to'
const read = (k: string) => { try { return window.localStorage.getItem(k) ?? '' } catch { return '' } }
const write = (k: string, v: string) => { try { window.localStorage.setItem(k, v) } catch { /* private window */ } }

export function AskCard({ supabase, base, dirty, onSentBack, onChanged }: {
  supabase: Supabase; base: Quotation; dirty: boolean
  /** The senior has just sent it back (the request id): the price brief may be asked here. */
  onSentBack?: (requestId: string) => void
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: askKeys.state(base.id), queryFn: () => fetchAskState(supabase, base.id), retry: false, staleTime: 15_000 })
  const st = q.data
  const [mode, setMode] = useState<'ask' | 'answer' | null>(null)
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<AskKind>('price')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [now] = useState(() => Date.now())
  const desk = useQuery({ queryKey: askKeys.desk, queryFn: () => fetchDeskPeople(supabase), enabled: mode === 'ask', staleTime: 300_000, retry: false })

  if (!st) return null
  const done = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setErr('')
    try {
      await fn()
      setMode(null); setNote('')
      await qc.invalidateQueries({ queryKey: askKeys.state(base.id) })
      void qc.invalidateQueries({ queryKey: askKeys.list }); void qc.invalidateQueries({ queryKey: askKeys.count })
      after?.(); onChanged()
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }
  const people = desk.data ?? []
  const chosen = to || (people.some(p => p.id === read(PICK_KEY)) ? read(PICK_KEY) : '')
  const o = st.open
  const wait = o ? quotationWait(o.created_at, now) : null

  if (!o && !st.may_ask && !st.last) return null
  return (
    <section className={`${s.card} ${s.askStrip}`} aria-label="Ask a senior">
      <div className={s.row}>
        <UserCheck size={16} aria-hidden />
        {o ? (
          <span>
            {st.may_answer
              ? <><b>{o.from_name ?? 'A salesperson'}</b> sent this to you ({ASK_LABEL[o.kind].toLowerCase()}){o.note ? <>: “{o.note}”</> : null}</>
              : <>Sent to <b>{o.to_name ?? 'a senior'}</b> ({ASK_LABEL[o.kind].toLowerCase()}) · waiting {wait?.label ?? ''}{o.note ? <> · “{o.note}”</> : null}</>}
          </span>
        ) : st.last ? (
          <span><b>{st.last.answered_by_name ?? st.last.to_name}</b> sent it back{st.last.answered_at ? ` ${new Date(st.last.answered_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}{st.last.answer_note ? <>: “{st.last.answer_note}”</> : null}</span>
        ) : <span>Not sure of a price? Send this quotation to a senior.</span>}
        <span className={s.spacer} />
        {!mode && st.may_answer && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={dirty} onClick={() => setMode('answer')}><Send size={14} aria-hidden /> Send back to {o?.from_name ?? 'sales'}</button>}
        {!mode && st.may_withdraw && o && !st.may_answer && <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => done(() => withdrawRequest(supabase, o.id))}>Withdraw</button>}
        {!mode && st.may_ask && <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={dirty} onClick={() => setMode('ask')}>Ask a senior</button>}
        {dirty && (st.may_ask || st.may_answer) && <span className={s.dirty}>Save first</span>}
      </div>

      {mode === 'ask' && (
        <form className={s.leadForm} onSubmit={e => { e.preventDefault(); if (!chosen) { setErr('Choose who to send it to.'); return } write(PICK_KEY, chosen); void done(() => sendRequest(supabase, base.id, chosen, kind, note)) }}>
          <label className={s.field}><span>Send to</span>
            <select id="ask-to" className={s.input} value={chosen} onChange={e => setTo(e.target.value)} disabled={busy}>
              <option value="">Choose…</option>{people.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select></label>
          <div className={s.row} role="radiogroup" aria-label="What do you need">
            {(['price', 'verify'] as AskKind[]).map(k => (
              <label key={k} className={s.row} style={{ gap: 6 }}><input type="radio" name="ask-kind" checked={kind === k} onChange={() => setKind(k)} />{k === 'price' ? 'I need the prices' : 'Please check my prices'}</label>
            ))}
          </div>
          <label className={s.field}><span>Note (optional)</span><input id="ask-note" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Teak, 56 rooms, client wants it by January" disabled={busy} /></label>
          <div className={s.row}><button type="submit" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button><button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setMode(null)}>Cancel</button></div>
        </form>
      )}
      {mode === 'answer' && o && (
        <form className={s.leadForm} onSubmit={e => { e.preventDefault(); void done(() => answerRequest(supabase, o.id, note), () => onSentBack?.(o.id)) }}>
          <label className={s.field}><span>Note for {o.from_name ?? 'sales'} (optional)</span><input id="ask-answer" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Priced at the usual teak rate; wardrobes at 39 rooms" disabled={busy} autoFocus /></label>
          <div className={s.row}><button type="submit" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={busy}>{busy ? 'Sending…' : 'Send back'}</button><button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setMode(null)}>Cancel</button></div>
        </form>
      )}
      {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
    </section>
  )
}
