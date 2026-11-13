'use client'

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import {
  logMessageSent, logNoAnswer, moveLead, SALES_KEY, SalesRequestError, undoActivity, updateFacts,
  type LeadFacts, type WorkLead,
} from '@/lib/salesLeads/api'
import {
  BOARD_STAGES, DEAD_REASONS, FACT_HINTS, FACT_LABELS, NEXT_STAGE, parseValue, quickMessages, stageLabel, TYPED_FACTS, whatsAppLink, whenFrom,
  type DeadReason, type NeededFact, type Stage,
} from '@/lib/salesLeads/board'
import { dayShort } from '@/lib/salesLeads/format'
import { istToday } from '@/lib/istDate'
import { createClient } from '@/lib/supabase/client'
import { leadTitle } from './LeadBits'
import { useDialogFocus } from './useDialogFocus'
import { useToast } from './useToast'
import s from './leadBoard.module.css'

// Everything that happens to a lead from a button, in one place, so My day, the board and the lead panel behave the
// same. Everyday actions do not ask "are you sure?": they happen, and a message offers Undo. Only Dead asks, because it
// needs a reason. A missing fact is asked for in a small box, never shown as an error.

type Dialog =
  | { type: 'move'; lead: WorkLead }
  | { type: 'whatsapp'; lead: WorkLead }
  | { type: 'three'; lead: WorkLead }
  | { type: 'dead'; lead: WorkLead; note?: string }
  | { type: 'park'; lead: WorkLead }
  | { type: 'gate'; lead: WorkLead; to: Stage; missing: NeededFact[] }

export function useLeadWork() {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { profile } = usePermissionContext()
  const toast = useToast()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const today = istToday()

  const refresh = () => queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
  const fail = (e: unknown) => toast.show(e instanceof SalesRequestError ? e.message : 'Something went wrong. Nothing was saved.', true)

  /** One save at a time, and the screen is read again whatever happened: a refusal usually means it was out of date. */
  async function guarded(run: () => Promise<void>) {
    setBusy(true)
    try {
      await run()
    } catch (e) {
      fail(e)
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const undoEntry = (id: string) => void guarded(async () => { await undoActivity(supabase, id); toast.show('Undone') })
  const said = (text: string, activityId?: string) =>
    toast.show(text, false, activityId ? { label: 'Undo', run: () => undoEntry(activityId) } : null)

  // The follow-up the database set (the next working day), in words.
  const comesBack = (lead: WorkLead) => (lead.next_due_on ? dayShort(lead.next_due_on) : 'soon')

  const noAnswer = (lead: WorkLead) => guarded(async () => {
    const r = await logNoAnswer(supabase, lead.id)
    if ((r.streak ?? 0) >= 3) setDialog({ type: 'three', lead: r.lead })
    // A New lead that nobody answered has had its first try, so it is now Under Process.
    else said(`No answer logged${lead.stage === 'new' ? '. Moved to Under Process' : ''}. Next try ${comesBack(r.lead)}.`, r.activity_id)
  })

  const messageSent = (lead: WorkLead, label: string) => guarded(async () => {
    setDialog(null)
    const r = await logMessageSent(supabase, lead.id, label)
    said(`Message logged. This lead comes back ${comesBack(r.lead)}.`, r.activity_id)
  })

  async function doMove(lead: WorkLead, to: Stage, extra: Parameters<typeof moveLead>[4] = {}) {
    const r = await moveLead(supabase, lead.id, to, lead.stage, extra)
    if (r.status === 'needs') { setDialog({ type: 'gate', lead: r.lead, to, missing: r.missing }); return }
    setDialog(null)
    if (r.status === 'moved') {
      toast.show(`${leadTitle(lead)} moved to ${stageLabel(to)}`, false, {
        label: 'Undo',
        run: () => void guarded(async () => {
          const back = await moveLead(supabase, lead.id, lead.stage, to, { nextStep: lead.next_step ?? undefined, nextDue: lead.next_due_on ?? undefined })
          // Only say Undone when it moved back; if a fact is missing, ask for it the usual way.
          if (back.status === 'needs') setDialog({ type: 'gate', lead: back.lead, to: lead.stage, missing: back.missing })
          else toast.show('Undone')
        }),
      })
    }
  }

  /** Every way of moving a lead comes through here: a drag, the Move sheet, the panel's buttons. */
  function moveTo(lead: WorkLead, to: Stage, note?: string) {
    if (to === lead.stage) return
    if (to === 'dead') return setDialog({ type: 'dead', lead, note })
    if (to === 'follow_up_later') return setDialog({ type: 'park', lead })
    void guarded(() => doMove(lead, to))
  }

  const saveAndMove = (lead: WorkLead, to: Stage, facts: LeadFacts) => guarded(async () => {
    if (Object.keys(facts).length > 0) await updateFacts(supabase, lead.id, facts)
    await doMove({ ...lead }, to)
  })

  const sender = profile?.full_name ?? ''

  const node = (
    <>
      {dialog?.type === 'move' && (
        <MoveSheet lead={dialog.lead} onClose={() => setDialog(null)} onPick={to => moveTo(dialog.lead, to)} />
      )}
      {dialog?.type === 'whatsapp' && (
        <WhatsAppSheet lead={dialog.lead} sender={sender} onClose={() => setDialog(null)} onSent={label => void messageSent(dialog.lead, label)} />
      )}
      {dialog?.type === 'three' && (
        <ThreeTriesSheet
          lead={dialog.lead}
          onClose={() => setDialog(null)}
          onLater={() => setDialog({ type: 'park', lead: dialog.lead })}
          onDead={() => void guarded(() => doMove(dialog.lead, 'dead', { reason: 'not_responding' }))}
        />
      )}
      {dialog?.type === 'dead' && (
        <DeadDialog
          lead={dialog.lead}
          busy={busy}
          note={dialog.note ?? ''}
          onClose={() => setDialog(null)}
          onConfirm={(reason, note) => void guarded(() => doMove(dialog.lead, 'dead', { reason, note }))}
        />
      )}
      {dialog?.type === 'park' && (
        <ParkDialog
          lead={dialog.lead}
          today={today}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(nextStep, nextDue) => void guarded(() => doMove(dialog.lead, 'follow_up_later', { nextStep, nextDue }))}
        />
      )}
      {dialog?.type === 'gate' && (
        <GateDialog
          lead={dialog.lead}
          to={dialog.to}
          missing={dialog.missing}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={facts => void saveAndMove(dialog.lead, dialog.to, facts)}
        />
      )}
      {toast.node}
    </>
  )

  return {
    supabase, today, busy, node, refresh, fail, said, guarded, moveTo, saveAndMove, noAnswer: (l: WorkLead) => void noAnswer(l),
    /** Three tries with no answer: asks what next (a "Client not responding" comment can be the third). */
    threeTries: (lead: WorkLead) => setDialog({ type: 'three', lead }),
    openMove: (lead: WorkLead) => setDialog({ type: 'move', lead }),
    openWhatsApp: (lead: WorkLead) => setDialog({ type: 'whatsapp', lead }),
  }
}

export type LeadWork = ReturnType<typeof useLeadWork>

function Sheet({ title, sub, onClose, children }: { title: string; sub: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(onClose)
  return (
    <>
      <div className={s.sheetScrim} onClick={onClose} />
      <div ref={ref} className={s.sheet} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className={s.grab} />
        <h2 className={s.sheetTitle}>{title}</h2>
        <p className={s.sheetSub}>{sub}</p>
        {children}
      </div>
    </>
  )
}

function MoveSheet({ lead, onClose, onPick }: { lead: WorkLead; onClose: () => void; onPick: (to: Stage) => void }) {
  return (
    <Sheet title={`Move ${leadTitle(lead)}`} sub={`Now in ${stageLabel(lead.stage)}`} onClose={onClose}>
      {BOARD_STAGES.map(stage => (
        <button key={stage} type="button" className={s.sheetOption} disabled={stage === lead.stage} onClick={() => onPick(stage)}>
          {stageLabel(stage)}
          {stage === lead.stage ? <Check aria-hidden="true" /> : stage === NEXT_STAGE[lead.stage] ? <small>next step</small> : null}
        </button>
      ))}
      <div className={s.sheetLine} />
      <button type="button" className={`${s.sheetOption} ${s.sheetWin}`} onClick={() => onPick('converted')}>Converted</button>
      <button type="button" className={`${s.sheetOption} ${s.sheetDead}`} onClick={() => onPick('dead')}>Dead<small>asks why</small></button>
    </Sheet>
  )
}

function WhatsAppSheet({ lead, sender, onClose, onSent }: { lead: WorkLead; sender: string; onClose: () => void; onSent: (label: string) => void }) {
  return (
    <Sheet title={`WhatsApp ${leadTitle(lead)}`} sub="WhatsApp opens with the message filled in. You press send." onClose={onClose}>
      {quickMessages(sender).map(m => (
        <a key={m.label} className={`${s.sheetOption} ${s.sheetMessage}`} href={whatsAppLink(lead.phone, m.text)} target="_blank" rel="noreferrer" onClick={() => onSent(m.label)}>
          {m.label}<span>{m.text}</span>
        </a>
      ))}
      <div className={s.sheetLine} />
      <a className={s.sheetOption} href={whatsAppLink(lead.phone)} target="_blank" rel="noreferrer" onClick={onClose}>Write my own</a>
    </Sheet>
  )
}

function ThreeTriesSheet({ lead, onClose, onLater, onDead }: { lead: WorkLead; onClose: () => void; onLater: () => void; onDead: () => void }) {
  return (
    <Sheet title={`${lead.no_answer_streak} tries, no answer`} sub={`${leadTitle(lead)} has not picked up. What next?`} onClose={onClose}>
      <button type="button" className={s.sheetOption} onClick={onClose}>{lead.next_due_on ? `Try again ${dayShort(lead.next_due_on)}` : 'Try again later'}</button>
      <button type="button" className={s.sheetOption} onClick={onLater}>Follow up later<small>pick a date</small></button>
      <div className={s.sheetLine} />
      <button type="button" className={`${s.sheetOption} ${s.sheetDead}`} onClick={onDead}>Dead<small>reason: Not responding</small></button>
    </Sheet>
  )
}

function DialogFrame({ title, width, onClose, children }: { title: string; width: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(onClose)
  return (
    <div className="boe-modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={ref} className="boe-modal-sheet" style={{ maxWidth: width }} tabIndex={-1}>
        <div className="boe-modal-header"><h2 className={s.dialogTitle}>{title}</h2></div>
        {children}
      </div>
    </div>
  )
}

function DeadDialog({ lead, busy, note, onClose, onConfirm }: {
  lead: WorkLead; busy: boolean; note: string; onClose: () => void; onConfirm: (reason: DeadReason, note: string) => void
}) {
  const [reason, setReason] = useState<DeadReason | null>(null)
  const [text, setText] = useState(note)
  const ready = !!reason && (reason !== 'other' || text.trim() !== '')
  return (
    <DialogFrame title="Why is this lead dead?" width={460} onClose={onClose}>
      <div className="boe-modal-body">
        <div className={s.dialogLead}><b>{leadTitle(lead)}</b> moves from {stageLabel(lead.stage)} to Dead. Everything stays on the lead, and the reason is kept for your reports.</div>
        <div className={s.reasons} role="radiogroup" aria-label="Reason">
          {DEAD_REASONS.map(r => (
            <label key={r.value} className={s.reason}>
              <input type="radio" name="dead-reason" checked={reason === r.value} onChange={() => setReason(r.value)} />{r.label}
            </label>
          ))}
        </div>
        {(reason === 'other' || note !== '') && (
          <textarea className={s.input} aria-label="Why" placeholder="Say why" value={text} onChange={e => setText(e.target.value)} />
        )}
      </div>
      <div className={s.dialogFoot}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose}>Keep it where it is</button>
        <button type="button" className="boe-btn boe-btn-primary" disabled={!ready || busy} onClick={() => reason && onConfirm(reason, text)}>{busy ? 'Saving…' : 'Move to Dead'}</button>
      </div>
    </DialogFrame>
  )
}

function ParkDialog({ lead, today, busy, onClose, onConfirm }: {
  lead: WorkLead; today: string; busy: boolean; onClose: () => void; onConfirm: (nextStep: string, nextDue: string) => void
}) {
  const [step, setStep] = useState(lead.next_step && lead.next_step !== 'First call' ? lead.next_step : 'Call back')
  const [day, setDay] = useState(whenFrom(today, 30))
  const ready = step.trim() !== '' && day > today
  return (
    <DialogFrame title="When should this lead come back?" width={420} onClose={onClose}>
      <div className="boe-modal-body">
        <div className={s.dialogLead}><b>{leadTitle(lead)}</b> leaves your day and returns on its own on this date.</div>
        <div className={s.field}><label className={s.label} htmlFor="park-day">Come back on</label><input id="park-day" className={s.input} type="date" min={whenFrom(today, 1)} value={day} onChange={e => setDay(e.target.value)} /></div>
        <div className={s.field}><label className={s.label} htmlFor="park-step">What to do then</label><input id="park-step" className={s.input} maxLength={120} value={step} onChange={e => setStep(e.target.value)} /></div>
      </div>
      <div className={s.dialogFoot}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose}>Keep it where it is</button>
        <button type="button" className="boe-btn boe-btn-primary" disabled={!ready || busy} onClick={() => onConfirm(step.trim(), day)}>{busy ? 'Saving…' : 'Park this lead'}</button>
      </div>
    </DialogFrame>
  )
}

function GateDialog({ lead, to, missing, busy, onClose, onConfirm }: {
  lead: WorkLead; to: Stage; missing: NeededFact[]; busy: boolean; onClose: () => void; onConfirm: (facts: LeadFacts) => void
}) {
  const [values, setValues] = useState<Partial<Record<NeededFact, string>>>({})
  const typed = missing.filter(f => TYPED_FACTS.includes(f))
  const logged = missing.filter(f => !TYPED_FACTS.includes(f))
  const amount = values.value === undefined ? null : parseValue(values.value)
  const ready = logged.length === 0 && typed.every(f => (f === 'value' ? amount !== null : (values[f] ?? '').trim() !== ''))
  function facts(): LeadFacts {
    const out: LeadFacts = {}
    if (values.requirement) out.requirement = values.requirement.trim()
    if (values.quantity) out.quantity = values.quantity.trim()
    if (values.timeline) out.timeline = values.timeline.trim()
    if (amount !== null) out.expected_value_paise = amount
    return out
  }
  const title = typed.length + logged.length === 1 ? `One fact before ${stageLabel(to)}` : `Before ${stageLabel(to)}`
  return (
    <DialogFrame title={title} width={440} onClose={onClose}>
      <div className="boe-modal-body">
        {logged.length > 0 ? (
          <div className={s.dialogLead}>
            <b>{leadTitle(lead)}</b> needs {logged.map(f => FACT_LABELS[f].toLowerCase()).join(' and ')} logged first. Open the lead and log it, then move it.
          </div>
        ) : (
          <div className={s.dialogLead}><b>{leadTitle(lead)}</b> needs this to move on. Add it here and the lead moves straight away.</div>
        )}
        {logged.length === 0 && typed.map(f => (
          <div key={f} className={s.field}>
            <label className={s.label} htmlFor={`gate-${f}`}>{FACT_LABELS[f]}<span className="boe-req" aria-hidden="true">*</span></label>
            <input id={`gate-${f}`} className={s.input} placeholder={FACT_HINTS[f]} inputMode={f === 'value' ? 'decimal' : undefined} value={values[f] ?? ''} onChange={e => setValues(v => ({ ...v, [f]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className={s.dialogFoot}>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose}>Keep it where it is</button>
        {logged.length === 0 && (
          <button type="button" className="boe-btn boe-btn-primary" disabled={!ready || busy} onClick={() => onConfirm(facts())}>{busy ? 'Saving…' : 'Save and move'}</button>
        )}
      </div>
    </DialogFrame>
  )
}
