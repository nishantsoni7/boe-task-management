'use client'

// ATTENDANCE -> MONTHLY REVIEW: THE MONTH'S HELD DAYS (Day Close, owner 2026-11-18).
//
// A held day is a working day whose punch was "recorded but not counted" because the work left open the day before
// was never finished or moved (src/lib/dayClose/hold.ts). Holds the person cleared, or the owner lifted, are not
// here. For each one left, the owner decides for payroll:
//
//   Count the day   paid as normal; payroll does not change
//   Mark absent     applied through the existing attendance correction: versioned, with the owner's name, the draft
//                   recalculated. Asks once more before it changes pay.
//
// A held day left undecided counts as present: nothing is deducted without that click. Administrators only (the
// route checks again). Draws nothing when the month has no held days.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Notice } from '@/components/attendancePayroll/ui'
import { dayCloseFetch, dayLabel } from './api'
import styles from './heldDays.module.css'

type HeldDay = {
  id: string
  name: string
  held_date: string
  cause_date: string
  open_tasks: number
  decision: 'counted' | 'absent' | null
  decided_at: string | null
}

export function HeldDaysReview({ year, month }: { year: number; month: number }) {
  const query = useQuery<{ holds: HeldDay[]; available: boolean }>({
    queryKey: ['day-close', 'holds', year, month],
    queryFn: async () => {
      const r = await dayCloseFetch<{ holds: HeldDay[]; available: boolean }>(`/api/day-close/holds?year=${year}&month=${month}`)
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    retry: false,
  })
  const holds = query.data?.holds ?? []
  if (!query.data || holds.length === 0) return null
  const open = holds.filter(h => !h.decision)

  return (
    <section className={styles.card} aria-labelledby="held-days-heading">
      <div className={styles.head}>
        <h2 id="held-days-heading" className={styles.title}>Held days (Day Close)</h2>
        <Badge tone={open.length ? 'warn' : 'good'}>{open.length ? `${open.length} to decide` : 'All decided'}</Badge>
      </div>
      <p className={styles.muted}>
        These people left work open and never closed it, so their next day&rsquo;s punch was not counted. Decide each day for
        payroll. A day left undecided counts as present.
      </p>
      {holds.map(h => <HeldRow key={h.id} h={h} year={year} month={month} />)}
    </section>
  )
}

function HeldRow({ h, year, month }: { h: HeldDay; year: number; month: number }) {
  const queryClient = useQueryClient()
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const decide = async (decision: 'counted' | 'absent') => {
    if (decision === 'absent' && !sure) { setSure(true); return }
    setBusy(true)
    const r = await dayCloseFetch(`/api/day-close/holds/${h.id}/decide`, { body: { decision } })
    setBusy(false)
    setSure(false)
    if (!r.ok) { setError(r.error); return }
    setError(null)
    await queryClient.invalidateQueries({ queryKey: ['day-close', 'holds', year, month] })
  }

  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <p className={styles.name}>{h.name} · {dayLabel(h.held_date)}</p>
        <p className={styles.sub}>
          Left {h.open_tasks} {h.open_tasks === 1 ? 'task' : 'tasks'} open on {dayLabel(h.cause_date)} and never closed {h.open_tasks === 1 ? 'it' : 'them'}.
        </p>
      </div>
      {h.decision ? (
        <Badge tone={h.decision === 'absent' ? 'bad' : 'good'}>{h.decision === 'absent' ? 'Marked absent' : 'Counted'}</Badge>
      ) : (
        <div className={styles.actions}>
          <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => decide('counted')}>Count the day</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={busy} aria-busy={busy} onClick={() => decide('absent')}>
            {busy ? 'Saving…' : sure ? 'Yes, mark absent' : 'Mark absent'}
          </button>
        </div>
      )}
      {sure && !busy && (
        <div className={styles.error} role="alert">
          <Notice kind="warning">This marks {dayLabel(h.held_date)} absent for {h.name} and recalculates the payroll draft. Press again to confirm.</Notice>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  )
}
