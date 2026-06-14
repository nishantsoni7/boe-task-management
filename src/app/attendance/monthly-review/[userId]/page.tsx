'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

type DayRecord = {
  id:               string
  attendance_date:  string
  check_in_at:      string | null
  check_out_at:     string | null
  status:           string
  hours_worked:     number | null
  is_late:          boolean
  is_missing_punch: boolean
}

type EmployeeDetail = {
  id:            string
  full_name:     string
  employee_code: string | null
  office_timing: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    present:       { bg: 'rgba(16,185,129,0.1)',  color: '#059669', label: 'Present' },
    checked_in:    { bg: 'rgba(59,130,246,0.1)',  color: '#2563EB', label: 'Checked In' },
    absent:        { bg: 'rgba(239,68,68,0.1)',   color: '#DC2626', label: 'Absent' },
    half_day:      { bg: 'rgba(245,158,11,0.1)',  color: '#D97706', label: 'Half Day' },
    late:          { bg: 'rgba(249,115,22,0.1)',  color: '#EA580C', label: 'Late' },
    missing_punch: { bg: 'rgba(139,92,246,0.1)',  color: '#7C3AED', label: 'Missing Punch' },
  }
  const s = map[status] ?? { bg: 'rgba(140,148,166,0.1)', color: '#8C94A6', label: status }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.color,
      textTransform: 'capitalize',
    }}>
      {s.label}
    </span>
  )
}

function Flag({ active, label, color }: { active: boolean; label: string; color: string }) {
  if (!active) return <span style={{ color: colors.tertiary }}>—</span>
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 20,
      fontSize: 11, fontWeight: 600,
      background: `${color}18`, color,
    }}>
      {label}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeeMonthlyDetailPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null)
  const [records,  setRecords]  = useState<DayRecord[]>([])
  const [error,    setError]    = useState('')
  const [token,    setToken]    = useState('')

  const params       = useParams()
  const searchParams = useSearchParams()
  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])

  const userId = params.userId as string
  const year   = parseInt(searchParams.get('year')  ?? '0', 10)
  const month  = parseInt(searchParams.get('month') ?? '0', 10)

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

  useEffect(() => {
    if (!token || !userId || !year || !month) return
    const load = async () => {
      setFetching(true)
      setError('')
      const res  = await fetch(
        `/api/attendance/employee-monthly-detail?employee_id=${userId}&year=${year}&month=${month}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      )
      const json = await res.json()
      if (res.ok) {
        setEmployee(json.employee)
        setRecords(json.records)
      } else {
        setError(json.error ?? 'Failed to load records')
      }
      setFetching(false)
    }
    load()
  }, [token, userId, year, month])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const monthLabel = year && month ? `${MONTH_NAMES[month - 1]} ${year}` : ''
  const backHref   = year && month
    ? `/attendance/monthly-review?year=${year}&month=${month}`
    : '/attendance/monthly-review'

  return (
    <AttendanceLayout
      profile={profile}
      title={employee ? `${employee.full_name} — ${monthLabel}` : 'Employee Detail'}
      subtitle="Day-wise attendance records for the selected month"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 960, padding: '24px 0' }}>

        <Link
          href={backHref}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Monthly Review
        </Link>

        {/* ── Employee info header ── */}
        {employee && (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '16px 20px', marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>{employee.full_name}</div>
              {employee.employee_code && (
                <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 2 }}>{employee.employee_code}</div>
              )}
            </div>
            <div style={{ width: 1, height: 32, background: colors.border, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Period</div>
              <div style={{ fontSize: 13, color: colors.primary, marginTop: 2 }}>{monthLabel}</div>
            </div>
            {employee.office_timing && (
              <>
                <div style={{ width: 1, height: 32, background: colors.border, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Office Timing</div>
                  <div style={{ fontSize: 13, color: colors.primary, marginTop: 2 }}>{employee.office_timing}</div>
                </div>
              </>
            )}
            <div style={{ marginLeft: 'auto' }}>
              <div style={{ fontSize: 13, color: colors.secondary }}>{records.length} day{records.length !== 1 ? 's' : ''} recorded</div>
            </div>
          </div>
        )}

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

        {/* ── Records table ── */}
        {fetching ? (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            Loading records…
          </div>
        ) : records.length > 0 ? (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, overflow: 'hidden',
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                    {['Date', 'Check In', 'Check Out', 'Hours', 'Status', 'Late', 'Missing Punch'].map(col => (
                      <th key={col} style={{
                        padding: '10px 16px',
                        textAlign: col === 'Date' ? 'left' : 'center',
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
                  {records.map((rec, i) => (
                    <tr
                      key={rec.id}
                      style={{ borderBottom: i < records.length - 1 ? `1px solid ${colors.border}` : 'none' }}
                    >
                      <td style={{ padding: '11px 16px', color: colors.primary, whiteSpace: 'nowrap' }}>
                        {formatDate(rec.attendance_date)}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap', textAlign: 'center' }}>
                        {formatTime(rec.check_in_at)}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap', textAlign: 'center' }}>
                        {formatTime(rec.check_out_at)}
                      </td>
                      <td style={{ padding: '11px 16px', textAlign: 'center',
                        color: rec.hours_worked !== null ? colors.primary : colors.tertiary }}>
                        {rec.hours_worked !== null ? `${rec.hours_worked}h` : '—'}
                      </td>
                      <td style={{ padding: '11px 16px', textAlign: 'center' }}>
                        <StatusBadge status={rec.status} />
                      </td>
                      <td style={{ padding: '11px 16px', textAlign: 'center' }}>
                        <Flag active={rec.is_late} label="Late" color="#EA580C" />
                      </td>
                      <td style={{ padding: '11px 16px', textAlign: 'center' }}>
                        <Flag active={rec.is_missing_punch} label="Missing" color="#7C3AED" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : !error && (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            No attendance records found for this employee in {monthLabel}.
          </div>
        )}

      </div>
    </AttendanceLayout>
  )
}
