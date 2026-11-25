'use client'

// The builder's Client section (owner-approved layout, 18 Nov 2026; below the totals and without a card's frame since 25 Nov 2026): a plain grid of the
// basic fields (client name, phone, City, lead time), with Advanced client details as a slim row that opens into a grid of the rest. Moved out of
// BuilderScreen with its behaviour unchanged: a well-known city fills the state and the tax, the state and GST type are under Advanced.

import { ChevronDown, ChevronRight } from 'lucide-react'
import { CLIENT_TYPES, type Header } from '@/lib/quotations/api'
import { CITY_NAMES } from '@/lib/quotations/cities'
import { SUPPLY_STATES, gstModeForState, type QuoteArea } from '@/lib/quotations/math'
import { LeadTime, ProjectTypeField } from './LeadTime'
import s from './quotations.module.css'

type Props = {
  h: Header; areas: readonly QuoteArea[]; editable: boolean; advOpen: boolean; onAdv: () => void
  onField: <K extends keyof Header>(k: K, v: Header[K]) => void; onPatch: (patch: Partial<Header>) => void
  onCity: (v: string) => void; onState: (v: string) => void
}

export function ClientCard({ h, areas, editable, advOpen, onAdv, onField, onPatch, onCity, onState }: Props) {
  const stateKnown = SUPPLY_STATES.some(x => x.toLowerCase() === h.supply_state.trim().toLowerCase())
  return (
    <section className={s.sec} aria-labelledby="q-client">
      <h2 id="q-client" className={s.secH}>Client</h2>
      <div>
        <div className={s.fgrid}>
          <label className={s.field}><span>Client name *</span><input id="q-client-name" className={s.input} value={h.client_name} onChange={e => onField('client_name', e.target.value)} disabled={!editable} /></label>
          <label className={s.field}><span>Contact phone</span><input id="q-phone" className={s.input} value={h.contact_phone} inputMode="tel" onChange={e => onField('contact_phone', e.target.value)} disabled={!editable} /></label>
          <label className={s.field}><span>City</span><input id="q-city" className={s.input} list="q-cities" maxLength={80} autoComplete="off" placeholder="Where it is delivered" value={h.delivery_city} disabled={!editable} onChange={e => onCity(e.target.value)} />
            <datalist id="q-cities">{CITY_NAMES.map(x => <option key={x} value={x} />)}</datalist>
            <span className={s.fhint}>Tax: {h.gst_mode === 'igst' ? 'IGST (outside Rajasthan)' : 'CGST + SGST (within Rajasthan)'}{h.supply_state.trim() ? ` · ${h.supply_state.trim()}` : ''}</span>
            {h.delivery_city.trim() && !h.supply_state.trim() && <span className={s.small} style={{ color: '#8A5A00' }} role="status">State not found for this city: add it under Advanced client details.</span>}</label>
          <LeadTime h={h} areas={areas} editable={editable} onChange={onPatch} />
        </div>
        {h.supply_state && gstModeForState(h.supply_state) !== h.gst_mode && <div className={`${s.notice} ${s.noticeWarn}`} style={{ marginTop: 16 }}>Delivery to {h.supply_state} is normally {gstModeForState(h.supply_state) === 'igst' ? 'IGST' : 'CGST + SGST'}: BOE is registered in Rajasthan. Check before sending (GST type is under Advanced client details).</div>}
        {advOpen && (
          <div id="q-advanced" className={s.advGrid}>
            <div className={s.fgrid}>
              <label className={s.field}><span>Company name</span><input id="q-company" className={s.input} maxLength={160} value={h.company_name} onChange={e => onField('company_name', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Client type</span><select id="q-type" className={s.input} value={h.client_type} onChange={e => onField('client_type', e.target.value)} disabled={!editable}><option value="">Choose…</option>{CLIENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <ProjectTypeField h={h} editable={editable} onChange={onPatch} />
              <label className={s.field}><span>Project</span><input id="q-project" className={s.input} value={h.project_name} onChange={e => onField('project_name', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Contact person</span><input id="q-contact" className={s.input} value={h.contact_name} onChange={e => onField('contact_name', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Their role</span><input id="q-role" className={s.input} value={h.contact_role} onChange={e => onField('contact_role', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Email ID</span><input id="q-email" className={s.input} type="email" inputMode="email" autoComplete="off" maxLength={160} placeholder="name@company.com" value={h.client_email} onChange={e => onField('client_email', e.target.value)} disabled={!editable} /></label>
              <label className={s.field}><span>Delivery state</span><input id="q-state" className={s.input} list="q-states" value={h.supply_state} disabled={!editable} onChange={e => onState(e.target.value)} />
                <datalist id="q-states">{SUPPLY_STATES.map(x => <option key={x} value={x} />)}</datalist>
                {h.supply_state.trim() && !stateKnown && <span className={s.small} style={{ color: '#8A5A00' }} role="status">Pick the state from the list: it decides CGST + SGST or IGST.</span>}</label>
              <label className={s.field}><span>GST type</span><select id="q-gst" className={s.input} value={h.gst_mode} onChange={e => onField('gst_mode', e.target.value as Header['gst_mode'])} disabled={!editable}><option value="igst">IGST (outside Rajasthan)</option><option value="cgst_sgst">CGST + SGST (within Rajasthan)</option></select></label>
              <label className={s.field}><span>GSTIN</span><input id="q-gstin" className={s.input} maxLength={20} autoComplete="off" value={h.client_gstin} onChange={e => onField('client_gstin', e.target.value.toUpperCase())} disabled={!editable} /></label>
            </div>
          </div>
        )}
      </div>
      <div className={s.advRow}>
        <button type="button" className={s.advToggle} aria-expanded={advOpen} aria-controls="q-advanced" onClick={onAdv}>
          {advOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />} Advanced client details <span className={s.hintTxt}>Company, client type, project type, project, contact person, their role, email, state, GST type, GSTIN</span>
        </button>
      </div>
    </section>
  )
}
