'use client'

// TEAM TODAY (owner, 2026-11-12): one screen for the owner at the end of the day.
//
//   strikes to review     every open strike, oldest decision first: Uphold or Waive (reviewer only)
//   the day, per person   punch in and out from the machine, plan filed (late?), items done / not done /
//                         open with each proof one tap away, calls and WhatsApp logged on the Lead Board,
//                         overdue tasks, today's strikes, this month's strikes
//   who takes part        switch people on or off; "Add everyone"
//
// Reads /api/day-close/team and /api/day-close/members (administrators and the reviewer). Strike
// decisions are the reviewer's alone, and the server says so too.

import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { istAddDays } from '@/lib/istDate'
import { clock } from '@/lib/dayClose/rules'
import { dayCloseFetch, dayLabel, istClock } from './api'
import styles from './dayClose.module.css'

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

type Item = {
  id: string
  source: 'assigned' | 'own'
  title: string
  expected_output: string | null
  effective: 'open' | 'done' | 'not_done'
  proof_url: string | null
  proof_note: string | null
  photo_url: string | null
  reason: string | null
  next_date: string | null
  closed_at: string | null
}

type Row = {
  id: string
  name: string
  machineLinked: boolean
  onLeave: boolean
  punch: { checkInAt: string | null; checkOutAt: string | null }
  plan: { submitted_at: string | null; closed_at: string | null; close_note: string | null } | null
  counts: { total: number; done: number; notDone: number; open: number }
  items: Item[]
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
}

const STRIKE_WORDS: Record<string, string> = {
  no_plan: 'No plan',
  plan_late: 'Plan late',
  day_not_closed: 'Day not closed',
  closed_after_leaving: 'Closed after leaving',
}

export function TeamTodayScreen() {
  const [date, setDate] = useState<string | null>(null)
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

  const totals = team.rows.reduce((t, r) => ({
    filed: t.filed + (r.plan?.submitted_at ? 1 : 0),
    closed: t.closed + (r.plan?.closed_at ? 1 : 0),
    open: t.open + r.counts.open,
    strikes: t.strikes + r.strikes.filter(s => s.status !== 'waived').length,
  }), { filed: 0, closed: 0, open: 0, strikes: 0 })

  return (
    <div className={styles.page}>
      {!team.reviewer && <ReviewerSetup onDone={load} />}

      <div className={styles.toolbar}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setDate(istAddDays(team.date, -1))}>‹ Day before</button>
        <input
          type="date"
          className={styles.input}
          style={{ width: 'auto' }}
          value={team.date}
          max={team.today}
          aria-label="Date"
          onChange={e => setDate(e.target.value || null)}
        />
        {team.date !== team.today && (
          <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setDate(null)}>Today</button>
        )}
        <span className={styles.muted}>
          {dayLabel(team.date)} · plan due {clock(team.planDue)} · closing opens {clock(team.closeOpens)}
          {!team.workingDay && ' · not a working day'}
        </span>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.summary}>
        <Stat n={team.rows.length} label="Taking part" />
        <Stat n={totals.filed} label="Plans filed" />
        <Stat n={totals.closed} label="Days closed" />
        <Stat n={totals.open} label="Items still open" />
        <Stat n={totals.strikes} label="Strikes this day" />
      </div>

      {team.openStrikes.length > 0 && (
        <StrikesToReview strikes={team.openStrikes} canDecide={team.viewer.isReviewer} reviewerName={team.reviewer?.name ?? null} onDecided={load} />
      )}

      <section aria-labelledby="people-heading" className={styles.page}>
        <h2 id="people-heading" className={styles.eyebrow}>The day, person by person</h2>
        {team.rows.length === 0 && (
          <div className={styles.card}><p className={styles.muted}>Nobody is switched on yet. Use “Who takes part” below.</p></div>
        )}
        {team.rows.map(r => <PersonCard key={r.id} row={r} />)}
      </section>

      {team.viewer.manages && <Members onChanged={load} />}

      <p className={styles.muted}>
        Strikes are written each night at 11:15 pm for the day just ending. Days off, holidays, approved full-day leave
        and days with no punch on the machine never get a strike.
      </p>
    </div>
  )
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statNum}>{n}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

function PersonCard({ row }: { row: Row }) {
  const [open, setOpen] = useState(false)
  const plan = row.plan
  const planChip = row.onLeave
    ? <span className={`${styles.chip} ${styles.chipBlue}`}>On leave</span>
    : !plan?.submitted_at
      ? <span className={`${styles.chip} ${styles.chipRed}`}>No plan</span>
      : <span className={`${styles.chip} ${styles.chipGreen}`}>Plan {istClock(plan.submitted_at)}</span>
  const closeChip = plan?.closed_at
    ? <span className={`${styles.chip} ${styles.chipGreen}`}>Closed {istClock(plan.closed_at)}</span>
    : plan?.submitted_at ? <span className={`${styles.chip} ${styles.chipAmber}`}>Not closed</span> : null

  return (
    <article className={`${styles.card} ${styles.person}`}>
      <div className={styles.personHead}>
        <h3 className={styles.personName}>{row.name}</h3>
        <div className={styles.chips}>
          {planChip}
          {closeChip}
          {row.strikes.filter(s => s.status !== 'waived').map(s => (
            <span key={s.id} className={`${styles.chip} ${styles.chipRed}`}>{STRIKE_WORDS[s.kind] ?? s.kind}</span>
          ))}
        </div>
      </div>
      <div className={styles.facts}>
        <span>In <strong>{row.machineLinked ? istClock(row.punch.checkInAt) : 'no machine ID'}</strong></span>
        <span>Out <strong>{istClock(row.punch.checkOutAt)}</strong></span>
        <span><strong>{row.counts.done}</strong>/{row.counts.total} done</span>
        {row.counts.notDone > 0 && <span><strong>{row.counts.notDone}</strong> not done</span>}
        {row.counts.open > 0 && <span style={{ color: '#B42332' }}><strong>{row.counts.open}</strong> open</span>}
        <span>Calls <strong>{row.calls.call}</strong> · WhatsApp <strong>{row.calls.whatsapp}</strong></span>
        {row.overdueTasks > 0 && <span style={{ color: '#B42332' }}>Overdue tasks <strong>{row.overdueTasks}</strong></span>}
        <span>Strikes this month <strong>{row.monthStrikes}</strong></span>
      </div>
      {row.items.length > 0 && (
        <button type="button" className={styles.toggle} onClick={() => setOpen(o => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {' '}{open ? 'Hide' : 'Show'} the {row.items.length} {row.items.length === 1 ? 'item' : 'items'} and proof
        </button>
      )}
      {open && (
        <ul className={styles.items}>
          {row.items.map(i => (
            <li key={i.id} className={i.effective === 'done' ? `${styles.item} ${styles.itemDone}` : i.effective === 'not_done' ? `${styles.item} ${styles.itemNotDone}` : styles.item}>
              <div className={styles.itemHead}>
                <div>
                  <p className={styles.itemTitle}>{i.source === 'assigned' ? 'Given: ' : ''}{i.title}</p>
                  {i.expected_output && <p className={styles.itemSub}>Output: {i.expected_output}</p>}
                  {i.proof_url && <p className={styles.itemSub}><a href={i.proof_url} target="_blank" rel="noreferrer" className={styles.proofLink}>{i.proof_url}</a></p>}
                  {i.proof_note && <p className={styles.itemSub}>{i.proof_note}</p>}
                  {i.photo_url && (
                    <a href={i.photo_url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={i.photo_url} alt={`Proof for ${i.title}`} className={styles.proofPhoto} />
                    </a>
                  )}
                  {i.effective === 'not_done' && <p className={styles.itemSub}>Why: {i.reason} · New date {i.next_date ? dayLabel(i.next_date) : '—'}</p>}
                </div>
                <span className={`${styles.chip} ${i.effective === 'done' ? styles.chipGreen : i.effective === 'not_done' ? styles.chipAmber : styles.chipGrey}`}>
                  {i.effective === 'done' ? 'Done' : i.effective === 'not_done' ? 'Not done' : 'Open'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {plan?.close_note && <p className={styles.itemSub}>Note: {plan.close_note}</p>}
    </article>
  )
}

function strikeDetail(s: Strike): string {
  const d = s.detail ?? {}
  if (s.kind === 'no_plan' || s.kind === 'plan_late') {
    return `Due ${String(d.due ?? '')}${d.filed_at ? `, filed ${istClock(String(d.filed_at))}` : ''}`
  }
  if (s.kind === 'day_not_closed') {
    return `${d.punch_out_at ? `Last punch ${istClock(String(d.punch_out_at))}` : 'No punch-out'}${typeof d.open_items === 'number' ? `, ${d.open_items} open` : ''}`
  }
  if (s.kind === 'closed_after_leaving') {
    return `Last punch ${istClock(String(d.punch_out_at ?? ''))}, closed ${istClock(String(d.closed_at ?? ''))}`
  }
  return ''
}

function StrikesToReview({ strikes, canDecide, reviewerName, onDecided }: {
  strikes: (Strike & { name: string; label: string })[]
  canDecide: boolean
  reviewerName: string | null
  onDecided: () => Promise<void>
}) {
  return (
    <section className={styles.card} aria-labelledby="strikes-heading">
      <h2 id="strikes-heading" className={styles.eyebrow}>Strikes to review ({strikes.length})</h2>
      {!canDecide && <p className={styles.muted}>Only {reviewerName ?? 'the reviewer'} decides strikes.</p>}
      <ul className={styles.items}>
        {strikes.map(s => <StrikeRow key={s.id} s={s} canDecide={canDecide} onDecided={onDecided} />)}
      </ul>
    </section>
  )
}

function StrikeRow({ s, canDecide, onDecided }: { s: Strike & { name: string; label: string }; canDecide: boolean; onDecided: () => Promise<void> }) {
  const [note, setNote] = useState('')
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
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <div>
          <p className={styles.itemTitle}>{s.name} · {s.label}</p>
          <p className={styles.itemSub}>{dayLabel(s.work_date)} · {strikeDetail(s)}</p>
        </div>
        <span className={`${styles.chip} ${styles.chipRed}`}>Open</span>
      </div>
      {canDecide && (
        <>
          <div className={styles.form}>
            <input className={styles.input} value={note} maxLength={1000} onChange={e => setNote(e.target.value)}
              placeholder="Note (needed to waive)" aria-label={`Note for ${s.name}'s strike`} />
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <button type="button" className="boe-btn boe-btn-primary" disabled={busy} onClick={() => decide('upheld')}>Uphold</button>
            <button type="button" className="boe-btn boe-btn-ghost" disabled={busy || note.trim().length < 3} onClick={() => decide('waived')}>Waive</button>
          </div>
        </>
      )}
    </li>
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
  const [open, setOpen] = useState(false)
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
