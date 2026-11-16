'use client'

import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Ban, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Clock, Copy, Eye, FileSpreadsheet, FileText, Image as ImageIcon, LoaderCircle, Mail,
  MessageCircle, Paperclip, Pencil, Phone, Presentation, RotateCw, Search, TriangleAlert, X,
} from 'lucide-react'
import { formatPhone, telHref } from '@/lib/exhibitionLeads/phone'
import {
  addComment, changeDue, fetchWorkLead, SALES_KEY, updateFacts,
  type LeadFacts, type LeadFile, type WorkDetail, type WorkLead,
} from '@/lib/salesLeads/api'
import { canPreview, fileKind, formatBytes, LEAD_FILE_ACCEPT, LEAD_FILES_BUCKET, noteForFiles, type FileKind } from '@/lib/salesLeads/files'
import {
  activityTag, CLIENT_TYPES, dueAfterUpdate, dueOf, followUpChoices, isSunday, lastOf, marketLabel, nextStepOf, parseValue,
  QUICK_NOTES, SEGMENTS, stageLabel, STAGE_GUIDE, TEMPERATURES, valueLabel,
  type CommentTag, type Stage, type Temperature,
} from '@/lib/salesLeads/board'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { dayHeading, dayLabelLong, dayShort, initialsOf, istDayOf, timeLabel } from '@/lib/salesLeads/format'
import { eventBy, eventLine, leadTitle } from './LeadBits'
import { useDialogFocus } from './useDialogFocus'
import { useLeadFiles, type QueuedFile } from './useLeadFiles'
import type { LeadWork } from './useLeadWork'
import s from './leadBoard.module.css'

// One lead in a popup in the middle of the page (owner, 2026-11-13, after a clickable preview, on the lines of ClickUp):
// on the left who the client is, where the lead stands and what they want; on the right one box to write an update and
// everything that happened, newest first, a day at a time. Call and WhatsApp beside the name (Call came back on
// 2026-11-13); no "how did it go" form. Previous and next walk the list the lead was opened from; Esc, the cross or a
// click outside closes it. On a phone it fills the screen and the two sides are two tabs.
//
// The left side was laid out again on 2026-11-14 (owner approved a clickable preview), in the order a salesperson uses it:
// who; what to do next; where the lead stands; what they want and the reference facts. The phone number sits beside the
// name (with Copy), so the facts no longer repeat it; Type of client and Quantity are no longer shown (they are still
// stored, and still in Edit details). Later the same day (owner, "B + C"): Call and WhatsApp moved out of the name's row into
// a "next step" banner with the follow-up date (red when it is late), "Held by" moved under the name, "Stuck" into the
// Board status button, and the requirement and client facts became one list, "About this client", with one Edit details.
//
// Laid out again on 2026-11-15 (owner, after a clickable preview): more room between lines and groups, growing with the height
// of the window (see the end of leadBoard.module.css); Call and WhatsApp on the phone number's row, where the number you are
// about to call is read, so the follow-up date is a card of its own with "Change date" as a link; Edit details a link with a
// pencil, not a box; Email before Source in the list.
//
// Laid out again later the same day (owner, "still not neat and easy to scan", after a clickable preview on the lines of Quotation
// Details; Board status and Hot / Warm / Cold in the strip approved, Source kept in both places): a status strip across the top
// (next follow-up with Change date, last update, Board status, Hot / Warm / Cold), then two cards, the client (name, who holds it,
// the number with Call and WhatsApp, what they want, the facts with a label over each) and the activity (the update box, then each
// day as a heading and each update as a row). The sizes are variables set on .modal in leadBoard.module.css.
//
// It opens at once: the list the lead was opened from already holds the lead, so the left side is drawn from that while
// the full record (history and activity) is read; only the activity waits.

/** Only one menu is open at a time; Escape closes it before it closes the popup. */
type Menu = 'status' | 'due' | null
type Tab = 'details' | 'activity'

/**
 * The list the lead was opened from, so Previous and Next can walk it. `peek` hands back what that list already holds of a
 * lead (and whether this person may work it), so the popup can show it before the full record has arrived.
 */
export type LeadNav = {
  ids: readonly string[]
  label: string
  peek?: (id: string) => { lead: WorkLead; canWork: boolean } | undefined
}

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
  const peeked = nav?.peek?.(leadId)
  const peekLead = peeked?.lead
  const peekCanWork = peeked?.canWork ?? false
  // What the list holds, as a stand-in until the record arrives (a lead read before is shown from the cache instead).
  const stand = useMemo<WorkDetail | undefined>(
    () => (peekLead ? { clickup: [], lead: peekLead, can_work: peekCanWork, quotation_sent: false, events: [], activities: [] } : undefined),
    [peekLead, peekCanWork],
  )
  const detail = useQuery({
    queryKey: [SALES_KEY, 'work', leadId],
    queryFn: () => fetchWorkLead(work.supabase, leadId),
    staleTime: 0,
    placeholderData: stand,
  })
  const filling = detail.isPlaceholderData

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

  const count = detail.data && !filling ? detail.data.activities.length + detail.data.events.length : null
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
          <PanelBody
            key={leadId} detail={detail.data} work={work} focusLog={focusLog} closeAfterPost={closeAfterPost} menu={menu} setMenu={setMenu} onClose={onClose}
            filling={filling} loadFailed={filling && detail.isError} reload={() => void detail.refetch()}
          />
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

function PanelBody({ detail, work, focusLog, closeAfterPost, menu, setMenu, onClose, filling, loadFailed, reload }: {
  detail: WorkDetail; work: LeadWork; focusLog: boolean; closeAfterPost: boolean; menu: Menu; setMenu: (m: Menu) => void; onClose: () => void
  /** The lead is drawn from the list while its record is read: history and activity are not here yet. */
  filling: boolean; loadFailed: boolean; reload: () => void
}) {
  const { lead } = detail
  const canWork = detail.can_work && !work.readOnly
  const closed = lead.stage === 'converted' || lead.stage === 'dead'
  return (
    <div className={s.mBody}>
      <Strip lead={lead} since={filling ? null : stageSince(detail)} work={work} canWork={canWork} menu={menu} setMenu={setMenu} />
      <div className={s.mCols}>
        <div className={s.mLeft} aria-label="Lead details">
          {!canWork && (
            <div className={s.readOnly}>
              <Eye aria-hidden="true" />
              <span>You can read this lead. {lead.holder_name ? `${lead.holder_name} holds it, and only` : 'Only'} the person holding it can write on it or move it.</span>
            </div>
          )}
          <ClientCard lead={lead} work={work} canWork={canWork} closed={closed} />
        </div>
        <ActivitySide
          detail={detail} work={work} canWrite={canWork && !closed} focusLog={focusLog}
          onPosted={() => { if (closeAfterPost) onClose() }} filling={filling} loadFailed={loadFailed} reload={reload}
        />
      </div>
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

// ── Left: the strip and the client ──────────────────────────────────────────────────────────────────────────────────

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
        {lead.stuck && <span className={s.mStuck}>Stuck</span>}
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

const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

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

type StripTone = 'late' | 'today' | 'ok' | 'quiet' | 'won'
const TONE_CLASS: Record<StripTone, string> = { late: s.stripLate, today: s.stripToday, ok: s.stripOk, quiet: '', won: s.stripWon }

/** The day of the last update: "Sun 1 Nov", with the year once it is not this one. */
const onDay = (day: string, today: string) => (day.slice(0, 4) === today.slice(0, 4) ? dayShort(day) : dayLabelLong(day))

/**
 * The status strip (owner, 2026-11-15, after a clickable preview on the lines of Quotation Details): what you act on, in one row
 * across the top: the next follow-up (red and in words when it is late, with Change date), the last update, the Board status
 * and Hot / Warm / Cold. A converted or dead lead has no follow-up, so that cell says so and says how to reopen the lead; somebody
 * who can only read the lead sees the same words without the controls.
 */
function Strip({ lead, since, work, canWork, menu, setMenu }: {
  lead: WorkLead; since: string | null; work: LeadWork; canWork: boolean; menu: Menu; setMenu: (m: Menu) => void
}) {
  // The moment the popup opened: "12 days" in the status does not need to tick.
  const [now] = useState(() => Date.now())
  const open = menu === 'due'
  const wrap = useCloseOnOutside(open, () => setMenu(null))
  const step = nextStepOf(lead, work.today)
  const last = lastOf(lead, work.today)
  const tone: StripTone = step.kind === 'closed' ? (lead.stage === 'converted' ? 'won' : 'quiet')
    : step.kind === 'over' ? 'late' : step.kind === 'today' ? 'today' : step.kind === 'none' ? 'quiet' : 'ok'
  const Icon = step.kind === 'closed' ? (lead.stage === 'converted' ? CircleCheck : Ban)
    : step.kind === 'over' ? TriangleAlert : step.kind === 'today' ? Clock : CalendarDays
  const value = step.kind === 'closed' ? 'None needed' : step.kind === 'none' ? 'Not set' : step.kind === 'today' ? 'Today' : dayShort(step.date)
  const dim = step.kind === 'closed' || step.kind === 'none'
  const why = [dueOf(lead, work.today).label, lead.dead_note].filter(Boolean).join(' · ')
  const sub = step.kind === 'over' ? `${plural(step.days)} late`
    : step.kind === 'today' ? dayShort(step.date)
    : step.kind === 'soon' ? (step.days === 1 ? 'Tomorrow' : `In ${plural(step.days)}`)
    : step.kind === 'wakes' ? 'Parked until then'
    : step.kind === 'none' ? 'No follow-up date'
    : `${[lead.stage === 'dead' ? why : 'This lead is closed', canWork ? 'Pick a status to reopen it' : ''].filter(Boolean).join('. ')}.`
  const heat = (next: Temperature) => {
    if (next !== lead.temperature) void work.guarded(async () => { await updateFacts(work.supabase, lead.id, { temperature: next }) })
  }
  function pick(day: string) {
    setMenu(null)
    if (day === lead.next_due_on) return
    void work.guarded(async () => {
      const r = await changeDue(work.supabase, lead.id, day)
      if (r.status === 'saved') work.said(`Follow-up moved to ${dayShort(day)}.`)
    })
  }
  return (
    <section className={`${s.strip} ${TONE_CLASS[tone]}`} aria-label="Where this lead stands">
      <div className={`${s.stCell} ${s.stFollow}`}>
        <span className={s.stDisc} aria-hidden="true"><Icon /></span>
        <div className={s.stText}>
          <div className={s.eyebrow}>Next follow-up</div>
          <div className={`${s.stVal}${dim ? ` ${s.stDim}` : ''}`}>{value}</div>
          <div ref={wrap} className={`${s.stSub} ${s.mRel}`}>
            <span className={tone === 'late' || tone === 'today' ? s.stEm : undefined}>{sub}</span>
            {canWork && step.kind !== 'closed' && (
              <>
                <span className={s.stDot} aria-hidden="true">·</span>
                <button type="button" className={s.nLink} aria-haspopup="menu" aria-expanded={open} title="Change the follow-up date" onClick={() => setMenu(open ? null : 'due')}>
                  {lead.next_due_on ? 'Change date' : 'Set a date'}<ChevronDown aria-hidden="true" />
                </button>
                {open && <FollowUpMenu today={work.today} value={lead.next_due_on ?? ''} onPick={pick} />}
              </>
            )}
          </div>
        </div>
      </div>
      <div className={s.stCell}>
        <div className={s.eyebrow}>Last update</div>
        <div className={`${s.stVal}${last.day ? '' : ` ${s.stDim}`}`}>{last.ago}</div>
        <div className={s.stSub}>{last.day ? `${last.kind} · ${onDay(last.day, work.today)}` : 'No call or update yet'}</div>
      </div>
      <div className={s.stCell}>
        <div className={`${s.eyebrow} ${s.stLab}`}>Board status{since && <small>for {inStage(since, now)}</small>}</div>
        <StatusMenu lead={lead} work={work} canWork={canWork} open={menu === 'status'} setOpen={o => setMenu(o ? 'status' : null)} />
      </div>
      <div className={s.stCell}>
        <div className={s.eyebrow}>Temperature</div>
        <span className={s.stHeat} role="group" aria-label="How warm is this lead?">
          {TEMPERATURES.map(t => (
            <button key={t.value} type="button" aria-pressed={lead.temperature === t.value} disabled={!canWork} onClick={() => heat(t.value)}>
              <i className={`${s.heat} ${HEAT_CLASS[t.value]}`} aria-hidden="true" />{t.label}
            </button>
          ))}
        </span>
      </div>
    </section>
  )
}

/**
 * The client, in one card (owner, 2026-11-15): the name; who holds the lead and the market; the number with Copy and, at the end
 * of the same row, Call and WhatsApp (only for somebody who can work an open lead; "Call now" when the follow-up is late or due
 * today); what they want in their own words; then the facts, each with its label over it. "N not set" and Edit details are at the
 * top of the card; Edit details turns the requirement and the facts into one form. A lead with no name has the number as its
 * title, so Copy stands alone there. Type of client and Quantity are not shown (owner, 2026-11-14) but are still in the form.
 */
function ClientCard({ lead, work, canWork, closed }: { lead: WorkLead; work: LeadWork; canWork: boolean; closed: boolean }) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const start = useMemo(() => ({
    name: lead.name ?? '', email: lead.email ?? '', location: lead.location ?? '', requirement: lead.requirement ?? '',
    quantity: lead.quantity ?? '', timeline: lead.timeline ?? '', segment: lead.segment ?? '', client_type: lead.client_type ?? '',
    value: lead.expected_value_paise === null ? '' : String(lead.expected_value_paise / 100),
  }), [lead])
  const [form, setForm] = useState(start)
  const [problem, setProblem] = useState('')
  const set = (patch: Partial<typeof form>) => { setProblem(''); setForm(f => ({ ...f, ...patch })) }
  const edit = () => { setForm(start); setProblem(''); setEditing(true) }
  const title = leadTitle(lead)
  const named = title !== formatPhone(lead.phone)
  const step = nextStepOf(lead, work.today)
  const reach = canWork && !closed

  async function copy() {
    try {
      await navigator.clipboard.writeText(lead.phone)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      work.said('The number could not be copied. Select it instead.')
    }
  }

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

  // The rows that have nothing yet, counted at the top of the card (the Source is always known).
  const notSet = [lead.requirement, lead.expected_value_paise, lead.timeline, lead.location, lead.email].filter(v => v === null || v === undefined || v === '').length
  const text = (key: 'name' | 'email' | 'location' | 'quantity' | 'timeline', label: string) => (
    <div className={s.field}><label className={s.eyebrow} htmlFor={`fact-${key}`}>{label}</label><input id={`fact-${key}`} className={s.input} value={form[key]} onChange={e => set({ [key]: e.target.value })} /></div>
  )

  return (
    <section className={s.client} aria-label="Client">
      <div className={s.cHead}>
        <span className={s.eyebrow}>Client</span>
        <span className={s.grow} />
        {!editing && notSet > 0 && <span className={s.nMissing}>{notSet} not set</span>}
        {!editing && canWork && <button type="button" className={s.nLink} onClick={edit}><Pencil aria-hidden="true" />Edit details</button>}
      </div>
      <h2 className={s.mName}>{title}</h2>
      <div className={s.cMeta}>
        <span className={s.cWho}>
          {lead.holder_name
            ? <><i className={s.mAvSm} aria-hidden="true">{initialsOf(lead.holder_name)}</i>Held by <b>{lead.holder_name}</b></>
            : <span className={s.mNobody}>Held by nobody yet</span>}
        </span>
        <span className={s.cTag}>{marketLabel(lead)}</span>
      </div>
      <div className={s.cReach}>
        {named && <span className={s.mPhone}><Phone aria-hidden="true" />{formatPhone(lead.phone)}</span>}
        <button type="button" className={s.nCopy} data-done={copied ? '1' : '0'} aria-label="Copy number" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : named ? 'Copy' : 'Copy number'}
        </button>
        {reach && (
          <div className={s.nReach}>
            <a className={s.mCall} href={telHref(lead.phone)}><Phone aria-hidden="true" />{step.kind === 'over' || step.kind === 'today' ? 'Call now' : 'Call'}</a>
            <button type="button" className={s.mWa} onClick={() => work.openWhatsApp(lead)}><MessageCircle aria-hidden="true" />WhatsApp</button>
          </div>
        )}
      </div>

      {editing ? (
        <div className={`${s.cSec} ${s.detailsEdit}`} role="group" aria-label="Edit the details">
          <div className={s.mForm}>
            {text('name', 'Name')}
            {text('email', 'Email')}
            {text('location', 'Location')}
            <div className={s.field}><label className={s.eyebrow} htmlFor="fact-type">Type of client</label><select id="fact-type" className={s.input} value={form.client_type} onChange={e => set({ client_type: e.target.value })}><option value="">Not set</option>{CLIENT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            <div className={s.field}><label className={s.eyebrow} htmlFor="fact-seg">Segment</label><select id="fact-seg" className={s.input} value={form.segment} onChange={e => set({ segment: e.target.value })}><option value="">Not set</option>{SEGMENTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            {text('quantity', 'Quantity')}
            <div className={s.field}><label className={s.eyebrow} htmlFor="fact-value">Project value, approx. (₹)</label><input id="fact-value" className={s.input} inputMode="decimal" placeholder="e.g. 8 L" value={form.value} onChange={e => set({ value: e.target.value })} /></div>
            <div className={`${s.field} ${s.mFull}`}><label className={s.eyebrow} htmlFor="fact-req">Requirement</label><textarea id="fact-req" className={s.input} value={form.requirement} onChange={e => set({ requirement: e.target.value })} /></div>
            {text('timeline', 'Needed by')}
          </div>
          {problem && <div className="boe-callout boe-callout-error" role="alert">{problem}</div>}
          <div className={s.detailsFoot}>
            <button type="button" className="boe-btn boe-btn-primary" disabled={work.busy} onClick={save}>Save</button>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className={s.cSec}>
            <div className={s.eyebrow}>Requirement</div>
            {lead.requirement
              ? lead.requirement.split(/\n{2,}/).map((p, i) => <p key={i} className={s.cReq}>{p}</p>)
              : <p className={s.cNone}>The client has not said what they need yet.</p>}
          </div>
          <div className={s.cSec}>
            <dl className={s.cFacts}>
              <div className={s.cFact}>
                <dt className={s.eyebrow}>Project value</dt>
                {lead.expected_value_paise !== null
                  ? <dd>{valueLabel(lead.expected_value_paise)}</dd>
                  : <dd className={s.cWarn}>Not set<small>Needed for Negotiation.</small></dd>}
              </div>
              <div className={s.cFact}><dt className={s.eyebrow}>Needed by</dt><dd className={lead.timeline ? undefined : s.cNone}>{lead.timeline || 'Not shared'}</dd></div>
              <div className={s.cFact}><dt className={s.eyebrow}>Location</dt><dd className={lead.location ? undefined : s.cNone}>{lead.location || 'Not shared'}</dd></div>
              <div className={s.cFact}><dt className={s.eyebrow}>Source</dt><dd>{sourceLabel(lead.source)}</dd></div>
              <div className={`${s.cFact} ${s.cFull}`}>
                <dt className={s.eyebrow}>Email</dt>
                {lead.email
                  ? <dd><a className={s.nMail} href={`mailto:${lead.email}`}><Mail aria-hidden="true" />{lead.email}</a></dd>
                  : <dd className={s.cNone}>Not shared</dd>}
              </div>
            </dl>
          </div>
        </>
      )}
    </section>
  )
}

// ── Right: write an update, and everything that happened ────────────────────────────────────────────────────────────

type Entry =
  | { key: string; at: string; type: 'comment'; by: string; text: string | null; tag: ReturnType<typeof activityTag>; due: string | null; imported: boolean; files: readonly LeadFile[] }
  | { key: string; at: string; type: 'system'; line: React.ReactNode; by: string }

const SHOWN = 30
const TAG_CLASS = { no: s.mTagNo, quote: s.mTagQuote, plain: s.mTagPlain } as const

/** The words, with every place the search matched marked. */
function Marked({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>
}

function ActivitySide({ detail, work, canWrite, focusLog, onPosted, filling, loadFailed, reload }: {
  detail: WorkDetail; work: LeadWork; canWrite: boolean; focusLog: boolean; onPosted: () => void
  filling: boolean; loadFailed: boolean; reload: () => void
}) {
  // Updates only is what is read first (owner, 2026-11-14): "Updates only" is the first button and is on when the popup opens.
  const [updatesOnly, setUpdatesOnly] = useState(true)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const query = q.trim().toLowerCase()

  // A comment and the move it caused share a moment; the move is the later of the two, so it comes first.
  const rank = (e: Entry) => (e.type === 'system' ? 0 : 1)
  const entries: Entry[] = useMemo(() => [
    ...detail.activities.map<Entry>(a => ({
      key: a.id, at: a.at, type: 'comment', by: a.kind === 'imported' ? 'From ClickUp' : a.actor_name ?? 'A former colleague', text: a.note,
      tag: a.kind === 'imported' ? null : activityTag(a), due: a.next_due_on, imported: a.kind === 'imported', files: a.files ?? [],
    })),
    ...detail.events.map<Entry>((e, i) => ({ key: `e${i}`, at: e.at, type: 'system', line: eventLine(e), by: eventBy(e) })),
  ].sort((a, b) => b.at.localeCompare(a.at) || rank(a) - rank(b)), [detail])

  // A search reads the updates (words, who, tag); the system lines are left out while it runs.
  const shown = entries.filter(e => {
    if (e.type === 'system') return !updatesOnly && !query
    if (!query) return true
    return [e.text ?? '', e.by, e.tag?.label ?? '', ...e.files.map(f => f.name)].join(' ').toLowerCase().includes(query)
  })
  const list = all || query ? shown : shown.slice(0, SHOWN)

  // The links to the files of the updates, signed for five minutes in one call, after the lead is here: the bucket is private.
  // Nothing is asked for a lead with no files (every ClickUp lead), so opening a lead costs nothing more.
  const paths = useMemo(() => detail.activities.flatMap(a => (a.files ?? []).map(f => f.path)), [detail.activities])
  const signed = useQuery({
    queryKey: [SALES_KEY, 'file-links', detail.lead.id, paths.join('|')],
    enabled: paths.length > 0 && !filling,
    staleTime: 240_000,
    queryFn: async () => {
      const { data, error } = await work.supabase.storage.from(LEAD_FILES_BUCKET).createSignedUrls(paths, 300)
      if (error) throw error
      const links: Record<string, string> = {}
      for (const x of data ?? []) if (x.path && x.signedUrl) links[x.path] = x.signedUrl
      return links
    },
  })
  const links = signed.data ?? {}

  return (
    <div className={s.mRight} aria-label="Activity">
      <div className={s.mRHead}>
        <h3 className={s.mH3}>Activity</h3>
        {!filling && <span className={s.mPill}>{detail.activities.length + detail.events.length}</span>}
        <div className={s.mTools}>
          <div className={s.mSeg} role="group" aria-label="Show">
            <button type="button" aria-pressed={updatesOnly} onClick={() => setUpdatesOnly(true)}>Updates only</button>
            <button type="button" aria-pressed={!updatesOnly} onClick={() => setUpdatesOnly(false)}>All</button>
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
      {canWrite && <Composer lead={detail.lead} work={work} focus={focusLog} onPosted={onPosted} />}
      <div className={s.mFeed}>
        {filling && !loadFailed && <p className={s.mNone} role="status">Loading the activity…</p>}
        {loadFailed && (
          <p className={s.mNone} role="alert">The activity could not be loaded. <button type="button" className={s.linkBtn} onClick={reload}>Try again</button></p>
        )}
        {!filling && list.length === 0 && <p className={s.mNone}>{query ? 'Nothing matches.' : 'Nothing yet. The first update appears here.'}</p>}
        {list.map((e, i) => {
          const day = istDayOf(e.at)
          const heading = i === 0 || istDayOf(list[i - 1].at) !== day
          return (
            <Fragment key={e.key}>
              {heading && <div className={s.mDay}><span>{dayHeading(day, work.today)}</span></div>}
              {e.type === 'comment' ? (
                <div className={s.mEntry}>
                  <span className={`${s.mAv}${e.imported ? ` ${s.mAvCu}` : ''}`} aria-hidden="true">{e.imported ? 'CU' : initialsOf(e.by)}</span>
                  <div className={s.mBubble}>
                    <div className={s.mEHead}><b>{e.by}</b><time dateTime={e.at}>{timeLabel(e.at)}</time></div>
                    {e.text && <p><Marked text={e.text} q={query} /></p>}
                    {(e.tag || e.due) && (
                      <div className={s.mTags}>
                        {e.tag && <span className={`${s.mTag} ${TAG_CLASS[e.tag.tone]}`}>{e.tag.label}</span>}
                        {e.due && <span className={`${s.mTag} ${s.mTagDue}`}>Follow-up {dayShort(e.due)}</span>}
                      </div>
                    )}
                    {e.files.length > 0 && <FileList files={e.files} links={links} />}
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

/**
 * The update box (owner, 2026-11-13; files 2026-11-15): the words, the quick notes, and the files. A file can be picked with
 * Attach files, dropped on the box or pasted (a screenshot, or files copied in a folder); each uploads at once and shows as a
 * chip with its state. Post waits for the uploads, and a failed one has to be retried or removed. An update that is only files
 * says "Shared 2 files." The follow-up is changed at the top of the popup, so the box has no date of its own.
 */
function Composer({ lead, work, focus, onPosted }: {
  lead: WorkLead; work: LeadWork; focus: boolean; onPosted: () => void
}) {
  const [text, setText] = useState('')
  // A quick note the person tapped; two of them carry a meaning the database keeps (a try nobody answered, a quotation).
  const [quick, setQuick] = useState<string | null>(null)
  const [tag, setTag] = useState<CommentTag | null>(null)
  const [saving, setSaving] = useState(false)
  const [dropping, setDropping] = useState(false)
  const files = useLeadFiles(work.supabase, lead.id)
  const box = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focus) box.current?.focus() }, [focus])
  const withFiles = files.ready.length > 0
  const ready = (text.trim() !== '' || withFiles) && !files.uploading && !files.failed && !saving
  // The follow-up is changed at the top of the popup (owner, 2026-11-15), so posting keeps a date still ahead and moves a late,
  // due-today or missing one to the next working day.
  const due = dueAfterUpdate(lead, work.today)
  const notResponding = tag === 'not_responding'
  // What posting does besides saving the words, when it is not obvious.
  const hint = notResponding
    ? `Counts as a try, not a contact.${lead.stage === 'new' ? ' The lead moves from New to Under Process.' : ''}`
    : lead.stage === 'new' && (text.trim() !== '' || withFiles) ? 'Posting this moves the lead from New to Under Process.' : null

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
      const r = await addComment(work.supabase, lead.id, {
        note: text.trim() || noteForFiles(files.ready.length), tag, nextDue: due, files: files.ready,
      })
      // The screen reads itself again in the background: nothing here waits for it.
      void work.refresh()
      work.said(`Saved. Next follow-up ${dayShort(r.lead.next_due_on ?? due)}.`, r.activity_id)
      if (notResponding && (r.streak ?? 0) >= 3) work.threeTries(r.lead)
      setText(''); setQuick(null); setTag(null)
      files.finish()
      onPosted()
    } catch (e) {
      work.fail(e)
      void work.refresh()
    } finally {
      setSaving(false)
    }
  }

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  return (
    <section
      className={s.mCompose} aria-label="Write an update" data-dropping={dropping ? '1' : '0'}
      onDragEnter={e => { if (hasFiles(e)) { e.preventDefault(); setDropping(true) } }}
      onDragOver={e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false) }}
      onDrop={e => { if (hasFiles(e)) { e.preventDefault(); setDropping(false); files.add(Array.from(e.dataTransfer.files)) } }}
      onPaste={e => {
        // Files copied in a folder, or a screenshot: they become attachments, and no file name is pasted as text.
        const pasted = Array.from(e.clipboardData?.items ?? []).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => f !== null)
        if (pasted.length === 0) return
        e.preventDefault()
        files.add(pasted)
      }}
    >
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
      <FileChips items={files.items} onRetry={files.retry} onRemove={files.remove} />
      {files.refusal && (
        <p className={s.mFileErr} role="alert">{files.refusal}<button type="button" className={s.linkBtn} onClick={files.dismissRefusal}>OK</button></p>
      )}
      {hint && <p className={s.mHint}>{hint}</p>}
      <div className={s.mFoot}>
        <div className={s.mFootL}>
          <button type="button" className={s.nLink} onClick={() => picker.current?.click()}><Paperclip aria-hidden="true" />Attach files</button>
          <span className={s.mKbd}>or drop or paste them here</span>
          <input
            ref={picker} type="file" multiple hidden accept={LEAD_FILE_ACCEPT} aria-label="Choose files to attach"
            onChange={e => { files.add(Array.from(e.target.files ?? [])); e.target.value = '' }}
          />
        </div>
        <div className={s.mFootR}>
          <span className={s.mKbd}>Ctrl + Enter</span>
          <button
            type="button" className={s.mPost} disabled={!ready} onClick={() => void post()}
            title={files.uploading ? 'Waiting for the files to upload' : files.failed ? 'Retry or remove the file that did not upload' : undefined}
          >
            {saving ? 'Saving…' : files.uploading ? 'Uploading…' : 'Post update'}
          </button>
        </div>
      </div>
      {dropping && <div className={s.mDrop} aria-hidden="true"><Paperclip />Drop to attach</div>}
    </section>
  )
}

/** The files being attached, one chip each: a picture or an icon, the name, the size (or what went wrong), and what can be done. */
export function FileChips({ items, onRetry, onRemove }: { items: readonly QueuedFile[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  if (items.length === 0) return null
  return (
    <ul className={s.mFiles} aria-label="Files to attach">
      {items.map(f => (
        <li key={f.id} className={s.mFile} data-status={f.status}>
          {f.preview
            // eslint-disable-next-line @next/next/no-img-element -- a blob: URL of the file just picked; there is nothing to optimise
            ? <img className={s.mFileThumb} src={f.preview} alt="" />
            : <span className={s.mFileIc} aria-hidden="true"><KindIcon kind={fileKind(f.type)} /></span>}
          <span className={s.mFileName} title={f.name}>{f.name}</span>
          <span className={s.mFileMeta}>{f.status === 'failed' ? f.error : formatBytes(f.size)}</span>
          {f.status === 'uploading' && <LoaderCircle className={s.mSpin} role="img" aria-label="Uploading" />}
          {f.status === 'failed' && (
            <button type="button" className={s.mFileBtn} aria-label={`Try ${f.name} again`} title="Try again" onClick={() => onRetry(f.id)}><RotateCw aria-hidden="true" /></button>
          )}
          <button type="button" className={s.mFileBtn} aria-label={`Remove ${f.name}`} title="Remove" onClick={() => onRemove(f.id)}><X aria-hidden="true" /></button>
        </li>
      ))}
    </ul>
  )
}

/** The icon of a kind of file, where a picture cannot be drawn. */
function KindIcon({ kind }: { kind: FileKind }) {
  if (kind === 'image') return <ImageIcon />
  if (kind === 'sheet') return <FileSpreadsheet />
  if (kind === 'slides') return <Presentation />
  return <FileText />
}

/**
 * The files of one update, under its words: pictures as small squares, everything else as a chip with its name and size. Both
 * open in a new tab through a link that is signed for five minutes (the bucket is private); until the links have come, the
 * squares and chips are there without one.
 */
export function FileList({ files, links }: { files: readonly LeadFile[]; links: Readonly<Record<string, string>> }) {
  return (
    <div className={s.mAtt}>
      {files.map(f => {
        const href = links[f.path]
        const label = `${f.name}, ${formatBytes(f.size)}`
        if (canPreview(f.type)) {
          return href
            ? (
              <a key={f.id} className={s.mAttImg} href={href} target="_blank" rel="noopener noreferrer" title={label}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL of a private file */}
                <img src={href} alt={f.name} loading="lazy" decoding="async" />
              </a>
            )
            : <span key={f.id} className={`${s.mAttImg} ${s.mAttWait}`} role="img" aria-label={`${label}, loading`} />
        }
        const inner = <><span className={s.mFileIc} aria-hidden="true"><KindIcon kind={fileKind(f.type)} /></span><span className={s.mFileName}>{f.name}</span><span className={s.mFileMeta}>{formatBytes(f.size)}</span></>
        return href
          ? <a key={f.id} className={s.mAttFile} href={href} target="_blank" rel="noopener noreferrer" title={label}>{inner}</a>
          : <span key={f.id} className={`${s.mAttFile} ${s.mAttWait}`} title={label}>{inner}</span>
      })}
    </div>
  )
}
