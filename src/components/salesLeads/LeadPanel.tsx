'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, X } from 'lucide-react'
import { formatPhone, telHref, whatsappHref } from '@/lib/exhibitionLeads/phone'
import {
  fetchLead, SALES_KEY, SalesRequestError, updateLead,
  type Person, type SalesLead,
} from '@/lib/salesLeads/api'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { dayLabelLong, whenLabel } from '@/lib/salesLeads/format'
import { formFromLead, toInput, validateLead, type LeadForm } from '@/lib/salesLeads/validation'
import { createClient } from '@/lib/supabase/client'
import { AllotPicker, Holder } from './AllotParts'
import { eventBy, eventLine } from './LeadBits'
import { DetailFields, DupCallout, phoneCanSave, PhoneField, SourceField, usePhoneStatus } from './LeadFields'
import { useDialogFocus } from './useDialogFocus'
import s from './salesLeads.module.css'

type Props = {
  leadId: string
  people: Person[]
  canAssign: boolean
  canEdit: boolean
  /** Allotments being saved: lead id → the person it is being saved to. */
  saving: Record<string, string>
  onClose: () => void
  onPick: (lead: SalesLead, personId: string) => void
  onSaved: (text: string, isError?: boolean) => void
}

export function LeadPanel({ leadId, people, canAssign, canEdit, saving, onClose, onPick, onSaved }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [editing, setEditing] = useState(false)
  // Declared before the focus effect below: it must see what had focus BEFORE the close button takes it.
  // Escape closes the panel, except while a lead is being edited (that would throw the typing away).
  const panel = useDialogFocus<HTMLElement>(() => { if (!editing) onClose() })
  const closeButton = useRef<HTMLButtonElement>(null)
  const detail = useQuery({
    queryKey: [SALES_KEY, 'detail', leadId],
    queryFn: () => fetchLead(supabase, leadId),
    staleTime: 0,
  })

  useEffect(() => { closeButton.current?.focus() }, [])

  const lead = detail.data?.lead

  return (
    <>
      <div className={`${s.scrim} ${s.scrimOpen}`} onClick={() => { if (!editing) onClose() }} />
      <aside ref={panel} tabIndex={-1} className={`${s.drawer} ${s.drawerOpen}`} role="dialog" aria-modal="true" aria-labelledby="sales-lead-title">
        <div className={s.drawerHead}>
          <h2 className={s.drawerTitle} id="sales-lead-title">{lead ? `Lead #${lead.lead_no}` : 'Lead'}</h2>
          <button ref={closeButton} type="button" className={s.close} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button>
        </div>

        {detail.isError && (
          <div className={s.drawerBody}>
            <p>This lead could not be loaded.</p>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => detail.refetch()}>Try again</button>
          </div>
        )}
        {!detail.data && !detail.isError && <div className={s.drawerBody}>Loading…</div>}

        {detail.data && lead && !editing && (
          <>
            <div className={s.drawerBody}>
              <div>
                <div className={s.bigPhone}>{formatPhone(lead.phone)}</div>
                <div className={s.contactActions}>
                  <a className="boe-btn boe-btn-secondary" href={telHref(lead.phone)}>Call</a>
                  <a className="boe-btn boe-btn-secondary" href={whatsappHref(lead.phone)} target="_blank" rel="noreferrer">WhatsApp</a>
                </div>
              </div>

              <div>
                <h3 className={s.secTitle}>Allotted to</h3>
                <div className={`${s.holder}${lead.assigned_to ? '' : ` ${s.holderNone}`}`}>
                  <span className="fin-avatar" aria-hidden="true">{lead.holder_name ? lead.holder_name.trim()[0]?.toUpperCase() : '–'}</span>
                  <div>
                    <div className={s.holderName}>{lead.holder_name ?? 'Not allotted yet'}</div>
                    <div className={s.holderSub}>
                      {lead.assigned_to && lead.assigned_at ? `Since ${whenLabel(lead.assigned_at)}` : canAssign ? 'Choose a name to allot it' : 'Nobody holds it yet'}
                    </div>
                  </div>
                  {canAssign && (
                    <span className={s.holderPick}>
                      <AllotPicker lead={lead} people={people} canAssign saving={saving[lead.id]} onPick={id => onPick(lead, id)} />
                    </span>
                  )}
                </div>
              </div>

              <div>
                <h3 className={s.secTitle}>Details</h3>
                <dl className={s.dl}>
                  <dt>Received</dt>
                  <dd><span className={s.lock}>{dayLabelLong(lead.received_on)} <Lock size={12} aria-label="Fixed" /></span></dd>
                  <dt>Source</dt><dd>{sourceLabel(lead.source)}</dd>
                  <dt>Name</dt><dd>{lead.name ?? 'No name'}</dd>
                  <dt>Email</dt><dd>{lead.email ?? '–'}</dd>
                  <dt>Location</dt><dd>{lead.location ?? '–'}</dd>
                  <dt>Requirement</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{lead.requirement ?? '–'}</dd>
                </dl>
              </div>

              <div>
                <h3 className={s.secTitle}>History</h3>
                <ul className={s.timeline}>
                  {detail.data.events.map((e, i) => (
                    <li key={i}>
                      {eventLine(e)}
                      <small>{eventBy(e)} · {whenLabel(e.at)}</small>
                    </li>
                  ))}
                </ul>
              </div>

              {detail.data.lead.assigned_to && (
                <Link className="boe-btn boe-btn-secondary" href={`/sales/board?lead=${detail.data.lead.id}`}>Open on the Lead Board</Link>
              )}
            </div>
            {canEdit && (
              <div className={s.drawerFoot}>
                <button type="button" className="boe-btn boe-btn-secondary" onClick={() => setEditing(true)}>Edit details</button>
              </div>
            )}
          </>
        )}

        {detail.data && lead && editing && (
          <LeadEdit
            lead={lead}
            onCancel={() => setEditing(false)}
            onSaved={(text, isError) => { setEditing(false); onSaved(text, isError) }}
          />
        )}
      </aside>
    </>
  )
}

/** Correcting a lead's details. Who holds the lead is not here: that is the dropdown. */
function LeadEdit({ lead, onCancel, onSaved }: { lead: SalesLead; onCancel: () => void; onSaved: (text: string, isError?: boolean) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const [form, setForm] = useState<LeadForm>(() => formFromLead(lead))
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [raced, setRaced] = useState<SalesLead | null>(null)

  const phone = usePhoneStatus(supabase, form.countryCode, form.number, lead.id)
  const errors = validateLead(form)
  const canSave = phoneCanSave(phone) && Object.keys(errors).length === 0

  const change = (patch: Partial<LeadForm>) => {
    setForm(f => ({ ...f, ...patch }))
    setProblem(null)
    if ('number' in patch || 'countryCode' in patch) setRaced(null)
  }

  async function save() {
    if (!canSave || saving) return
    setSaving(true)
    setProblem(null)
    try {
      // The version the edit started from goes with it: if somebody changed the lead meanwhile, nothing is saved.
      const result = await updateLead(supabase, lead.id, toInput(form), lead.updated_at)
      if (result.status === 'duplicate') {
        setRaced(result.lead)
        // The number was free when it was last checked and is not now: look again, so the page agrees with itself.
        await queryClient.invalidateQueries({ queryKey: [SALES_KEY, 'phone'] })
        return
      }
      // Wait for the fresh lead before leaving edit mode, so the panel never shows the old details after "saved".
      await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
      onSaved(`Lead #${lead.lead_no} saved`)
    } catch (e) {
      if (e instanceof SalesRequestError && e.kind === 'changed') {
        // Leave edit mode and show the latest version: the person sees what changed before editing again.
        await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
        onSaved(e.message, true)
        return
      }
      setProblem(e instanceof SalesRequestError ? e.message : 'Something went wrong. Nothing was confirmed saved: try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className={s.drawerBody}>
        <PhoneField form={form} onChange={change} status={phone} inputId="sales-edit-phone" />
        {raced && phone.kind !== 'taken' && <DupCallout lead={raced} />}
        <SourceField form={form} onChange={change} />
        <DetailFields form={form} onChange={change} errors={errors} idPrefix="sales-edit" />
        <div className={s.hint}>Who holds the lead is changed from the dropdown, not here. The received date never changes. <Holder name={lead.holder_name} /></div>
        {problem && <div className={`${s.status} ${s.statusBad}`} role="alert">{problem}</div>}
      </div>
      <div className={s.drawerFoot}>
        <button type="button" className="boe-btn boe-btn-primary" disabled={!canSave || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="boe-btn boe-btn-secondary" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </>
  )
}
