'use client'

import { AppLink as Link } from '@/components/ui/AppLink'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ExternalLink, Info } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { checkPhone, SALES_KEY, type SalesLead } from '@/lib/salesLeads/api'
import { COUNTRY_CODES, LEAD_SOURCES, MAX_EMAIL, MAX_LOCATION, MAX_NAME, MAX_REQUIREMENT, sourceLabel } from '@/lib/salesLeads/constants'
import { dayLabel } from '@/lib/salesLeads/format'
import { formatPhone, joinPhone, normalizeLeadPhone } from '@/lib/exhibitionLeads/phone'
import { istDateOf } from '@/lib/istDate'
import { numberError, type LeadForm, type LeadFormErrors } from '@/lib/salesLeads/validation'
import s from './salesLeads.module.css'

type Supabase = ReturnType<typeof createClient>

// ── The number: one format, and the register's one-lead-per-number rule, checked as you type ──────────

export type PhoneStatus =
  | { kind: 'empty' }
  | { kind: 'bad'; message: string }
  | { kind: 'checking' }
  | { kind: 'free'; e164: string }
  | { kind: 'taken'; e164: string; lead: SalesLead }
  /** The check could not run (offline, say). The database still decides when the lead is saved. */
  | { kind: 'unknown'; e164: string }

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * What the number typed so far means. `ignoreId` is the lead being edited: its own number is not "taken".
 * The answer is never reused (gcTime 0): somebody may add the number between two looks.
 */
export function usePhoneStatus(supabase: Supabase, countryCode: string, number: string, ignoreId?: string): PhoneStatus {
  const typed = number.trim() !== ''
  const error = typed ? numberError(countryCode, number) : null
  const e164 = typed && !error ? normalizeLeadPhone(joinPhone(countryCode, number)) : null
  const settled = useDebounced(e164, 350)
  const query = useQuery({
    queryKey: [SALES_KEY, 'phone', settled],
    queryFn: () => checkPhone(supabase, settled as string),
    enabled: settled !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  if (!typed) return { kind: 'empty' }
  if (error || !e164) return { kind: 'bad', message: error ?? 'Enter a valid mobile number' }
  if (settled !== e164 || query.isPending) return { kind: 'checking' }
  if (query.isError) return { kind: 'unknown', e164 }
  const result = query.data
  if (result.state === 'exists' && result.lead.id !== ignoreId) return { kind: 'taken', e164, lead: result.lead }
  return { kind: 'free', e164 }
}

/** True when the number may go to the database: valid, and not known to be taken. */
export const phoneCanSave = (p: PhoneStatus) => p.kind === 'free' || p.kind === 'unknown'

export function DupCallout({ lead, onRepeat }: { lead: SalesLead; onRepeat?: (lead: SalesLead) => Promise<void> }) {
  const [repeat, setRepeat] = useState<'idle' | 'saving' | 'done' | 'failed'>('idle')
  async function record() {
    if (!onRepeat) return
    setRepeat('saving')
    try {
      await onRepeat(lead)
      setRepeat('done')
    } catch {
      setRepeat('failed')
    }
  }
  return (
    <div className={`boe-callout boe-callout-warning ${s.dup} ${s.dupOn}`} role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <span className="boe-callout-title">This number is already in Lead Master</span>
        <div className={s.dupLines}>
          <div>
            <b>Lead #{lead.lead_no}</b> · received {dayLabel(lead.received_on)} · {sourceLabel(lead.source)}
            {lead.name ? ` · ${lead.name}` : ''}
          </div>
          <div>
            {lead.holder_name
              ? <>Allotted to <b>{lead.holder_name}</b>{lead.assigned_at ? <> since {dayLabel(istDateOf(lead.assigned_at))}</> : null}</>
              : <b>Not allotted yet</b>}
          </div>
        </div>
        {/* 'stage' only comes back for a lead this person may open (sales_lead_json). */}
        {'stage' in lead && lead.assigned_to && (
          <Link className={s.openLink} href={`/sales/board?lead=${lead.id}`}>Open lead #{lead.lead_no} <ExternalLink aria-hidden="true" size={13} /></Link>
        )}
        <div className={s.dupFoot}>
          Nothing was saved. If this is a different customer, check the number.
          {lead.holder_name ? ` Otherwise ask ${lead.holder_name} about this lead.` : ' Otherwise it is still waiting to be allotted.'}
          {onRepeat && (
            <div className={s.repeat}>
              {repeat === 'done'
                ? <span role="status">Recorded{lead.holder_name ? `. ${lead.holder_name} sees it at the top of their day.` : '.'}</span>
                : <button type="button" className="boe-btn boe-btn-secondary" disabled={repeat === 'saving'} onClick={() => void record()}>{repeat === 'saving' ? 'Saving…' : 'Same customer: record a repeat enquiry'}</button>}
              {repeat === 'failed' && <span role="alert">That did not save. Try again.</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PhoneNote({ status }: { status: PhoneStatus }) {
  switch (status.kind) {
    case 'empty':
      return <div className={s.status}><Info aria-hidden="true" />Type the number as you have it. It is saved in one format.</div>
    case 'bad':
      return <div className={`${s.status} ${s.statusBad}`}><AlertTriangle aria-hidden="true" />{status.message}</div>
    case 'checking':
      return <div className={s.status}><Info aria-hidden="true" />Checking the number…</div>
    case 'free':
      return <div className={`${s.status} ${s.statusOk}`}><Check aria-hidden="true" />New number. Saved as <b>{formatPhone(status.e164)}</b></div>
    case 'taken':
      return <div className={s.status}><Info aria-hidden="true" />Saved format: <b>{formatPhone(status.e164)}</b></div>
    case 'unknown':
      return <div className={s.status}><Info aria-hidden="true" />Could not check this number just now. It is checked again when you save.</div>
  }
}

type PatchProps = { form: LeadForm; onChange: (patch: Partial<LeadForm>) => void }

export function PhoneField({ form, onChange, status, inputId, onRepeat }: PatchProps & { status: PhoneStatus; inputId: string; onRepeat?: (lead: SalesLead) => Promise<void> }) {
  const tone = status.kind === 'bad' ? ` ${s.inputBad}` : status.kind === 'taken' ? ` ${s.inputDup}` : ''
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={inputId}>Mobile number<span className="boe-req" aria-hidden="true">*</span></label>
      <div className={s.phoneRow}>
        <select
          className={`boe-input ${s.input}`}
          aria-label="Country code"
          value={form.countryCode}
          onChange={e => onChange({ countryCode: e.target.value })}
        >
          {COUNTRY_CODES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input
          id={inputId}
          className={`boe-input ${s.input} ${s.inputPhone}${tone}`}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="98765 43210"
          value={form.number}
          aria-invalid={status.kind === 'bad'}
          onChange={e => onChange({ number: e.target.value })}
        />
      </div>
      <PhoneNote status={status} />
      {status.kind === 'taken' && <DupCallout lead={status.lead} onRepeat={onRepeat} />}
    </div>
  )
}

function FieldError({ text }: { text?: string }) {
  return text ? <div className={`${s.status} ${s.statusBad}`} role="alert"><AlertTriangle aria-hidden="true" />{text}</div> : null
}

export function SourceField({ form, onChange, error }: PatchProps & { error?: string }) {
  return (
    <div className={s.field}>
      <div className={s.label} id="sales-source-label">Lead source<span className="boe-req" aria-hidden="true">*</span></div>
      <div className={s.choices} role="group" aria-labelledby="sales-source-label">
        {LEAD_SOURCES.map(o => (
          <button
            key={o.value}
            type="button"
            className={s.choice}
            aria-pressed={form.source === o.value}
            onClick={() => onChange({ source: form.source === o.value ? '' : o.value })}
          >
            {o.label}
          </button>
        ))}
      </div>
      <FieldError text={error} />
    </div>
  )
}

/** Name, email, location and requirement: everything a lead can be saved without. */
export function DetailFields({ form, onChange, errors, idPrefix }: PatchProps & { errors: LeadFormErrors; idPrefix: string }) {
  return (
    <>
      <div className={s.grid2}>
        <div className={s.field}>
          <label className={s.label} htmlFor={`${idPrefix}-name`}>Name</label>
          <input id={`${idPrefix}-name`} className={`boe-input ${s.input}`} type="text" autoComplete="off" maxLength={MAX_NAME + 20} value={form.name} onChange={e => onChange({ name: e.target.value })} />
          <FieldError text={errors.name} />
        </div>
        <div className={s.field}>
          <label className={s.label} htmlFor={`${idPrefix}-email`}>Email</label>
          <input id={`${idPrefix}-email`} className={`boe-input ${s.input}`} type="email" autoComplete="off" maxLength={MAX_EMAIL + 20} value={form.email} onChange={e => onChange({ email: e.target.value })} />
          <FieldError text={errors.email} />
        </div>
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor={`${idPrefix}-location`}>Location</label>
        <input id={`${idPrefix}-location`} className={`boe-input ${s.input}`} type="text" autoComplete="off" placeholder="City or country" maxLength={MAX_LOCATION + 20} value={form.location} onChange={e => onChange({ location: e.target.value })} />
        <FieldError text={errors.location} />
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor={`${idPrefix}-requirement`}>Requirement or message</label>
        <textarea id={`${idPrefix}-requirement`} className={`boe-input ${s.input}`} rows={3} placeholder="What they asked for, or paste their message" maxLength={MAX_REQUIREMENT + 200} value={form.requirement} onChange={e => onChange({ requirement: e.target.value })} />
        <FieldError text={errors.requirement} />
      </div>
    </>
  )
}
