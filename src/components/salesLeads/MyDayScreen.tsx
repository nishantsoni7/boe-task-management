'use client'

import { AppLink as Link } from '@/components/ui/AppLink'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, MessageCircle, Pencil, PhoneMissed } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { fetchMyDay, SALES_KEY, type WorkLead } from '@/lib/salesLeads/api'
import { lastLabel, rankMyDay, whyFirst } from '@/lib/salesLeads/board'
import { dayLabelLong, plural } from '@/lib/salesLeads/format'
import { Due, Flag, LeadChips, leadTitle, StepLine, TempChip, ValueChip } from './LeadBits'
import { SalesFrame } from './SalesFrame'
import { useLeadWork } from './useLeadWork'
import { WorkPanel } from './WorkPanel'
import s from './leadBoard.module.css'

// My day: who to follow up next. One lead at a time, with the reason it is first, and the rest in order behind it. The
// only big button on the screen is the update for that lead (nobody calls from here). Saving anything takes the lead off
// the list and the next one comes up.

const HINT_KEY = 'sales-my-day-hint-seen'

type View = { key: string; label: string; test: (l: WorkLead, today: string) => boolean }
const VIEWS: readonly View[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'new', label: 'New', test: l => !l.first_attempt_at },
  { key: 'overdue', label: 'Overdue', test: (l, today) => !!l.next_due_on && l.next_due_on < today },
  { key: 'today', label: 'Today', test: (l, today) => l.next_due_on === today },
  { key: 'hot', label: 'Hot', test: l => l.temperature === 'hot' },
]

const hintChanges = (changed: () => void) => {
  window.addEventListener('storage', changed)
  return () => window.removeEventListener('storage', changed)
}
// Browser storage can be missing (private window): the page simply goes without the hint.
const hintUnseen = () => {
  try { return !window.localStorage.getItem(HINT_KEY) } catch { return false }
}

function useFirstDayHint() {
  const unseen = useSyncExternalStore(hintChanges, hintUnseen, () => false)
  const [dismissed, setDismissed] = useState(false)
  const dismiss = () => {
    setDismissed(true)
    try { window.localStorage.setItem(HINT_KEY, '1') } catch { /* nothing to remember it in */ }
  }
  return { show: unseen && !dismissed, dismiss }
}

export function MyDayScreen() {
  const { ready } = usePermissionContext()
  const { readOnly } = useSalesAccess()
  const work = useLeadWork()
  const hint = useFirstDayHint()
  const [view, setView] = useState('all')
  const [open, setOpen] = useState<{ id: string; log: boolean } | null>(null)
  const today = work.today
  // The clocks move on with every refresh (once a minute), which is as exact as "Waiting 12 min" needs.
  const [openedAt] = useState(() => Date.now())
  // The lead on top stays on top until something is done to it, so a refresh never swaps it under a finger.
  const [pinned, setPinned] = useState<string | null>(null)

  const day = useQuery({
    queryKey: [SALES_KEY, 'my-day'],
    queryFn: () => fetchMyDay(work.supabase),
    staleTime: 15_000,
    refetchInterval: 60_000,
    enabled: ready,
  })

  const now = Math.max(openedAt, day.dataUpdatedAt)
  const ranked = useMemo(() => rankMyDay(day.data?.rows ?? []), [day.data])
  const shown = ranked.filter(l => VIEWS.find(v => v.key === view)?.test(l, today))
  const held = pinned ? shown.findIndex(l => l.id === pinned) : -1
  const [first, ...rest] = held > 0 ? [shown[held], ...shown.slice(0, held), ...shown.slice(held + 1)] : shown
  if (first && first.id !== pinned && held < 0) setPinned(first.id)
  const done = day.data?.done_today ?? 0
  const total = done + ranked.length

  let body: React.ReactNode
  if (!ready || (day.isPending && !day.data)) {
    body = <LoadingScreen message="Loading your day..." />
  } else if (day.isError && !day.data) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">Your day could not be loaded</p>
        <p>Check your connection and try again.</p>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={() => day.refetch()}>Try again</button>
      </div>
    )
  } else {
    body = (
      <div className={s.day}>
        <div className={s.progress}>
          <span className={s.progressText}><b>{done}</b> of {total} done</span>
          <span className={s.progressTrack} aria-hidden="true"><span className={s.progressFill} style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
        </div>

        {hint.show && first && (
          <div className={s.hint}>
            <span><b>New here?</b> Start with the lead on top. Write what happened, and the next lead comes up on its own.</span>
            <button type="button" className="boe-btn boe-btn-secondary" onClick={hint.dismiss}>Got it</button>
          </div>
        )}

        <div className={s.views} role="group" aria-label="Lists">
          {VIEWS.map(v => (
            <button key={v.key} type="button" className={s.view} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
              {v.label} <span className={s.count}>{ranked.filter(l => v.test(l, today)).length}</span>
            </button>
          ))}
        </div>

        {first ? (
          <Hero lead={first} today={today} now={now} canWork={!readOnly} busy={work.busy}
            onOpen={log => setOpen({ id: first.id, log })} onWhatsApp={() => work.openWhatsApp(first)} onNoAnswer={() => work.noAnswer(first)} />
        ) : (
          <section className={s.done}>
            <Check aria-hidden="true" />
            <h2>{view === 'all' ? 'All done for now' : 'Nothing in this list'}</h2>
            <p>{view === 'all' ? `Nothing is overdue. ${plural(day.data?.coming_up ?? 0, 'lead comes', 'leads come')} up in the next 7 days.` : 'Pick another list above.'}</p>
          </section>
        )}

        {rest.length > 0 && (
          <>
            <h2 className={s.then}>Then, in this order</h2>
            <div className={s.rows}>
              {rest.map(lead => <Row key={lead.id} lead={lead} today={today} now={now} onOpen={() => setOpen({ id: lead.id, log: false })} />)}
            </div>
          </>
        )}

        <Link className={s.more} href="/sales/board">Coming up in the next 7 days<b>{day.data?.coming_up ?? 0}</b></Link>
      </div>
    )
  }

  return (
    <SalesFrame title="My day" subtitle={`${dayLabelLong(today).slice(0, -5)}, most important first`}>
      {body}
      {open && <WorkPanel leadId={open.id} work={work} nav={{ ids: shown.map(l => l.id), label: 'on My day' }} onNavigate={id => setOpen({ id, log: false })} focusLog={open.log} closeAfterPost onClose={() => setOpen(null)} />}
      {work.node}
    </SalesFrame>
  )
}

function Hero({ lead, today, now, canWork, busy, onOpen, onWhatsApp, onNoAnswer }: {
  lead: WorkLead; today: string; now: number; canWork: boolean; busy: boolean
  onOpen: (log: boolean) => void; onWhatsApp: () => void; onNoAnswer: () => void
}) {
  const inner = (run: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); run() }
  return (
    <section className={`${s.hero}${lead.stuck ? ` ${s.heroStuck}` : ''}`} aria-label="Next lead" onClick={() => onOpen(false)}>
      <div className={s.heroTop}>
        <span className={s.heroTag}>Next lead</span>
        <span className={s.heroWhy}>{whyFirst(lead, today)}</span>
        <Due lead={lead} today={today} />
      </div>
      <div className={s.heroMain}>
        <div>
          <h2 className={`${s.heroName}${lead.name ? '' : ` ${s.phoneName}`}`}>{leadTitle(lead)}</h2>
          <LeadChips lead={lead} />
        </div>
        <div className={s.heroDo}>
          <StepLine step={lead.next_step}><Flag lead={lead} now={now} /></StepLine>
          <p>{lead.requirement ?? lastLabel(lead, today)}</p>
        </div>
      </div>
      <div className={s.heroActs}>
        <button type="button" className="boe-btn boe-btn-primary" disabled={!canWork} onClick={inner(() => onOpen(true))}><Pencil aria-hidden="true" />Write an update</button>
        <button type="button" className="boe-btn boe-btn-secondary" disabled={!canWork} onClick={inner(onWhatsApp)}><MessageCircle aria-hidden="true" />WhatsApp</button>
        <button type="button" className="boe-btn boe-btn-secondary" disabled={!canWork || busy} onClick={inner(onNoAnswer)}><PhoneMissed aria-hidden="true" />No answer</button>
      </div>
    </section>
  )
}

function Row({ lead, today, now, onOpen }: { lead: WorkLead; today: string; now: number; onOpen: () => void }) {
  return (
    <article
      className={`${s.row}${lead.stuck ? ` ${s.rowStuck}` : ''}`}
      tabIndex={0}
      aria-label={leadTitle(lead)}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}
    >
      <div className={s.rowWho}>
        <h3 className={`${s.name}${lead.name ? '' : ` ${s.phoneName}`}`}>{leadTitle(lead)}</h3>
        <TempChip value={lead.temperature} />
        <ValueChip paise={lead.expected_value_paise} />
      </div>
      <div className={s.rowWhat}><StepLine step={lead.next_step} /></div>
      <div className={s.rowFlag}><Flag lead={lead} now={now} /></div>
      <div className={s.rowDue}><Due lead={lead} today={today} /></div>
    </article>
  )
}
