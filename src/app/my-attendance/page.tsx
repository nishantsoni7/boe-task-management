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
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { istClockOf } from '@/lib/istDate'
import { colors } from '@/lib/tokens'
import { RaiseIssueModal } from '@/components/objections/RaiseIssueModal'
import {
  employeeStatusLabel,
  statusTone as objectionTone,
  ownAttendanceObjections,
  objectionsByAttendanceDate,
  type ObjectionRow,
} from '@/lib/objections'
import {
  istCurrentYearMonth,
  selectableMonthsInYear,
  selectableYears,
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
  const [objections, setObjections] = useState<ObjectionRow[]>([])
  const [issueDay,   setIssueDay]   = useState<MyDayRow | null>(null)
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
      setMonthImported(true)
      setCoverageThrough(null)
    } else {
      setRows(json.records ?? [])
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

  /** The newest objection per date — what the row badge reflects. */
  const objectionByDate = useMemo(() => objectionsByAttendanceDate(objections), [objections])

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

  return (
    <AttendanceLayout
      profile={profile}
      title="My Attendance"
      subtitle="Your own attendance record, month by month"
      onSignOut={handleSignOut}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select
            aria-label="Month"
            value={month}
            onChange={e => changeMonth(year, Number(e.target.value))}
            className="boe-input"
            style={{ padding: '8px 10px', fontSize: 13 }}
          >
            {/* Only months that have started. A future month holds no
                attendance, so offering one just invites a wrong answer. */}
            {selectableMonthsInYear(year).map(m => (
              <option key={m} value={m}>{MONTHS[m - 1]}</option>
            ))}
          </select>
          <select
            aria-label="Year"
            value={year}
            onChange={e => changeMonth(Number(e.target.value), month)}
            className="boe-input"
            style={{ padding: '8px 10px', fontSize: 13 }}
          >
            {selectableYears().map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      }
    >
      {error && (
        <div role="alert" style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      <div style={{ fontSize: 13, color: colors.tertiary, marginBottom: 12 }}>
        {MONTHS[month - 1]} {year}
        {busy && <span style={{ marginLeft: 8 }}>· Loading…</span>}
      </div>

      {/* Nothing uploaded for this month. Shown INSTEAD of the table, not as an
          empty row inside it: a table of dates with no data still reads as a
          statement about those dates, and there is no statement to make yet. */}
      {!monthImported && !busy && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: 12,
          background: colors.base, padding: '34px 24px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111318', marginBottom: 6 }}>
            {MONTH_NOT_IMPORTED_TITLE}
          </div>
          <div style={{ fontSize: 13, color: colors.tertiary, lineHeight: 1.55 }}>
            {monthNotImportedMessage(`${MONTHS[month - 1]} ${year}`)}
          </div>
          <div style={{ fontSize: 12.5, color: colors.muted, marginTop: 10 }}>
            Nothing here counts as an absence — pick an earlier month to see your record.
          </div>
        </div>
      )}

      {/* The current month, uploaded only part-way. The days after the cut-off
          are not in the table at all — they have not been processed, and some
          have not happened, so neither one is something to be absent on. */}
      {partiallyUploaded && !busy && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(232,160,48,0.10)', border: '1px solid rgba(232,160,48,0.30)',
          fontSize: 12.5, color: '#8A5A12', lineHeight: 1.55,
        }}>
          {coverageNoticeMessage(dayLabel(coverageThrough!))}
        </div>
      )}

      {/* Wide content scrolls inside its own box, so the page itself never does. */}
      {monthImported && (
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: 12,
        background: colors.base, overflowX: 'auto',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              {['Date', 'In', 'Out', 'Hours', 'Status', ''].map((h, i) => (
                <th key={h || 'issue'} style={{
                  textAlign: i === 0 || i >= 4 ? 'left' : 'right',
                  padding: '10px 14px', fontSize: 11, fontWeight: 600,
                  color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
                  whiteSpace: 'nowrap',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !busy && (
              <tr>
                <td colSpan={6} style={{ padding: '28px 14px', textAlign: 'center', fontSize: 13, color: colors.muted }}>
                  No attendance recorded for this month yet.
                </td>
              </tr>
            )}
            {rows.map(r => {
              const tone = statusTone(r.effective_status)
              const objection = objectionByDate.get(r.attendance_date)
              return (
                <tr key={r.id} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td style={{
                    padding: '10px 14px', fontSize: 13, color: '#111318',
                    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                  }}>
                    {dayLabel(r.attendance_date)}
                    {r.is_corrected && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: '#3B63B8', fontWeight: 600 }}>
                        Corrected
                      </span>
                    )}
                  </td>
                  <td style={{
                    padding: '10px 14px', fontSize: 13, textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                    color: r.check_in_at ? '#3D4455' : colors.muted,
                  }}>
                    {clock(r.check_in_at)}
                  </td>
                  <td style={{
                    padding: '10px 14px', fontSize: 13, textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                    color: r.check_out_at ? '#3D4455' : colors.muted,
                  }}>
                    {clock(r.check_out_at)}
                  </td>
                  <td style={{
                    padding: '10px 14px', fontSize: 13, textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums', color: '#3D4455',
                  }}>
                    {r.hours_worked != null && r.hours_worked > 0 ? r.hours_worked.toFixed(2) : '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{
                      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                      fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                      background: tone.bg, color: tone.fg,
                    }}>
                      {statusLabel(r.effective_status)}
                    </span>
                    {r.is_late && r.late_minutes != null && r.late_minutes > 0 && (
                      <span style={{ marginLeft: 8, fontSize: 11.5, color: '#B45309' }}>
                        {r.late_minutes}m late
                      </span>
                    )}
                  </td>
                  {/* Quiet by design: reporting a problem is rare, so the
                      control should not compete with the day's own figures. */}
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                    {objection ? (
                      <span
                        title={objection.review_note ?? undefined}
                        style={{
                          display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                          fontSize: 11.5, fontWeight: 600,
                          background: objectionTone(objection.status).bg,
                          color: objectionTone(objection.status).fg,
                        }}
                      >
                        {employeeStatusLabel(objection.status)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setIssueDay(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                      >
                        Raise Issue
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* There is no employee-facing correction request in this system — the
          only correction workflow is the admin one. Rather than invent a second
          one, say who to go to. */}
      {monthImported && (
      <div style={{
        marginTop: 14, padding: '11px 14px', borderRadius: 10,
        background: '#F4F6F9', border: `1px solid ${colors.border}`,
        fontSize: 12.5, color: '#4B5563', lineHeight: 1.55,
      }}>
        {anyCorrected
          ? 'Days marked “Corrected” were adjusted by an admin after the machine import. '
          : ''}
        Something look wrong? Use <strong>Raise Issue</strong> on that day. An admin
        reviews it — raising an issue does not change your attendance or salary by
        itself. Applied corrections show as <strong>Corrected</strong>.
      </div>
      )}

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
    </AttendanceLayout>
  )
}
