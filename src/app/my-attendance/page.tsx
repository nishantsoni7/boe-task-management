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
  const now = new Date()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [rows,    setRows]    = useState<MyDayRow[]>([])
  const [year,    setYear]    = useState(now.getFullYear())
  const [month,   setMonth]   = useState(now.getMonth() + 1)
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
    const res = await fetch(`/api/attendance/employee-monthly-detail?${params}`, {
      headers: { authorization: `Bearer ${session.access_token}` },
    })
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? 'Failed to load your attendance'); setRows([]) }
    else setRows(json.records ?? [])
    setBusy(false)
  }, [supabase, router])

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

  const changeMonth = (y: number, m: number) => {
    setYear(y)
    setMonth(m)
    void load(y, m)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const anyCorrected = rows.some(r => r.is_corrected)

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
            {MONTHS.map((label, i) => (
              <option key={label} value={i + 1}>{label}</option>
            ))}
          </select>
          <select
            aria-label="Year"
            value={year}
            onChange={e => changeMonth(Number(e.target.value), month)}
            className="boe-input"
            style={{ padding: '8px 10px', fontSize: 13 }}
          >
            {[0, 1, 2].map(back => {
              const y = now.getFullYear() - back
              return <option key={y} value={y}>{y}</option>
            })}
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

      {/* Wide content scrolls inside its own box, so the page itself never does. */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: 12,
        background: colors.base, overflowX: 'auto',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
              {['Date', 'In', 'Out', 'Hours', 'Status'].map((h, i) => (
                <th key={h} style={{
                  textAlign: i === 0 || i === 4 ? 'left' : 'right',
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
                <td colSpan={5} style={{ padding: '28px 14px', textAlign: 'center', fontSize: 13, color: colors.muted }}>
                  No attendance recorded for this month yet.
                </td>
              </tr>
            )}
            {rows.map(r => {
              const tone = statusTone(r.effective_status)
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
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* There is no employee-facing correction request in this system — the
          only correction workflow is the admin one. Rather than invent a second
          one, say who to go to. */}
      <div style={{
        marginTop: 14, padding: '11px 14px', borderRadius: 10,
        background: '#F4F6F9', border: `1px solid ${colors.border}`,
        fontSize: 12.5, color: '#4B5563', lineHeight: 1.55,
      }}>
        {anyCorrected
          ? 'Days marked “Corrected” were adjusted by an admin after the machine import. '
          : ''}
        Something look wrong? Raise it with your admin — attendance corrections are
        made by an admin against the imported record, and will show here as{' '}
        <strong>Corrected</strong> once applied.
      </div>
    </AttendanceLayout>
  )
}
