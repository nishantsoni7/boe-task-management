'use client'

// TEAM TODAY (owner, 2026-11-12; redesigned "attention first" 2026-11-13). Three tabs:
//
//   Today              "Needs your decision" (open strikes: Uphold or Waive; leave locked by pending work)
//                      beside "The day so far" (planned, closed, tasks done, the office day's time bar);
//                      then everybody in one table, worst first: Needs attention, On track, Away. A row opens
//                      to that person's tasks (each proof one tap away), carry-over reasons and end-of-day note.
//   People & targets   who takes part ("Add everyone"), the Scoreboard's monthly tracks and targets, and
//                      who sees the Scoreboard's Top 5 (staff or administrators only)
//   Ratings            the owner's monthly 1-5 rating (the reviewer seat only)
//
// A plan that is not yet due is never red (src/lib/dayClose/teamView.ts).
//
// Reads /api/day-close/team and /api/day-close/members (administrators and the reviewer). Strike
// decisions are the reviewer's alone, and the server says so too.

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { TargetsEditor } from '@/components/scoreboard/TargetsEditor'
import { RatingsEditor } from '@/components/scoreboard/RatingsEditor'
import { Top5Switch } from '@/components/scoreboard/Top5Switch'
import { istAddDays, istMinutesOfDay } from '@/lib/istDate'
import { clock } from '@/lib/dayClose/rules'
import { OFFICE_END_MINUTES, OFFICE_START_MINUTES, dayProgress, rosterStatus, sortRoster, type Group, type RosterStatus, type Tone } from '@/lib/dayClose/teamView'
import { dayCloseFetch, dayLabel, istClock } from './api'
import styles from './dayClose.module.css'
import tt from './teamToday.module.css'

type Strike = {
  id: string
  employee_id: string
  work_date: string
  kind: string
  label?: string
  name?: string
  status: 'open' | 'upheld' | 'waived'
  detail: Record<string, unknown>
  decision_note: string | null
}

type DayTaskRow = {
  id: string
  title: string
  status: string
  due_date: string | null
  state: 'done' | 'carried' | 'open'
  self: boolean
  carryover: { reason: string; next_date: string } | null
}

type Row = {
  id: string
  name: string
  machineLinked: boolean
  onLeave: boolean
  punch: { checkInAt: string | null; checkOutAt: string | null }
  plan: { submitted_at: string | null; closed_at: string | null; close_note: string | null } | null
  counts: { total: number; done: number; carried: number; open: number }
  tasks: DayTaskRow[]
  strikes: Strike[]
  monthStrikes: number
  calls: { call: number; whatsapp: number }
  overdueTasks: number
}

type Team = {
  date: string
  today: string
  workingDay: boolean
  holiday: boolean
  viewer: { isReviewer: boolean; manages: boolean }
  reviewer: { id: string; name: string | null } | null
  planDue: number
  closeOpens: number
  rows: Row[]
  openStrikes: (Strike & { name: string; label: string })[]
  lockedLeave?: { requestId: string; employeeId: string; name: string; requestType: string; startDate: string; endDate: string; words: string }[]
}

type Tab = 'today' | 'people' | 'ratings'

const TONE: Record<Tone, string> = { red: tt.chipRed, amber: tt.chipAmber, green: tt.chipGreen, grey: tt.chipGrey, blue: tt.chipBlue }
const GROUP_LABEL: Record<Group, string> = { attention: 'Needs attention', on_track: 'On track', away: 'Away' }
const LEAVE_WORDS: Record<string, string> = { full_day_leave: 'Full-day leave', half_day: 'Half day', early_departure: 'Early leaving', time_out: 'Time out', late_arrival: 'Late arrival' }

/** The minute of the IST day now, refreshed every minute. */
function useIstNow(): number {
  const [now, setNow] = useState(() => istMinutesOfDay(new Date()))
  useEffect(() => {
    const id = window.setInterval(() => setNow(istMinutesOfDay(new Date())), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}


export function TeamTodayScreen() {
  const [date, setDate] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('today')
  const nowMinutes = useIstNow()
  const query = useQuery<Team>({
    queryKey: ['day-close', 'team', date],
    queryFn: async () => {
      const r = await dayCloseFetch<Team>(`/api/day-close/team${date ? `?date=${date}` : ''}`)
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    placeholderData: previous => previous,
    retry: false,
  })
  const team = query.data ?? null
  const error = query.error instanceof Error ? query.error.message : null
  const { refetch } = query
  const load = useCallback(async () => { await refetch() }, [refetch])

  if (error && !team) return <div className={`${styles.banner} ${styles.bannerRed}`} role="alert">{error}</div>
  if (!team) return <p className={styles.muted}>Loading the team’s day…</p>

  const tabs: { key: Tab; label: string }[] = [
    { key: 'today', label: 'Today' },
    ...(team.viewer.manages ? [{ key: 'people' as const, label: 'People & targets' }] : []),
    ...(team.viewer.isReviewer ? [{ key: 'ratings' as const, label: 'Ratings' }] : []),
  ]

  return (
    <div className={tt.page}>
      {!team.reviewer && <ReviewerSetup onDone={load} />}

      <div className={tt.toolbar}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setDate(istAddDays(team.date, -1))}>‹ Day before</button>
        <input type="date" className={tt.dateInput} value={team.date} max={team.today} aria-label="Date"
          onChange={e => setDate(e.target.value || null)} />
        {team.date !== team.today && (
          <>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setDate(istAddDays(team.date, 1))}>Next day ›</button>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setDate(null)}>Today</button>
          </>
        )}
        <span className={tt.dayLabel}>
          {dayLabel(team.date)}{team.date === team.today ? ` · ${clock(nowMinutes)}` : ''}
          {!team.workingDay && ' · not a working day'}
        </span>
      </div>

      {tabs.length > 1 && (
        <nav className={tt.tabs} aria-label="Team Today sections">
          {tabs.map(t => (
            <button key={t.key} type="button" className={tt.tab} aria-current={tab === t.key ? 'page' : undefined} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}

      {tab === 'today' && <TodayTab team={team} nowMinutes={nowMinutes} onChanged={load} />}
      {tab === 'people' && team.viewer.manages && (
        <>
          <Members onChanged={load} />
          {/* The Scoreboard's monthly tracks and targets (administrators; the route checks again). */}
          <TargetsEditor />
          {/* Who sees the Scoreboard's Top 5 (administrators; the route checks again). */}
          <Top5Switch />
        </>
      )}
      {/* The owner's monthly 1-5 rating, and the vote totals once closed: the reviewer seat (the owner) alone. */}
      {tab === 'ratings' && team.viewer.isReviewer && <RatingsEditor />}
    </div>
  )
}

function TodayTab({ team, nowMinutes, onChanged }: { team: Team; nowMinutes: number; onChanged: () => Promise<void> }) {
  const ctx = { date: team.date, today: team.today, nowMinutes, workingDay: team.workingDay, planDue: team.planDue, closeOpens: team.closeOpens }
  const rows = sortRoster(team.rows.map(r => ({ ...r, status: rosterStatus(r, ctx) })))
  const count = (g: Group) => rows.filter(r => r.status.group === g).length
  const present = rows.filter(r => r.status.group !== 'away')
  const totals = {
    filed: present.filter(r => r.plan?.submitted_at).length,
    closed: present.filter(r => r.plan?.closed_at).length,
    done: rows.reduce((n, r) => n + r.counts.done, 0),
    total: rows.reduce((n, r) => n + r.counts.total, 0),
  }
  const isToday = team.date === team.today

  return (
    <>
      <div className={tt.top}>
        <NeedsDecision team={team} onDecided={onChanged} />
        <section className={`${tt.card} ${tt.pulse}`} aria-labelledby="pulse-heading">
          <h2 id="pulse-heading" className={tt.eyebrow}>{isToday ? 'The day so far' : 'That day'}</h2>
          <div className={tt.kpis}>
            <Kpi n={totals.filed} of={present.length} label="Planned" />
            <Kpi n={totals.closed} of={present.length} label="Closed" />
            <Kpi n={totals.done} of={totals.total} label="Tasks done" />
          </div>
          {isToday && team.workingDay && <DayBar nowMinutes={nowMinutes} planDue={team.planDue} closeOpens={team.closeOpens} />}
        </section>
      </div>

      <section className={`${tt.card} ${tt.roster}`} aria-labelledby="people-heading">
        <div className={tt.rosterHead}>
          <h2 id="people-heading" className={tt.h2}>Everyone, worst first</h2>
          <div className={tt.counts}>
            <span className={`${tt.chip} ${tt.chipRed}`}>Needs attention {count('attention')}</span>
            <span className={`${tt.chip} ${tt.chipGreen}`}>On track {count('on_track')}</span>
            {count('away') > 0 && <span className={`${tt.chip} ${tt.chipBlue}`}>Away {count('away')}</span>}
          </div>
        </div>
        {rows.length === 0 ? (
          <p className={tt.muted} style={{ padding: '0 18px 18px' }}>Nobody is switched on yet. Add people in “People &amp; targets”.</p>
        ) : (
          <div className={tt.scroll}>
            <table className={tt.table}>
              <thead>
                <tr>
                  <th scope="col">Person</th><th scope="col">In</th><th scope="col">Plan</th><th scope="col">Tasks today</th>
                  <th scope="col">Close</th><th scope="col">Calls · WhatsApp</th><th scope="col">Overdue</th><th scope="col">Strikes (month)</th>
                  <th scope="col"><span className={tt.srOnly}>Details</span></th>
                </tr>
              </thead>
              <tbody>
                {(['attention', 'on_track', 'away'] as Group[]).map(g => {
                  const inGroup = rows.filter(r => r.status.group === g)
                  if (inGroup.length === 0) return null
                  return (
                    <Fragment key={g}>
                      <tr className={tt.group}><td colSpan={9}>{GROUP_LABEL[g]} · {inGroup.length}</td></tr>
                      {inGroup.map(r => <PersonRow key={r.id} row={r} status={r.status} />)}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className={tt.footnote}>
        Before the plan is due a missing plan shows grey, not red. Strikes are written each night at 11:15 pm for the
        day just ending. Days off, holidays, approved full-day leave and days with no punch on the machine never get a strike.
      </p>
    </>
  )
}

function Kpi({ n, of, label }: { n: number; of: number; label: string }) {
  return (
    <div>
      <div className={tt.kpiNum}>{n}<span className={tt.kpiOf}>/{of}</span></div>
      <div className={tt.kpiLabel}>{label}</div>
    </div>
  )
}

function DayBar({ nowMinutes, planDue, closeOpens }: { nowMinutes: number; planDue: number; closeOpens: number }) {
  const at = (m: number) => `${(100 * dayProgress(m)).toFixed(1)}%`
  return (
    <div>
      <div className={tt.timeline} role="img" aria-label={`Office day ${clock(OFFICE_START_MINUTES)} to ${clock(OFFICE_END_MINUTES)}; now ${clock(nowMinutes)}`}>
        <div className={tt.timelineFill} style={{ width: at(nowMinutes) }} />
        <div className={tt.timelineTick} style={{ left: at(planDue) }} />
        <div className={tt.timelineTick} style={{ left: at(closeOpens) }} />
        <div className={tt.timelineMark} style={{ left: at(nowMinutes) }} />
      </div>
      <div className={tt.timelineLabels} style={{ marginTop: 6 }} aria-hidden="true">
        <span>{clock(OFFICE_START_MINUTES)}</span><span>Plan {clock(planDue)}</span><span>Close {clock(closeOpens)}</span><span>{clock(OFFICE_END_MINUTES)}</span>
      </div>
    </div>
  )
}

function NeedsDecision({ team, onDecided }: { team: Team; onDecided: () => Promise<void> }) {
  const leave = team.lockedLeave ?? []
  const n = team.openStrikes.length + leave.length
  const canDecide = team.viewer.isReviewer
  return (
    <section className={tt.card} aria-labelledby="needs-heading">
      <div className={tt.cardHead}>
        <h2 id="needs-heading" className={tt.h2}>Needs your decision</h2>
        {n > 0 && <span className={`${tt.chip} ${tt.chipRed}`}>{n}</span>}
      </div>
      {n === 0 && <p className={tt.muted}>Nothing is waiting for you.</p>}
      {n > 0 && !canDecide && <p className={tt.muted}>Only {team.reviewer?.name ?? 'the reviewer'} decides these.</p>}
      {team.openStrikes.map(s => <StrikeRow key={s.id} s={s} canDecide={canDecide} onDecided={onDecided} />)}
      {leave.map(l => (
        <div key={l.requestId} className={tt.decision}>
          <span className={`${tt.chip} ${tt.chipAmber}`}>Leave locked</span>
          <div className={tt.decisionText}>
            <p className={tt.decisionTitle}>{l.name} · {LEAVE_WORDS[l.requestType] ?? 'Leave'} {dayLabel(l.startDate)}{l.endDate !== l.startDate ? ` to ${dayLabel(l.endDate)}` : ''}</p>
            <p className={tt.decisionSub}>{l.words} · only the reviewer can approve</p>
          </div>
          <div className={tt.decisionActions}>
            <Link href="/attendance/requests" className={tt.link}>Open leave requests ›</Link>
          </div>
        </div>
      ))}
    </section>
  )
}

function PersonRow({ row, status }: { row: Row; status: RosterStatus }) {
  const [open, setOpen] = useState(false)
  const detailId = `person-${row.id}`
  const away = status.group === 'away'
  return (
    <>
      <tr>
        <td><span className={tt.name}>{row.name}</span></td>
        <td className={tt.num}>
          {away ? '—' : !row.machineLinked ? <span className={tt.muted}>No machine ID</span>
            : row.punch.checkInAt ? istClock(row.punch.checkInAt)
            : status.issues.includes('No punch') ? <span className={tt.bad}>No punch</span> : '—'}
        </td>
        <td><span className={`${tt.chip} ${TONE[status.plan.tone]}`}>{status.plan.text}</span></td>
        <td className={tt.num}>
          {away ? '—' : (
            <>
              <span className={tt.bar} aria-hidden="true"><span className={tt.barFill} style={{ width: `${row.counts.total ? Math.round((100 * row.counts.done) / row.counts.total) : 0}%` }} /></span>
              {row.counts.done}/{row.counts.total}{row.counts.carried > 0 ? ` · ${row.counts.carried} carried` : ''}
            </>
          )}
        </td>
        <td>{status.close ? <span className={`${tt.chip} ${TONE[status.close.tone]}`}>{status.close.text}</span> : '—'}</td>
        <td className={tt.num}>{row.calls.call} · {row.calls.whatsapp}</td>
        <td className={`${tt.num} ${row.overdueTasks > 0 ? tt.bad : ''}`}>{row.overdueTasks}</td>
        <td className={tt.num}>{row.monthStrikes}</td>
        <td>
          <button type="button" className={tt.detailsBtn} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={detailId}
            aria-label={`${open ? 'Hide' : 'Show'} ${row.name}'s day`}>
            {open ? 'Hide' : 'Details'} {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        </td>
      </tr>
      {open && (
        <tr className={tt.detailRow} id={detailId}>
          <td colSpan={9}>
            <PersonDetail row={row} status={status} />
          </td>
        </tr>
      )}
    </>
  )
}

function PersonDetail({ row, status }: { row: Row; status: RosterStatus }) {
  return (
    <div className={tt.detail}>
      {status.issues.length > 0 && (
        <div className={tt.cellChips}>{status.issues.map(i => <span key={i} className={`${tt.chip} ${tt.chipRed}`}>{i}</span>)}</div>
      )}
      <div className={tt.detailFacts}>
        <span>In <strong>{row.machineLinked ? istClock(row.punch.checkInAt) : 'no machine ID'}</strong></span>
        <span>Out <strong>{istClock(row.punch.checkOutAt)}</strong></span>
        <span><strong>{row.counts.done}</strong>/{row.counts.total} tasks done</span>
        {row.counts.open > 0 && <span><strong>{row.counts.open}</strong> open</span>}
        {row.counts.carried > 0 && <span><strong>{row.counts.carried}</strong> carried over</span>}
      </div>
      {row.tasks.length === 0 ? <p className={tt.muted}>No tasks for this day.</p> : (
        <ul className={styles.items}>
          {row.tasks.map(t => (
            <li key={t.id} className={t.state === 'done' ? `${styles.item} ${styles.itemDone}` : t.state === 'carried' ? `${styles.item} ${styles.itemNotDone}` : styles.item}>
              <div className={styles.itemHead}>
                <div>
                  <p className={styles.itemTitle}><Link href={`/tasks/${t.id}`} className={styles.proofLink}>{t.title}</Link></p>
                  <p className={styles.itemSub}>{t.self ? 'Self task' : 'Given to them'}{t.due_date ? ` · due ${dayLabel(t.due_date)}` : ''} · open the task for its proof</p>
                  {t.carryover && <p className={styles.itemSub}>Why not finished: {t.carryover.reason} · New date {dayLabel(t.carryover.next_date)}</p>}
                </div>
                <span className={`${tt.chip} ${t.state === 'done' ? tt.chipGreen : t.state === 'carried' ? tt.chipAmber : tt.chipGrey}`}>
                  {t.state === 'done' ? 'Done' : t.state === 'carried' ? 'Carried over' : 'Open'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {row.plan?.close_note && <p className={tt.muted}><strong>End of day:</strong> {row.plan.close_note}</p>}
    </div>
  )
}

function strikeDetail(s: Strike): string {
  const d = s.detail ?? {}
  if (s.kind === 'no_plan' || s.kind === 'plan_late') {
    return `Due ${String(d.due ?? '')}${d.filed_at ? `, filed ${istClock(String(d.filed_at))}` : ''}`
  }
  if (s.kind === 'day_not_closed') {
    return d.punch_out_at ? `Last punch ${istClock(String(d.punch_out_at))}` : 'No punch-out'
  }
  if (s.kind === 'closed_after_leaving') {
    return `Last punch ${istClock(String(d.punch_out_at ?? ''))}, closed ${istClock(String(d.closed_at ?? ''))}`
  }
  return ''
}

function StrikeRow({ s, canDecide, onDecided }: { s: Strike & { name: string; label: string }; canDecide: boolean; onDecided: () => Promise<void> }) {
  const [note, setNote] = useState('')
  const [waiving, setWaiving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: 'upheld' | 'waived') => {
    setBusy(true)
    const r = await dayCloseFetch(`/api/day-close/strikes/${s.id}`, { body: { decision, note } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await onDecided()
  }
  return (
    <div className={tt.decision}>
      <span className={`${tt.chip} ${tt.chipRed}`}>Strike</span>
      <div className={tt.decisionText}>
        <p className={tt.decisionTitle}>{s.name} · {s.label}</p>
        <p className={tt.decisionSub}>{dayLabel(s.work_date)} · {strikeDetail(s)}</p>
      </div>
      {canDecide && (
        <div className={tt.decisionActions}>
          {waiving ? (
            <>
              <input className={tt.noteInput} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} autoFocus
                placeholder="Why waive it?" aria-label={`Why waive ${s.name}'s strike`} />
              <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => { setWaiving(false); setNote('') }}>Cancel</button>
              <button type="button" className="boe-btn boe-btn-primary" disabled={busy || note.trim().length < 3} onClick={() => decide('waived')}>Waive</button>
            </>
          ) : (
            <>
              <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => setWaiving(true)}>Waive…</button>
              <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={() => decide('upheld')}>Uphold</button>
            </>
          )}
        </div>
      )}
      {error && <p className={tt.error} role="alert">{error}</p>}
    </div>
  )
}

function ReviewerSetup({ onDone }: { onDone: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const take = async () => {
    const r = await dayCloseFetch('/api/day-close/members', { body: { action: 'become_reviewer' } })
    if (!r.ok) { setError(r.error); return }
    await onDone()
  }
  return (
    <div className={`${styles.banner} ${styles.bannerAmber}`}>
      <div style={{ flex: 1 }}>
        <p className={styles.bannerTitle}>Nobody reviews strikes yet</p>
        <p className={styles.bannerText}>The reviewer decides every strike and is the only person who can approve leave while work is pending.</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className="boe-btn boe-btn-primary" onClick={take}>Make me the reviewer</button>
        </div>
      </div>
    </div>
  )
}

type Person = { id: string; name: string; role: string; member: boolean }

function Members({ onChanged }: { onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const membersQuery = useQuery<Person[]>({
    queryKey: ['day-close', 'members'],
    enabled: open,
    queryFn: async () => {
      const r = await dayCloseFetch<{ people: Person[] }>('/api/day-close/members')
      if (!r.ok) throw new Error(r.error)
      return r.data.people
    },
    retry: false,
  })
  const people = membersQuery.data ?? null
  const { refetch } = membersQuery
  const load = useCallback(async () => { await refetch() }, [refetch])
  const loadError = membersQuery.error instanceof Error ? membersQuery.error.message : null

  const change = async (body: Record<string, unknown>) => {
    setBusy(true)
    const r = await dayCloseFetch('/api/day-close/members', { body })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setError(null)
    await load()
    await onChanged()
  }

  const on = people?.filter(p => p.member).length ?? 0

  return (
    <section className={styles.card} aria-labelledby="members-heading">
      <button type="button" className={styles.toggle} onClick={() => setOpen(o => !o)} aria-expanded={open} id="members-heading">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {' '}Who takes part{people ? ` (${on})` : ''}
      </button>
      {open && (
        <>
          {(error ?? loadError) && <p className={styles.error} role="alert">{error ?? loadError}</p>}
          {!people && !loadError && <p className={styles.muted}>Loading…</p>}
          {people && (
            <>
              <div className={styles.actions}>
                <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => change({ action: 'add_everyone' })}>
                  Add everyone (except administrators)
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                {people.map(p => (
                  <div key={p.id} className={styles.memberRow}>
                    <span>{p.name}{p.role === 'admin' ? <span className={styles.muted}> · admin</span> : null}</span>
                    <button
                      type="button"
                      className={`boe-btn ${p.member ? 'boe-btn-ghost' : 'boe-btn-secondary'}`}
                      disabled={busy}
                      onClick={() => change({ action: p.member ? 'remove' : 'add', employee_id: p.id })}
                      aria-label={`${p.member ? 'Switch off' : 'Switch on'} Day Close for ${p.name}`}
                    >
                      {p.member ? 'On · switch off' : 'Switch on'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
