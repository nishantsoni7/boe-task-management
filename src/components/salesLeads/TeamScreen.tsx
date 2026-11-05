'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, SlidersHorizontal, UserRoundPen } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { PhoneSheetButton } from '@/components/ui/phoneSheet'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { istAddDays, istToday } from '@/lib/istDate'
import {
  allotLead, fetchPeople, fetchPremiumMisplaced, fetchTeam, reassignDue, remindLead, SALES_KEY,
  type MisplacedPremium, type Person, type TeamData, type TeamPersonRow, type TeamRisk, type WorkLead,
} from '@/lib/salesLeads/api'
import { deadReasonLabel, MARKETS, valueLabel } from '@/lib/salesLeads/board'
import { initialsOf, plural } from '@/lib/salesLeads/format'
import { createClient } from '@/lib/supabase/client'
import { Due, Flag, leadTitle } from './LeadBits'
import { SalesFrame } from './SalesFrame'
import { useDialogFocus } from './useDialogFocus'
import { useLeadWork } from './useLeadWork'
import { useToast } from './useToast'
import { WorkPanel } from './WorkPanel'
import b from './leadBoard.module.css'
import s from './salesPages.module.css'

// Team: the one page a manager opens. What could be lost today comes first, because that is the part somebody can still
// do something about. The numbers below it answer where leads drop off, why they die and who is keeping up.

const FUNNEL = ['Leads', 'Under process', 'Potential client', 'Negotiation', 'Converted']
const PERIODS = [
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'Last 3 months' },
  { key: 'year', label: 'Last 12 months' },
] as const
type PeriodKey = typeof PERIODS[number]['key']

function fromDate(period: PeriodKey, today: string): string {
  if (period === 'month') return `${today.slice(0, 7)}-01`
  return istAddDays(today, period === 'quarter' ? -91 : -365)
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–')

export function TeamScreen() {
  const { ready } = usePermissionContext()
  const { canAssign, canSeeAll, readOnly } = useSalesAccess()
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const work = useLeadWork()
  const toast = useToast()
  const [period, setPeriod] = useState<PeriodKey>('quarter')
  const [market, setMarket] = useState('')
  const [holder, setHolder] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<{ title: string; sub: string; exclude: string | null; pick: (to: Person) => Promise<void> } | null>(null)
  const today = istToday()
  const [now] = useState(() => Date.now())
  const from = fromDate(period, today)

  const team = useQuery({
    queryKey: [SALES_KEY, 'team', from, market, holder],
    queryFn: () => fetchTeam(supabase, from, market, holder),
    staleTime: 30_000,
    enabled: ready && canSeeAll,
  })
  // Everybody with a Sales job: the filter lists them all whoever is picked, and Change holder offers them.
  const people = useQuery({ queryKey: [SALES_KEY, 'people'], queryFn: () => fetchPeople(supabase), staleTime: 300_000, enabled: ready && canSeeAll })
  // Premium leads the allotment rule gave a Junior or Backup this week, because the Seniors were full or away.
  const premium = useQuery({ queryKey: [SALES_KEY, 'premium-misplaced'], queryFn: () => fetchPremiumMisplaced(supabase), staleTime: 30_000, enabled: ready && canSeeAll })
  const refresh = () => queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
  const data = team.data

  async function remind(lead: TeamRisk) {
    try {
      const r = await remindLead(supabase, lead.id)
      toast.show(r.status === 'sent' ? `${lead.holder_name} has been reminded` : `${lead.holder_name} was already reminded today`)
    } catch (e) { toast.show((e as Error).message, true) }
  }

  const changeHolder = (lead: WorkLead) => setChoosing({
    title: `Change who holds ${leadTitle(lead)}`, sub: `Now with ${lead.holder_name}`, exclude: lead.assigned_to,
    pick: async to => {
      await allotLead(supabase, lead.id, to.id, lead.assigned_to)
      toast.show(`Moved to ${to.full_name}`)
    },
  })

  const coverFor = (who: { id: string; name: string; due: number }) => setChoosing({
    title: `Who covers for ${who.name}?`, sub: `${plural(who.due, 'lead')} due today or earlier will move. The rest stays with ${who.name}.`, exclude: who.id,
    pick: async to => {
      const r = await reassignDue(supabase, who.id, to.id)
      toast.show(`${plural(r.moved, 'lead')} moved to ${to.full_name}`)
    },
  })

  let body: React.ReactNode
  if (!ready || (team.isPending && canSeeAll && !data)) {
    body = <LoadingScreen message="Loading the team..." />
  } else if (!canSeeAll) {
    body = <div className="boe-empty"><p className="boe-empty-title">This page is for managers</p><p>Your own leads are on My day and the Lead Board.</p></div>
  } else if (team.isError && !data) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">The team page could not be loaded</p>
        <p>Check your connection and try again.</p>
        <button type="button" className="boe-btn boe-btn-secondary" onClick={() => team.refetch()}>Try again</button>
      </div>
    )
  } else if (data) {
    const t = data.tiles
    const peopleOptions = people.data ?? data.people.map(p => ({ id: p.id, full_name: p.name }))
    body = (
      <div className={s.team}>
        <RiskCard data={data} premium={premium.data ?? []} today={today} now={now} canAssign={canAssign && !readOnly} readOnly={readOnly} onOpen={setOpen} onRemind={remind} onChange={changeHolder} onCover={coverFor} />

        {/* A phone: one line saying what is shown, and one Filter button for period, market and salesperson. */}
        <div className={s.phoneFilterRow}>
          <span className={s.phoneFilterText}>
            {PERIODS.find(p => p.key === period)?.label} · {market ? (MARKETS.find(m => m.value === market)?.label ?? market) : 'All markets'} · {holder ? (peopleOptions.find(p => p.id === holder)?.full_name ?? 'One person') : 'Everyone'}
          </span>
          <PhoneSheetButton
            label="Filter"
            title="Filter"
            icon={<SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />}
            triggerClassName="boe-phone-only orders-phone-filter p3-filter"
            sheetClassName="orders-sheet p3-sheet"
            badge={(period !== 'quarter' ? 1 : 0) + (market ? 1 : 0) + (holder ? 1 : 0)}
            groups={[
              { id: 'period', label: 'Period', value: period, options: PERIODS.map(p => ({ value: p.key, label: p.label })), onChange: v => setPeriod(v as PeriodKey) },
              { id: 'market', label: 'Market', value: market, options: [{ value: '', label: 'All markets' }, ...MARKETS.map(m => ({ value: m.value, label: m.label }))], onChange: setMarket },
              { id: 'holder', label: 'Salesperson', value: holder, options: [{ value: '', label: 'Everyone' }, ...peopleOptions.map(p => ({ value: p.id, label: p.full_name }))], onChange: setHolder },
            ]}
            doneLabel="Show"
            onClearAll={() => { setPeriod('quarter'); setMarket(''); setHolder('') }}
          />
        </div>
        <div className={s.filters} role="group" aria-label="Filters">
          {PERIODS.map(p => <button key={p.key} type="button" className={b.view} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
          <span className={s.sep} aria-hidden="true" />
          <button type="button" className={b.view} aria-pressed={market === ''} onClick={() => setMarket('')}>All markets</button>
          {MARKETS.map(m => <button key={m.value} type="button" className={b.view} aria-pressed={market === m.value} onClick={() => setMarket(m.value)}>{m.label}</button>)}
          <span className={s.sep} aria-hidden="true" />
          <select className={`${b.filter}${holder ? ` ${b.filterSet}` : ''}`} aria-label="Salesperson" value={holder} onChange={e => setHolder(e.target.value)}>
            <option value="">Everyone</option>
            {peopleOptions.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </div>

        <div className="fin-stats" role="group" aria-label="The period at a glance">
          <Tile label="Leads" value={t.leads.toLocaleString('en-IN')} sub="received" />
          <Tile label="Converted" value={percent(t.converted, t.leads)} sub={`${t.converted.toLocaleString('en-IN')} of ${t.leads.toLocaleString('en-IN')} leads`} />
          <Tile label="First call" value={percent(t.first_call_on_time, t.first_call_total)} sub={t.first_call_total ? 'on the same working day' : 'starts with the next new lead'} />
          <Tile label="Follow-ups on time" value={percent(t.followups_on_time, t.followups_total)} sub={t.followups_total ? 'done by the due date' : 'starts with the first follow-up'} />
        </div>

        <div className={s.two}>
          <section className={s.card} aria-labelledby="team-funnel">
            <h2 id="team-funnel">Where leads drop off</h2>
            <p>How many leads reached each stage</p>
            {t.leads === 0 ? <p className={s.none}>No leads in this period.</p> : (
              <div className={s.bars}>
                {data.funnel.map(f => <Bar key={f.rank} label={FUNNEL[f.rank - 1]} n={f.n} max={data.funnel[0].n} />)}
              </div>
            )}
          </section>
          <section className={s.card} aria-labelledby="team-reasons">
            <h2 id="team-reasons">Why leads die</h2>
            <p>{plural(data.reasons.reduce((n, r) => n + r.n, 0), 'dead lead')}, by the reason given</p>
            {data.reasons.length === 0 ? <p className={s.none}>No dead leads in this period.</p> : (
              <div className={s.bars}>
                {data.reasons.map(r => <Bar key={r.reason} label={deadReasonLabel(r.reason)} n={r.n} max={data.reasons[0].n} />)}
              </div>
            )}
          </section>
        </div>

        <section className={s.card} aria-labelledby="team-people">
          <h2 id="team-people">Who is keeping up</h2>
          <p>Press a name to see their board</p>
          <table className={s.table}>
            <thead><tr><th scope="col">Salesperson</th><th scope="col">Leads</th><th scope="col">Open now</th><th scope="col">First call</th><th scope="col">Follow-ups on time</th><th scope="col">Stuck now</th><th scope="col">Converted</th></tr></thead>
            <tbody>{data.people.map(p => <PersonRow key={p.id} p={p} />)}</tbody>
          </table>
        </section>
      </div>
    )
  }

  return (
    <SalesFrame title="Team" subtitle="What could be lost today, where leads drop off, who is keeping up">
      {body}
      {open && <WorkPanel leadId={open} work={work} focusLog={false} closeAfterPost={false} onClose={() => setOpen(null)} />}
      {choosing && (
        <PersonSheet {...choosing} people={people.data ?? []} onClose={() => setChoosing(null)}
          onPick={async to => {
            try { await choosing.pick(to); await refresh() } catch (e) { toast.show((e as Error).message, true) }
            setChoosing(null)
          }} />
      )}
      {work.node}
      {toast.node}
    </SalesFrame>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="fin-stat"><span className="fin-stat-label">{label}</span><span className="fin-stat-value" style={{ display: 'block' }}>{value}</span><span className="fin-stat-sub" style={{ display: 'block' }}>{sub}</span></div>
}

function Bar({ label, n, max }: { label: string; n: number; max: number }) {
  return (
    <div className={s.bar}>
      <span className={s.barLabel}>{label}</span>
      <span className={s.barTrack} aria-hidden="true"><span className={s.barFill} style={{ width: `${max ? Math.max((n / max) * 100, n ? 1 : 0) : 0}%` }} /></span>
      <span className={s.barValue}>{n.toLocaleString('en-IN')}</span>
    </div>
  )
}

function RiskCard({ data, premium, today, now, canAssign, readOnly, onOpen, onRemind, onChange, onCover }: {
  data: TeamData; premium: MisplacedPremium[]; today: string; now: number; canAssign: boolean; readOnly: boolean
  onOpen: (id: string) => void; onRemind: (lead: TeamRisk) => void; onChange: (lead: WorkLead) => void
  onCover: (who: { id: string; name: string; due: number }) => void
}) {
  const shown = data.at_risk.length
  return (
    <section className={s.card} aria-labelledby="team-risk">
      <h2 id="team-risk">At risk now</h2>
      <p>{data.at_risk_total === 0 ? 'Nothing is slipping today.' : `${plural(data.at_risk_total, 'lead')} could be lost if nobody acts${data.at_risk_total > shown ? `. The ${shown} that matter most are here` : ''}`}</p>
      {data.absent.map(a => (
        <div key={a.id} className={s.absent}>
          <span><b>{a.name} has not punched in today.</b> {plural(a.due, 'lead')} due.</span>
          {canAssign && <button type="button" className="boe-btn boe-btn-secondary" onClick={() => onCover(a)}>Give to someone else</button>}
        </div>
      ))}
      {premium.map(l => (
        <div key={l.id} className={s.absent}>
          <span>
            <b>Premium lead with a {l.level === 'backup' ? 'Backup' : 'Junior'}.</b>{' '}
            <button type="button" className={s.leadLink} onClick={() => onOpen(l.id)}>{leadTitle(l)}</button> ({l.premium}) is with {l.holder_name}. Hand it to a Senior?
          </span>
          {canAssign && <button type="button" className="boe-btn boe-btn-secondary" onClick={() => onChange(l)}><UserRoundPen aria-hidden="true" />Change holder</button>}
        </div>
      ))}
      {shown > 0 && (
        <table className={`${s.table} ${s.risk}`}>
          <thead><tr><th scope="col">Lead</th><th scope="col">Held by</th><th scope="col">Problem</th><th scope="col">Value</th><th scope="col"><span className="boe-sr-only">Actions</span></th></tr></thead>
          <tbody>
            {data.at_risk.map(l => (
              <tr key={l.id}>
                <td><button type="button" className={s.leadLink} onClick={() => onOpen(l.id)}>{leadTitle(l)}</button></td>
                <td data-l="Held by"><span className={s.person}><span className={b.avatar}>{initialsOf(l.holder_name ?? '?')}</span>{l.holder_name}</span></td>
                <td data-l="Problem">{l.problem === 'overdue' ? <Due lead={l} today={today} /> : <Flag lead={l} now={now} />}</td>
                <td data-l="Value">{l.expected_value_paise ? valueLabel(l.expected_value_paise) : '–'}</td>
                <td className={s.riskActs}>
                  <button type="button" className="boe-btn boe-btn-secondary" disabled={readOnly} onClick={() => onRemind(l)}><BellRing aria-hidden="true" />Remind</button>
                  {canAssign && <button type="button" className="boe-btn boe-btn-secondary" onClick={() => onChange(l)}><UserRoundPen aria-hidden="true" />Change holder</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function PersonRow({ p }: { p: TeamPersonRow }) {
  return (
    <tr>
      <td><Link className={s.person} href={`/sales/board?holder=${p.id}`}><span className={b.avatar}>{initialsOf(p.name)}</span>{p.name}</Link></td>
      <td data-l="Leads">{p.leads.toLocaleString('en-IN')}</td>
      <td data-l="Open now">{p.open.toLocaleString('en-IN')}</td>
      <td data-l="First call">{percent(p.first_call_on_time, p.first_call_total)}</td>
      <td data-l="Follow-ups on time">{percent(p.followups_on_time, p.followups_total)}</td>
      <td data-l="Stuck now">{p.stuck ? <span className={b.red}>{p.stuck}</span> : 0}</td>
      <td data-l="Converted">{p.converted}</td>
    </tr>
  )
}

function PersonSheet({ title, sub, exclude, people, onClose, onPick }: {
  title: string; sub: string; exclude: string | null; people: Person[]; onClose: () => void; onPick: (to: Person) => Promise<void>
}) {
  const ref = useDialogFocus<HTMLDivElement>(onClose)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <div className={b.sheetScrim} onClick={onClose} />
      <div ref={ref} className={b.sheet} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h2 className={b.sheetTitle}>{title}</h2>
        <p className={b.sheetSub}>{sub}</p>
        {people.filter(p => p.id !== exclude).map(p => (
          <button key={p.id} type="button" className={b.sheetOption} disabled={busy} onClick={() => { setBusy(true); void onPick(p) }}>{p.full_name}</button>
        ))}
      </div>
    </>
  )
}
