'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import type { createClient } from '@/lib/supabase/client'
import {
  BUYING_TIMELINES, CLIENT_TYPES, LEAD_TYPES, REQUIREMENTS, STATUSES,
  isTerminalStatus, labelOf, requirementsLabel, type Lead, type LeadEvent, type LeadStatus,
} from '@/lib/exhibitionLeads/constants'
import {
  EXHIBITION_LEADS_KEY, archiveLead, fetchLead, fetchPeople, reassignLead, restoreLead, updateLead,
  LeadRequestError,
} from '@/lib/exhibitionLeads/api'
import { formatPhone, normalizeLeadPhone } from '@/lib/exhibitionLeads/phone'
import { istDateTime, longDate } from '@/lib/exhibitionLeads/format'
import { MAX_CITY, MAX_COMPANY, MAX_NAME, MAX_NOTE, MAX_OTHER, toggleRequirement } from '@/lib/exhibitionLeads/validation'
import { istToday } from '@/lib/istDate'
import { ChoiceGroup } from './ChoiceGroup'
import { ContactActions, LeadTypeBadge, StatusBadge } from './LeadBits'
import s from './leads.module.css'

type Supabase = ReturnType<typeof createClient>

function describeEvent(e: LeadEvent): string {
  const d = e.detail as Record<string, string | string[] | null | undefined>
  const status = (v: unknown) => labelOf(STATUSES, typeof v === 'string' ? v : null)
  switch (e.event_type) {
    case 'created': return 'Lead created'
    case 'details_edited': return `Details edited (${((d.fields as string[]) ?? []).join(', ').replaceAll('_', ' ')})`
    case 'status_changed': return `Status: ${status(d.from)} → ${status(d.to)}`
    case 'follow_up_changed':
      return d.to ? `Next follow-up set to ${longDate(String(d.to))}` : 'Follow-up schedule cleared'
    case 'note': return 'Note added'
    case 'reassigned': return 'Reassigned to another owner'
    case 'archived': return 'Archived'
    case 'restored': return 'Restored'
  }
}

type Result = { ok: boolean; text: string } | null

export default function LeadDetailSheet({
  leadId, supabase, isAdmin, onClose,
}: { leadId: string; supabase: Supabase; isAdmin: boolean; onClose: () => void }) {
  // Lifted out of SheetBody: a save refetches the lead, which remounts the body
  // (so its fields reset to what is now stored) and must not wipe the message.
  const [result, setResult] = useState<Result>(null)
  const q = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'lead', leadId],
    queryFn: () => fetchLead(supabase, leadId),
  })

  return (
    <ReviewSheet
      title={q.data?.lead.contact_name ?? 'Lead'}
      subtitle={q.data?.lead.company_name ?? undefined}
      onClose={onClose}
      dismissOnBackdrop={false}
      maxWidth="640px"
    >
      {q.isLoading && <div className={s.skeleton} aria-busy="true" />}
      {q.error && (
        <div className={`${s.notice} ${s.noticeErr}`} role="alert">
          {(q.error as LeadRequestError).message}
          <div className={s.noticeActions}>
            <button className={s.btn} onClick={() => q.refetch()}>Try again</button>
          </div>
        </div>
      )}
      {q.data && (
        <SheetBody
          key={`${q.data.lead.id}:${q.data.lead.updated_at}:${q.data.lead.archived_at ?? ''}:${q.data.events.length}`}
          lead={q.data.lead}
          events={q.data.events}
          supabase={supabase}
          isAdmin={isAdmin}
          result={result}
          setResult={setResult}
        />
      )}
    </ReviewSheet>
  )
}

function SheetBody({
  lead, events, supabase, isAdmin, result, setResult,
}: {
  lead: Lead; events: LeadEvent[]; supabase: Supabase; isAdmin: boolean
  result: Result; setResult: (r: Result) => void
}) {
  const qc = useQueryClient()
  const today = istToday()
  const archived = !!lead.archived_at

  const [name, setName] = useState(lead.contact_name)
  const [phone, setPhone] = useState(formatPhone(lead.phone))
  const [clientType, setClientType] = useState<string>(lead.client_type)
  const [clientOther, setClientOther] = useState(lead.client_type_other ?? '')
  const [reqs, setReqs] = useState<string[]>(lead.requirements)
  const [company, setCompany] = useState(lead.company_name ?? '')
  const [city, setCity] = useState(lead.project_city ?? '')
  const [timeline, setTimeline] = useState<string>(lead.buying_timeline ?? '')
  const [leadType, setLeadType] = useState<string>(lead.lead_type)
  const [status, setStatus] = useState<string>(lead.status)
  const [nextOn, setNextOn] = useState(lead.next_follow_up_on ?? '')
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const terminal = isTerminalStatus(status)

  const save = useMutation({
    mutationFn: async () => {
      const e: Record<string, string> = {}
      if (!name.trim()) e.name = 'Enter the contact name'
      const normalized = normalizeLeadPhone(phone)
      if (!normalized) e.phone = 'Enter a valid mobile number'
      if (reqs.length === 0) e.reqs = 'Choose at least one requirement'
      if (clientType === 'other' && !clientOther.trim()) e.other = 'Say what kind of client this is'
      if (status === 'follow_up' && !nextOn) e.nextOn = 'Choose the next follow-up date'
      if (!terminal && nextOn && nextOn !== (lead.next_follow_up_on ?? '') && nextOn < today) {
        e.nextOn = 'The follow-up date cannot be in the past'
      }
      setErrors(e)
      if (Object.keys(e).length) throw new LeadRequestError({ kind: 'invalid', message: 'Fix the highlighted fields.' })

      const changes: Record<string, unknown> = {}
      if (name.trim() !== lead.contact_name) changes.contact_name = name.trim()
      if (normalized !== lead.phone) changes.phone = normalized
      if (clientType !== lead.client_type) changes.client_type = clientType
      if (clientType === 'other' && clientOther.trim() !== (lead.client_type_other ?? '')) changes.client_type_other = clientOther.trim()
      if ([...reqs].sort().join() !== [...lead.requirements].sort().join()) changes.requirements = reqs
      if (company.trim() !== (lead.company_name ?? '')) changes.company_name = company.trim()
      if (city.trim() !== (lead.project_city ?? '')) changes.project_city = city.trim()
      if (timeline !== (lead.buying_timeline ?? '')) changes.buying_timeline = timeline
      if (leadType !== lead.lead_type) changes.lead_type = leadType
      if (status !== lead.status) changes.status = status
      if (!terminal && nextOn !== (lead.next_follow_up_on ?? '')) changes.next_follow_up_on = nextOn || null
      if (Object.keys(changes).length === 0 && !note.trim()) {
        throw new LeadRequestError({ kind: 'invalid', message: 'Nothing has changed yet.' })
      }
      return updateLead(supabase, lead.id, changes, note.trim() || null)
    },
    onSuccess: () => {
      setResult({ ok: true, text: 'Saved.' })
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    },
    onError: err => setResult({ ok: false, text: (err as Error).message }),
  })

  const people = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'people', lead.exhibition_id],
    queryFn: () => fetchPeople(supabase, lead.exhibition_id),
    enabled: isAdmin,
  })
  const [newOwner, setNewOwner] = useState('')
  const [reason, setReason] = useState('')
  const admin = useMutation({
    mutationFn: async (kind: 'reassign' | 'archive' | 'restore') => {
      if (kind === 'reassign') return reassignLead(supabase, lead.id, newOwner, null)
      if (kind === 'archive') return archiveLead(supabase, lead.id, reason)
      return restoreLead(supabase, lead.id)
    },
    onSuccess: (_d, kind) => {
      setResult({ ok: true, text: kind === 'reassign' ? 'Reassigned.' : kind === 'archive' ? 'Archived.' : 'Restored.' })
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    },
    onError: err => setResult({ ok: false, text: (err as Error).message }),
  })

  const eligible = useMemo(
    () => (people.data ?? []).filter(p => p.eligible && p.id !== lead.owner_id),
    [people.data, lead.owner_id],
  )
  const busy = save.isPending || admin.isPending
  const err = (k: string) => errors[k] && <div className={s.err} role="alert">{errors[k]}</div>

  return (
    <>
      <div className={s.sheetSection}>
        <div className={s.phoneText}>{formatPhone(lead.phone)}</div>
        <div className={s.contactRow}><ContactActions phone={lead.phone} /></div>
        <div className={s.cardMeta}>
          <StatusBadge status={lead.status} /> <LeadTypeBadge leadType={lead.lead_type} />
          {archived && <span className={`${s.badge} ${s.badgeMuted}`}>Archived</span>}
        </div>
        <div className={s.facts}>
          <span>Added <b>{istDateTime(lead.created_at)}</b></span>
          <span>Collected by <b>{lead.collected_by_name ?? '—'}</b></span>
          <span>Current owner <b>{lead.owner_name ?? '—'}</b></span>
          <span>{requirementsLabel(lead.requirements)}</span>
        </div>
        {lead.initial_note && (
          <div className={s.historyNote}><span className={s.hint}>First discussion note</span><br />{lead.initial_note}</div>
        )}
        {archived && (
          <div className={`${s.notice} ${s.noticeWarn}`}>Archived: {lead.archive_reason}. An archived lead cannot be edited.</div>
        )}
      </div>

      {result && (
        <div className={`${s.notice} ${result.ok ? s.noticeOk : s.noticeErr}`} role={result.ok ? 'status' : 'alert'}>{result.text}</div>
      )}

      {!archived && (
        <form
          className={s.sheetSection}
          onSubmit={ev => { ev.preventDefault(); setResult(null); save.mutate() }}
          noValidate
        >
          <div className={s.sheetTitle}>Update</div>

          <div className={s.field}>
            <label className={s.label} htmlFor="ed-status">Status</label>
            <select id="ed-status" className={s.select} value={status} onChange={e => setStatus(e.target.value as LeadStatus)}>
              {STATUSES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="ed-next">
              Next follow-up date{status === 'follow_up' && <span className={s.req} aria-hidden="true">*</span>}
            </label>
            <input
              id="ed-next" type="date" className={`${s.input}${errors.nextOn ? ` ${s.invalid}` : ''}`}
              value={terminal ? '' : nextOn} disabled={terminal}
              min={nextOn && nextOn < today ? undefined : today}
              onChange={e => setNextOn(e.target.value)}
              aria-invalid={!!errors.nextOn}
            />
            {terminal && <div className={s.hint}>Closing a lead clears its follow-up date. The change stays in the history.</div>}
            {err('nextOn')}
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="ed-note">Add follow-up note</label>
            <textarea
              id="ed-note" className={s.textarea} value={note} maxLength={MAX_NOTE}
              onChange={e => setNote(e.target.value)} placeholder="What was discussed or agreed?"
            />
            <div className={s.hint}>Earlier notes are kept; this one is added to the history.</div>
          </div>

          <div className={s.sheetTitle}>Contact and classification</div>
          <div className={s.field}>
            <label className={s.label} htmlFor="ed-name">Contact name<span className={s.req} aria-hidden="true">*</span></label>
            <input id="ed-name" className={`${s.input}${errors.name ? ` ${s.invalid}` : ''}`} value={name} maxLength={MAX_NAME} onChange={e => setName(e.target.value)} />
            {err('name')}
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="ed-phone">Mobile / WhatsApp<span className={s.req} aria-hidden="true">*</span></label>
            <input id="ed-phone" className={`${s.input}${errors.phone ? ` ${s.invalid}` : ''}`} type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} />
            {err('phone')}
          </div>
          <div className={s.field}>
            <span className={s.label}>Client type</span>
            <ChoiceGroup name="ed-type" legend="Client type" options={CLIENT_TYPES} value={clientType} onChange={setClientType} />
            {clientType === 'other' && (
              <>
                <label className={s.label} htmlFor="ed-other">What kind of client?<span className={s.req} aria-hidden="true">*</span></label>
                <input id="ed-other" className={`${s.input}${errors.other ? ` ${s.invalid}` : ''}`} value={clientOther} maxLength={MAX_OTHER + 20} onChange={e => setClientOther(e.target.value)} />
                {err('other')}
              </>
            )}
          </div>
          <div className={s.field}>
            <span className={s.label}>Requirement<span className={s.req} aria-hidden="true">*</span></span>
            <ChoiceGroup
              name="ed-req" legend="Requirement" options={REQUIREMENTS} multiple value={reqs} invalid={!!errors.reqs}
              onChange={v => setReqs(toggleRequirement(reqs as never, v as never))}
            />
            {err('reqs')}
          </div>
          <div className={s.grid2}>
            <div className={s.field}>
              <label className={s.label} htmlFor="ed-company">Company / project</label>
              <input id="ed-company" className={s.input} value={company} maxLength={MAX_COMPANY} onChange={e => setCompany(e.target.value)} />
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="ed-city">City</label>
              <input id="ed-city" className={s.input} value={city} maxLength={MAX_CITY} onChange={e => setCity(e.target.value)} />
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="ed-timeline">Buying timeline</label>
              <select id="ed-timeline" className={s.select} value={timeline} onChange={e => setTimeline(e.target.value)}>
                <option value="">Not recorded</option>
                {BUYING_TIMELINES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="ed-leadtype">Lead type<span className={s.req} aria-hidden="true">*</span></label>
              <select id="ed-leadtype" className={s.select} value={leadType} onChange={e => setLeadType(e.target.value)}>
                {LEAD_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <div className={s.hint}>{LEAD_TYPES.find(o => o.value === leadType)?.hint}</div>
            </div>
          </div>

          <div className={s.sheetFooter}>
            <button type="submit" className={`${s.btn} ${s.btnRed}`} disabled={busy}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      )}

      {isAdmin && (
        <div className={s.sheetSection}>
          <div className={s.sheetTitle}>Admin</div>
          {!archived && (
            <>
              <div className={s.field}>
                <label className={s.label} htmlFor="ed-owner">Reassign current owner</label>
                <div className={s.dateRow}>
                  <select id="ed-owner" className={s.select} style={{ flex: 1 }} value={newOwner} onChange={e => setNewOwner(e.target.value)}>
                    <option value="">Choose a salesperson…</option>
                    {eligible.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button className={s.btn} disabled={!newOwner || busy} onClick={() => { setResult(null); admin.mutate('reassign') }}>Reassign</button>
                </div>
                <div className={s.hint}>The collection credit stays with {lead.collected_by_name ?? 'the original collector'}.</div>
              </div>
              <div className={s.field}>
                <label className={s.label} htmlFor="ed-reason">Archive (invalid, test or duplicate)</label>
                <div className={s.dateRow}>
                  <input id="ed-reason" className={s.input} style={{ flex: 1 }} value={reason} maxLength={500} placeholder="Reason (required)" onChange={e => setReason(e.target.value)} />
                  <button className={s.btn} disabled={reason.trim().length < 3 || busy} onClick={() => { setResult(null); admin.mutate('archive') }}>Archive</button>
                </div>
              </div>
            </>
          )}
          {archived && (
            <button className={s.btn} disabled={busy} onClick={() => { setResult(null); admin.mutate('restore') }}>Restore this lead</button>
          )}
        </div>
      )}

      <div className={s.sheetSection}>
        <div className={s.sheetTitle}>History</div>
        <ul className={s.history}>
          {events.map(e => (
            <li key={e.id} className={s.historyItem}>
              <div>{describeEvent(e)}</div>
              {e.note && <div className={s.historyNote}>{e.note}</div>}
              <div className={s.historyWhen}>{istDateTime(e.created_at)} · {e.actor_name ?? 'Unknown'}</div>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
