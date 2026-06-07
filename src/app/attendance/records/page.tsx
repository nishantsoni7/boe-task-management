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

type EmployeeOption = { id: string; full_name: string; employee_code: string | null }

type AttendanceRecord = {
  id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string
  user_id: string
  users: { full_name: string; employee_code: string | null } | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function statusBadge(status: string) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    present:    { bg: 'rgba(16,185,129,0.1)', color: '#059669', label: 'Present' },
    checked_in: { bg: 'rgba(59,130,246,0.1)', color: '#2563EB', label: 'Checked In' },
    absent:     { bg: 'rgba(239,68,68,0.1)',  color: '#DC2626', label: 'Absent' },
    half_day:   { bg: 'rgba(245,158,11,0.1)', color: '#D97706', label: 'Half Day' },
  }
  const s = map[status] ?? { bg: 'rgba(140,148,166,0.1)', color: '#8C94A6', label: status }
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 9px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600,
      background: s.bg, color: s.color,
      textTransform: 'capitalize',
    }}>
      {s.label}
    </span>
  )
}

const inputStyle: React.CSSProperties = {
  fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
  background: colors.base, color: colors.primary, outline: 'none',
  padding: '8px 12px', boxSizing: 'border-box',
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AttendanceRecordsPage() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [records,   setRecords]   = useState<AttendanceRecord[]>([])
  const [fetching,  setFetching]  = useState(false)
  const [exporting, setExporting] = useState(false)
  const [token,     setToken]     = useState('')
  const [total,     setTotal]     = useState<number | null>(null)
  const [page,      setPage]      = useState(1)
  const PAGE_SIZE = 50

  const [employeeId, setEmployeeId] = useState('')
  const [fromDate,   setFromDate]   = useState('')
  const [toDate,     setToDate]     = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)

      const [{ data: me }, { data: emps }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('users')
          .select('id, full_name, employee_code')
          .eq('is_active', true)
          .order('full_name'),
      ])

      setProfile(me as UserProfile)
      setEmployees((emps ?? []) as EmployeeOption[])
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchPage = async (targetPage: number) => {
    setFetching(true)
    const params = new URLSearchParams()
    if (employeeId) params.set('employee_id', employeeId)
    if (fromDate)   params.set('from', fromDate)
    if (toDate)     params.set('to', toDate)
    params.set('page', String(targetPage))

    const res  = await fetch(`/api/attendance/records?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const json = await res.json()
    if (res.ok) {
      setRecords(json.records)
      setTotal(json.total)
      setPage(targetPage)
    }
    setFetching(false)
  }

  const handleSearch = () => fetchPage(1)

  const handleExportCSV = async () => {
    setExporting(true)
    const params = new URLSearchParams()
    if (employeeId) params.set('employee_id', employeeId)
    if (fromDate)   params.set('from', fromDate)
    if (toDate)     params.set('to', toDate)
    params.set('format', 'csv')

    const res = await fetch(`/api/attendance/records?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (res.ok) {
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = 'attendance-records.csv'
      a.click()
      URL.revokeObjectURL(url)
    }
    setExporting(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const totalPages = total !== null ? Math.ceil(total / PAGE_SIZE) : 1

  if (loading) return <LoadingScreen />

  return (
    <AttendanceLayout
      profile={profile}
      title="Attendance Records"
      subtitle="View imported fingerprint attendance data"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 960, padding: '24px 0' }}>

        <Link
          href="/attendance"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Attendance Dashboard
        </Link>

        {/* ── Filters ── */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '20px 24px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            Filters
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>

            <div style={{ flex: '1 1 200px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Employee
              </label>
              <select
                value={employeeId}
                onChange={e => setEmployeeId(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
              >
                <option value="">All Employees</option>
                {employees.map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name}{emp.employee_code ? ` (${emp.employee_code})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: '1 1 150px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                From Date
              </label>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>

            <div style={{ flex: '1 1 150px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                To Date
              </label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>

            <button
              onClick={handleSearch}
              disabled={fetching}
              style={{
                padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 7,
                border: 'none', cursor: fetching ? 'not-allowed' : 'pointer',
                background: '#3B82F6', color: '#fff', opacity: fetching ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              {fetching ? 'Loading…' : 'Search'}
            </button>

          </div>
        </div>

        {/* ── Results header: count + export ── */}
        {total !== null && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: colors.secondary }}>
              {total} record{total !== 1 ? 's' : ''} found
            </span>
            <button
              onClick={handleExportCSV}
              disabled={exporting || total === 0}
              style={{
                padding: '7px 16px', fontSize: 12, fontWeight: 600, borderRadius: 7,
                border: `1px solid ${colors.border}`, cursor: exporting || total === 0 ? 'not-allowed' : 'pointer',
                background: colors.base, color: colors.primary, opacity: exporting || total === 0 ? 0.5 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          </div>
        )}

        {/* ── Table ── */}
        {records.length > 0 ? (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, overflow: 'hidden',
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                    {['Date', 'Employee', 'Check In', 'Check Out', 'Status'].map(col => (
                      <th key={col} style={{
                        padding: '10px 16px', textAlign: 'left',
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
                      style={{
                        borderBottom: i < records.length - 1 ? `1px solid ${colors.border}` : 'none',
                      }}
                    >
                      <td style={{ padding: '11px 16px', color: colors.primary, whiteSpace: 'nowrap' }}>
                        {formatDate(rec.attendance_date)}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.primary }}>
                        {rec.users?.full_name ?? '—'}
                        {rec.users?.employee_code && (
                          <span style={{ fontSize: 11, color: colors.tertiary, marginLeft: 6 }}>
                            {rec.users.employee_code}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {formatTime(rec.check_in_at)}
                      </td>
                      <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                        {formatTime(rec.check_out_at)}
                      </td>
                      <td style={{ padding: '11px 16px' }}>
                        {statusBadge(rec.status)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Pagination footer ── */}
            <div style={{
              padding: '12px 16px', borderTop: `1px solid ${colors.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 12, color: colors.tertiary,
            }}>
              <span>
                Page {page} of {totalPages}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => fetchPage(page - 1)}
                  disabled={fetching || page <= 1}
                  style={{
                    padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                    border: `1px solid ${colors.border}`, cursor: page <= 1 ? 'not-allowed' : 'pointer',
                    background: colors.base, color: colors.primary, opacity: page <= 1 ? 0.4 : 1,
                  }}
                >
                  Previous
                </button>
                <button
                  onClick={() => fetchPage(page + 1)}
                  disabled={fetching || page >= totalPages}
                  style={{
                    padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                    border: `1px solid ${colors.border}`, cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                    background: colors.base, color: colors.primary, opacity: page >= totalPages ? 0.4 : 1,
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            {fetching ? 'Loading records…' : 'Select filters and click Search to view records.'}
          </div>
        )}

      </div>
    </AttendanceLayout>
  )
}
