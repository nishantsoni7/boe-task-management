'use client'

import { useState } from 'react'
import type { Header } from '@/lib/quotations/api'
import type { QuoteArea } from '@/lib/quotations/math'
import { PROJECT_TYPES, countsSeats, leadTimeRule, roomsOf, toProjectType } from '@/lib/quotations/documentPlan'
import s from './quotations.module.css'

/**
 * Project type, seats and lead time (20270717000000), in the Client card. The lead time is the owner's rule (documentPlan:
 * hotel and resort by rooms, restaurant, cafe and brewery by seats) and follows the quotation by itself; a person may change
 * it, only with a reason, and the reason stays internal. What is stored is `lead_time_weeks` (the number the client is told)
 * and `lead_time_reason` (present = a person changed it). `effectiveLeadTime` is what a save writes.
 */

export const effectiveLeadTime = (h: Pick<Header, 'project_type' | 'seats' | 'lead_time_weeks' | 'lead_time_reason'>, areas: readonly QuoteArea[]): number | null =>
  h.lead_time_reason ? h.lead_time_weeks : leadTimeRule(toProjectType(h.project_type), roomsOf(areas), h.seats)?.weeks ?? null

export function LeadTime({ h, areas, editable, onChange }: { h: Header; areas: readonly QuoteArea[]; editable: boolean; onChange: (patch: Partial<Header>) => void }) {
  const type = toProjectType(h.project_type)
  const rule = leadTimeRule(type, roomsOf(areas), h.seats)
  const weeks = effectiveLeadTime(h, areas)
  const overridden = !!h.lead_time_reason
  const [open, setOpen] = useState(false)
  const [wk, setWk] = useState('')
  const [why, setWhy] = useState('')
  const valid = Number(wk) >= 1 && Number(wk) <= 104 && Number.isInteger(Number(wk)) && why.trim().length > 0

  return (
    <div className={`${s.leadRow} ${countsSeats(type) ? '' : s.leadRowNoSeats}`}>
      <label className={s.field}><span>Project type</span>
        <select id="q-ptype" className={s.input} value={h.project_type} disabled={!editable} onChange={e => onChange({ project_type: e.target.value })}>
          <option value="">Choose…</option>{PROJECT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {countsSeats(type) && (
        <label className={s.field}><span>Seats</span>
          <input id="q-seats" className={s.input} type="number" inputMode="numeric" min={1} max={100000} placeholder="How many seats" value={h.seats ?? ''} disabled={!editable}
            onChange={e => onChange({ seats: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) || null })} />
        </label>
      )}
      <div className={s.leadBox}>
        <span className={s.leadLab}>Lead time</span>
        <div className={s.leadLine}>
          {weeks ? <span className={s.chip}>{weeks} weeks</span> : <span className={`${s.small} ${s.muted}`}>Not printed</span>}
          <span className={`${s.small} ${s.muted}`}>
            {overridden ? `Changed by a person: ${h.lead_time_reason}` : rule ? `${rule.basis}, from the advance` : type && type !== 'other' ? (countsSeats(type) ? 'Add the seats to see it' : 'Add the rooms (room types) to see it') : 'Choose Hotel, Resort, Restaurant, Café or Brewery'}
          </span>
          {editable && !open && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { setWk(weeks ? String(weeks) : ''); setWhy(h.lead_time_reason); setOpen(true) }}>Change</button>}
        </div>
        {open && (
          <div className={s.leadEdit}>
            <label className={s.field}><span>Weeks from the advance</span><input id="q-lead-weeks" className={s.input} type="number" inputMode="numeric" min={1} max={104} value={wk} onChange={e => setWk(e.target.value)} /></label>
            <label className={s.field}><span>Why is it different? (kept inside, never printed)</span><input id="q-lead-why" className={s.input} maxLength={200} value={why} onChange={e => setWhy(e.target.value)} /></label>
            <div className={s.leadActs}>
              <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`} disabled={!valid} onClick={() => { onChange({ lead_time_weeks: Number(wk), lead_time_reason: why.trim() }); setOpen(false) }}>Use this</button>
              {overridden && <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => { onChange({ lead_time_weeks: rule?.weeks ?? null, lead_time_reason: '' }); setOpen(false) }}>Back to the rule</button>}
              <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
