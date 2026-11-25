'use client'

// The Status and Lead rows of the top panel (owner, 25 Nov 2026, quotation page version 2: "It will only show the status from the lead part and
// modification can be done via lead management only for the status"). STATUS is the lead's stage, read only, with a link to Lead Management;
// nothing on this page moves the lead (the Mark lead Converted and Mark lead Dead buttons are gone). LEAD is the lead's name, which opens a brief
// (LeadBrief.tsx), who holds it and the follow-up, "Log on the lead" (a comment and a follow-up date, not a status) and Unlink. A quotation with no
// lead shows its own status, read only, and how to link one. The lead card itself was owner-approved 19 Nov 2026 (migration 20270811000000).

import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Lock } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { createClient } from '@/lib/supabase/client'
import { istToday } from '@/lib/istDate'
import { fetchLeadInfo, leadInfoKey, linkLead, type Quotation, type LeadSummary } from '@/lib/quotations/api'
import { FOLLOW_UP_DAYS, followUpDefault, leadAction, logNote } from '@/lib/quotations/leadLink'
import { stageLabel } from '@/lib/salesLeads/board'
import { addComment, fetchLeadPage, type SalesLead } from '@/lib/salesLeads/api'
import { LeadBrief, StageChip, stageTone } from './LeadBrief'
import { StatusPill } from './ListScreen'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
type Mode = null | 'log' | 'pick'
type Tone = 'ok' | 'warn' | 'bad'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const title = (l: Pick<LeadSummary, 'lead_no' | 'name'>) => `#${l.lead_no} ${l.name?.trim() || 'No name yet'}`
const msgOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

/** "today", "yesterday" or "3 days ago", by India days. */
function ago(iso: string, today: string): string {
  const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000)
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`
}

/** The stage chip and meter live in LeadBrief.tsx (the brief shows them too); re-exported for the old imports. */
export { StageChip, stageTone }

export function LeadCard({ supabase, base, dirty, onChanged }: { supabase: Supabase; base: Quotation; dirty: boolean; onChanged: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: leadInfoKey(base.id), queryFn: () => fetchLeadInfo(supabase, base.id), retry: false, staleTime: 30_000 })
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [due, setDue] = useState('')
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<SalesLead[] | null>(null)
  const [brief, setBrief] = useState(false)

  const info = q.data
  const lead = info?.lead ?? null
  const may = base.may_edit
  const today = istToday()
  // Only the log fits this page now: Converted and Dead are moved in Lead Management.
  const canLog = !!lead && leadAction(base.status, lead.stage) === 'log'
  const closed = lead ? lead.stage === 'converted' || lead.stage === 'dead' : false
  const leadHref = lead ? `/sales/board?lead=${lead.id}` : ''
  const off = busy || dirty
  const saveFirst = dirty ? 'Save first' : undefined

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
  }

  const doLog = () => lead && info && run(async () => {
    const text = logNote(base.quote_no, info.version_no, info.value)
    await addComment(supabase, lead.id, { note: text, tag: 'quotation', nextDue: due })
    const later = ['new', 'under_process', 'visit_meeting', 'potential'].includes(lead.stage)
    return { tone: 'ok', text: `Logged on the lead. Follow-up ${day(due)}.${later ? ' To move the lead to Negotiation, open it in Lead Management.' : ''}` }
  })

  const cancel = <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setMode(null)}>Cancel</button>

  const statusRow = (
    <div className={s.prow} role="group" aria-label="Status">
      <span className={s.tileLab}>Status</span>
      <div className={s.prc}>
        {lead ? (
          <>
            <StageChip stage={lead.stage} deadReason={lead.dead_reason} />
            <span className={s.leadMeta}><Lock size={13} aria-hidden /> Comes from the lead. Changed only in Lead Management.</span>
            <span className={s.spacer} />
            <Link href={leadHref} className={`${s.btn} ${s.btnSm} ${s.btnQuiet}`}>Open in Lead Management <ExternalLink size={13} aria-hidden /></Link>
          </>
        ) : (
          <>
            <StatusPill status={base.status} />
            <span className={s.leadMeta}>{info?.linked ? 'The lead’s stage shows here once you can open the lead.' : 'Link a lead to follow its status here.'}</span>
          </>
        )}
      </div>
    </div>
  )

  // Not set up yet (the database part is not applied), or no Sales at all and no lead: the status row only.
  if (!info || (!info.sales_open && !info.linked)) return statusRow

  return (
    <>
      {statusRow}
      <div className={s.prow} role="group" aria-label="Lead">
        <span className={s.tileLab}>Lead</span>
        <div className={s.pcol}>
          <div className={s.prc}>
            {lead ? (
              <>
                <button type="button" className={s.leadBtn} aria-haspopup="dialog" onClick={() => setBrief(true)}>
                  <span className={s.leadNo}>#{lead.lead_no}</span> {lead.name?.trim() || 'No name yet'} <ChevronDown size={14} aria-hidden />
                </button>
                <span className={s.leadMeta}>
                  Held by {lead.holder_name ?? 'nobody yet'}
                  {!closed && lead.next_due_on ? ` · follow-up ${day(lead.next_due_on)}` : ''}
                  {(base.status === 'sent' || base.status === 'negotiating') && !closed
                    ? ` · ${lead.last_logged_at ? `logged on the lead ${ago(lead.last_logged_at, today)}` : 'not logged on the lead yet'}` : ''}
                </span>
                <span className={s.spacer} />
                {canLog && lead.may_work && mode === null && (
                  <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={off} title={saveFirst ?? `Writes ${base.quote_no}${info.version_no ? ` v${info.version_no}` : ''} on the lead and sets its follow-up.`} onClick={() => open('log')}>Log on the lead</button>
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

          {lead && canLog && !lead.may_work && (
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

          {msg && <div role="status" className={`${s.notice} ${msg.tone === 'ok' ? s.noticeOk : msg.tone === 'warn' ? s.noticeWarn : s.noticeBad}`}>
            {msg.text}{lead && msg.tone === 'warn' ? <> <Link href={leadHref}>Open the lead</Link></> : null}</div>}
        </div>
      </div>
      {brief && lead && <LeadBrief supabase={supabase} leadId={lead.id} leadNo={lead.lead_no} name={lead.name} onClose={() => setBrief(false)} />}
    </>
  )
}
