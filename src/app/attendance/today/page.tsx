'use client'

// Today: who has punched on the attendance machine, and whether the machine is
// sending. It shows what the machine recorded and changes nothing: a missing
// punch is still fixed in Monthly Review. The rules are in
// src/lib/minop/machineDayView.ts and machineHealth.ts, and the route answers
// admins only, like every screen under /attendance.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { Badge, Notice, StateBlock, StatusFilter, ui, type Tone } from '@/components/attendancePayroll/ui'
import { LoadingScreen } from '@/components/ui/atoms'
import { useRefresh } from '@/contexts/RefreshContext'
import { istAddDays } from '@/lib/istDate'
import { MACHINE_ATTENDANCE_FROM } from '@/lib/minop/machineDay'
import { formatPunchMoment, punchLagLabel, type MachineHealth } from '@/lib/minop/machineHealth'
import type { MachineDayEntry, MachineDayGroup, MachineDayStatus, MachineDayView } from '@/lib/minop/machineDayView'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import styles from './today.module.css'

type Filter = 'all' | MachineDayGroup

const STATUS: Record<MachineDayStatus, { label: string; tone: Tone }> = {
  in_office:       { label: 'In office',             tone: 'good' },
  left:            { label: 'Left',                  tone: 'good' },
  no_punch_yet:    { label: 'No punch yet',          tone: 'warn' },
  no_punch:        { label: 'No punch',              tone: 'bad' },
  cant_tell:       { label: 'Can’t tell yet',        tone: 'neutral' },
  on_leave:        { label: 'On leave',              tone: 'info' },
  day_off:         { label: 'Day off',               tone: 'neutral' },
  morning_missing: { label: 'Morning punch missing', tone: 'warn' },
  evening_missing: { label: 'Evening punch missing', tone: 'warn' },
  no_machine_id:   { label: 'No Machine ID',         tone: 'bad' },
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  })
}

function fmtHours(hours: number | null): string {
  if (hours === null) return '—'
  const minutes = Math.round(hours * 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function fmtDay(date: string): string {
  return new Date(`${date}T00:00:00Z`)
    .toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .replace(',', '')
}

const machineLabel = (e: MachineDayEntry) => (e.machineId ? `Machine ID ${e.machineId}` : 'No Machine ID')

async function fetchDay(token: string, day: string | null): Promise<{ view: MachineDayView } | { error: string }> {
  try {
    const res = await fetch(`/api/attendance/machine-day${day ? `?date=${day}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) return { view: json as MachineDayView }
    return { error: json.error ?? 'The machine day could not be loaded.' }
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' }
  }
}

function MachineStrip({ health }: { health: MachineHealth }) {
  const last = health.lastPunch
  const moment = last ? formatPunchMoment(last.punchAt, health.today) : null
  const syncLink = <Link href="/attendance/minop" className={styles.stripLink}>See every message</Link>

  if (health.state === 'stopped') {
    return (
      <section className={`${styles.strip} ${styles.stripBad}`} aria-label="Machine status">
        <div className={styles.stripHead}>
          <span className={styles.dot} aria-hidden="true" />
          <p className={styles.stripText}>
            <strong>Machine has stopped sending.</strong>{' '}
            No punch has reached BOE today.{moment ? ` The last one was ${moment}.` : ''}
          </p>
          {syncLink}
        </div>
        <ol className={styles.steps}>
          <li>Check the machine has power and shows Wi-Fi.</li>
          <li>Check the Minop subscription is still active.</li>
          <li>Ask someone to punch, then look here again in 15 minutes.</li>
        </ol>
        <p className={styles.reassure}>
          Punches usually arrive late rather than get lost: the longest delay so far is 6 days.
          Those days fill in by themselves.
        </p>
      </section>
    )
  }

  const lead = health.state === 'sending' ? 'Machine is sending.'
    : health.state === 'day_off' ? 'Day off.'
    : 'No punch yet today.'
  const detail = health.state === 'sending' && last
    ? `Last punch ${moment}, reached BOE ${punchLagLabel(last)}.`
    : `${health.state === 'day_off' ? 'No punches expected today. ' : ''}${moment ? `The last one was ${moment}.` : 'No punch has reached BOE yet.'}`

  return (
    <section
      className={`${styles.strip} ${health.state === 'sending' ? styles.stripGood : styles.stripQuiet}`}
      aria-label="Machine status"
    >
      <div className={styles.stripHead}>
        <span className={styles.dot} aria-hidden="true" />
        <p className={styles.stripText}><strong>{lead}</strong>{' '}{detail}</p>
        {syncLink}
      </div>
    </section>
  )
}

function StatusCell({ entry }: { entry: MachineDayEntry }) {
  const status = STATUS[entry.status]
  // A person with an approved reason is not a concern yet.
  const tone = entry.status === 'no_punch_yet' && entry.approved ? 'neutral' : status.tone
  return (
    <>
      <div className={styles.badges}>
        <Badge tone={tone}>{status.label}</Badge>
        {entry.lateMinutes !== null && <Badge tone="warn">Late {entry.lateMinutes} min</Badge>}
      </div>
      {entry.note && <div className={ui.sub}>{entry.note}</div>}
    </>
  )
}

export default function AttendanceTodayPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  // Null is today, whatever date that is by the time the page is refreshed.
  const [date, setDate] = useState<string | null>(null)
  const [view, setView] = useState<MachineDayView | null>(null)
  const [asOf, setAsOf] = useState('')
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [attempt, setAttempt] = useState(0)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: prof } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      setToken(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!token) return
    // Only the newest request may fill the page: arrows can be pressed quickly.
    let superseded = false
    void fetchDay(token, date).then(result => {
      if (superseded) return
      if ('view' in result) {
        setView(result.view)
        setAsOf(fmtTime(new Date().toISOString()))
        setError('')
      } else {
        setError(result.error)
      }
      setFetching(false)
    })
    return () => { superseded = true }
  }, [token, date, refreshKey, attempt])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const goTo = (day: string | null) => {
    setFetching(true)
    setFilter('all')
    setDate(day)
  }

  const rows = useMemo(() => {
    const entries = view?.entries ?? []
    return filter === 'all' ? entries : entries.filter(e => e.group === filter)
  }, [view, filter])

  if (loading) return <LoadingScreen />

  const isToday = view ? view.date === view.today : true
  const silent = view?.entries.some(e => e.status === 'cant_tell') ?? false

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Today"
      subtitle="Who has punched on the machine, and whether the machine is sending."
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>
        {error && (
          <Notice
            kind="error"
            action={
              <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setAttempt(a => a + 1)}>
                Try again
              </button>
            }
          >
            {error}
          </Notice>
        )}

        {!view && !error && <StateBlock kind="loading" title="Loading the machine’s day…" />}

        {view && (
          <>
            <MachineStrip health={view.health} />

            {view.date < MACHINE_ATTENDANCE_FROM && (
              <Notice kind="info">
                The machine becomes the attendance source on 1 November 2026. Until then this page only shows its punches.
              </Notice>
            )}

            <div className={styles.dayBar}>
              <div className={styles.dayPicker}>
                <button
                  type="button"
                  className={styles.dayBtn}
                  aria-label="Previous day"
                  disabled={fetching || view.date <= view.earliest}
                  onClick={() => goTo(istAddDays(view.date, -1))}
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                </button>
                <strong className={styles.dayLabel}>{fmtDay(view.date)}</strong>
                <button
                  type="button"
                  className={styles.dayBtn}
                  aria-label="Next day"
                  disabled={fetching || isToday}
                  onClick={() => {
                    const next = istAddDays(view.date, 1)
                    goTo(next === view.today ? null : next)
                  }}
                >
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
              {isToday
                ? <span className={styles.dayHint}>As of {asOf}</span>
                : <button type="button" className={styles.backToday} onClick={() => goTo(null)}>Back to today</button>}
              <div className={styles.filterEnd}>
                <StatusFilter<Filter>
                  label="Filter staff by status"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { key: 'all', label: 'All', count: view.counts.all },
                    { key: 'in_office', label: 'In office', count: view.counts.in_office },
                    { key: 'left', label: 'Left', count: view.counts.left },
                    { key: 'no_punch', label: silent ? 'Can’t tell' : 'No punch', count: view.counts.no_punch },
                    { key: 'on_leave', label: 'On leave', count: view.counts.on_leave },
                    { key: 'needs_look', label: 'Needs a look', count: view.counts.needs_look },
                  ]}
                />
              </div>
            </div>

            {rows.length === 0 ? (
              <StateBlock kind="empty" title="Nobody here">
                {view.counts.all === 0
                  ? 'Nobody has a Machine ID yet. Add them on Employees.'
                  : 'Nobody on this day matches that filter.'}
              </StateBlock>
            ) : (
              <>
                <section className={`${ui.surface} ${ui.desktopOnly}`} aria-label="Staff on this day">
                  <div className={ui.tableWrap}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th>In</th>
                          <th>Out</th>
                          <th>Hours</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(entry => (
                          <tr key={entry.userId}>
                            <td>
                              <div className={ui.strong}>{entry.name}</div>
                              <div className={ui.sub}>{machineLabel(entry)}</div>
                            </td>
                            <td className={ui.nowrap}>{fmtTime(entry.checkInAt)}</td>
                            <td className={ui.nowrap}>{fmtTime(entry.checkOutAt)}</td>
                            <td className={ui.nowrap}>{fmtHours(entry.hoursWorked)}</td>
                            <td><StatusCell entry={entry} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <ul className={ui.cards} aria-label="Staff on this day">
                  {rows.map(entry => (
                    <li key={entry.userId} className={`${ui.surface} ${ui.card}`}>
                      <div className={ui.cardHead}>
                        <span className={ui.strong}>{entry.name}</span>
                        <Badge tone={entry.status === 'no_punch_yet' && entry.approved ? 'neutral' : STATUS[entry.status].tone}>
                          {STATUS[entry.status].label}
                        </Badge>
                      </div>
                      {(entry.checkInAt || entry.checkOutAt) && (
                        <div className={ui.sub}>
                          {[
                            entry.checkInAt && `In ${fmtTime(entry.checkInAt)}`,
                            entry.checkOutAt && `Out ${fmtTime(entry.checkOutAt)}`,
                            entry.hoursWorked !== null && fmtHours(entry.hoursWorked),
                            entry.lateMinutes !== null && `late ${entry.lateMinutes} min`,
                          ].filter(Boolean).join(', ')}
                        </div>
                      )}
                      {entry.note && <div className={ui.sub}>{entry.note}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {view.strays.map(stray => (
              <Notice
                key={stray.machineId}
                kind="warning"
                action={<Link href="/attendance/employees" className={ui.link}>Open Employees</Link>}
              >
                {stray.message}
              </Notice>
            ))}

            <p className={styles.foot}>
              {silent ? (
                'Nobody shows as absent for a day the machine has not sent.'
              ) : (
                <>
                  This page shows what the machine recorded. A missing punch is still fixed in{' '}
                  <Link href="/attendance/monthly-review" className={ui.link}>Monthly Review</Link>.
                </>
              )}
            </p>
          </>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}
