'use client'

import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, MessageCircle, Pencil, Phone, X } from 'lucide-react'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import {
  fetchWorkLead, logActivity, SALES_KEY, updateFacts,
  type Activity, type LeadFacts, type WorkDetail, type WorkLead,
} from '@/lib/salesLeads/api'
import {
  BOARD_STAGES, CLIENT_TYPES, dueOf, kindLabel, KINDS, marketLabel, NEXT_STEPS, OUTCOMES, outcomeLabel, parseValue,
  SEGMENTS, STAGE_GUIDE, stageLabel, TEMPERATURES, valueLabel, WHEN_CHOICES, whenFrom,
  type OutcomeChoice, type Stage, type Temperature,
} from '@/lib/salesLeads/board'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { dayLabel, dayLabelLong, whenLabel } from '@/lib/salesLeads/format'
import { eventBy, eventLine, leadTitle, StepIcon } from './LeadBits'
import { useDialogFocus } from './useDialogFocus'
import type { LeadWork } from './useLeadWork'
import s from './leadBoard.module.css'

// One lead, kept short: who it is and where it stands, what happens next, and how did it go. A stage move that needs a
// fact asks for it in the small box the board and My day already use. The rest of the record is one tap away.

type Menu = 'stage' | 'heat' | null

export function WorkPanel({ leadId, work, focusLog = false, closeAfterPost = false, onClose }: {
  leadId: string
  work: LeadWork
  focusLog?: boolean
  /** On My day, posting closes the panel so the next lead is already there. */
  closeAfterPost?: boolean
  onClose: () => void
}) {
  const [menu, setMenu] = useState<Menu>(null)
  // Escape closes an open menu first, and the panel only when none is open.
  const ref = useDialogFocus<HTMLDivElement>(() => { if (menu) setMenu(null); else onClose() })
  const detail = useQuery({
    queryKey: [SALES_KEY, 'work', leadId],
    queryFn: () => fetchWorkLead(work.supabase, leadId),
    staleTime: 0,
  })

  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <aside ref={ref} className={s.drawer} role="dialog" aria-modal="true" aria-label="Lead details" tabIndex={-1}>
        {detail.data
          ? <PanelBody detail={detail.data} work={work} focusLog={focusLog} closeAfterPost={closeAfterPost} menu={menu} setMenu={setMenu} onClose={onClose} />
          : (
            <>
              <div className={s.pHead}>
                <div className={s.pTop}>
                  <h2 className={s.pTitle}>Lead</h2>
                  <button type="button" className={s.close} aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
                </div>
              </div>
              <div className={s.pBody}>
                {detail.isPending && 'Loading…'}
                {detail.isError && (
                  <div className="boe-empty">
                    <p className="boe-empty-title">This lead could not be opened</p>
                    <p>It may not be yours to see, or the connection dropped.</p>
                    <button type="button" className="boe-btn boe-btn-secondary" onClick={() => detail.refetch()}>Try again</button>
                  </div>
                )}
              </div>
            </>
          )}
      </aside>
    </>
  )
}

function PanelBody({ detail, work, focusLog, closeAfterPost, menu, setMenu, onClose }: {
  detail: WorkDetail; work: LeadWork; focusLog: boolean; closeAfterPost: boolean; menu: Menu; setMenu: (m: Menu) => void; onClose: () => void
}) {
  const { lead } = detail
  const { readOnly } = useSalesAccess()
  const canWork = detail.can_work && !readOnly
  const closed = lead.stage === 'converted' || lead.stage === 'dead'
  const due = dueOf(lead, work.today)
  const composer = useRef<HTMLElement>(null)
  useEffect(() => { if (focusLog) composer.current?.scrollIntoView({ block: 'start' }) }, [focusLog])

  const titleIsPhone = !lead.name
  const sub = [titleIsPhone ? null : formatPhone(lead.phone), lead.location, `#${lead.lead_no}`].filter(Boolean).join(' · ')
  const about = [
    SEGMENTS.find(o => o.value === lead.segment)?.label, CLIENT_TYPES.find(o => o.value === lead.client_type)?.label,
    lead.market === 'export' ? marketLabel(lead) : null, sourceLabel(lead.source),
  ].filter(Boolean).join(' · ')

  return (
    <>
      <div className={s.pHead}>
        <div className={s.pTop}>
          <h2 className={s.pTitle}>{leadTitle(lead)}<small>{sub}</small></h2>
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>
        <div className={s.pills}>
          <StagePill lead={lead} work={work} canWork={canWork} open={menu === 'stage'} setOpen={open => setMenu(open ? 'stage' : null)} />
          <HeatPill lead={lead} work={work} canWork={canWork} open={menu === 'heat'} setOpen={open => setMenu(open ? 'heat' : null)} />
          <span className={s.meta}>{about}</span>
          {lead.stuck && <span className={`${s.meta} ${s.metaRed}`}>Stuck</span>}
        </div>
        {canWork && !closed && (
          <div className={s.go}>
            <a className="boe-btn boe-btn-primary" href={telHref(lead.phone)}><Phone aria-hidden="true" />Call</a>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => work.openWhatsApp(lead)}><MessageCircle aria-hidden="true" />WhatsApp</button>
          </div>
        )}
      </div>

      <div className={s.pBody}>
        {!closed && lead.next_step && (
          <div className={`${s.next}${due.tone === 'over' ? ` ${s.nextOver}` : ''}`}>
            <StepIcon step={lead.next_step} />
            <div>
              <div className={s.nextMain}>{lead.next_step}</div>
              <div className={s.nextSub}>{due.tone === 'over' ? `${due.label}, was due ${dayLabelLong(lead.next_due_on ?? '')}` : `Due ${dayLabelLong(lead.next_due_on ?? '')}`}</div>
            </div>
          </div>
        )}
        {lead.stage === 'dead' && (
          <div className={s.next}>
            <div>
              <div className={s.nextMain}>Dead · {due.label}</div>
              {lead.dead_note && <div className={s.nextSub}>{lead.dead_note}</div>}
            </div>
          </div>
        )}
        {canWork && !closed && (
          <Composer ref={composer} lead={lead} work={work} onPosted={() => { if (closeAfterPost) onClose() }} />
        )}
        <About lead={lead} work={work} canWork={canWork} />
        <History detail={detail} />
        {!canWork && <div className={s.readOnly}>You can read this lead. {lead.holder_name ? `${lead.holder_name} holds it, and only` : 'Only'} the person holding it can log on it or move it.</div>}
      </div>
    </>
  )
}

/** A menu in the panel closes when the person clicks anywhere else. */
function useCloseOnOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const closeNow = useEffectEvent(close)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) closeNow() }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  return ref
}

function StagePill({ lead, work, canWork, open, setOpen }: { lead: WorkLead; work: LeadWork; canWork: boolean; open: boolean; setOpen: (open: boolean) => void }) {
  const wrap = useCloseOnOutside(open, () => setOpen(false))
  const button = useRef<HTMLButtonElement>(null)
  const closed = lead.stage === 'converted' || lead.stage === 'dead'
  const others = BOARD_STAGES.filter(stage => stage !== lead.stage)
  // Focus goes back to the pill, so a keyboard user is not left on a menu item that has just disappeared.
  const pick = (to: Stage) => { setOpen(false); button.current?.focus(); work.moveTo(lead, to) }
  return (
    <div ref={wrap} className={s.pMenuWrap}>
      <button
        ref={button} type="button" className={`${s.pPill} ${s.pPillStage}`} disabled={!canWork} aria-haspopup="menu" aria-expanded={open}
        title={STAGE_GUIDE[lead.stage]} onClick={() => setOpen(!open)}
      >
        {stageLabel(lead.stage)}{canWork && <ChevronDown aria-hidden="true" />}
      </button>
      {open && (
        <div className={s.pMenu} role="menu">
          <div className={s.menuHead}>{closed ? 'Reopen to' : 'Move to'}</div>
          {others.map(stage => <button key={stage} type="button" role="menuitem" className={s.menuItem} onClick={() => pick(stage)}>{stageLabel(stage)}</button>)}
          {!closed && (
            <>
              <hr className={s.menuLine} />
              <button type="button" role="menuitem" className={s.menuItem} onClick={() => pick('converted')}>Converted</button>
              <button type="button" role="menuitem" className={s.menuItem} onClick={() => pick('dead')}>Dead</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const HEAT_CLASS: Record<Temperature, string> = { hot: s.heatHot, warm: s.heatWarm, cold: s.heatCold }

function HeatPill({ lead, work, canWork, open, setOpen }: { lead: WorkLead; work: LeadWork; canWork: boolean; open: boolean; setOpen: (open: boolean) => void }) {
  const wrap = useCloseOnOutside(open, () => setOpen(false))
  const button = useRef<HTMLButtonElement>(null)
  const label = TEMPERATURES.find(t => t.value === lead.temperature)?.label
  const pick = (value: Temperature) => {
    setOpen(false)
    button.current?.focus()
    if (value !== lead.temperature) void work.guarded(async () => { await updateFacts(work.supabase, lead.id, { temperature: value }) })
  }
  return (
    <div ref={wrap} className={s.pMenuWrap}>
      <button ref={button} type="button" className={s.pPill} disabled={!canWork} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`${s.heat} ${HEAT_CLASS[lead.temperature]}`} aria-hidden="true" />{label}{canWork && <ChevronDown aria-hidden="true" />}
      </button>
      {open && (
        <div className={s.pMenu} role="menu">
          <div className={s.menuHead}>How warm is this lead?</div>
          {TEMPERATURES.map(t => (
            <button key={t.value} type="button" role="menuitemradio" aria-checked={lead.temperature === t.value} className={s.menuItem} onClick={() => pick(t.value)}>
              <span className={`${s.heat} ${HEAT_CLASS[t.value]}`} aria-hidden="true" />{t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Composer({ ref, lead, work, onPosted }: { ref: React.Ref<HTMLElement>; lead: WorkLead; work: LeadWork; onPosted: () => void }) {
  const [kind, setKind] = useState<string>('call')
  // Nothing is chosen until the person chooses: an answer nobody gave is never logged for them.
  const [outcome, setOutcome] = useState<OutcomeChoice | null>(null)
  const [note, setNote] = useState('')
  const [nextStep, setNextStep] = useState<string>('')
  const [days, setDays] = useState<number | 'pick'>(1)
  const [picked, setPicked] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const notInterested = outcome === 'not_interested'
  const nextDue = days === 'pick' ? picked : whenFrom(work.today, days)
  const ready = outcome !== null && (notInterested || (nextStep.trim() !== '' && nextDue !== ''))

  function choose(choice: OutcomeChoice) {
    if (outcome === choice) { setOutcome(null); setEditing(false); return }
    setOutcome(choice)
    const o = OUTCOMES.find(x => x.value === choice)
    if (o && o.step) { setNextStep(o.step); setDays(o.inDays) }
  }

  async function post() {
    if (!outcome) return
    setSaving(true)
    try {
      if (notInterested) {
        // The call happened, so it is logged and the first call counts; then the lead asks why it is dead.
        await logActivity(work.supabase, lead.id, { kind, outcome, note, nextStep: 'Close as dead', nextDue: work.today })
        await work.refresh()
        setNote(''); setOutcome(null)
        work.moveTo(lead, 'dead', note)
        return
      }
      const r = await logActivity(work.supabase, lead.id, { kind, outcome, note, nextStep: nextStep.trim(), nextDue })
      await work.refresh()
      work.said(`Saved. Next: ${nextStep.trim()}, ${dayLabel(nextDue)}.`, r.activity_id)
      setNote(''); setOutcome(null); setEditing(false)
      onPosted()
    } catch (e) {
      work.fail(e)
      await work.refresh()
    } finally {
      setSaving(false)
    }
  }

  const box = useRef<HTMLTextAreaElement>(null)
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px` }
  // After a post the box is empty again, so it goes back to one line.
  useEffect(() => { if (note === '' && box.current) box.current.style.height = 'auto' }, [note])
  return (
    <section ref={ref} className={s.sec} aria-label="Log what happened">
      <div className={s.secHead}>
        <h3 className={s.secTitle}>How did it go?</h3>
        <select className={s.kind} aria-label="What kind of contact this was" title="What kind of contact this was" value={kind} onChange={e => setKind(e.target.value)}>
          {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>
      <div className={s.outs} role="group" aria-label="How did it go?">
        {OUTCOMES.filter(o => o.value !== 'not_interested').map(o => (
          <button key={o.value} type="button" className={s.out} aria-pressed={outcome === o.value} onClick={() => choose(o.value)}>{o.label}</button>
        ))}
        <button type="button" className={s.out} disabled={work.busy} title="Logs it now and tries again tomorrow" onClick={() => work.noAnswer(lead)}>No answer</button>
        <button type="button" className={`${s.out} ${s.outDead}`} aria-pressed={outcome === 'not_interested'} onClick={() => choose('not_interested')}>Not interested</button>
      </div>
      <textarea
        id="log-note" ref={box} className={s.say} rows={1} maxLength={4000} aria-label="What was said" placeholder="What was said? (optional)"
        value={note} onChange={e => { setNote(e.target.value); grow(e.target) }}
      />
      {outcome && (
        <>
          <div className={s.saveBar}>
            {notInterested ? (
              <div className={s.saveText}>Saved as a call. <b>The next question asks why.</b></div>
            ) : (
              <div className={s.saveText}>
                Next: <b>{nextStep || 'choose a step'}</b>, {nextDue ? dayLabelLong(nextDue) : 'pick a date'}{' '}
                <button type="button" className={s.linkBtn} aria-expanded={editing} onClick={() => setEditing(e => !e)}><Pencil aria-hidden="true" />Change</button>
              </div>
            )}
            <button type="button" className="boe-btn boe-btn-primary" disabled={!ready || saving} onClick={() => void post()}>{saving ? 'Saving…' : notInterested ? 'Continue' : 'Save'}</button>
          </div>
          {editing && !notInterested && (
            <div className={s.editGrid}>
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
              </div>
              {days === 'pick' && (
                <div className={`${s.field} ${s.editFull}`}>
                  <input className={s.input} type="date" aria-label="Pick a date" min={work.today} value={picked} onChange={e => setPicked(e.target.value)} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function About({ lead, work, canWork }: { lead: WorkLead; work: LeadWork; canWork: boolean }) {
  const [editing, setEditing] = useState(false)
  const start = useMemo(() => ({
    name: lead.name ?? '', email: lead.email ?? '', location: lead.location ?? '', requirement: lead.requirement ?? '',
    quantity: lead.quantity ?? '', timeline: lead.timeline ?? '', segment: lead.segment ?? '', client_type: lead.client_type ?? '',
    value: lead.expected_value_paise === null ? '' : String(lead.expected_value_paise / 100),
  }), [lead])
  const [form, setForm] = useState(start)
  const [problem, setProblem] = useState('')
  const set = (patch: Partial<typeof form>) => { setProblem(''); setForm(f => ({ ...f, ...patch })) }

  function save() {
    const facts: LeadFacts = {}
    for (const key of ['name', 'email', 'location', 'requirement', 'quantity', 'timeline', 'segment', 'client_type'] as const) {
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
      <section className={`${s.sec} ${s.detailsEdit}`} aria-label="About this lead">
        <h3 className={s.secTitle}>About this lead</h3>
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
      </section>
    )
  }

  // Only what is known is shown; what is not, is one line, so nobody scans a column of "Not known yet".
  const facts: [string, string | null][] = [
    ['Requirement', lead.requirement], ['Quantity', lead.quantity],
    ['Expected value', lead.expected_value_paise === null ? null : valueLabel(lead.expected_value_paise)], ['Timeline', lead.timeline],
    ['Email', lead.email],
  ]
  const known = facts.filter(([, value]) => value)
  const missing = facts.slice(0, 4).filter(([, value]) => !value)
  return (
    <section className={s.sec} aria-label="About this lead">
      <div className={s.secHead}>
        <h3 className={s.secTitle}>About this lead</h3>
        {canWork && <button type="button" className={s.linkBtn} onClick={() => { setForm(start); setEditing(true) }}>Edit</button>}
      </div>
      <dl className={s.dl}>
        {known.map(([label, value]) => <div key={label} className={s.dlRow}><dt>{label}</dt><dd>{value}</dd></div>)}
        {missing.length > 0 && <div className={s.dlRow}><dt>Not known yet</dt><dd className={s.dlNone}>{missing.map(([label]) => label.toLowerCase()).join(', ')}</dd></div>}
      </dl>
    </section>
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

const SHORT = 3

function History({ detail }: { detail: WorkDetail }) {
  const [all, setAll] = useState(false)
  const entries: Entry[] = [
    ...detail.activities.map(a => ({ key: a.id, at: a.at, body: activityLine(a), by: a.kind === 'imported' ? 'From ClickUp' : a.actor_name ?? 'A former colleague' })),
    ...detail.events.map((e, i) => ({ key: `e${i}`, at: e.at, body: eventLine(e), by: eventBy(e) })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const more = entries.length > SHORT || detail.clickup.length > 0
  return (
    <section className={s.sec} aria-label="History">
      <h3 className={s.secTitle}>History</h3>
      <ul className={s.timeline}>
        {(all ? entries : entries.slice(0, SHORT)).map(e => <li key={e.key}>{e.body}<small>{e.by} · {whenLabel(e.at)}</small></li>)}
        {all && detail.clickup.length > 0 && (
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
      {more && (
        <button type="button" className={`${s.linkBtn} ${s.linkStart}`} aria-expanded={all} onClick={() => setAll(a => !a)}>
          {all ? 'Show less' : `Show all ${entries.length}`}
        </button>
      )}
    </section>
  )
}
