'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

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

function statCell(value: number, warn?: boolean) {
  return (
    <td style={{
      padding: '11px 16px',
      color: warn && value > 0 ? '#DC2626' : value > 0 ? colors.primary : colors.tertiary,
      fontWeight: warn && value > 0 ? 600 : 400,
      textAlign: 'center',
    }}>
      {value}
    </td>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MonthlyReviewPage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [fetching,   setFetching]   = useState(false)
  const [summaries,  setSummaries]  = useState<EmployeeSummary[] | null>(null)
  const [token,      setToken]      = useState('')
  const [error,      setError]      = useState('')

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
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
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

  return (
    <AttendanceLayout
      profile={profile}
      title="Monthly Attendance Review"
      subtitle="Per-employee attendance summary for the selected month"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 1000, padding: '24px 0' }}>

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

        {/* ── Table ── */}
        {summaries !== null && (
          <>
            <div style={{ fontSize: 13, color: colors.secondary, marginBottom: 12 }}>
              {summaries.length} employee{summaries.length !== 1 ? 's' : ''} — {MONTH_NAMES[month - 1]} {year}
            </div>

            <div style={{
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: 10, overflow: 'hidden',
            }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                      {['Employee', 'Present', 'Half Day', 'Absent', 'Late', 'Missing Punch', 'Days Recorded'].map(col => (
                        <th key={col} style={{
                          padding: '10px 16px',
                          textAlign: col === 'Employee' ? 'left' : 'center',
                          fontSize: 11, fontWeight: 600, color: colors.tertiary,
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                        }}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s, i) => (
                      <tr
                        key={s.employee_id}
                        style={{ borderBottom: i < summaries.length - 1 ? `1px solid ${colors.border}` : 'none' }}
                      >
                        <td style={{ padding: '11px 16px', color: colors.primary }}>
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
                        {statCell(s.late)}
                        {statCell(s.missing_punch, true)}
                        <td style={{ padding: '11px 16px', color: colors.tertiary, textAlign: 'center' }}>
                          {s.total_records}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {summaries.length === 0 && (
                <div style={{
                  padding: '48px 24px', textAlign: 'center',
                  color: colors.tertiary, fontSize: 13,
                }}>
                  No employees found.
                </div>
              )}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, color: colors.tertiary, lineHeight: 1.6 }}>
              <strong style={{ color: colors.secondary }}>Note:</strong> Absent and Missing Punch counts are highlighted in red. Days Recorded shows how many attendance entries exist for that employee this month.
            </div>
          </>
        )}

        {summaries === null && !fetching && !error && (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            Select a month and click Load to view the attendance summary.
          </div>
        )}

      </div>
    </AttendanceLayout>
  )
}
