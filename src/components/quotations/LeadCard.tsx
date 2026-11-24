'use client'

// The Lead row of the top panel (the card was owner-approved 19 Nov 2026, migration 20270811000000; a row of the panel since 24 Nov 2026): the Sales
// lead a quotation came from, and ONE button that fits where the quotation is (Sent: log it on the lead; Confirmed: mark the lead Converted; Lost:
// mark it Dead). Never automatic: each button calls the lead's own function (add_sales_lead_comment, move_sales_lead), so the lead's permission
// rules, checks and Undo apply as if the person had done it on the lead. The lead's STAGE is the status shown for the quotation (24 Nov 2026):
// a chip, and a five-step meter while the lead is on the path of a sale.

import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { createClient } from '@/lib/supabase/client'
import { istToday } from '@/lib/istDate'
import { fetchLeadInfo, leadInfoKey, linkLead, type Quotation, type LeadSummary } from '@/lib/quotations/api'
import { FOLLOW_UP_DAYS, followUpDefault, leadAction, logNote, lostNote, lostReason } from '@/lib/quotations/leadLink'
import { DEAD_REASONS, FACT_LABELS, PATH_STAGES, STAGES, deadReasonLabel, stageLabel, type Stage } from '@/lib/salesLeads/board'
import { addComment, fetchLeadPage, moveLead, type SalesLead } from '@/lib/salesLeads/api'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
type Mode = null | 'log' | 'convert' | 'dead' | 'pick'
type Tone = 'ok' | 'warn' | 'bad'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const title = (l: Pick<LeadSummary, 'lead_no' | 'name'>) => `#${l.lead_no} ${l.name?.trim() || 'No name yet'}`
const msgOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

/** "today", "yesterday" or "3 days ago", by India days. */
function ago(iso: string, today: string): string {
  const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000)
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`
}

/** The chip's colour: green once converted, grey when dead, amber while parked; the stages of a sale are blue. */
const stageTone = (stage: string) => (stage === 'converted' ? s.stageDone : stage === 'dead' ? s.stageDead : stage === 'follow_up_later' ? s.stageLater : '')

/** The one button that fits where the quotation is; its hint is the button's tooltip (the row has no room for a sentence). */
const ACT_TEXT = {
  log: { label: 'Log on the lead', hint: (no: string, v: number | null) => `Writes ${no}${v ? ` v${v}` : ''} on the lead and sets its follow-up.` },
  convert: { label: 'Mark lead Converted', hint: () => 'A record on the lead only: nothing in Orders changes.' },
  dead: { label: 'Mark lead Dead', hint: () => 'You choose the reason; your lost note goes with it.' },
} as const

export function LeadCard({ supabase, base, dirty, onChanged }: { supabase: Supabase; base: Quotation; dirty: boolean; onChanged: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: leadInfoKey(base.id), queryFn: () => fetchLeadInfo(supabase, base.id), retry: false, staleTime: 30_000 })
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [due, setDue] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<SalesLead[] | null>(null)

  const info = q.data
  // Not set up yet (the database part is not applied), or nothing to say: no row.
  if (!info || (!info.sales_open && !info.linked)) return null

  const lead = info.lead
  const may = base.may_edit
  const today = istToday()
  const act = lead ? leadAction(base.status, lead.stage) : null
  const closed = lead ? lead.stage === 'converted' || lead.stage === 'dead' : false
  const leadHref = lead ? `/sales/board?lead=${lead.id}` : ''
  const off = busy || dirty
  const saveFirst = dirty ? 'Save first' : undefined
  const stageAt = lead ? PATH_STAGES.indexOf(lead.stage as Stage) : -1

  const run = async (work: () => Promise<{ tone: Tone; text: string } | void>, keepMode = false) => {
    setBusy(true); setMsg(null)
    try {
      const m = await work()
      if (m) setMsg(m)
      if (!keepMode) setMode(null)
      await qc.invalidateQueries({ queryKey: leadInfoKey(base.id) })
    } catch (e) { setMsg({ tone: 'bad', text: msgOf(e) }) } finally { setBusy(false) }
  }

  const doLink = (id: string | null) => run(async () => {
    await linkLead(supabase, base.id, id)
    setFound(null); setSearch('')
    onChanged()
    return { tone: 'ok', text: id ? 'Linked to the lead.' : 'Unlinked from the lead.' }
  })

  const find = (e: FormEvent) => {
    e.preventDefault()
    if (!search.trim()) return
    return run(async () => {
      const p = await fetchLeadPage(supabase, { period: 'all', from: '', to: '', holder: '', source: '', q: search.trim(), limit: 5, offset: 0 })
      setFound(p.rows)
    }, true)
  }

  const open = (m: Exclude<Mode, null>) => {
    setMsg(null); setMode(m)
    if (m === 'log') setDue(followUpDefault(today))
    if (m === 'dead') { setReason(lostReason(base.events)); setNote(lostNote(base.events)) }
  }

  const doLog = () => lead && run(async () => {
    const text = logNote(base.quote_no, info.version_no, info.value)
    await addComment(supabase, lead.id, { note: text, tag: 'quotation', nextDue: due })
    const later = ['new', 'under_process', 'visit_meeting', 'potential'].includes(lead.stage)
    return { tone: 'ok', text: `Logged on the lead. Follow-up ${day(due)}.${later ? ' To move the lead to Negotiation, open it and use its status.' : ''}` }
  })

  const doConvert = () => lead && run(async () => {
    const r = await moveLead(supabase, lead.id, 'converted', lead.stage as Stage)
    if (r.status === 'needs') return { tone: 'warn', text: `The lead needs ${r.missing.map(f => FACT_LABELS[f].toLowerCase()).join(', ')} before it can be Converted. Open the lead to add ${r.missing.length === 1 ? 'it' : 'them'}.` }
    return { tone: 'ok', text: 'The lead is marked Converted.' }
  })

  const doDead = () => lead && run(async () => {
    await moveLead(supabase, lead.id, 'dead', lead.stage as Stage, { reason, note })
    return { tone: 'ok', text: 'The lead is marked Dead.' }
  })

  const label = lead ? title(lead) : ''
  const cancel = <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setMode(null)}>Cancel</button>

  return (
    <div className={s.prow} role="group" aria-label="Lead">
      <span className={s.tileLab}>Lead</span>
      <div className={s.pcol}>
        <div className={s.prc}>
          {lead ? (
            <>
              <Link href={leadHref} className={s.tileTitle}>{label}</Link>
              <span className={`${s.stage} ${stageTone(lead.stage)}`}>{stageLabel(lead.stage)}{lead.stage === 'dead' && lead.dead_reason ? ` · ${deadReasonLabel(lead.dead_reason)}` : ''}</span>
              {stageAt >= 0 && (
                <span className={s.meter} role="img" aria-label={`Stage ${stageAt + 1} of ${PATH_STAGES.length}`}
                  title={`Stage ${stageAt + 1} of ${PATH_STAGES.length}: ${PATH_STAGES.map(k => STAGES.find(x => x.key === k)?.label ?? k).join(', ')}`}>
                  {PATH_STAGES.map((k, i) => <i key={k} className={i <= stageAt ? s.meterOn : undefined} />)}
                </span>
              )}
              <span className={s.leadMeta}>
                Held by {lead.holder_name ?? 'nobody yet'}
                {!closed && lead.next_due_on ? ` · follow-up ${day(lead.next_due_on)}` : ''}
                {(base.status === 'sent' || base.status === 'negotiating') && !closed
                  ? ` · ${lead.last_logged_at ? `logged on the lead ${ago(lead.last_logged_at, today)}` : 'not logged on the lead yet'}` : ''}
              </span>
              <span className={s.spacer} />
              {act && lead.may_work && mode === null && (
                <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={off} title={saveFirst ?? ACT_TEXT[act].hint(base.quote_no, info.version_no)} onClick={() => open(act)}>{ACT_TEXT[act].label}</button>
              )}
              {may && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} disabled={off} title={saveFirst} onClick={() => doLink(null)}>Unlink</button>}
            </>
          ) : info.linked ? (
            <>
              <span className={s.leadMeta}>Linked to a lead you cannot open{info.sales_open ? '' : ' (your account has no Sales access)'}.</span>
              {may && <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} disabled={off} title={saveFirst} onClick={() => doLink(null)}>Unlink</button>}
            </>
          ) : may ? (
            info.suggest ? (
              <>
                <span className={s.leadMeta}>Is this the lead? <b>{title(info.suggest)}</b> · {stageLabel(info.suggest.stage)} · held by {info.suggest.holder_name ?? 'nobody yet'} (same phone)</span>
                <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={off} title={saveFirst} onClick={() => doLink(info.suggest!.id)}>Link this lead</button>
                <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`} disabled={off} title={saveFirst} onClick={() => open('pick')}>Not this one</button>
              </>
            ) : (
              <>
                <span className={s.leadMeta}>Not linked to a lead yet.</span>
                <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={off} title={saveFirst} onClick={() => open('pick')}>Link to a lead</button>
              </>
            )
          ) : <span className={s.leadMeta}>Not linked to a lead.</span>}
        </div>

        {mode === 'pick' && may && (
          <form className={s.leadForm} onSubmit={find}>
            <label className={s.field}><span>Find the lead by name, number or phone</span>
              <input id="q-lead-search" className={s.input} value={search} onChange={e => setSearch(e.target.value)} placeholder="Hotel Aravali, 98765…" autoFocus /></label>
            <div className={s.row}><button type="submit" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={off || !search.trim()}>Search</button>{cancel}</div>
            {found && (found.length === 0
              ? <p className={s.tileText}>No lead you can see matches that.</p>
              : <ul className={s.leadList}>{found.map(l => (
                <li key={l.id}><button type="button" className={s.btn} disabled={off} onClick={() => doLink(l.id)}>
                  {title(l)} · {l.phone} · held by {l.holder_name ?? 'nobody yet'}
                </button></li>))}</ul>)}
          </form>
        )}

        {lead && act && !lead.may_work && (
          <p className={s.tileText}>Held by {lead.holder_name ?? 'nobody yet'}: only they, or a sales manager, can update the lead.</p>
        )}

        {lead && mode === 'log' && (
          <div className={s.leadForm}>
            <p className={s.tileText}>{logNote(base.quote_no, info.version_no, info.value)}</p>
            <label className={s.field}><span>Follow up on the quotation (default {FOLLOW_UP_DAYS} days)</span>
              <input id="q-lead-due" className={s.input} type="date" min={today} value={due} onChange={e => setDue(e.target.value)} /></label>
            <div className={s.row}>
              <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={off || !due || due < today} onClick={doLog}>{busy ? 'Logging…' : 'Log it'}</button>{cancel}
            </div>
          </div>
        )}

        {lead && mode === 'convert' && (
          <div className={s.leadForm}>
            <p className={s.tileText}>Mark {label} as Converted? The lead asks for what it still needs first.</p>
            <div className={s.row}>
              <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={off} onClick={doConvert}>{busy ? 'Marking…' : 'Yes, mark Converted'}</button>{cancel}
            </div>
          </div>
        )}

        {lead && mode === 'dead' && (
          <div className={s.leadForm}>
            <label className={s.field}><span>Why is the lead dead?</span>
              <select id="q-lead-reason" className={s.input} value={reason} onChange={e => setReason(e.target.value)}>
                <option value="">Choose a reason…</option>
                {DEAD_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select></label>
            <label className={s.field}><span>Note{reason === 'other' ? ' (required)' : ''}</span>
              <input id="q-lead-dead-note" className={s.input} value={note} maxLength={300} onChange={e => setNote(e.target.value)} /></label>
            <div className={s.row}>
              <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={off || !reason || (reason === 'other' && !note.trim())} onClick={doDead}>{busy ? 'Marking…' : 'Mark Dead'}</button>{cancel}
            </div>
          </div>
        )}

        {msg && <div role="status" className={`${s.notice} ${msg.tone === 'ok' ? s.noticeOk : msg.tone === 'warn' ? s.noticeWarn : s.noticeBad}`}>
          {msg.text}{lead && msg.tone === 'warn' ? <> <Link href={leadHref}>Open the lead</Link></> : null}</div>}
      </div>
    </div>
  )
}
