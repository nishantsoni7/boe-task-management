'use client'

import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, MessageCircle, Phone, Search, X } from 'lucide-react'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import {
  addComment, changeDue, fetchWorkLead, SALES_KEY, updateFacts,
  type LeadFacts, type WorkDetail, type WorkLead,
} from '@/lib/salesLeads/api'
import {
  activityTag, CLIENT_TYPES, dueOf, followUpChoices, isSunday, lastLabel, marketLabel, nextWorkingDay, parseValue,
  QUICK_NOTES, SEGMENTS, stageLabel, STAGE_GUIDE, TEMPERATURES, valueLabel,
  type CommentTag, type Stage, type Temperature,
} from '@/lib/salesLeads/board'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { dayHeading, dayShort, initialsOf, istDayOf, timeLabel } from '@/lib/salesLeads/format'
import { eventBy, eventLine, leadTitle } from './LeadBits'
import { useDialogFocus } from './useDialogFocus'
import type { LeadWork } from './useLeadWork'
import s from './leadBoard.module.css'

// One lead in a popup in the middle of the page (owner, 2026-11-13, after a clickable preview, on the lines of ClickUp):
// on the left who the client is, where the lead stands and what they want; on the right one box to write an update and
// everything that happened, newest first, a day at a time. Call and WhatsApp beside the name (Call came back on
// 2026-11-13); no "how did it go" form. Previous and next walk the list the lead was opened from; Esc, the cross or a
// click outside closes it. On a phone it fills the screen and the two sides are two tabs.

/** Only one menu is open at a time; Escape closes it before it closes the popup. */
type Menu = 'status' | 'due' | 'next' | null
type Tab = 'details' | 'activity'

/** The list the lead was opened from, so Previous and Next can walk it. */
export type LeadNav = { ids: readonly string[]; label: string }

export function WorkPanel({ leadId, work, nav, onNavigate, focusLog = false, closeAfterPost = false, onClose }: {
  leadId: string
  work: LeadWork
  nav?: LeadNav
  onNavigate?: (id: string) => void
  focusLog?: boolean
  /** On My day, posting closes the popup so the next lead is already there. */
  closeAfterPost?: boolean
  onClose: () => void
}) {
  const [menu, setMenu] = useState<Menu>(null)
  const [tab, setTab] = useState<Tab>(focusLog ? 'activity' : 'details')
  // Escape closes an open menu first, and the popup only when none is open.
  const ref = useDialogFocus<HTMLDivElement>(() => { if (menu) setMenu(null); else onClose() })
  const detail = useQuery({
    queryKey: [SALES_KEY, 'work', leadId],
    queryFn: () => fetchWorkLead(work.supabase, leadId),
    staleTime: 0,
  })

  const at = nav ? nav.ids.indexOf(leadId) : -1
  const prev = at > 0 ? nav?.ids[at - 1] : undefined
  const next = at >= 0 && nav && at < nav.ids.length - 1 ? nav.ids[at + 1] : undefined
  const go = (id: string | undefined) => { if (id && onNavigate) { setMenu(null); onNavigate(id) } }

  // ← and → walk the list, unless the person is typing or a menu is open.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (menu || e.altKey || e.ctrlKey || e.metaKey) return
    const el = e.target as HTMLElement | null
    if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
    if (e.key === 'ArrowLeft') go(prev)
    if (e.key === 'ArrowRight') go(next)
  })
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onKey(e)
    document.addEventListener('keydown', listen)
    return () => document.removeEventListener('keydown', listen)
  }, [])

  const count = detail.data ? detail.data.activities.length + detail.data.events.length : null
  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <div ref={ref} className={s.modal} data-tab={tab} role="dialog" aria-modal="true" aria-label={detail.data ? `Lead ${leadTitle(detail.data.lead)}` : 'Lead'} tabIndex={-1}>
        <header className={s.mBar}>
          <div className={s.mNav}>
            {nav && onNavigate && at >= 0 && (
              <>
                <button type="button" className={s.mIcon} aria-label="Previous lead" title="Previous lead (←)" disabled={!prev} onClick={() => go(prev)}><ChevronLeft aria-hidden="true" /></button>
                <button type="button" className={s.mIcon} aria-label="Next lead" title="Next lead (→)" disabled={!next} onClick={() => go(next)}><ChevronRight aria-hidden="true" /></button>
                <span className={s.mPos}><b>{at + 1} of {nav.ids.length}</b> {nav.label}</span>
              </>
            )}
          </div>
          <div className={s.mCrumb}>
            {detail.data && `Lead #${detail.data.lead.lead_no} · ${sourceLabel(detail.data.lead.source)} · received ${dayShort(detail.data.lead.received_on)}`}
          </div>
          <div className={s.mBarEnd}>
            <span className={s.mEsc}>Esc to close</span>
            <button type="button" className={s.mIcon} aria-label="Close" title="Close (Esc)" onClick={onClose}><X aria-hidden="true" /></button>
          </div>
        </header>

        {/* A phone shows one side at a time. */}
        <div className={s.mTabs} role="tablist" aria-label="Lead">
          <button type="button" role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Details</button>
          <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
            Activity{count !== null && <span className={s.mCount}>{count}</span>}
          </button>
        </div>

        {detail.data ? (
          <PanelBody key={leadId} detail={detail.data} work={work} focusLog={focusLog} closeAfterPost={closeAfterPost} menu={menu} setMenu={setMenu} onClose={onClose} />
        ) : (
          <div className={s.mLoading}>
            {detail.isPending && 'Loading…'}
            {detail.isError && (
              <div className="boe-empty">
                <p className="boe-empty-title">This lead could not be opened</p>
                <p>It may not be yours to see, or the connection dropped.</p>
                <button type="button" className="boe-btn boe-btn-secondary" onClick={() => detail.refetch()}>Try again</button>
              </div>
            )}
          </div>
        )}
      </div>
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
  return (
    <div className={s.mBody}>
      <div className={s.mLeft} aria-label="Lead details">
        <Who lead={lead} work={work} canWork={canWork} closed={closed} />
        <StateBox lead={lead} since={stageSince(detail)} work={work} canWork={canWork} closed={closed} menu={menu} setMenu={setMenu} />
        <Details lead={lead} work={work} canWork={canWork} />
        {!canWork && <div className={s.readOnly}>You can read this lead. {lead.holder_name ? `${lead.holder_name} holds it, and only` : 'Only'} the person holding it can write on it or move it.</div>}
      </div>
      <ActivitySide
        detail={detail} work={work} canWrite={canWork && !closed} focusLog={focusLog} menu={menu} setMenu={setMenu}
        onPosted={() => { if (closeAfterPost) onClose() }}
      />
    </div>
  )
}

/** A menu in the popup closes when the person clicks anywhere else. */
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

// ── Left: who, where it stands, what they want ──────────────────────────────────────────────────────────────────────

/** The name, the number and how to reach them: Call (from the phone's dialler) and WhatsApp (owner, 2026-11-13). */
function Who({ lead, work, canWork, closed }: { lead: WorkLead; work: LeadWork; canWork: boolean; closed: boolean }) {
  return (
    <div className={s.mWho}>
      <div className={s.mWhoText}>
        <h2 className={s.mName}>{leadTitle(lead)}</h2>
        <div className={s.mMeta}>
          {lead.name && <span className={s.mPhone}>{formatPhone(lead.phone)}</span>}
          {lead.name && <span className={s.mDot} aria-hidden="true">·</span>}
          <span>{marketLabel(lead)}</span>
          <span className={s.mDot} aria-hidden="true">·</span>
          <span>{lastLabel(lead, work.today)}</span>
          {lead.stuck && <span className={s.mStuck}>Stuck</span>}
        </div>
      </div>
      {canWork && !closed && (
        <div className={s.mReach}>
          <a className={s.mCall} href={telHref(lead.phone)}><Phone aria-hidden="true" />Call</a>
          <button type="button" className={s.mWa} onClick={() => work.openWhatsApp(lead)}><MessageCircle aria-hidden="true" />WhatsApp</button>
        </div>
      )}
    </div>
  )
}

const HEAT_CLASS: Record<Temperature, string> = { hot: s.heatHot, warm: s.heatWarm, cold: s.heatCold }

/**
 * When the lead entered its stage, from its own history: the last move, else the stage ClickUp gave it, else when it was
 * brought in. Null when the history says nothing.
 */
function stageSince(detail: WorkDetail): string | null {
  const marks = detail.events.filter(e => e.kind === 'moved' || e.kind === 'clickup_status' || e.kind === 'imported' || e.kind === 'added')
  return marks.reduce<string | null>((latest, e) => (!latest || e.at > latest ? e.at : latest), null) ?? detail.lead.assigned_at
}

/** Days since the lead entered its stage, in words. */
const inStage = (since: string, now: number) => {
  const d = Math.max(0, Math.floor((now - Date.parse(since)) / 86_400_000))
  return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

/** Each status's colour dot: the status, not a step of a path (any status can follow any other). */
const STATUS_DOT: Record<Stage, string> = {
  new: '#8A8F8E', under_process: '#C98A1E', visit_meeting: '#5B7FB8', potential: '#B9472E', negotiation: '#7A4FB0',
  follow_up_later: '#686D6C', converted: '#2F7D4F', dead: '#A12438',
}
/** The statuses a lead can be put in, in the owner's order; the three ways out after a line. */
const STATUS_OPEN: readonly Stage[] = ['new', 'under_process', 'visit_meeting', 'potential', 'negotiation']
const STATUS_OUT: readonly Stage[] = ['follow_up_later', 'converted', 'dead']

/**
 * Where it stands: the Board status as one dropdown (owner, 2026-11-13, option B: a lead can go from any status to any
 * other, so it is a choice, not a path); then Hot / Warm / Cold, the next follow-up and who holds it, as plain rows.
 */
function StateBox({ lead, since, work, canWork, closed, menu, setMenu }: {
  lead: WorkLead; since: string | null; work: LeadWork; canWork: boolean; closed: boolean; menu: Menu; setMenu: (m: Menu) => void
}) {
  // The moment the popup opened: "12 days" in the status does not need to tick.
  const [now] = useState(() => Date.now())
  const due = dueOf(lead, work.today)
  const heat = (value: Temperature) => {
    if (value !== lead.temperature) void work.guarded(async () => { await updateFacts(work.supabase, lead.id, { temperature: value }) })
  }
  return (
    <>
      <section className={s.mStage} aria-label="Board status">
        <div className={s.mStageHead}>
          <span className={s.mStageKey}>Board status</span>
          {since && <span className={s.mSince}>for {inStage(since, now)}</span>}
        </div>
        <StatusMenu lead={lead} work={work} canWork={canWork} open={menu === 'status'} setOpen={open => setMenu(open ? 'status' : null)} />
        {(lead.stage === 'dead' || lead.dead_note) && (
          <p className={s.mDeadNote}>{lead.stage === 'dead' ? due.label : ''}{lead.stage === 'dead' && lead.dead_note ? ' · ' : ''}{lead.dead_note}</p>
        )}
        {closed && canWork && <p className={s.mDeadNote}>Choose a status to reopen it.</p>}
      </section>
      <dl className={s.mRows}>
        <div>
          <dt>Hot / Warm / Cold</dt>
          <dd>
            <span className={s.mHeat} role="group" aria-label="How warm is this lead?">
              {TEMPERATURES.map(t => (
                <button key={t.value} type="button" aria-pressed={lead.temperature === t.value} disabled={!canWork} onClick={() => heat(t.value)}>
                  <i className={`${s.heat} ${HEAT_CLASS[t.value]}`} aria-hidden="true" />{t.label}
                </button>
              ))}
            </span>
          </dd>
        </div>
        {!closed && (
          <div>
            <dt>Next follow-up</dt>
            <dd><DueChip lead={lead} work={work} canWork={canWork} open={menu === 'due'} setOpen={open => setMenu(open ? 'due' : null)} /></dd>
          </div>
        )}
        <div>
          <dt>Held by</dt>
          <dd>
            {lead.holder_name
              ? <span className={s.mPerson}><i className={s.mAvSm} aria-hidden="true">{initialsOf(lead.holder_name)}</i>{lead.holder_name}</span>
              : <span className={s.mNone}>Nobody yet</span>}
          </dd>
        </div>
      </dl>
    </>
  )
}

/** The Board status: the current one on the button, every status in the menu; picking one moves the lead at once. */
function StatusMenu({ lead, work, canWork, open, setOpen }: { lead: WorkLead; work: LeadWork; canWork: boolean; open: boolean; setOpen: (open: boolean) => void }) {
  const wrap = useCloseOnOutside(open, () => setOpen(false))
  const button = useRef<HTMLButtonElement>(null)
  // Focus goes back to the button, so a keyboard user is not left on a menu item that has just disappeared.
  const pick = (stage: Stage) => { setOpen(false); button.current?.focus(); if (stage !== lead.stage) work.moveTo(lead, stage) }
  const item = (stage: Stage) => (
    <button key={stage} type="button" role="menuitemradio" aria-checked={lead.stage === stage} className={s.mStatusItem} title={STAGE_GUIDE[stage]} onClick={() => pick(stage)}>
      <i className={s.mDot8} style={{ background: STATUS_DOT[stage] }} aria-hidden="true" />{stageLabel(stage)}
      {lead.stage === stage && <span className={s.mStatusNow}>current</span>}
    </button>
  )
  return (
    <div ref={wrap} className={s.mRel}>
      <button
        ref={button} type="button" className={s.mStatusBtn} disabled={!canWork} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Board status: ${stageLabel(lead.stage)}. Change it`} onClick={() => setOpen(!open)}
      >
        <i className={s.mDot8} style={{ background: STATUS_DOT[lead.stage] }} aria-hidden="true" />
        <b>{stageLabel(lead.stage)}</b>
        {canWork && <ChevronDown aria-hidden="true" />}
      </button>
      {open && (
        <div className={s.mStatusMenu} role="menu" aria-label="Move this lead to">
          {STATUS_OPEN.map(item)}
          <hr className={s.menuLine} />
          {STATUS_OUT.map(item)}
        </div>
      )}
    </div>
  )
}

/** The follow-up date of an open lead, changeable in any stage. */
function DueChip({ lead, work, canWork, open, setOpen }: { lead: WorkLead; work: LeadWork; canWork: boolean; open: boolean; setOpen: (open: boolean) => void }) {
  const wrap = useCloseOnOutside(open, () => setOpen(false))
  const date = lead.next_due_on
  const due = dueOf(lead, work.today)
  const note = due.tone !== 'plain' || due.label === 'Tomorrow' ? due.label : ''
  function pick(day: string) {
    setOpen(false)
    if (day === date) return
    void work.guarded(async () => {
      const r = await changeDue(work.supabase, lead.id, day)
      if (r.status === 'saved') work.said(`Follow-up moved to ${dayShort(day)}.`)
    })
  }
  return (
    <div ref={wrap} className={s.mRel}>
      <button
        type="button" className={`${s.mDue}${due.tone === 'over' ? ` ${s.mDueOver}` : ''}`} disabled={!canWork} aria-haspopup="menu" aria-expanded={open}
        title="Change the follow-up date" onClick={() => setOpen(!open)}
      >
        <CalendarDays aria-hidden="true" />
        <b>{date ? dayShort(date) : 'No date'}</b>
        {note && <span className={s.mDueNote}>{note}</span>}
        {canWork && <span className={s.mChange}>Change</span>}
      </button>
      {open && <FollowUpMenu today={work.today} value={date ?? ''} onPick={pick} />}
    </div>
  )
}

/** The dates offered for a follow-up: the next working day first, then 3 days, a week, or any date from today. */
function FollowUpMenu({ today, value, onPick }: { today: string; value: string; onPick: (day: string) => void }) {
  const choices = followUpChoices(today)
  return (
    <div className={s.mPop} role="menu" aria-label="Choose the follow-up date">
      <div className={s.menuHead}>Follow up on</div>
      {choices.map(c => (
        <button key={c.date} type="button" role="menuitemradio" aria-checked={value === c.date} className={s.mPopItem} onClick={() => onPick(c.date)}>
          <span><b>{dayShort(c.date)}</b><small>{c.why}{isSunday(c.date) ? ' · a Sunday' : ''}</small></span>
          <i className={s.mTick} aria-hidden="true" />
        </button>
      ))}
      <label className={s.mPick}>
        <span>Pick a date</span>
        <input type="date" min={today} value={choices.some(c => c.date === value) ? '' : value} onChange={e => { if (e.target.value >= today) onPick(e.target.value) }} />
      </label>
    </div>
  )
}

/** Client, Requirement and Order value, read as rows; "Edit details" turns all three into one form. */
function Details({ lead, work, canWork }: { lead: WorkLead; work: LeadWork; canWork: boolean }) {
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const start = useMemo(() => ({
    name: lead.name ?? '', email: lead.email ?? '', location: lead.location ?? '', requirement: lead.requirement ?? '',
    quantity: lead.quantity ?? '', timeline: lead.timeline ?? '', segment: lead.segment ?? '', client_type: lead.client_type ?? '',
    value: lead.expected_value_paise === null ? '' : String(lead.expected_value_paise / 100),
  }), [lead])
  const [form, setForm] = useState(start)
  const [problem, setProblem] = useState('')
  const set = (patch: Partial<typeof form>) => { setProblem(''); setForm(f => ({ ...f, ...patch })) }
  const edit = () => { setForm(start); setProblem(''); setEditing(true) }

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

  async function copy() {
    try {
      await navigator.clipboard.writeText(lead.phone)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      work.said('The number could not be copied. Select it instead.')
    }
  }

  if (editing) {
    const text = (key: 'name' | 'email' | 'location' | 'quantity' | 'timeline', label: string) => (
      <div className={s.field}><label className={s.label} htmlFor={`fact-${key}`}>{label}</label><input id={`fact-${key}`} className={s.input} value={form[key]} onChange={e => set({ [key]: e.target.value })} /></div>
    )
    return (
      <section className={`${s.mSec} ${s.detailsEdit}`} aria-label="Edit the details">
        <h3 className={s.mH3}>Edit details</h3>
        <div className={s.mForm}>
          {text('name', 'Name')}
          {text('email', 'Email')}
          {text('location', 'Location')}
          <div className={s.field}><label className={s.label} htmlFor="fact-type">Type of client</label><select id="fact-type" className={s.input} value={form.client_type} onChange={e => set({ client_type: e.target.value })}><option value="">Not set</option>{CLIENT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
          <div className={s.field}><label className={s.label} htmlFor="fact-seg">Segment</label><select id="fact-seg" className={s.input} value={form.segment} onChange={e => set({ segment: e.target.value })}><option value="">Not set</option>{SEGMENTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
          {text('quantity', 'Quantity')}
          <div className={s.field}><label className={s.label} htmlFor="fact-value">Project value, approx. (₹)</label><input id="fact-value" className={s.input} inputMode="decimal" placeholder="e.g. 8 L" value={form.value} onChange={e => set({ value: e.target.value })} /></div>
          <div className={`${s.field} ${s.mFull}`}><label className={s.label} htmlFor="fact-req">Requirement</label><textarea id="fact-req" className={s.input} value={form.requirement} onChange={e => set({ requirement: e.target.value })} /></div>
          {text('timeline', 'Needed by')}
        </div>
        {problem && <div className="boe-callout boe-callout-error" role="alert">{problem}</div>}
        <div className={s.detailsFoot}>
          <button type="button" className="boe-btn boe-btn-primary" disabled={work.busy} onClick={save}>Save</button>
          <button type="button" className="boe-btn boe-btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </section>
    )
  }

  const kind = [CLIENT_TYPES.find(o => o.value === lead.client_type)?.label, SEGMENTS.find(o => o.value === lead.segment)?.label].filter(Boolean).join(' · ')
  const none = <span className={s.mNone}>Not shared</span>
  return (
    <>
      <section className={s.mSec} aria-label="Client details">
        <div className={s.mSecHead}>
          <h3 className={s.mH3}>Client details</h3>
          {canWork && <button type="button" className={s.linkBtn} onClick={edit}>Edit details</button>}
        </div>
        <dl className={s.mRows}>
          <div><dt>Phone</dt><dd>{formatPhone(lead.phone)} <button type="button" className={s.mCopy} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></dd></div>
          <div><dt>Email</dt><dd>{lead.email || none}</dd></div>
          <div><dt>Location</dt><dd>{lead.location || none}</dd></div>
          <div><dt>Type of client</dt><dd>{kind || none}</dd></div>
          {/* Quantity lives with the client's details (owner, 2026-11-13), not under the requirement. */}
          <div><dt>Quantity</dt><dd>{lead.quantity || none}</dd></div>
          <div><dt>Source</dt><dd>{sourceLabel(lead.source)}</dd></div>
        </dl>
      </section>
      <section className={s.mSec} aria-label="Requirement">
        <div className={s.mSecHead}><h3 className={s.mH3}>Requirement</h3></div>
        {lead.requirement ? <p className={s.mReq}>{lead.requirement}</p> : <p className={s.mNone}>The client has not said what they need yet.</p>}
        <dl className={s.mRows}>
          <div><dt>Needed by</dt><dd>{lead.timeline || none}</dd></div>
        </dl>
      </section>
      <section className={s.mSec} aria-label="Project value">
        <div className={s.mSecHead}><h3 className={s.mH3}>Project value (approx.)</h3></div>
        <div className={s.mValue}>
          {lead.expected_value_paise !== null
            ? <span className={s.mBig}>{valueLabel(lead.expected_value_paise)}</span>
            : <span className={s.mNone}>Not set yet. It is asked for before Potential Clients.</span>}
          {canWork && lead.expected_value_paise === null && <button type="button" className={s.linkBtn} onClick={edit}>Add</button>}
        </div>
      </section>
    </>
  )
}

// ── Right: write an update, and everything that happened ────────────────────────────────────────────────────────────

type Entry =
  | { key: string; at: string; type: 'comment'; by: string; text: string | null; tag: ReturnType<typeof activityTag>; due: string | null; imported: boolean }
  | { key: string; at: string; type: 'system'; line: React.ReactNode; by: string }

const SHOWN = 30
const TAG_CLASS = { no: s.mTagNo, quote: s.mTagQuote, plain: s.mTagPlain } as const

/** The words, with every place the search matched marked. */
function Marked({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>
}

function ActivitySide({ detail, work, canWrite, focusLog, menu, setMenu, onPosted }: {
  detail: WorkDetail; work: LeadWork; canWrite: boolean; focusLog: boolean; menu: Menu; setMenu: (m: Menu) => void; onPosted: () => void
}) {
  const [updatesOnly, setUpdatesOnly] = useState(false)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const query = q.trim().toLowerCase()

  // A comment and the move it caused share a moment; the move is the later of the two, so it comes first.
  const rank = (e: Entry) => (e.type === 'system' ? 0 : 1)
  const entries: Entry[] = useMemo(() => [
    ...detail.activities.map<Entry>(a => ({
      key: a.id, at: a.at, type: 'comment', by: a.kind === 'imported' ? 'From ClickUp' : a.actor_name ?? 'A former colleague', text: a.note,
      tag: a.kind === 'imported' ? null : activityTag(a), due: a.next_due_on, imported: a.kind === 'imported',
    })),
    ...detail.events.map<Entry>((e, i) => ({ key: `e${i}`, at: e.at, type: 'system', line: eventLine(e), by: eventBy(e) })),
  ].sort((a, b) => b.at.localeCompare(a.at) || rank(a) - rank(b)), [detail])

  // A search reads the updates (words, who, tag); the system lines are left out while it runs.
  const shown = entries.filter(e => {
    if (e.type === 'system') return !updatesOnly && !query
    if (!query) return true
    return [e.text ?? '', e.by, e.tag?.label ?? ''].join(' ').toLowerCase().includes(query)
  })
  const list = all || query ? shown : shown.slice(0, SHOWN)

  return (
    <div className={s.mRight} aria-label="Activity">
      <div className={s.mRHead}>
        <h3 className={s.mH3}>Activity</h3>
        <div className={s.mTools}>
          <div className={s.mSeg} role="group" aria-label="Show">
            <button type="button" aria-pressed={!updatesOnly} onClick={() => setUpdatesOnly(false)}>All</button>
            <button type="button" aria-pressed={updatesOnly} onClick={() => setUpdatesOnly(true)}>Updates only</button>
          </div>
          <button
            type="button" className={s.mIcon} aria-label="Search this lead's activity" title="Search" aria-pressed={searching}
            onClick={() => { setSearching(v => !v); setQ('') }}
          ><Search aria-hidden="true" /></button>
        </div>
      </div>
      {searching && (
        <div className={s.mSearch}>
          <input type="search" autoFocus placeholder="Search this lead's updates" aria-label="Search this lead's updates" value={q} onChange={e => setQ(e.target.value)} />
          {query && <span className={s.mNone}>{shown.length} found</span>}
        </div>
      )}
      {canWrite && <Composer lead={detail.lead} work={work} focus={focusLog} menu={menu} setMenu={setMenu} onPosted={onPosted} />}
      <div className={s.mFeed}>
        {list.length === 0 && <p className={s.mNone}>{query ? 'Nothing matches.' : 'Nothing yet. The first update appears here.'}</p>}
        {list.map((e, i) => {
          const day = istDayOf(e.at)
          const heading = i === 0 || istDayOf(list[i - 1].at) !== day
          return (
            <Fragment key={e.key}>
              {heading && <div className={s.mDay}><span>{dayHeading(day, work.today)}</span></div>}
              {e.type === 'comment' ? (
                <div className={s.mEntry}>
                  <span className={s.mAv} aria-hidden="true">{e.imported ? 'CU' : initialsOf(e.by)}</span>
                  <div className={s.mBubble}>
                    <div className={s.mEHead}><b>{e.by}</b><time dateTime={e.at}>{timeLabel(e.at)}</time></div>
                    {e.text && <p><Marked text={e.text} q={query} /></p>}
                    {(e.tag || e.due) && (
                      <div className={s.mTags}>
                        {e.tag && <span className={`${s.mTag} ${TAG_CLASS[e.tag.tone]}`}>{e.tag.label}</span>}
                        {e.due && <span className={`${s.mTag} ${s.mTagDue}`}>Follow-up {dayShort(e.due)}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className={s.mSys}>
                  <span>{e.line}{e.by !== 'Automatically' && <small> · {e.by}</small>}</span>
                  <time dateTime={e.at}>{timeLabel(e.at)}</time>
                </div>
              )}
            </Fragment>
          )
        })}
        {!all && !query && shown.length > SHOWN && (
          <button type="button" className={`${s.linkBtn} ${s.linkStart}`} onClick={() => setAll(true)}>Show all {shown.length}</button>
        )}
        {detail.clickup.length > 0 && (
          <details className={s.clickup}>
            <summary>ClickUp record</summary>
            {detail.clickup.map((task, i) => (
              <dl key={i}>
                {Object.entries(task).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}
              </dl>
            ))}
          </details>
        )}
      </div>
    </div>
  )
}

function Composer({ lead, work, focus, menu, setMenu, onPosted }: {
  lead: WorkLead; work: LeadWork; focus: boolean; menu: Menu; setMenu: (m: Menu) => void; onPosted: () => void
}) {
  const [text, setText] = useState('')
  // A quick note the person tapped; two of them carry a meaning the database keeps (a try nobody answered, a quotation).
  const [quick, setQuick] = useState<string | null>(null)
  const [tag, setTag] = useState<CommentTag | null>(null)
  const [due, setDue] = useState(() => nextWorkingDay(work.today))
  const [saving, setSaving] = useState(false)
  const wrap = useCloseOnOutside(menu === 'next', () => setMenu(null))
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (focus) box.current?.focus() }, [focus])
  const ready = text.trim() !== '' && !saving
  const why = followUpChoices(work.today).find(c => c.date === due)?.why.toLowerCase() ?? (isSunday(due) ? 'a Sunday, picked by you' : 'picked by you')
  const notResponding = tag === 'not_responding'
  // What posting does besides saving the words, when it is not obvious.
  const hint = notResponding
    ? `Counts as a try, not a contact.${lead.stage === 'new' ? ' The lead moves from New to Under Process.' : ''}`
    : lead.stage === 'new' && text.trim() !== '' ? 'Posting this moves the lead from New to Under Process.' : null

  function type(next: string) {
    setText(next)
    // Words wiped out: the quick note goes with them.
    if (next.trim() === '') { setQuick(null); setTag(null) }
  }

  function tap(note: (typeof QUICK_NOTES)[number]) {
    if (quick === note.key) { if (text.trim() === note.text) setText(''); setQuick(null); setTag(null); return }
    // What was already typed stays, after the note.
    const typed = QUICK_NOTES.some(n => n.text === text.trim()) ? '' : text.trim()
    setQuick(note.key)
    setTag(note.tag)
    setText(typed ? `${note.text} ${typed}` : note.text)
    box.current?.focus()
  }

  async function post() {
    if (!ready) return
    setSaving(true)
    try {
      const r = await addComment(work.supabase, lead.id, { note: text.trim(), tag, nextDue: due })
      await work.refresh()
      work.said(`Saved. Next follow-up ${dayShort(r.lead.next_due_on ?? due)}.`, r.activity_id)
      if (notResponding && (r.streak ?? 0) >= 3) work.threeTries(r.lead)
      setText(''); setQuick(null); setTag(null); setDue(nextWorkingDay(work.today))
      onPosted()
    } catch (e) {
      work.fail(e)
      await work.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={s.mCompose} aria-label="Write an update">
      <textarea
        ref={box} rows={2} maxLength={4000} aria-label="Write an update" placeholder="Write an update: what happened with this client?"
        value={text} onChange={e => type(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void post() } }}
      />
      <div className={s.mChips} role="group" aria-label="Quick notes">
        {QUICK_NOTES.map(n => (
          <button key={n.key} type="button" className={s.mChip} aria-pressed={quick === n.key} onClick={() => tap(n)}>{n.label}</button>
        ))}
      </div>
      {hint && <p className={s.mHint}>{hint}</p>}
      <div className={s.mFoot}>
        <div ref={wrap} className={`${s.mRel} ${s.mNext}`}>
          <CalendarDays aria-hidden="true" />
          <span>Follow up <b>{dayShort(due)}</b> <small>{why}</small></span>
          <button type="button" className={s.linkBtn} aria-haspopup="menu" aria-expanded={menu === 'next'} onClick={() => setMenu(menu === 'next' ? null : 'next')}>Change</button>
          {menu === 'next' && <FollowUpMenu today={work.today} value={due} onPick={day => { setDue(day); setMenu(null) }} />}
        </div>
        <span className={s.mKbd}>Ctrl + Enter</span>
        <button type="button" className={s.mPost} disabled={!ready} onClick={() => void post()}>{saving ? 'Saving…' : 'Post update'}</button>
      </div>
    </section>
  )
}
