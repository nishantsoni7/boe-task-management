'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function currentYearMonth() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
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

function statCell(value: number, warn?: boolean) {
  return (
    <td style={{
      padding: '11px 14px',
      color: warn && value > 0 ? '#DC2626' : value > 0 ? colors.primary : colors.tertiary,
      fontWeight: warn && value > 0 ? 600 : 400,
      textAlign: 'center',
      fontVariantNumeric: 'tabular-nums',
    }}>
      {value}
    </td>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MonthlyReviewPage() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [fetching,  setFetching]  = useState(false)
  const [summaries, setSummaries] = useState<EmployeeSummary[] | null>(null)
  const [token,     setToken]     = useState('')
  const [error,     setError]     = useState('')

  const def = currentYearMonth()
  const [year,  setYear]  = useState(def.year)
  const [month, setMonth] = useState(def.month)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchSummary = async (y: number, m: number) => {
    setFetching(true)
    setError('')
    const res  = await fetch(`/api/attendance/monthly-summary?year=${y}&month=${m}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const json = await res.json()
    if (res.ok) {
      setSummaries(json.summaries)
    } else {
      setError(json.error ?? 'Failed to load summary')
      setSummaries(null)
    }
    setFetching(false)
  }

  const handleLoad = () => fetchSummary(year, month)

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const yearOptions: number[] = []
  for (let y = def.year; y >= def.year - 2; y--) yearOptions.push(y)

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 12px', boxSizing: 'border-box',
  }

  // Sort by attendance % descending — the exceptions rise where a scanning eye
  // finds them first, without needing a chart to say so.
  const sorted = summaries
    ? [...summaries].sort((a, b) => attendancePct(b) - attendancePct(a))
    : null

  // One compact line, not a card grid: how many rows actually need a look.
  const exceptions = sorted ? {
    absent:        sorted.filter(s => s.absent > 0).length,
    missingPunch:  sorted.filter(s => s.missing_punch > 0).length,
    late:          sorted.filter(s => s.late > 0).length,
  } : null

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="View Attendance"
      subtitle="Select a month to see attendance for all employees"
      onSignOut={handleSignOut}
      actions={
        <Link
          href="/attendance/upload"
          style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.13)',
            fontSize: 13, fontWeight: 600, color: '#111318', textDecoration: 'none',
            whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          Upload Attendance
        </Link>
      }
    >
      <div style={{ maxWidth: 1060, padding: '24px 0' }}>

        <Link
          href="/attendance"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Attendance
        </Link>

        {/* ── Month selector ── */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '20px 24px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            Select Month
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Month
              </label>
              <select value={month} onChange={e => setMonth(parseInt(e.target.value))} style={{ ...inputStyle, width: 160 }}>
                {MONTH_NAMES.map((name, i) => (
                  <option key={i + 1} value={i + 1}>{name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Year
              </label>
              <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ ...inputStyle, width: 110 }}>
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button
              onClick={handleLoad}
              disabled={fetching || !token}
              style={{
                padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 7,
                border: 'none', cursor: fetching ? 'not-allowed' : 'pointer',
                background: '#3B82F6', color: '#fff', opacity: fetching ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              {fetching ? 'Loading…' : 'Load'}
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            fontSize: 13, color: '#DC2626',
          }}>
            {error}
          </div>
        )}

        {/* ── Employee table — the page itself, not a dashboard preceding it ── */}
        {sorted !== null && (
          <>
            <div style={{ fontSize: 13, color: colors.secondary, marginBottom: 12 }}>
              {sorted.length} employee{sorted.length !== 1 ? 's' : ''} — {MONTH_NAMES[month - 1]} {year}
              {exceptions && (exceptions.absent + exceptions.missingPunch + exceptions.late > 0) && (
                <span style={{ color: colors.tertiary }}>
                  {' · '}
                  {exceptions.absent > 0 && <span style={{ color: '#DC2626' }}>{exceptions.absent} absent</span>}
                  {exceptions.absent > 0 && (exceptions.missingPunch > 0 || exceptions.late > 0) && ', '}
                  {exceptions.missingPunch > 0 && <span style={{ color: '#7C3AED' }}>{exceptions.missingPunch} missing punch</span>}
                  {exceptions.missingPunch > 0 && exceptions.late > 0 && ', '}
                  {exceptions.late > 0 && <span style={{ color: '#D97706' }}>{exceptions.late} late</span>}
                </span>
              )}
            </div>

            <div style={{
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: 10, overflow: 'hidden',
            }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                      {[
                        { label: 'Employee',         align: 'left'   },
                        { label: 'Present',          align: 'center' },
                        { label: 'Half Day',         align: 'center' },
                        { label: 'Absent',           align: 'center' },
                        { label: 'Missing Punch',    align: 'center' },
                        { label: 'Late Marks',       align: 'center' },
                        { label: 'Productive Hrs',   align: 'center' },
                        { label: 'Attendance %',     align: 'center' },
                        { label: '',                 align: 'left'   },
                      ].map(col => (
                        <th key={col.label} style={{
                          padding: '10px 14px',
                          textAlign: col.align as React.CSSProperties['textAlign'],
                          fontSize: 11, fontWeight: 600, color: colors.tertiary,
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                        }}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((s, i) => {
                      const pct = attendancePct(s)
                      const pctColor = pct >= 90 ? '#059669' : pct >= 75 ? '#D97706' : '#DC2626'
                      return (
                        <tr
                          key={s.employee_id}
                          style={{ borderBottom: i < sorted.length - 1 ? `1px solid ${colors.border}` : 'none' }}
                        >
                          <td style={{ padding: '11px 14px', color: colors.primary, fontWeight: 500, whiteSpace: 'nowrap' }}>
                            {s.employee_name}
                            {s.employee_code && (
                              <span style={{ fontSize: 11, color: colors.tertiary, marginLeft: 6 }}>
                                {s.employee_code}
                              </span>
                            )}
                          </td>
                          {statCell(s.present)}
                          {statCell(s.half_day)}
                          {statCell(s.absent, true)}
                          {statCell(s.missing_punch, true)}
                          {statCell(s.late)}
                          <td style={{ padding: '11px 14px', textAlign: 'center', color: s.hours_worked > 0 ? '#059669' : colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>
                            {fmtHours(s.hours_worked)}
                          </td>
                          <td style={{ padding: '11px 14px', textAlign: 'center', fontWeight: 600, color: pctColor, fontVariantNumeric: 'tabular-nums' }}>
                            {s.total_records === 0 ? '—' : `${pct}%`}
                          </td>
                          <td style={{ padding: '11px 14px' }}>
                            <Link
                              href={`/attendance/monthly-review/${s.employee_id}?year=${year}&month=${month}`}
                              style={{
                                fontSize: 12, fontWeight: 600, color: '#3B82F6',
                                textDecoration: 'none', whiteSpace: 'nowrap',
                              }}
                              onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                              onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                            >
                              View →
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {sorted.length === 0 && (
                <div style={{ padding: '48px 24px', textAlign: 'center', color: colors.tertiary, fontSize: 13 }}>
                  No employees found.
                </div>
              )}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, color: colors.tertiary, lineHeight: 1.6 }}>
              <strong style={{ color: colors.secondary }}>Attendance %</strong> = (Present + Missing Punch + Half×0.5) ÷ Working Days × 100.
              Missing punch days count as attendance credit but carry a 2h penalty. Absent days give 0 credit. Sorted highest to lowest.
            </div>
          </>
        )}

        {sorted === null && !fetching && !error && (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            Select a month and click Load to view the attendance summary.
          </div>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
