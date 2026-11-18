'use client'

// THE DAY, ON THE TASK MANAGEMENT DASHBOARD (owner, 2026-11-12: no separate "My Day"; the day's work is the
// person's own tasks).
//
//   morning   the open tasks due today or before (Self Tasks included); "Add a Self Task" for anything
//             else. No plan to file (owner, 2026-11-18): today's tasks are the plan
//   day       tasks are finished in Task Management as always. Finishing one needs proof posted on the
//             task (the database refuses otherwise); this card only counts
//   evening   "Close my day": every task not handed in gets a reason and a new date (the task's due date
//             really moves), and the end-of-day summary, which also files the EOD log. Before the punch-out.
//
// Shown only to somebody switched on; nothing at all otherwise. Every read and write is /api/day-close/me,
// which takes the person from the bearer token.

import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import { CircleCheck, Clock, TriangleAlert } from 'lucide-react'
import { istAddDays } from '@/lib/istDate'
import { clock } from '@/lib/dayClose/rules'
import { dayCloseFetch, dayLabel, istClock } from './api'
import { EveningScoreLine } from '@/components/scoreboard/ScoreCard'
import styles from './dayClose.module.css'

type DayTaskRow = {
  id: string
  title: string
  status: string
  due_date: string | null
  state: 'done' | 'carried' | 'open'
  self: boolean
  carryover: { reason: string; next_date: string } | null
}

type Prompt =
  | { kind: 'none' }
  | { kind: 'close_day'; open: number }
  | { kind: 'on_hold'; open: number; causeDate: string }
  | { kind: 'closed' }

type MyDay = {
  member: boolean
  /** The team switch (Control Center). Only `true` shows the due / strike / proof messages. */
  live?: boolean
  today: string
  workingDay?: boolean
  planDue: number
  closeOpens: number
  plan?: { submitted_at: string | null; closed_at: string | null; close_note: string | null } | null
  tasks?: DayTaskRow[]
  counts?: { total: number; done: number; carried: number; open: number }
  prompt?: Prompt
  punch?: { checkInAt: string | null; checkOutAt: string | null }
  /** The attendance hold (2026-11-18): a working day whose punch is not counted until older work is closed. */
  hold?: { held_date: string; cause_date: string; open_tasks: number } | null
}

export function DayCard({ enabled }: { enabled: boolean }) {
  const query = useQuery<MyDay>({
    queryKey: ['day-close', 'me'],
    enabled,
    queryFn: async () => {
      const r = await dayCloseFetch<MyDay>('/api/day-close/me')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    staleTime: 30_000,
    retry: false,
  })
  const { refetch } = query
  const queryClient = useQueryClient()
  // After filing or closing, the score may move too: read both again.
  const reload = useCallback(async () => {
    await refetch()
    await queryClient.invalidateQueries({ queryKey: ['scoreboard', 'me'] })
  }, [refetch, queryClient])
  const day = query.data

  // Nothing for anybody not switched on, on a day off, while loading, or when the read fails.
  if (!enabled || !day || !day.member || !day.workingDay) return null

  const plan = day.plan ?? null
  const tasks = day.tasks ?? []
  const closed = !!plan?.closed_at
  const counts = day.counts ?? { total: 0, done: 0, carried: 0, open: 0 }

  return (
    <section className={styles.card} aria-labelledby="day-card-heading" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
      <div className={styles.personHead}>
        <h2 id="day-card-heading" className={styles.title}>Today · {dayLabel(day.today)}</h2>
        <div className={styles.facts}>
          <span>Punch in <strong>{istClock(day.punch?.checkInAt)}</strong></span>
          <span><strong>{counts.done}</strong>/{counts.total} done</span>
        </div>
      </div>

      <Banner day={day} />

      {tasks.length > 0 && (
        <ul className={styles.items}>
          {tasks.map(t => (
            <li key={t.id} className={t.state === 'done' ? `${styles.item} ${styles.itemDone}` : t.state === 'carried' ? `${styles.item} ${styles.itemNotDone}` : styles.item}>
              <div className={styles.itemHead}>
                <div>
                  <p className={styles.itemTitle}><Link href={`/tasks/${t.id}`} className={styles.proofLink}>{t.title}</Link></p>
                  <p className={styles.itemSub}>{t.self ? 'Self task' : 'Given to you'}{t.due_date && t.due_date < day.today ? ` · overdue since ${dayLabel(t.due_date)}` : ''}</p>
                  {t.carryover && <p className={styles.itemSub}>Carried to {dayLabel(t.carryover.next_date)}: {t.carryover.reason}</p>}
                </div>
                <span className={`${styles.chip} ${t.state === 'done' ? styles.chipGreen : t.state === 'carried' ? styles.chipAmber : styles.chipGrey}`}>
                  {t.state === 'done' ? 'Done' : t.state === 'carried' ? 'Carried over' : 'Open'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!closed && (
        <div className={styles.actions} style={{ marginTop: 0 }}>
          <Link href="/tasks/create-self" className="boe-btn boe-btn-ghost">Add a Self Task for today</Link>
        </div>
      )}

      {!closed && <CloseDay day={day} tasks={tasks.filter(t => t.state === 'open')} onDone={reload} />}
      {closed && (
        <div className={`${styles.banner} ${styles.bannerGreen}`}>
          <CircleCheck size={20} aria-hidden="true" />
          <div>
            <p className={styles.bannerTitle}>Day closed at {istClock(plan?.closed_at)}</p>
            {plan?.close_note && <p className={styles.bannerText}>{plan.close_note}</p>}
            {/* The Scoreboard, the evening half: what the day did to the month's score. */}
            <EveningScoreLine enabled={enabled} />
          </div>
        </div>
      )}
    </section>
  )
}

function Banner({ day }: { day: MyDay }) {
  // While the team switch is off every message here is about a rule that is paused (due, strike, proof): none is shown.
  if (day.live !== true) return null
  const p = day.prompt
  const hold = day.hold
  if (hold) {
    const n = hold.open_tasks
    return (
      <div className={`${styles.banner} ${styles.bannerRed}`} role="alert">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <p className={styles.bannerTitle}>
            {hold.held_date === day.today ? 'Your punch-in today is not counted yet' : `Your attendance on ${dayLabel(hold.held_date)} is on hold`}
          </p>
          <p className={styles.bannerText}>
            {n} {n === 1 ? 'task' : 'tasks'} from {dayLabel(hold.cause_date)} {n === 1 ? 'is' : 'are'} still open. Finish {n === 1 ? 'it' : 'them'} or
            move {n === 1 ? 'it' : 'them'} to a new date below, and the day counts at once.
          </p>
        </div>
      </div>
    )
  }
  if (p?.kind === 'close_day') {
    return (
      <div className={`${styles.banner} ${styles.bannerRed}`} role="status">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <p className={styles.bannerTitle}>
            {p.open > 0 ? `${p.open} ${p.open === 1 ? 'task is' : 'tasks are'} still open` : 'Close your day before you punch out'}
          </p>
          <p className={styles.bannerText}>Before you leave, finish each task or move it to a new date with a reason, then close your day. Otherwise tomorrow’s attendance will be on hold.</p>
        </div>
      </div>
    )
  }
  if (!day.plan?.closed_at) {
    return (
      <div className={`${styles.banner} ${styles.bannerBlue}`}>
        <Clock size={20} aria-hidden="true" />
        <div>
          <p className={styles.bannerTitle}>Your day is the tasks below. Finish each with proof.</p>
          <p className={styles.bannerText}>Before completing or submitting a task, post an update on it saying what you did (one line is enough), or a photo, a file or a link. Closing the day opens at {clock(day.closeOpens)}.</p>
        </div>
      </div>
    )
  }
  return null
}

type Carry = { reason: string; next_date: string }

function CloseDay({ day, tasks, onDone }: { day: MyDay; tasks: DayTaskRow[]; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [carry, setCarry] = useState<Record<string, Carry>>({})
  const [confirmEarly, setConfirmEarly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const early = day.prompt?.kind !== 'close_day'
  const tomorrow = istAddDays(day.today, 1)
  const entry = (id: string): Carry => carry[id] ?? { reason: '', next_date: tomorrow }

  const close = async () => {
    if (busy) return
    if (early && !confirmEarly) { setConfirmEarly(true); return }
    setBusy(true)
    const r = await dayCloseFetch('/api/day-close/me', {
      body: { action: 'close_day', summary, carryovers: tasks.map(t => ({ task_id: t.id, ...entry(t.id) })) },
    })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await onDone()
  }

  if (!open) {
    return (
      <div className={styles.actions} style={{ marginTop: 0 }}>
        <button type="button" className={`boe-btn ${early ? 'boe-btn-ghost' : 'boe-btn-primary'} ${styles.wide}`} onClick={() => setOpen(true)}>
          Close my day
        </button>
      </div>
    )
  }

  return (
    <div className={styles.form} style={{ marginTop: 0 }}>
      {tasks.length > 0 && (
        <>
          <p className={styles.muted}>Not finished today ({tasks.length}). Say why, and when each will be done:</p>
          {tasks.map(t => (
            <div key={t.id} className={styles.item}>
              <p className={styles.itemTitle}>{t.title}</p>
              <label className={styles.label} htmlFor={`why-${t.id}`}>Why is it not finished?</label>
              <input id={`why-${t.id}`} className={styles.input} value={entry(t.id).reason} maxLength={1000}
                onChange={e => setCarry(c => ({ ...c, [t.id]: { ...entry(t.id), reason: e.target.value } }))} />
              <label className={styles.label} htmlFor={`next-${t.id}`}>When will it be done?</label>
              <input id={`next-${t.id}`} className={styles.input} type="date" min={tomorrow} value={entry(t.id).next_date}
                onChange={e => setCarry(c => ({ ...c, [t.id]: { ...entry(t.id), next_date: e.target.value } }))} />
            </div>
          ))}
        </>
      )}
      <label className={styles.label} htmlFor="day-summary">Your day in a few lines (this is also your EOD log)</label>
      <textarea id="day-summary" className={styles.input} rows={3} maxLength={4000} value={summary}
        onChange={e => setSummary(e.target.value)} placeholder="What got done, what is stuck, what is next." />
      {confirmEarly && (
        <p className={styles.error} role="alert">It is before {clock(day.closeOpens)}. Close now only if you are leaving early with permission. Press Close my day again to confirm.</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className="boe-btn boe-btn-primary" onClick={close} disabled={busy} aria-busy={busy}>
          {busy ? 'Closing…' : 'Close my day'}
        </button>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { setOpen(false); setConfirmEarly(false); setError(null) }} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
