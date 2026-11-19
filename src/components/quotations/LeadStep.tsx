'use client'

// Step one of every new quotation (owner, 20 Nov 2026): CHOOSE THE SALES LEAD. The quotation is then made FROM it: the client's name,
// phone, city, venue and requirement come from the lead, nothing is typed (quotation_start, 20270814000000). The list is the leads the
// person may see (their own; the whole team for a manager or Admin), newest first; typing searches name, number and phone.
//
// An administrator or the pricing desk may also put the quotation on somebody else's page ("On whose page?"): an Excel quotation the owner
// received for a salesperson belongs to that salesperson's My quotations. The person defaults to the lead's holder.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { fetchLeadPage, type SalesLead } from '@/lib/salesLeads/api'
import { fetchMakers, makersKey, errorText } from '@/lib/quotations/api'
import { formatPhone } from '@/lib/exhibitionLeads/phone'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export type StartChoice = { lead: SalesLead; ownerId: string | null; alreadySent: boolean }

export const leadName = (l: Pick<SalesLead, 'name' | 'lead_no'>) => l.name?.trim() || `Lead ${l.lead_no}`

export function LeadStep({ supabase, userId, canAssign, title, action, askSent, onClose, onPick }: {
  supabase: Supabase; userId: string
  /** An administrator or the pricing desk: may put the quotation on a salesperson's page. */
  canAssign: boolean
  title: string
  /** The primary button. */
  action: string
  /** Offer "Already sent to the client" (an Excel quotation that has already gone out). */
  askSent?: boolean
  onClose: () => void
  onPick: (c: StartChoice) => Promise<void>
}) {
  const [typed, setTyped] = useState('')
  const [term, setTerm] = useState('')
  const [lead, setLead] = useState<SalesLead | null>(null)
  const [owner, setOwner] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { const t = setTimeout(() => setTerm(typed.trim()), 250); return () => clearTimeout(t) }, [typed])

  const found = useQuery({
    queryKey: ['quotations', 'lead-pick', term], staleTime: 30_000, retry: false,
    queryFn: () => fetchLeadPage(supabase, { period: 'all', from: '', to: '', holder: '', source: '', q: term, limit: 8, offset: 0 }),
  })
  const makers = useQuery({ queryKey: makersKey, queryFn: () => fetchMakers(supabase), enabled: canAssign, staleTime: 300_000, retry: false })

  const people = makers.data ?? []
  // Default: the lead's holder when that person can own quotations, else the person asking.
  const holderOk = !!lead?.assigned_to && people.some(p => p.id === lead.assigned_to)
  const chosenOwner = owner || (holderOk ? lead!.assigned_to! : userId)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!lead) { setErr('Choose the lead first.'); return }
    setBusy(true); setErr('')
    try { await onPick({ lead, ownerId: canAssign && chosenOwner !== userId ? chosenOwner : null, alreadySent: !!askSent && sent }) }
    catch (x) { setErr(errorText(x)); setBusy(false) }
  }

  // A tap outside or Escape closes it only while nothing is chosen.
  const holding = busy || !!lead
  const dialogRef = useDialogFocus<HTMLFormElement>(() => { if (!holding) onClose() })

  return (
    <div className={s.scrim} onClick={holding ? undefined : onClose}>
      <form ref={dialogRef} tabIndex={-1} className={s.modal} onClick={e => e.stopPropagation()} onSubmit={submit} aria-labelledby="leadstep-title">
        <div className={s.cardHead}><h2 id="leadstep-title">{title}</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <p className={`${s.small} ${s.muted}`} style={{ margin: 0 }}>Every quotation starts from a lead in Sales. Choose it and the client&apos;s details come across by themselves.</p>

          {!lead && (
            <>
              <label className={s.search} style={{ position: 'relative' }}>
                <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--boe-text-muted)' }} aria-hidden />
                <input id="leadstep-search" className={s.input} style={{ paddingLeft: 32 }} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search a lead by name, number or phone" aria-label="Search leads" autoFocus autoComplete="off" />
              </label>
              {found.isLoading && <div className={`${s.small} ${s.muted}`}>Loading leads…</div>}
              {found.isError && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{errorText(found.error)}</div>}
              {found.data && found.data.rows.length === 0 && <div className={`${s.small} ${s.muted}`}>{term ? 'No lead you can see matches that.' : 'No leads to show yet. Add the lead in Sales first.'}</div>}
              {found.data && found.data.rows.length > 0 && (
                <ul className={s.pickList}>
                  {found.data.rows.map(l => (
                    <li key={l.id}>
                      <button type="button" className={s.pickRow} onClick={() => { setLead(l); setErr('') }}>
                        <span className={s.pickName}>{leadName(l)}</span>
                        <span className={`${s.small} ${s.muted}`}>Lead {l.lead_no} · {formatPhone(l.phone)}{l.location ? ` · ${l.location}` : ''}</span>
                        <span className={`${s.small} ${s.muted}`}>Held by {l.holder_name ?? 'nobody yet'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {lead && (
            <>
              <div className={s.fromLead}>
                <div className={s.row}><b>{leadName(lead)}</b><span className={`${s.small} ${s.muted}`}>Lead {lead.lead_no}</span><span className={s.spacer} />
                  <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => { setLead(null); setOwner('') }}>Change lead</button></div>
                <dl className={s.fromLeadList}>
                  <dt>Phone</dt><dd>{formatPhone(lead.phone)}</dd>
                  {lead.email && <><dt>E-mail</dt><dd>{lead.email}</dd></>}
                  {lead.location && <><dt>City</dt><dd>{lead.location}</dd></>}
                  {lead.requirement && <><dt>Needs</dt><dd className={s.clamp}>{lead.requirement}</dd></>}
                  <dt>Held by</dt><dd>{lead.holder_name ?? 'nobody yet'}</dd>
                </dl>
                <p className={`${s.small} ${s.muted}`} style={{ margin: 0 }}>These are copied into the quotation. You can still correct them in the builder.</p>
              </div>
              {canAssign && people.length > 0 && (
                <label className={s.field}><span>On whose page?</span>
                  <select id="leadstep-owner" className={s.input} value={chosenOwner} onChange={e => setOwner(e.target.value)} disabled={busy}>
                    {people.map(p => <option key={p.id} value={p.id}>{p.full_name ?? 'Unnamed'}{p.id === userId ? ' (me)' : ''}{p.id === lead.assigned_to ? ' · holds the lead' : ''}</option>)}
                  </select>
                </label>
              )}
              {askSent && (
                <label className={s.row} style={{ gap: 8 }}><input type="checkbox" checked={sent} onChange={e => setSent(e.target.checked)} disabled={busy} /><span>Already sent to the client</span></label>
              )}
            </>
          )}
          {err && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{err}</div>}
        </div>
        <div className={s.cardHead} style={{ borderTop: '1px solid var(--boe-border)', borderBottom: 0, justifyContent: 'flex-end' }}>
          <button type="button" className={s.btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={busy || !lead}>{busy ? 'Starting…' : action}</button>
        </div>
      </form>
    </div>
  )
}
