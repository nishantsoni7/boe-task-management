'use client'

// The Status and Lead rows of the properties panel (the card was owner-approved 19 Nov 2026, migration 20270811000000; rows of the panel since 25 Nov 2026).
// STATUS is the lead's stage, read only: a chip, a five-step meter while the lead is on the path of a sale, and a link to Lead Board, where the status is
// changed (owner, 25 Nov 2026: one status, no status buttons on this page). LEAD is the Sales lead the quotation came from, who holds it, when the
// follow-up is due, and the one lead action that is not a status change: "Log on the lead" (add_sales_lead_comment writes the quotation on the lead and sets
// its follow-up, with the lead's own permission rules). Linking, suggesting a lead and Unlink are unchanged.

import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, CalendarDays, CircleDot, Link2 } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { createClient } from '@/lib/supabase/client'
import { istToday } from '@/lib/istDate'
import { fetchLeadInfo, leadInfoKey, linkLead, type Quotation, type LeadSummary } from '@/lib/quotations/api'
import { FOLLOW_UP_DAYS, followUpDefault, leadAction, logNote } from '@/lib/quotations/leadLink'
import { PATH_STAGES, STAGES, deadReasonLabel, stageLabel, type Stage } from '@/lib/salesLeads/board'
import { addComment, fetchLeadPage, type SalesLead } from '@/lib/salesLeads/api'
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

/** The chip's colour: green once converted, grey when dead, amber while parked; the stages of a sale are blue. */
const stageTone = (stage: string) => (stage === 'converted' ? s.stageDone : stage === 'dead' ? s.stageDead : stage === 'follow_up_later' ? s.stageLater : '')

export function LeadCard({ supabase, base, dirty, onChanged }: { supabase: Supabase; base: Quotation; dirty: boolean; onChanged: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: leadInfoKey(base.id), queryFn: () => fetchLeadInfo(supabase, base.id), retry: false, staleTime: 30_000 })
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [due, setDue] = useState('')
  const [search, setSearch] = useState('')
  const [found, setFound] = useState<SalesLead[] | null>(null)

  const info = q.data
  // Not set up yet (the database part is not applied), or nothing to say: no rows.
  if (!info || (!info.sales_open && !info.linked)) return null

  const lead = info.lead
  const may = base.may_edit
  const today = istToday()
  const act = lead ? leadAction(base.status, lead.stage) : null
  const canLog = act === 'log'
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
  }

  const doLog = () => lead && run(async () => {
    const text = logNote(base.quote_no, info.version_no, info.value)
    await addComment(supabase, lead.id, { note: text, tag: 'quotation', nextDue: due })
    const later = ['new', 'under_process', 'visit_meeting', 'potential'].includes(lead.stage)
    return { tone: 'ok', text: `Logged on the lead. Follow-up ${day(due)}.${later ? ' To move the lead to Negotiation, open it and use its status.' : ''}` }
  })

  const label = lead ? title(lead) : ''
  const cancel = <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setMode(null)}>Cancel</button>
  const unlink = may && <button type="button" className={s.propQuiet} disabled={off} title={saveFirst} onClick={() => doLink(null)}>Unlink</button>

  return (
    <>
      {lead && (
        <div className={s.prop} role="group" aria-label="Status">
          <span className={s.propLab}><CircleDot size={16} aria-hidden /> Status</span>
          <div className={s.propVal}>
            <span className={`${s.stage} ${stageTone(lead.stage)}`} title="Set in Lead Board. It shows here and cannot be changed on this page.">
              {stageLabel(lead.stage)}{lead.stage === 'dead' && lead.dead_reason ? ` · ${deadReasonLabel(lead.dead_reason)}` : ''}
            </span>
            {stageAt >= 0 && (
              <>
                <span className={s.meter} role="img" aria-label={`Stage ${stageAt + 1} of ${PATH_STAGES.length}`}
                  title={`Stage ${stageAt + 1} of ${PATH_STAGES.length}: ${PATH_STAGES.map(k => STAGES.find(x => x.key === k)?.label ?? k).join(', ')}`}>
                  {PATH_STAGES.map((k, i) => <i key={k} className={i <= stageAt ? s.meterOn : undefined} />)}
                </span>
                <span className={s.propMuted}>Stage {stageAt + 1} of {PATH_STAGES.length}</span>
              </>
            )}
            <Link href={leadHref} className={s.propLink}>Change in Lead Board <ArrowUpRight size={14} aria-hidden /></Link>
          </div>
        </div>
      )}

      <div className={s.prop} role="group" aria-label="Lead">
        <span className={s.propLab}><Link2 size={16} aria-hidden /> Lead</span>
        <div className={s.propVal}>
          {lead ? (
            <>
              <Link href={leadHref} className={s.propLink}>{label} <ArrowUpRight size={14} aria-hidden /></Link>
              <span className={s.propMuted}>Held by <b style={{ color: 'var(--boe-text)', fontWeight: 600 }}>{lead.holder_name ?? 'nobody yet'}</b></span>
              {!closed && lead.next_due_on && <span className={s.propMuted} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={14} aria-hidden /> Follow-up {day(lead.next_due_on)}</span>}
              {(base.status === 'sent' || base.status === 'negotiating') && !closed && (
                <span className={s.propMuted}>{lead.last_logged_at ? `Logged on the lead ${ago(lead.last_logged_at, today)}` : 'Not logged on the lead yet'}</span>
              )}
              {canLog && lead.may_work && mode === null && (
                <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={off} title={saveFirst ?? `Writes ${base.quote_no}${info.version_no ? ` v${info.version_no}` : ''} on the lead and sets its follow-up.`} onClick={() => open('log')}>Log on the lead</button>
              )}
              {unlink}
            </>
          ) : info.linked ? (
            <>
              <span className={s.propMuted}>Linked to a lead you cannot open{info.sales_open ? '' : ' (your account has no Sales access)'}.</span>
              {unlink}
            </>
          ) : may ? (
            info.suggest ? (
              <>
                <span className={s.propMuted}>Is this the lead? <b style={{ color: 'var(--boe-text)', fontWeight: 600 }}>{title(info.suggest)}</b> · {stageLabel(info.suggest.stage)} · held by {info.suggest.holder_name ?? 'nobody yet'} (same phone)</span>
                <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={off} title={saveFirst} onClick={() => doLink(info.suggest!.id)}>Link this lead</button>
                <button type="button" className={s.propQuiet} disabled={off} title={saveFirst} onClick={() => open('pick')}>Not this one</button>
              </>
            ) : (
              <>
                <span className={s.propMuted}>Not linked to a lead yet.</span>
                <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={off} title={saveFirst} onClick={() => open('pick')}>Link to a lead</button>
              </>
            )
          ) : <span className={s.propMuted}>Not linked to a lead.</span>}
        </div>

        {(mode === 'pick' && may) || (lead && canLog && !lead.may_work) || (lead && mode === 'log') || msg ? (
          <div className={s.propForm}>
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
        ) : null}
      </div>
    </>
  )
}
