'use client'

// Monthly Review — the ONE place a month of attendance is reviewed before
// payroll. Two views of the same month, sharing one month picker:
//
//   Attendance summary   every employee's counts for the month, and a way in to
//                        each person's day-by-day record
//   Salary decisions     the salary treatment of each late arrival, early
//                        departure, missing punch and approved request, and
//                        whether the payroll draft agrees. This used to be a
//                        second tab on the Requests page ("Payroll review");
//                        /attendance/requests?tab=review redirects here.
//
// The view and the month are in the address (?view=decisions&year=&month=), so a
// refresh, a link and the browser's Back button land where they were. Each view
// reads only when it is the one on screen.
//
// Admins only: AttendanceGuard sends everyone else to /my-attendance, and the
// routes behind both views check requireAdmin themselves.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { PayrollAttendanceReview } from '@/components/attendanceRequests/PayrollAttendanceReview'
import { Badge, MONTH_NAMES, MonthPicker, Notice, StateBlock, StatusFilter, istCurrentYearMonth, ui } from '@/components/attendancePayroll/ui'
import { isFutureMonth, selectableYears } from '@/lib/attendance/monthAvailability'

type View = 'summary' | 'decisions'

const VIEWS = [
  { key: 'summary',   label: 'Attendance summary' },
  { key: 'decisions', label: 'Salary decisions' },
] as const

type EmployeeSummary = {
  employee_id:   string
  employee_name: string
  employee_code: string | null
  present:       number
  half_day:      number
  absent:        number
  late:          number
  missing_punch: number
  total_records: number
  hours_worked:  number
}

function attendancePct(s: EmployeeSummary): number {
  // Denominator = all recorded days (present + half_day + absent + missing_punch).
  // Missing punch days are not absent but are not credited — they reduce attendance %.
  if (s.total_records === 0) return 0
  return Math.round((s.present + s.half_day * 0.5) / s.total_records * 1000) / 10
}

function fmtHours(h: number): string {
  if (h <= 0) return '—'
  const totalMins = Math.round(h * 60)
  const hrs  = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (mins === 0) return `${hrs}h`
  return `${hrs}h ${mins}m`
}

/** A month from the address, or the current IST month when it is absent or not a month we allow. */
function monthFromParams(params: URLSearchParams): { year: number; month: number } {
  const now = istCurrentYearMonth()
  const year = Number(params.get('year'))
  const month = Number(params.get('month'))
  const okYear = selectableYears().includes(year)
  if (!okYear || !Number.isInteger(month) || month < 1 || month > 12 || isFutureMonth(year, month)) return now
  return { year, month }
}

// useSearchParams needs a Suspense boundary; same shape as /payroll.
export default function MonthlyReviewPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MonthlyReviewScreen />
    </Suspense>
  )
}

function MonthlyReviewScreen() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const router = useRouter()
  const params = useSearchParams()
  const supabase = useMemo(() => createClient(), [])

  const view: View = params.get('view') === 'decisions' ? 'decisions' : 'summary'
  const { year, month } = monthFromParams(params)

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: me } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!me) { router.push('/login'); return }
      setProfile(me as UserProfile)
    }
    void init()
  }, [supabase, router])

  const go = (next: { view?: View; year?: number; month?: number }) => {
    const v = next.view ?? view
    const qs = new URLSearchParams()
    if (v === 'decisions') qs.set('view', 'decisions')
    qs.set('year', String(next.year ?? year))
    qs.set('month', String(next.month ?? month))
    router.replace(`/attendance/monthly-review?${qs}`, { scroll: false })
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!profile) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Monthly review"
      subtitle={`${MONTH_NAMES[month - 1]} ${year} — check the month's attendance, then settle what affects pay.`}
      onSignOut={handleSignOut}
      actions={
        view === 'decisions'
          ? <Link href="/attendance/requests" className="boe-btn boe-btn-ghost" style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}>Attendance requests</Link>
          : <Link href={`/payroll/monthly-review?year=${year}&month=${month}`} className="boe-btn boe-btn-ghost" style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}>Payroll preview</Link>
      }
    >
      <div className={ui.toolbar}>
        <MonthPicker year={year} month={month} onChange={(y, m) => go({ year: y, month: m })} idPrefix="review-month" />
        <StatusFilter
          label="Choose a view of this month"
          value={view}
          options={VIEWS}
          onChange={v => go({ view: v })}
        />
      </div>

      {view === 'summary'
        ? <AttendanceSummary year={year} month={month} getToken={getToken} />
        : <PayrollAttendanceReview getToken={getToken} year={year} month={month} />}
    </AttendancePayrollLayout>
  )
}

function AttendanceSummary({
  year, month, getToken,
}: {
  year: number
  month: number
  getToken: () => Promise<string | null>
}) {
  const [summaries, setSummaries] = useState<EmployeeSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`/api/attendance/monthly-summary?year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      })
      const json = await res.json().catch(() => ({}))
      if (ticket !== latest.current) return
      if (res.ok) { setSummaries(json.summaries ?? []); setError(null) }
      else { setError(json.error ?? 'Failed to load the summary'); setSummaries(null) }
    } catch {
      if (ticket === latest.current) { setError('Could not reach the server. Check your connection and try again.'); setSummaries(null) }
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [getToken, year, month])

  useEffect(() => {
    const run = async () => { await load() }
    void run()
  }, [load])

  const sorted = useMemo(
    () => summaries ? [...summaries].sort((a, b) => attendancePct(b) - attendancePct(a)) : null,
    [summaries],
  )

  const totals = useMemo(() => sorted ? {
    employees:    sorted.length,
    present:      sorted.reduce((a, s) => a + s.present, 0),
    halfDays:     sorted.reduce((a, s) => a + s.half_day, 0),
    absent:       sorted.reduce((a, s) => a + s.absent, 0),
    missingPunch: sorted.reduce((a, s) => a + s.missing_punch, 0),
    late:         sorted.reduce((a, s) => a + s.late, 0),
    hours:        sorted.reduce((a, s) => a + s.hours_worked, 0),
  } : null, [sorted])

  if (error) {
    return (
      <StateBlock
        kind="error"
        title="Could not load this month"
        action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void load()}>Try again</button>}
      >
        {error}
      </StateBlock>
    )
  }
  if (loading && !sorted) return <StateBlock kind="loading">Loading the {MONTH_NAMES[month - 1]} summary…</StateBlock>
  if (!sorted || !totals) return null
  if (sorted.length === 0) {
    return <StateBlock kind="empty" title="No employees to show">No active employees take part in attendance for this month.</StateBlock>
  }

  const pctTone = (pct: number) => pct >= 90 ? 'good' : pct >= 75 ? 'warn' : 'bad'
  const detail = (id: string) => `/attendance/monthly-review/${id}?year=${year}&month=${month}`

  return (
    <div className={ui.stack} aria-busy={loading}>
      {/* One line of totals, not seven tiles: the table below is the content. */}
      <p style={{ margin: 0, fontSize: 13, color: '#4A5261', lineHeight: 1.6 }}>
        <strong style={{ color: '#111318' }}>{totals.employees}</strong> employees ·{' '}
        <strong style={{ color: '#111318' }}>{totals.present}</strong> present days ·{' '}
        <strong style={{ color: '#111318' }}>{totals.halfDays}</strong> half days ·{' '}
        <strong style={{ color: totals.absent > 0 ? '#B91C1C' : '#111318' }}>{totals.absent}</strong> absent ·{' '}
        <strong style={{ color: totals.missingPunch > 0 ? '#B45309' : '#111318' }}>{totals.missingPunch}</strong> missing punch ·{' '}
        <strong style={{ color: '#111318' }}>{totals.late}</strong> late marks ·{' '}
        <strong style={{ color: '#111318' }}>{fmtHours(totals.hours)}</strong> worked
      </p>

      {/* Desktop and tablet: the table, full width. */}
      <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }}>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col" className={ui.num}>Present</th>
                <th scope="col" className={ui.num}>Half day</th>
                <th scope="col" className={ui.num}>Absent</th>
                <th scope="col" className={ui.num}>Missing punch</th>
                <th scope="col" className={ui.num}>Late</th>
                <th scope="col" className={ui.num}>Hours</th>
                <th scope="col" className={ui.num}>Attendance</th>
                <th scope="col"><span className={ui.srOnly}>Open</span></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(s => {
                const pct = attendancePct(s)
                return (
                  <tr key={s.employee_id}>
                    <td className={ui.nowrap}>
                      <span className={ui.strong}>{s.employee_name}</span>
                      {s.employee_code && <span className={ui.muted} style={{ fontSize: 12, marginLeft: 6 }}>{s.employee_code}</span>}
                    </td>
                    <td className={ui.num}>{s.present}</td>
                    <td className={ui.num}>{s.half_day}</td>
                    <td className={ui.num} style={{ color: s.absent > 0 ? '#B91C1C' : undefined, fontWeight: s.absent > 0 ? 600 : 400 }}>{s.absent}</td>
                    <td className={ui.num} style={{ color: s.missing_punch > 0 ? '#B45309' : undefined, fontWeight: s.missing_punch > 0 ? 600 : 400 }}>{s.missing_punch}</td>
                    <td className={ui.num}>{s.late}</td>
                    <td className={ui.num}>{fmtHours(s.hours_worked)}</td>
                    <td className={ui.num}>
                      {s.total_records === 0 ? '—' : <Badge tone={pctTone(pct)}>{pct}%</Badge>}
                    </td>
                    <td className={ui.nowrap} style={{ textAlign: 'right' }}>
                      <Link href={detail(s.employee_id)} className={ui.link} aria-label={`Open ${s.employee_name}'s days`}>Open days →</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Phone: one card per person. */}
      <ul className={ui.cards}>
        {sorted.map(s => {
          const pct = attendancePct(s)
          return (
            <li key={s.employee_id} className={`${ui.surface} ${ui.card}`}>
              <div className={ui.cardHead}>
                <div>
                  <div className={ui.strong}>{s.employee_name}</div>
                  {s.employee_code && <div className={ui.sub}>{s.employee_code}</div>}
                </div>
                {s.total_records > 0 && <Badge tone={pctTone(pct)}>{pct}%</Badge>}
              </div>
              <div style={{ fontSize: 13, color: '#4A5261', lineHeight: 1.6 }}>
                {s.present} present · {s.half_day} half · <span style={{ color: s.absent > 0 ? '#B91C1C' : undefined }}>{s.absent} absent</span> ·{' '}
                <span style={{ color: s.missing_punch > 0 ? '#B45309' : undefined }}>{s.missing_punch} missing punch</span> · {s.late} late · {fmtHours(s.hours_worked)}
              </div>
              <Link href={detail(s.employee_id)} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>Open days</Link>
            </li>
          )
        })}
      </ul>

      <Notice kind="info">
        <strong>Attendance</strong> = (Present + Half day × 0.5) ÷ recorded working days. Present includes
        days with only one punch, which are also counted under Missing punch and carry a 2h penalty. Absent
        days give no credit. Sorted highest to lowest. Use <strong>Salary decisions</strong> above to settle what
        affects pay.
      </Notice>
    </div>
  )
}
