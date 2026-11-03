'use client'

import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import type { Person, SalesLead } from '@/lib/salesLeads/api'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { receivedLabel } from '@/lib/salesLeads/format'
import { AllotPicker } from './AllotParts'
import s from './salesLeads.module.css'

type Props = {
  rows: SalesLead[]
  people: Person[]
  canAssign: boolean
  today: string
  /** Allotments being saved: lead id → the person it is being saved to. */
  saving: Record<string, string>
  onOpen: (lead: SalesLead) => void
  onPick: (lead: SalesLead, personId: string) => void
}

export function LeadTable({ rows, people, canAssign, today, saving, onOpen, onPick }: Props) {
  return (
    <div className="fin-table-wrap">
      <table className={`fin-table ${s.table}`}>
        <colgroup>
          <col style={{ width: 78 }} />
          <col style={{ width: 84 }} />
          <col style={{ width: 150 }} />
          <col style={{ width: 180 }} />
          <col style={{ width: 138 }} />
          <col className={s.kLoc} style={{ width: 130 }} />
          <col />
          <col style={{ width: 190 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Lead</th>
            <th scope="col">Received</th>
            <th scope="col">Phone</th>
            <th scope="col">Name</th>
            <th scope="col">Source</th>
            <th scope="col" className={s.cLoc}>Location</th>
            <th scope="col">Requirement</th>
            <th scope="col">Allotted to</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(l => (
            <tr
              key={l.id}
              tabIndex={0}
              aria-label={`Lead ${l.lead_no}, ${formatPhone(l.phone)}`}
              onClick={() => onOpen(l)}
              onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(l) }}
            >
              <td className={s.cNo}><span className="fin-ordno">#{l.lead_no}</span></td>
              <td className={s.cRecv}><span className={s.mobNo}>#{l.lead_no} · </span>{receivedLabel(l.received_on, today)}</td>
              <td className={s.cPhone}>
                <a className={s.phone} href={telHref(l.phone)} onClick={e => e.stopPropagation()}>{formatPhone(l.phone)}</a>
              </td>
              <td className={s.cName}>
                {l.name ? <span className="fin-primary-text">{l.name}</span> : <span className={s.noName}>No name</span>}
                {l.email && <span className="fin-sub">{l.email}</span>}
              </td>
              <td className={s.cSrc}><span className={s.tag}>{sourceLabel(l.source)}</span>{l.is_history && <span className={s.tag}>Old lead</span>}</td>
              <td className={s.cLoc}>{l.location ?? <span className="fin-muted">–</span>}</td>
              <td className={s.cReq} title={l.requirement ?? undefined}>{l.requirement}</td>
              <td className={s.cWho} onClick={e => e.stopPropagation()}>
                <AllotPicker lead={l} people={people} canAssign={canAssign} saving={saving[l.id]} onPick={id => onPick(l, id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
