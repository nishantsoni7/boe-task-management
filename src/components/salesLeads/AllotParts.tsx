'use client'

import { useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Person, SalesLead } from '@/lib/salesLeads/api'
import { formatPhone } from '@/lib/exhibitionLeads/phone'
import { changeCameFromKey, isSelectNavigationKey } from '@/lib/salesLeads/allot'
import { initialsOf } from '@/lib/salesLeads/format'
import { useDialogFocus } from './useDialogFocus'
import s from './salesLeads.module.css'

// The name dropdown is the only place a lead is allotted. It is a plain controlled <select>: the value shows who
// holds the lead NOW (or, while a save runs, the person being saved), so a pick that is not saved (cancelled,
// refused) simply shows the old name again. The screen decides what a pick means: a first allotment saves at once,
// changing a name asks first.

export function Holder({ name, old = false }: { name: string | null; old?: boolean }) {
  if (!name) return <span className={s.noName}>{old ? 'Old lead, not allotted' : 'Not allotted yet'}</span>
  return (
    <span className="fin-person">
      <span className="fin-avatar" aria-hidden="true">{initialsOf(name)}</span>
      <span>{name}</span>
    </span>
  )
}

type PickerProps = {
  lead: SalesLead
  people: Person[]
  /** Without the assign right the name is only shown. */
  canAssign: boolean
  /** While a save for this lead runs: the person it is being saved to. The dropdown shows them and ignores picks. */
  saving: string | undefined
  onPick: (personId: string) => void
  id?: string
}

export function AllotPicker({ lead, people, canAssign, saving, onPick, id }: PickerProps) {
  // When the last moving key was pressed on this dropdown (see changeCameFromKey).
  const keyAt = useRef<number | null>(null)
  if (!canAssign) return <Holder name={lead.holder_name} old={lead.is_history} />
  // A holder who no longer counts as a sales candidate must still read as themselves, not as a blank.
  const holderMissing = lead.assigned_to !== null && !people.some(p => p.id === lead.assigned_to)
  const busy = saving !== undefined
  return (
    <select
      id={id}
      className={`${s.pick}${lead.assigned_to || busy ? '' : ` ${s.pickEmpty}`}`}
      value={saving ?? lead.assigned_to ?? ''}
      // aria-busy, not disabled: a disabled control drops keyboard focus to <body>, and the person loses their place.
      aria-busy={busy}
      aria-label={`Allotted to, lead ${lead.lead_no}`}
      onKeyDown={e => { if (isSelectNavigationKey(e)) keyAt.current = e.timeStamp }}
      onChange={e => {
        // A stray key moved the value: the controlled select snaps back to the holder, and nothing is picked.
        if (changeCameFromKey(keyAt.current, e.timeStamp)) return
        if (busy || !e.target.value) return
        onPick(e.target.value)
      }}
    >
      {lead.assigned_to === null && <option value="" disabled hidden>Select name</option>}
      {holderMissing && <option value={lead.assigned_to ?? ''}>{lead.holder_name ?? 'Former colleague'}</option>}
      {people.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
    </select>
  )
}

type ConfirmProps = {
  lead: SalesLead
  fromName: string
  toName: string
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Asked only when a name that is already there would change. The safe answer is the one that has focus. */
export function ConfirmChange({ lead, fromName, toName, saving, onConfirm, onCancel }: ConfirmProps) {
  // Escape cancels (and, while the change is being saved, does nothing); Tab stays on the two buttons; focus goes
  // back to the dropdown that opened the question. No layer underneath hears the Escape.
  const sheet = useDialogFocus<HTMLDivElement>(() => { if (!saving) onCancel() })
  return (
    <div
      className="boe-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sales-confirm-title"
      onClick={e => { if (e.target === e.currentTarget && !saving) onCancel() }}
    >
      <div className="boe-modal-sheet" style={{ maxWidth: 440 }} ref={sheet} tabIndex={-1}>
        <div className="boe-modal-header"><h2 className={s.cfTitle} id="sales-confirm-title">Change who holds this lead?</h2></div>
        <div className="boe-modal-body">
          <div className={s.cfLead}>
            <b>Lead #{lead.lead_no}</b> · {lead.name ?? 'No name'} · {formatPhone(lead.phone)}
          </div>
          <div className={s.swap}>
            <div className={s.swapCol}><span className={s.swapLabel}>From</span><Holder name={fromName} /></div>
            <ArrowRight className={s.swapArrow} size={18} aria-hidden="true" />
            <div className={s.swapCol}><span className={s.swapLabel}>To</span><Holder name={toName} /></div>
          </div>
          <p className={s.cfNote}>Both names stay in the lead&apos;s history.</p>
        </div>
        <div className={s.cfFoot}>
          <button type="button" className="boe-btn boe-btn-secondary" onClick={onCancel} disabled={saving} autoFocus>Keep as it is</button>
          <button type="button" className="boe-btn boe-btn-primary" onClick={onConfirm} disabled={saving}>
            {saving ? 'Changing…' : `Change to ${toName}`}
          </button>
        </div>
      </div>
    </div>
  )
}
