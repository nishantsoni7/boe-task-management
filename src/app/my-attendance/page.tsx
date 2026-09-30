'use client'

// An employee's own attendance for one month, and nothing else.
//
// This is the SELF-SERVICE half of the Attendance module — the counterpart to
// /my-payroll. It never asks for another employee's id and could not use one:
// /api/attendance/employee-monthly-detail authorises the requested id against
// the bearer token and pins a non-admin to their own. See
// SELF_SERVICE_MODULE_KEYS in src/lib/moduleAccess.ts.
//
// Deliberately not a dashboard. No company figures, no charts, no rankings —
// the questions an employee actually has are "was I marked present on the 12th"
// and "why does it say I was late", and those are answered by a plain table.

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { istClockOf } from '@/lib/istDate'
import { RefreshCw } from 'lucide-react'
import { MonthPicker, Notice, StateBlock, ui } from '@/components/attendancePayroll/ui'
import styles from './myAttendance.module.css'
import { RaiseIssueModal } from '@/components/objections/RaiseIssueModal'
import { IssueHistoryModal } from '@/components/objections/IssueHistoryModal'
import { MyAttendanceRequests } from '@/components/attendanceRequests/MyAttendanceRequests'
import { MonthRequestsPanel, DayRequestChips, requestsByDate, type MonthRequest } from '@/components/attendanceRequests/MonthRequests'
import {
  employeeStatusLabel,
  statusTone as objectionTone,
  ownAttendanceObjections,
  objectionsByAttendanceDate,
  canRaiseIssue,
  raiseActionLabel,
  groupIssueChains,
  type ObjectionRow,
} from '@/lib/objections'
import {
  istCurrentYearMonth,
  selectableMonthsInYear,
  MONTH_NOT_IMPORTED_TITLE,
  monthNotImportedMessage,
  coverageNoticeMessage,
} from '@/lib/attendance/monthAvailability'

// ─── Types ────────────────────────────────────────────────────────────────────

type MyDayRow = {
  id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string
  effective_status: string
  hours_worked: number | null
  late_minutes: number | null
  is_late: boolean
  is_missing_punch: boolean
  penalty: string | null
  is_corrected: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** The machine's status vocabulary, said the way an employee would say it. */
const STATUS_LABEL: Record<string, string> = {
  present:       'Present',
  absent:        'Absent',
  half_day:      'Half Day',
  checked_in:    'Checked In',
  missing_punch: 'Missing Punch',
  leave:         'Leave',
  paid_leave:    'Paid Leave',
  unpaid_leave:  'Unpaid Leave',
  holiday:       'Holiday',
  weekly_off:    'Weekly Off',
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ')
}

/** Green reads "fine", amber "look at this", red "you lost a day". */
function statusTone(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'present':
    case 'paid_leave':
    case 'holiday':
    case 'weekly_off':
      return { bg: 'rgba(16,185,129,0.12)', fg: '#059669' }
    case 'absent':
    case 'unpaid_leave':
      return { bg: 'rgba(239,68,68,0.10)',  fg: '#DC2626' }
    default:
      return { bg: 'rgba(232,160,48,0.15)', fg: '#B45309' }
  }
}

function dayLabel(date: string): string {
  // The API returns plain YYYY-MM-DD, already in IST terms — parsing it as UTC
  // and formatting in local time would shift it a day.
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1].slice(0, 3)}, ${weekday}`
}

function clock(instant: string | null): string {
  return instant ? istClockOf(instant) : '—'
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyAttendancePage() {
  // The month it is in IST, not in the browser's timezone — an employee abroad
  // must still land on the company's current month.
  const nowIst = istCurrentYearMonth()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [rows,    setRows]    = useState<MyDayRow[]>([])
  const [monthImported, setMonthImported] = useState(true)
  // The last date the answer speaks for. Null for a finished month, where the
  // cut-off is the month end and there is nothing to explain.
  const [coverageThrough, setCoverageThrough] = useState<string | null>(null)
  // The month's attendance requests, shown beside (never inside) the punches.
  const [monthRequests, setMonthRequests] = useState<MonthRequest[]>([])
  const [requestsError, setRequestsError] = useState<string | null>(null)
  const [objections, setObjections] = useState<ObjectionRow[]>([])
  const [issueDay,   setIssueDay]   = useState<MyDayRow | null>(null)
  const [historyDate, setHistoryDate] = useState<string | null>(null)
  const [year,    setYear]    = useState(nowIst.year)
  const [month,   setMonth]   = useState(nowIst.month)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const load = useCallback(async (y: number, m: number) => {
    setBusy(true)
    setError(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return }

    // Own id, from the session. The route would reject anything else anyway.
    const params = new URLSearchParams({
      employee_id: session.user.id,
      year:  String(y),
      month: String(m),
    })
    const auth = { authorization: `Bearer ${session.access_token}` }

    const [detailRes, objRes] = await Promise.all([
      fetch(`/api/attendance/employee-monthly-detail?${params}`, { headers: auth }),
      // The objection list. Asks for no id and could not use one — a non-admin
      // is pinned to their own rows by the route. An ADMIN, however, gets the
      // company-wide review queue back from this same endpoint, which is why
      // the answer is scoped to this viewer below rather than trusted whole.
      fetch('/api/objections', { headers: auth }),
    ])

    const json = await detailRes.json()
    if (!detailRes.ok) {
      setError(json.error ?? 'Failed to load your attendance')
      setRows([])
      setMonthRequests([])
      setRequestsError(null)
      setMonthImported(true)
      setCoverageThrough(null)
    } else {
      setRows(json.records ?? [])
      setMonthRequests(json.requests ?? [])
      setRequestsError(json.requests_error ?? null)
      // Absent from an older response shape means "imported"; only an explicit
      // false is the not-uploaded state.
      setMonthImported(json.month_imported !== false)
      setCoverageThrough(json.coverage_through ?? null)
    }

    if (objRes.ok) {
      const { objections } = await objRes.json()
      // THIS viewer's own attendance objections, and nobody else's. A date is
      // not a person: every employee has an 11 July, so an admin reading the
      // company-wide queue would otherwise show a colleague's issue as a badge
      // on their own day. Scoped at the boundary so the state below can only
      // ever hold rows that belong on this page.
      setObjections(ownAttendanceObjections<ObjectionRow>(objections ?? [], session.user.id))
    }
    setBusy(false)
  }, [supabase, router])

  /** The caller's own access token, for the attendance-request section. */
  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  /** Live requests by the dates they cover, for the day chips. */
  const requestsOnDate = useMemo(() => requestsByDate(monthRequests), [monthRequests])

  /** The newest objection per date — what the row badge reflects. */
  const objectionByDate = useMemo(() => objectionsByAttendanceDate(objections), [objections])

  /**
   * Every attempt against each date, oldest first — what "View History" shows.
   *
   * The badge above answers "where does this stand"; this answers "what has
   * happened", which after a re-raise are two different questions.
   */
  const chainsByDate = useMemo(() => {
    const byDate = new Map<string, ObjectionRow[]>()
    for (const chain of groupIssueChains(objections).values()) {
      const date = chain[0].attendance_date
      if (date) byDate.set(date, chain)
    }
    return byDate
  }, [objections])

  const submitIssue = async (date: string, reason: string): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return 'Session expired.' }

    const res = await fetch('/api/objections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ attendance_date: date, reason }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not submit your issue.'

    setObjections(prev => [json.objection, ...prev])
    return null
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      if (!prof) { router.push('/login'); return }
      setProfile(prof)

      await load(year, month)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Same-day verification (Phase E): a Minop punch should be visible without
  // an employee having to think to press Refresh. Polling only the CURRENT
  // IST month, only while this page is open, at a modest interval — near
  // enough to real-time for "did my punch register" without a websocket this
  // product does not otherwise need. Older months never poll: nothing about
  // a finished month changes on its own.
  useEffect(() => {
    const current = istCurrentYearMonth()
    if (year !== current.year || month !== current.month) return
    const id = setInterval(() => { void load(year, month) }, 45_000)
    return () => clearInterval(id)
  }, [year, month, load])

  /**
   * Changing the year can strand the selection in a future month — picking
   * this year while December is chosen, say. Clamp to the latest month that
   * exists rather than sending a request the route will refuse.
   */
  const changeMonth = (y: number, m: number) => {
    const allowed = selectableMonthsInYear(y)
    const safeMonth = allowed.includes(m) ? m : allowed[allowed.length - 1]
    setYear(y)
    setMonth(safeMonth)
    void load(y, safeMonth)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const anyCorrected = rows.some(r => r.is_corrected)

  // Only worth saying when the month is genuinely cut short. A finished month's
  // cut-off IS its last day, and announcing that would be noise on every past
  // month an employee opens.
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const partiallyUploaded = monthImported && coverageThrough != null && coverageThrough < monthEnd

  const statusPill = (effective: string) => {
    const tone = statusTone(effective)
    return (
      <span className={ui.badge} style={{ background: tone.bg, color: tone.fg }}>
        {statusLabel(effective)}
      </span>
    )
  }

  /** Status of an issue already raised, plus the actions that remain for that day. */
  const issueControls = (r: MyDayRow) => {
    const objection = objectionByDate.get(r.attendance_date)
    return (
      <div className={styles.issueControls}>
        {objection && (
          <>
            <span
              title={objection.review_note ?? undefined}
              className={ui.badge}
              style={{ background: objectionTone(objection.status).bg, color: objectionTone(objection.status).fg }}
            >
              {employeeStatusLabel(objection.status)}
            </span>
            <button
              type="button"
              onClick={() => setHistoryDate(r.attendance_date)}
              className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
            >
              History
            </button>
          </>
        )}
        {canRaiseIssue(objection) && (
          <button
            type="button"
            onClick={() => setIssueDay(r)}
            className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
          >
            {raiseActionLabel(objection)}
          </button>
        )}
      </div>
    )
  }

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="My Attendance"
      subtitle="Your own attendance record, month by month. Something look wrong? Raise an issue on that day."
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>
        {error && (
          <Notice
            kind="error"
            action={
              <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void load(year, month)} disabled={busy}>
                Try again
              </button>
            }
          >
            {error}
          </Notice>
        )}

        {/* Late, early, time out, half day, leave — the one entry point. */}
        <MyAttendanceRequests getToken={getToken} />

        <div className={ui.toolbar} style={{ marginBottom: 0 }}>
          {/* Only months that have started. A future month holds no
              attendance, so offering one just invites a wrong answer. */}
          <MonthPicker year={year} month={month} onChange={changeMonth} idPrefix="my-att" />
          <button
            type="button"
            onClick={() => void load(year, month)}
            disabled={busy}
            className={`boe-btn boe-btn-ghost ${ui.btnSm} ${styles.refresh}`}
          >
            <RefreshCw size={13} className={busy ? 'boe-spin' : undefined} /> Refresh
          </button>
          <span className={ui.muted} style={{ fontSize: 13 }} aria-live="polite">
            {MONTHS[month - 1]} {year}
            {busy && <span style={{ marginLeft: 8 }}>· Loading…</span>}
          </span>
        </div>

        {/* Nothing uploaded for this month. Shown INSTEAD of the table, not as an
            empty row inside it: a table of dates with no data still reads as a
            statement about those dates, and there is no statement to make yet. */}
        {!monthImported && !busy && (
          <StateBlock kind="empty" title={MONTH_NOT_IMPORTED_TITLE}>
            {monthNotImportedMessage(`${MONTHS[month - 1]} ${year}`)}
            <div style={{ marginTop: 8 }}>
              Nothing here counts as an absence — pick an earlier month to see your record.
            </div>
          </StateBlock>
        )}

        {/* The current month, uploaded only part-way. The days after the cut-off
            are not in the table at all — they have not been processed, and some
            have not happened, so neither one is something to be absent on. */}
        {partiallyUploaded && !busy && (
          <Notice kind="warning">{coverageNoticeMessage(dayLabel(coverageThrough!))}</Notice>
        )}

        {monthImported && rows.length === 0 && !busy && (
          <StateBlock kind="empty" title="No attendance recorded for this month yet" />
        )}

        {monthImported && rows.length > 0 && (
          <>
            {/* Desktop and tablet: the table. */}
            <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }}>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col" className={ui.num}>In</th>
                      <th scope="col" className={ui.num}>Out</th>
                      <th scope="col" className={ui.num}>Hours</th>
                      <th scope="col">Status</th>
                      <th scope="col"><span className={ui.srOnly}>Issue</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id}>
                        <td className={ui.nowrap}>
                          {dayLabel(r.attendance_date)}
                          {r.is_corrected && <span className={styles.corrected}>Corrected</span>}
                          <DayRequestChips items={requestsOnDate.get(r.attendance_date)} />
                        </td>
                        <td className={`${ui.num} ${r.check_in_at ? '' : ui.muted}`}>{clock(r.check_in_at)}</td>
                        <td className={`${ui.num} ${r.check_out_at ? '' : ui.muted}`}>{clock(r.check_out_at)}</td>
                        <td className={ui.num}>
                          {r.hours_worked != null && r.hours_worked > 0 ? r.hours_worked.toFixed(2) : '—'}
                        </td>
                        <td>
                          {statusPill(r.effective_status)}
                          {r.is_late && r.late_minutes != null && r.late_minutes > 0 && (
                            <span className={styles.late}>{r.late_minutes}m late</span>
                          )}
                        </td>
                        {/* Quiet by design: reporting a problem is rare, so the
                            control should not compete with the day's own figures.

                            The status and the action are shown TOGETHER once a day
                            has been reported. Showing only the badge is what left an
                            employee with no way back after a decision — a rejected
                            issue looked like a permanent verdict on the row. */}
                        <td>{issueControls(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Phone: one card per day, so nothing scrolls sideways. */}
            <ul className={ui.cards} aria-label="Days this month">
              {rows.map(r => (
                <li key={r.id} className={`${ui.surface} ${ui.card}`}>
                  <div className={ui.cardHead}>
                    <div className={ui.strong}>
                      {dayLabel(r.attendance_date)}
                      {r.is_corrected && <span className={styles.corrected}>Corrected</span>}
                    </div>
                    <div>{statusPill(r.effective_status)}</div>
                  </div>
                  <div className={ui.sub}>
                    {clock(r.check_in_at)} → {clock(r.check_out_at)}
                    {r.hours_worked != null && r.hours_worked > 0 && ` · ${r.hours_worked.toFixed(2)} h`}
                    {r.is_late && r.late_minutes != null && r.late_minutes > 0 && (
                      <span className={styles.late}>{r.late_minutes}m late</span>
                    )}
                  </div>
                  <DayRequestChips items={requestsOnDate.get(r.attendance_date)} />
                  {issueControls(r)}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Requests and their decisions — shown whether or not this month's
            attendance has been imported, and kept apart from the punches. */}
        {!busy && (
          <MonthRequestsPanel
            requests={monthRequests}
            error={requestsError}
            monthLabel={`${MONTHS[month - 1]} ${year}`}
            getToken={getToken}
            audience="employee"
          />
        )}

        {/* There is no employee-facing correction request in this system — the
            only correction workflow is the admin one. Rather than invent a second
            one, say who to go to. */}
        {monthImported && (
          <Notice kind="info">
            {anyCorrected
              ? 'Days marked “Corrected” were adjusted by an admin after the machine import. '
              : ''}
            Something look wrong? Use <strong>Raise Issue</strong> on that day. An admin
            reviews it — raising an issue does not change your attendance or salary by
            itself. Applied corrections show as <strong>Corrected</strong>. Once an admin
            has resolved or rejected an issue you can raise it again; every earlier
            submission and reply stays under <strong>History</strong>, and all of them are
            listed on <strong>My Issues</strong>.
          </Notice>
        )}
      </div>

      {issueDay && (
        <RaiseIssueModal
          subject={{
            title: dayLabel(issueDay.attendance_date),
            summary: `${clock(issueDay.check_in_at)} → ${clock(issueDay.check_out_at)} · ${statusLabel(issueDay.effective_status)}`,
          }}
          onClose={() => setIssueDay(null)}
          onSubmit={reason => submitIssue(issueDay.attendance_date, reason)}
        />
      )}

      {historyDate && chainsByDate.get(historyDate) && (
        <IssueHistoryModal
          chain={chainsByDate.get(historyDate)!}
          employeeLabel="You"
          onClose={() => setHistoryDate(null)}
        />
      )}
    </AttendancePayrollLayout>
  )
}
