'use client'

// Ask a senior (owner, 20 Nov 2026): the salesperson sends THEIR OWN quotation to the owner or Nitish, either to get the prices or to have
// their prices checked. The senior sees it in Quotations › Requests, edits the prices in this same builder, and sends it back with a note.
// One row of the properties panel since 25 Nov 2026 (SeniorRow: what was asked and what came back, and the AskButton beside it, whose form opens as a
// small pop-over under it). Both read the same cached state.

import { useEffect, useRef, useState } from 'react'
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

const useAskState = (supabase: Supabase, base: Quotation) =>
  useQuery({ queryKey: askKeys.state(base.id), queryFn: () => fetchAskState(supabase, base.id), retry: false, staleTime: 15_000 }).data

const initials = (name?: string | null) => (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'

/**
 * The Senior row of the properties panel (owner, 25 Nov 2026): what was asked and what came back, with the Ask a senior button in the same row
 * (its form opens as a small pop-over under it). The row draws nothing when nothing was asked and the person has nothing to do here.
 */
export function SeniorRow({ supabase, base, dirty, onChanged, onSentBack }: {
  supabase: Supabase; base: Quotation; dirty: boolean; onChanged: () => void; onSentBack?: (requestId: string) => void
}) {
  const st = useAskState(supabase, base)
  const [now] = useState(() => Date.now())
  if (!st) return null
  const o = st.open
  const acts = st.may_answer || !!(st.may_withdraw && o && !st.may_answer) || st.may_ask
  if (!o && !st.last && !acts) return null
  const wait = o ? quotationWait(o.created_at, now) : null
  const name = o ? (st.may_answer ? o.from_name : o.to_name) : st.last ? (st.last.answered_by_name ?? st.last.to_name) : null
  return (
    <div className={s.prop} role="group" aria-label="Senior">
      <span className={s.propLab}><UserCheck size={16} aria-hidden /> Senior</span>
      <div className={s.propVal}>
        {o || st.last ? (
          <span className={s.who}>
            <span className={s.avatar} aria-hidden>{initials(name)}</span>
            <span>
              {o ? (
                st.may_answer
                  ? <><b>{o.from_name ?? 'A salesperson'}</b> sent this to you ({ASK_LABEL[o.kind].toLowerCase()}){o.note ? <>: “{o.note}”</> : null}</>
                  : <>Sent to <b>{o.to_name ?? 'a senior'}</b> ({ASK_LABEL[o.kind].toLowerCase()}) · waiting {wait?.label ?? ''}{o.note ? <> · “{o.note}”</> : null}</>
              ) : st.last ? (
                <><b>{st.last.answered_by_name ?? st.last.to_name}</b> sent it back{st.last.answered_at ? ` ${new Date(st.last.answered_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}{st.last.answer_note ? <>: “{st.last.answer_note}”</> : null}</>
              ) : null}
            </span>
          </span>
        ) : <span className={s.propMuted}>Nothing asked yet</span>}
        <AskButton supabase={supabase} base={base} dirty={dirty} onChanged={onChanged} onSentBack={onSentBack} />
      </div>
    </div>
  )
}

/** The button of the Share row: Send back (the senior's), Withdraw (the asker's, while it waits) or Ask a senior, with its form as a pop-over. */
export function AskButton({ supabase, base, dirty, onSentBack, onChanged }: {
  supabase: Supabase; base: Quotation; dirty: boolean
  /** The senior has just sent it back (the request id): the price brief may be asked here. */
  onSentBack?: (requestId: string) => void
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const st = useAskState(supabase, base)
  const [mode, setMode] = useState<'ask' | 'answer' | null>(null)
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<AskKind>('price')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const wrap = useRef<HTMLSpanElement>(null)
  const desk = useQuery({ queryKey: askKeys.desk, queryFn: () => fetchDeskPeople(supabase), enabled: mode === 'ask', staleTime: 300_000, retry: false })
  const shown = mode !== null || !!err
  const close = () => { setMode(null); setErr('') }

  // The pop-over closes on Escape and on a click outside it, like the other menus.
  useEffect(() => {
    if (!shown) return
    const shut = () => { setMode(null); setErr('') }
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) shut() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') shut() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [shown])

  if (!st) return null
  const o = st.open
  const withdraw = !!(st.may_withdraw && o && !st.may_answer)
  if (!st.may_answer && !withdraw && !st.may_ask) return null

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
  const saveFirst = dirty ? 'Save first' : undefined
  const toggle = (m: 'ask' | 'answer') => { setErr(''); setMode(x => (x === m ? null : m)) }

  return (
    <span ref={wrap} className={s.askw}>
      {st.may_answer && <button type="button" className={s.btn} disabled={dirty} title={saveFirst} aria-haspopup="dialog" aria-expanded={mode === 'answer'} onClick={() => toggle('answer')}><Send size={15} aria-hidden /> Send back to {o?.from_name ?? 'sales'}</button>}
      {withdraw && o && <button type="button" className={`${s.btn} ${s.btnQuiet}`} disabled={busy} onClick={() => done(() => withdrawRequest(supabase, o.id))}>Withdraw</button>}
      {st.may_ask && <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={dirty} title={saveFirst} aria-haspopup="dialog" aria-expanded={mode === 'ask'} onClick={() => toggle('ask')}><UserCheck size={15} aria-hidden /> Ask a senior</button>}

      {shown && (
        <div className={s.pop} role="dialog" aria-label={mode === 'answer' ? 'Send it back' : 'Ask a senior'}>
          {mode === 'ask' && (
            <form className={s.leadForm} onSubmit={e => { e.preventDefault(); if (!chosen) { setErr('Choose who to send it to.'); return } write(PICK_KEY, chosen); void done(() => sendRequest(supabase, base.id, chosen, kind, note)) }}>
              <h3>Ask a senior</h3>
              <label className={s.field}><span>Send to</span>
                <select id="ask-to" className={s.input} value={chosen} onChange={e => setTo(e.target.value)} disabled={busy} autoFocus>
                  <option value="">Choose…</option>{people.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                </select></label>
              <div className={s.row} role="radiogroup" aria-label="What do you need">
                {(['price', 'verify'] as AskKind[]).map(k => (
                  <label key={k} className={s.row} style={{ gap: 6 }}><input type="radio" name="ask-kind" checked={kind === k} onChange={() => setKind(k)} />{k === 'price' ? 'I need the prices' : 'Please check my prices'}</label>
                ))}
              </div>
              <label className={s.field}><span>Note (optional)</span><input id="ask-note" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Teak, 56 rooms, client wants it by January" disabled={busy} /></label>
              <div className={s.row}><button type="submit" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button><button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={close}>Cancel</button></div>
            </form>
          )}
          {mode === 'answer' && o && (
            <form className={s.leadForm} onSubmit={e => { e.preventDefault(); void done(() => answerRequest(supabase, o.id, note), () => onSentBack?.(o.id)) }}>
              <h3>Send it back to {o.from_name ?? 'sales'}</h3>
              <label className={s.field}><span>Note for {o.from_name ?? 'sales'} (optional)</span><input id="ask-answer" className={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Priced at the usual teak rate; wardrobes at 39 rooms" disabled={busy} autoFocus /></label>
              <div className={s.row}><button type="submit" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={busy}>{busy ? 'Sending…' : 'Send back'}</button><button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={close}>Cancel</button></div>
            </form>
          )}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
      )}
    </span>
  )
}
