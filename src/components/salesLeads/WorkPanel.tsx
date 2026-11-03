'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, MessageCircle, Phone, PhoneMissed, TriangleAlert, X } from 'lucide-react'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import {
  fetchWorkLead, logActivity, SALES_KEY, updateFacts,
  type Activity, type LeadFacts, type WorkDetail, type WorkLead,
} from '@/lib/salesLeads/api'
import {
  BOARD_STAGES, checklistFor, CLIENT_TYPES, dueOf, FACT_HINTS, kindLabel, KINDS, lastLabel, marketLabel, NEXT_STEPS, OUTCOMES, outcomeLabel, parseValue,
  PATH_STAGES, SEGMENTS, STAGE_GUIDE, stageLabel, TEMPERATURES, TYPED_FACTS, valueLabel, WHEN_CHOICES, whenFrom,
  type CheckItem, type NeededFact, type OutcomeChoice, type Stage,
} from '@/lib/salesLeads/board'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { dayLabel, dayLabelLong, whenLabel } from '@/lib/salesLeads/format'
import { eventBy, eventLine, leadTitle, StepIcon } from './LeadBits'
import { useDialogFocus } from './useDialogFocus'
import type { LeadWork } from './useLeadWork'
import s from './leadBoard.module.css'

// One lead, all of it. On a desktop it fits a wide panel: the work on the left, the stage on the right. On a phone it
// is one column, and the stage comes after the log, because logging is what a salesperson does most.

export function WorkPanel({ leadId, work, focusLog = false, closeAfterPost = false, onClose }: {
  leadId: string
  work: LeadWork
  focusLog?: boolean
  /** On My day, posting closes the panel so the next lead is already there. */
  closeAfterPost?: boolean
  onClose: () => void
}) {
  const ref = useDialogFocus<HTMLDivElement>(onClose)
  const detail = useQuery({
    queryKey: [SALES_KEY, 'work', leadId],
    queryFn: () => fetchWorkLead(work.supabase, leadId),
    staleTime: 0,
  })
  const lead = detail.data?.lead

  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <aside ref={ref} className={s.drawer} role="dialog" aria-modal="true" aria-label="Lead details" tabIndex={-1}>
        <div className={s.drawerHead}>
          <h2 className={s.drawerTitle}>{lead ? <>{leadTitle(lead)}<small>#{lead.lead_no}</small></> : 'Lead'}</h2>
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>
        {detail.isPending && <div className={s.drawerBody}>Loading…</div>}
        {detail.isError && (
          <div className={s.drawerBody}>
            <div className="boe-empty">
              <p className="boe-empty-title">This lead could not be opened</p>
              <p>It may not be yours to see, or the connection dropped.</p>
              <button type="button" className="boe-btn boe-btn-secondary" onClick={() => detail.refetch()}>Try again</button>
            </div>
          </div>
        )}
        {detail.data && <PanelBody detail={detail.data} work={work} focusLog={focusLog} closeAfterPost={closeAfterPost} onClose={onClose} />}
      </aside>
    </>
  )
}

function PanelBody({ detail, work, focusLog, closeAfterPost, onClose }: {
  detail: WorkDetail; work: LeadWork; focusLog: boolean; closeAfterPost: boolean; onClose: () => void
}) {
  const { lead } = detail
  const { readOnly } = useSalesAccess()
  const canWork = detail.can_work && !readOnly
  const closed = lead.stage === 'converted' || lead.stage === 'dead'
  const position = PATH_STAGES.indexOf(lead.stage)
  const due = dueOf(lead, work.today)
  const composer = useRef<HTMLElement>(null)
  useEffect(() => { if (focusLog) composer.current?.scrollIntoView({ block: 'start' }) }, [focusLog])

  return (
    <div className={s.drawerBody}>
      <div className={s.head}>
        <div>
          <div className={s.bigPhone}>{formatPhone(lead.phone)}</div>
          <div className={s.sub}>{[lead.location, lead.holder_name].filter(Boolean).join(' · ')}</div>
        </div>
        {canWork && !closed && (
          <div className={s.callRow}>
            <a className="boe-btn boe-btn-primary" href={telHref(lead.phone)}><Phone aria-hidden="true" />Call</a>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => work.openWhatsApp(lead)}><MessageCircle aria-hidden="true" />WhatsApp</button>
            <button type="button" className="boe-btn boe-btn-secondary" disabled={work.busy} onClick={() => work.noAnswer(lead)}><PhoneMissed aria-hidden="true" />No answer</button>
          </div>
        )}
      </div>

      <div className={s.path} role="img" aria-label={`Stage: ${stageLabel(lead.stage)}`}>
        {PATH_STAGES.map((stage, i) => (
          <span key={stage} className={`${s.pathStep}${i === position ? ` ${s.pathNow}` : position > i ? ` ${s.pathDone}` : ''}`}>{stageLabel(stage)}</span>
        ))}
      </div>

      <div className={s.grid}>
        <div className={s.left}>
          {!closed && lead.next_step && (
            <div className={`${s.next} ${s.order1}${due.tone === 'over' ? ` ${s.nextOver}` : ''}`}>
              <StepIcon step={lead.next_step} />
              <div>
                <div className={s.nextMain}>{lead.next_step}</div>
                <div className={s.nextSub}>{due.tone === 'over' ? `${due.label}, was due ${dayLabelLong(lead.next_due_on ?? '')}` : `Due ${dayLabelLong(lead.next_due_on ?? '')}`}</div>
              </div>
            </div>
          )}
          {canWork && !closed && (
            <Composer ref={composer} lead={lead} work={work} onPosted={() => { if (closeAfterPost) onClose() }} />
          )}
          <div className={s.order4}>
            <h3 className={s.secTitle}>History</h3>
            <History detail={detail} />
          </div>
        </div>
        <div className={s.right}>
          <StageCard detail={detail} work={work} canWork={canWork} />
          <Details lead={lead} work={work} canWork={canWork} />
        </div>
      </div>
    </div>
  )
}

function Composer({ ref, lead, work, onPosted }: { ref: React.Ref<HTMLElement>; lead: WorkLead; work: LeadWork; onPosted: () => void }) {
  const [kind, setKind] = useState<string>('call')
  const [outcome, setOutcome] = useState<OutcomeChoice>('interested')
  const [note, setNote] = useState('')
  const [nextStep, setNextStep] = useState<string>(OUTCOMES[0].step)
  const [days, setDays] = useState<number | 'pick'>(OUTCOMES[0].inDays)
  const [picked, setPicked] = useState('')
  const [saving, setSaving] = useState(false)
  const notInterested = outcome === 'not_interested'
  const nextDue = days === 'pick' ? picked : whenFrom(work.today, days)
  const ready = notInterested || (nextStep.trim() !== '' && nextDue !== '')

  function choose(choice: OutcomeChoice) {
    setOutcome(choice)
    const o = OUTCOMES.find(x => x.value === choice)
    if (o && o.step) { setNextStep(o.step); setDays(o.inDays) }
  }

  async function post() {
    setSaving(true)
    try {
      if (notInterested) {
        // The call happened, so it is logged and the first call counts; then the lead asks why it is dead.
        await logActivity(work.supabase, lead.id, { kind, outcome, note, nextStep: 'Close as dead', nextDue: work.today })
        await work.refresh()
        setNote('')
        work.moveTo(lead, 'dead', note)
        return
      }
      const r = await logActivity(work.supabase, lead.id, { kind, outcome, note, nextStep: nextStep.trim(), nextDue })
      await work.refresh()
      work.said(`Saved. Next: ${nextStep.trim()}, ${dayLabel(nextDue)}.`, r.activity_id)
      setNote('')
      onPosted()
    } catch (e) {
      work.fail(e)
      await work.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section ref={ref} className={`${s.compose} ${s.order2}`} aria-label="Log what happened">
      <h3 className={s.secTitle}>Log what happened</h3>
      <div className={s.choices} role="group" aria-label="How">
        {KINDS.map(k => <button key={k.value} type="button" className={s.choice} aria-pressed={kind === k.value} onClick={() => setKind(k.value)}>{k.label}</button>)}
      </div>
      <div className={s.field}>
        <span className={s.label}>How did it go?</span>
        <div className={s.choices} role="group" aria-label="How did it go?">
          {OUTCOMES.map(o => <button key={o.value} type="button" className={s.choice} aria-pressed={outcome === o.value} onClick={() => choose(o.value)}>{o.label}</button>)}
        </div>
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor="log-note">What was said</label>
        <textarea id="log-note" className={s.input} maxLength={4000} placeholder="Quantity, budget, who decides, what they asked for" value={note} onChange={e => setNote(e.target.value)} />
      </div>
      {!notInterested && (
        <div className={s.nextRow}>
          <div className={s.field}>
            <label className={s.label} htmlFor="log-next">Next step<span className="boe-req" aria-hidden="true">*</span></label>
            <select id="log-next" className={s.input} value={nextStep} onChange={e => setNextStep(e.target.value)}>
              {NEXT_STEPS.map(n => <option key={n}>{n}</option>)}
            </select>
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="log-when">When<span className="boe-req" aria-hidden="true">*</span></label>
            <select id="log-when" className={s.input} value={days} onChange={e => setDays(e.target.value === 'pick' ? 'pick' : Number(e.target.value))}>
              {WHEN_CHOICES.map(w => <option key={w.key} value={w.key}>{w.label}, {dayLabelLong(whenFrom(work.today, w.key)).slice(0, -5)}</option>)}
              <option value="pick">Pick a date</option>
            </select>
            {days === 'pick' && <input className={s.input} type="date" aria-label="Pick a date" min={work.today} value={picked} onChange={e => setPicked(e.target.value)} />}
          </div>
        </div>
      )}
      <div className={s.composeFoot}>
        <button type="button" className="boe-btn boe-btn-primary" disabled={!ready || saving} onClick={() => void post()}>{saving ? 'Saving…' : notInterested ? 'Continue' : 'Post'}</button>
        <span className={s.stamp}>{notInterested ? 'The next question asks why.' : 'Next step filled in from your answer. Change it if you need to.'}</span>
      </div>
    </section>
  )
}

function StageCard({ detail, work, canWork }: { detail: WorkDetail; work: LeadWork; canWork: boolean }) {
  const { lead } = detail
  const check = checklistFor(lead, detail.quotation_sent)
  const [typed, setTyped] = useState<Partial<Record<NeededFact, string>>>({})
  const closed = lead.stage === 'converted' || lead.stage === 'dead'
  const others = BOARD_STAGES.filter(stage => stage !== lead.stage)

  const open = check?.items.filter(i => !i.done) ?? []
  const amount = typed.value === undefined ? null : parseValue(typed.value)
  const canGo = open.every(i => TYPED_FACTS.includes(i.fact) && (i.fact === 'value' ? amount !== null : (typed[i.fact] ?? '').trim() !== ''))

  function go() {
    if (!check) return
    const facts: LeadFacts = {}
    if (typed.requirement) facts.requirement = typed.requirement.trim()
    if (typed.quantity) facts.quantity = typed.quantity.trim()
    if (typed.timeline) facts.timeline = typed.timeline.trim()
    if (amount !== null) facts.expected_value_paise = amount
    setTyped({})
    void work.saveAndMove(lead, check.to, facts)
  }

  return (
    <div className={`${s.stage} ${s.order3}`}>
      <div className={s.stageLine}>
        <span><b>{stageLabel(lead.stage)}</b>{lead.last_activity_at ? ` · ${lastLabel(lead, work.today).toLowerCase()}` : ''}</span>
        {lead.stuck && <span className={`${s.flag} ${s.flagRed}`}><TriangleAlert aria-hidden="true" />Stuck</span>}
      </div>
      {STAGE_GUIDE[lead.stage] && <p className={s.guide}>{STAGE_GUIDE[lead.stage]}</p>}
      {lead.stage === 'dead' && <p className={s.guide}>Reason: {dueOf(lead, work.today).label}{lead.dead_note ? `. ${lead.dead_note}` : ''}</p>}
      {canWork && check && (
        <>
          <h4 className={s.checkTitle}>To reach {stageLabel(check.to)} <span>· {check.left ? `${check.left} left` : 'ready'}</span></h4>
          <ul className={s.check}>
            {check.items.map(item => <CheckRow key={item.fact} item={item} value={typed[item.fact] ?? ''} onChange={v => setTyped(t => ({ ...t, [item.fact]: v }))} />)}
          </ul>
          <button type="button" className={`boe-btn boe-btn-primary ${s.stageGo}`} disabled={!canGo || work.busy} onClick={go}>Move to {stageLabel(check.to)}</button>
        </>
      )}
      {canWork && (
        <div className={s.stageRow}>
          <select className={s.input} aria-label="Move to another stage" value="" onChange={e => { if (e.target.value) work.moveTo(lead, e.target.value as Stage) }}>
            <option value="">{closed ? 'Reopen to…' : 'Other stages…'}</option>
            {others.map(stage => <option key={stage} value={stage}>{stageLabel(stage)}</option>)}
          </select>
          {!closed && <button type="button" className={`boe-btn boe-btn-secondary ${s.win}`} disabled={work.busy} onClick={() => work.moveTo(lead, 'converted')}>Converted</button>}
          {!closed && <button type="button" className={`boe-btn boe-btn-secondary ${s.lost}`} disabled={work.busy} onClick={() => work.moveTo(lead, 'dead')}>Dead</button>}
        </div>
      )}
      {!canWork && <div className={s.readOnly}>You can read this lead. Only the person holding it can log on it or move it.</div>}
    </div>
  )
}

function CheckRow({ item, value, onChange }: { item: CheckItem; value: string; onChange: (v: string) => void }) {
  const typedFact = TYPED_FACTS.includes(item.fact)
  return (
    <li>
      <span className={`${s.tick}${item.done ? ` ${s.tickOn}` : ''}`}><Check aria-hidden="true" /></span>
      <span>{item.label}</span>
      {item.done
        ? <span className={s.checkValue}>{item.value}</span>
        : typedFact
          ? <input className={s.input} aria-label={item.label} placeholder={FACT_HINTS[item.fact]} value={value} onChange={e => onChange(e.target.value)} />
          : <span className={s.checkTodo}>Log it under Log what happened</span>}
    </li>
  )
}

function Details({ lead, work, canWork }: { lead: WorkLead; work: LeadWork; canWork: boolean }) {
  const [editing, setEditing] = useState(false)
  const start = useMemo(() => ({
    name: lead.name ?? '', email: lead.email ?? '', location: lead.location ?? '', requirement: lead.requirement ?? '',
    quantity: lead.quantity ?? '', timeline: lead.timeline ?? '', segment: lead.segment ?? '', client_type: lead.client_type ?? '',
    temperature: lead.temperature, value: lead.expected_value_paise === null ? '' : String(lead.expected_value_paise / 100),
  }), [lead])
  const [form, setForm] = useState(start)
  const [problem, setProblem] = useState('')
  const set = (patch: Partial<typeof form>) => { setProblem(''); setForm(f => ({ ...f, ...patch })) }

  function save() {
    const facts: LeadFacts = {}
    for (const key of ['name', 'email', 'location', 'requirement', 'quantity', 'timeline', 'segment', 'client_type', 'temperature'] as const) {
      if (form[key] !== start[key]) facts[key] = form[key]
    }
    if (form.value !== start.value) {
      const paise = form.value.trim() === '' ? '' : parseValue(form.value)
      if (paise === null) return setProblem('Write the value as an amount, like 14,00,000 or 14 L.')
      facts.expected_value_paise = paise
    }
    void work.guarded(async () => {
      if (Object.keys(facts).length > 0) await updateFacts(work.supabase, lead.id, facts)
      setEditing(false)
    })
  }

  if (editing) {
    const text = (key: 'name' | 'email' | 'location' | 'quantity' | 'timeline', label: string) => (
      <div className={s.field}><label className={s.label} htmlFor={`fact-${key}`}>{label}</label><input id={`fact-${key}`} className={s.input} value={form[key]} onChange={e => set({ [key]: e.target.value })} /></div>
    )
    return (
      <div className={`${s.detailsEdit} ${s.order5}`}>
        <h3 className={s.secTitle}>Details</h3>
        {text('name', 'Name')}
        <div className={s.field}><label className={s.label} htmlFor="fact-req">Requirement</label><textarea id="fact-req" className={s.input} value={form.requirement} onChange={e => set({ requirement: e.target.value })} /></div>
        {text('quantity', 'Quantity')}
        {text('timeline', 'Timeline')}
        <div className={s.field}><label className={s.label} htmlFor="fact-value">Expected value (₹)</label><input id="fact-value" className={s.input} inputMode="decimal" placeholder="e.g. 14 L" value={form.value} onChange={e => set({ value: e.target.value })} /></div>
        <div className={s.field}><label className={s.label} htmlFor="fact-seg">Segment</label><select id="fact-seg" className={s.input} value={form.segment} onChange={e => set({ segment: e.target.value })}><option value="">Not set</option>{SEGMENTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div className={s.field}><label className={s.label} htmlFor="fact-type">Client type</label><select id="fact-type" className={s.input} value={form.client_type} onChange={e => set({ client_type: e.target.value })}><option value="">Not set</option>{CLIENT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        {text('location', 'Location')}
        {text('email', 'Email')}
        {problem && <div className="boe-callout boe-callout-error" role="alert">{problem}</div>}
        <div className={s.detailsFoot}>
          <button type="button" className="boe-btn boe-btn-primary" disabled={work.busy} onClick={save}>Save</button>
          <button type="button" className="boe-btn boe-btn-secondary" onClick={() => { setForm(start); setEditing(false) }}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className={s.order5}>
      <h3 className={s.secTitle}>Details</h3>
      {canWork && (
        <div className={s.field} style={{ marginBottom: 12 }}>
          <span className={s.label}>How warm is this lead?</span>
          <div className={s.choices} role="group" aria-label="How warm is this lead?">
            {TEMPERATURES.map(t => (
              <button
                key={t.value}
                type="button"
                className={s.choice}
                aria-pressed={lead.temperature === t.value}
                disabled={work.busy}
                onClick={() => { if (lead.temperature !== t.value) void work.guarded(async () => { await updateFacts(work.supabase, lead.id, { temperature: t.value }) }) }}
              >{t.label}</button>
            ))}
          </div>
        </div>
      )}
      <dl className={s.dl}>
        <dt>Requirement</dt><dd>{lead.requirement ?? 'Not known yet'}</dd>
        <dt>Quantity</dt><dd>{lead.quantity ?? 'Not known yet'}</dd>
        <dt>Timeline</dt><dd>{lead.timeline ?? 'Not known yet'}</dd>
        <dt>Expected value</dt><dd>{lead.expected_value_paise === null ? 'Not set' : valueLabel(lead.expected_value_paise)}</dd>
        <dt>Segment</dt><dd>{[SEGMENTS.find(o => o.value === lead.segment)?.label, CLIENT_TYPES.find(o => o.value === lead.client_type)?.label].filter(Boolean).join(' · ') || 'Not set'}</dd>
        <dt>Market</dt><dd>{marketLabel(lead)} <span className={s.auto}>from the number</span></dd>
        <dt>Source</dt><dd>{sourceLabel(lead.source)}</dd>
        <dt>Received</dt><dd>{dayLabel(lead.received_on)}</dd>
        {lead.email && <><dt>Email</dt><dd>{lead.email}</dd></>}
      </dl>
      {canWork && <button type="button" className={`boe-btn boe-btn-secondary ${s.linkBtn}`} onClick={() => { setForm(start); setEditing(true) }}>Edit details</button>}
    </div>
  )
}

type Entry = { key: string; at: string; body: React.ReactNode; by: string }

function activityLine(a: Activity): React.ReactNode {
  if (a.kind === 'imported') return <><span className={s.kindWord}>ClickUp</span><div className={s.note}>{a.note}</div></>
  return (
    <>
      <span className={s.kindWord}>{kindLabel(a.kind)}</span> · {outcomeLabel(a.outcome)}
      {a.note && <div className={s.note}>{a.note}</div>}
    </>
  )
}

function History({ detail }: { detail: WorkDetail }) {
  const entries: Entry[] = [
    ...detail.activities.map(a => ({ key: a.id, at: a.at, body: activityLine(a), by: a.kind === 'imported' ? 'From ClickUp' : a.actor_name ?? 'A former colleague' })),
    ...detail.events.map((e, i) => ({ key: `e${i}`, at: e.at, body: eventLine(e), by: eventBy(e) })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  return (
    <ul className={s.timeline}>
      {entries.map(e => <li key={e.key}>{e.body}<small>{e.by} · {whenLabel(e.at)}</small></li>)}
      {detail.clickup.length > 0 && (
        <li>
          <details className={s.clickup}>
            <summary>ClickUp record</summary>
            {detail.clickup.map((task, i) => (
              <dl key={i}>
                {Object.entries(task).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}
              </dl>
            ))}
          </details>
        </li>
      )}
    </ul>
  )
}
