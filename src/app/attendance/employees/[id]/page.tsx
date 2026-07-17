'use client'

import { useEffect, useState, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

type EmployeeDetail = Pick<
  UserProfile,
  | 'id' | 'full_name' | 'team' | 'position' | 'role' | 'employee_code' | 'fingerprint_employee_code' | 'is_active'
  | 'joining_date' | 'monthly_salary' | 'payroll_active' | 'employment_type' | 'payroll_notes'
>

type AttendanceRecord = {
  id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string
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

function fmt(val: string | null | undefined) {
  return val && val.trim() ? val : '—'
}

function statusBadge(status: string) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    present:    { bg: 'rgba(16,185,129,0.1)',  color: '#059669', label: 'Present' },
    checked_in: { bg: 'rgba(59,130,246,0.1)',  color: '#2563EB', label: 'Checked In' },
    absent:     { bg: 'rgba(239,68,68,0.1)',   color: '#DC2626', label: 'Absent' },
    half_day:   { bg: 'rgba(245,158,11,0.1)',  color: '#D97706', label: 'Half Day' },
    late:       { bg: 'rgba(249,115,22,0.1)',  color: '#EA580C', label: 'Late' },
  }
  const s = map[status] ?? { bg: 'rgba(140,148,166,0.1)', color: '#8C94A6', label: status }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600,
      background: s.bg, color: s.color, textTransform: 'capitalize',
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

const PAGE_SIZE = 50

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, accent, sub }: { label: string; value: string | number; accent: string; sub?: string }) {
  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: 10, padding: '16px 20px', flex: 1, minWidth: 130,
    }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: accent, marginTop: 3, opacity: 0.75 }}>{sub}</div>}
      <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 6, fontWeight: 500 }}>{label}</div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeeDetailPage() {
  const params = useParams()
  const id     = params?.id as string

  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [employee,  setEmployee]  = useState<EmployeeDetail | null>(null)
  const [records,   setRecords]   = useState<AttendanceRecord[]>([])
  const [loading,   setLoading]   = useState(true)
  const [notFound,  setNotFound]  = useState(false)
  const [fromDate,  setFromDate]  = useState('')
  const [toDate,    setToDate]    = useState('')
  const [page,      setPage]      = useState(1)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // Fetch current user profile and target employee profile in parallel.
      // attendance_records is fetched via API (service role) to bypass RLS.
      const [{ data: me }, { data: emp }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
          .eq('id', session.user.id)
          .single(),
        supabase
          .from('users')
          .select('id, full_name, team, position, role, employee_code, fingerprint_employee_code, is_active, joining_date, monthly_salary, payroll_active, employment_type, payroll_notes')
          .eq('id', id)
          .single(),
      ])

      setProfile(me as UserProfile)

      if (!emp) { setNotFound(true); setLoading(false); return }
      setEmployee(emp as EmployeeDetail)

      // Use the service-role API so RLS does not block reading other employees' records.
      const recsRes = await fetch(`/api/attendance/employee-records?employee_id=${id}`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (recsRes.ok) {
        const json = await recsRes.json()
        setRecords(json.records as AttendanceRecord[])
      }

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // ── Filter records client-side ──
  const filtered = useMemo(() => {
    let rows = records
    if (fromDate) rows = rows.filter(r => r.attendance_date >= fromDate)
    if (toDate)   rows = rows.filter(r => r.attendance_date <= toDate)
    return rows
  }, [records, fromDate, toDate])

  // Reset to page 1 when filter changes
  useEffect(() => {
    const onFilterChange = () => { setPage(1) }
    onFilterChange()
  }, [fromDate, toDate])

  // ── Summary cards ──
  const summary = useMemo(() => {
    const total    = filtered.length
    const present  = filtered.filter(r => r.status === 'present').length
    const late     = filtered.filter(r => r.status === 'late').length
    const dates    = filtered.map(r => r.attendance_date).sort()
    const earliest = dates[0]   ?? null
    const latest   = dates[dates.length - 1] ?? null
    return { total, present, late, earliest, latest }
  }, [filtered])

  // ── Pagination ──
  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRecords = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  if (loading) return <LoadingScreen />

  if (notFound) {
    return (
      <AttendanceLayout profile={profile} title="Employee Not Found" subtitle="" onSignOut={handleSignOut}>
        <div style={{ maxWidth: 600, padding: '48px 0', color: colors.tertiary, fontSize: 14 }}>
          Employee not found. <Link href="/attendance/employees" style={{ color: colors.blue }}>Back to Employee Master</Link>
        </div>
      </AttendanceLayout>
    )
  }

  const emp = employee!

  return (
    <AttendanceLayout
      profile={profile}
      title={emp.full_name}
      subtitle="Attendance Detail"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 960, padding: '24px 0' }}>

        <Link
          href="/attendance/employees"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Employee Master
        </Link>

        {/* ── Employee profile card ── */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '20px 24px', marginBottom: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: colors.primary }}>{emp.full_name}</div>
              <div style={{ fontSize: 13, color: colors.secondary, marginTop: 4 }}>
                {fmt(emp.position)}{emp.team ? ` · ${emp.team}` : ''}
              </div>
            </div>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
              background: emp.is_active ? 'rgba(16,185,129,0.1)' : 'rgba(156,163,175,0.15)',
              color: emp.is_active ? '#059669' : '#6B7280',
              alignSelf: 'flex-start',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: emp.is_active ? '#10B981' : '#9CA3AF' }} />
              {emp.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: 16 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>HR Employee Code</div>
              <div style={{ fontSize: 13, fontFamily: 'monospace', color: colors.primary }}>{fmt(emp.employee_code)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Fingerprint Code</div>
              <div style={{ fontSize: 13, fontFamily: 'monospace', color: colors.primary }}>{fmt(emp.fingerprint_employee_code)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Team</div>
              <div style={{ fontSize: 13, color: colors.primary, textTransform: 'capitalize' }}>{fmt(emp.team)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Role</div>
              <div style={{ fontSize: 13, color: colors.primary, textTransform: 'capitalize' }}>{fmt(emp.role)}</div>
            </div>
          </div>

          {/* Payroll config row */}
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Joining Date</div>
              <div style={{ fontSize: 13, color: colors.primary }}>
                {emp.joining_date ? new Date(emp.joining_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Monthly Salary</div>
              <div style={{ fontSize: 13, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                {emp.monthly_salary != null ? '₹' + Number(emp.monthly_salary).toLocaleString('en-IN') : '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Employment Type</div>
              <div style={{ fontSize: 13, color: colors.primary, textTransform: 'capitalize' }}>{fmt(emp.employment_type)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Payroll Active</div>
              <div style={{ fontSize: 13, color: emp.payroll_active ? '#059669' : '#6B7280', fontWeight: 600 }}>
                {emp.payroll_active ? 'Yes' : 'No'}
              </div>
            </div>
            {emp.payroll_notes && (
              <div style={{ flexBasis: '100%' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Payroll Notes</div>
                <div style={{ fontSize: 13, color: colors.secondary }}>{emp.payroll_notes}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── Date filter ── */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '16px 20px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Filter Records
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 150px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                From Date
              </label>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                To Date
              </label>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
            </div>
            {(fromDate || toDate) && (
              <button
                onClick={() => { setFromDate(''); setToDate('') }}
                style={{
                  padding: '8px 16px', fontSize: 12, fontWeight: 500, borderRadius: 7,
                  border: `1px solid ${colors.border}`, cursor: 'pointer',
                  background: 'transparent', color: colors.secondary,
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* ── Summary cards ── */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <SummaryCard label="Total Records"  value={summary.total}   accent={colors.primary} />
          <SummaryCard label="Present Days"   value={summary.present} accent="#10B981" />
          <SummaryCard label="Late"           value={summary.late}    accent="#F97316" />
          <SummaryCard
            label="Date Range"
            value={summary.earliest ? formatDate(summary.earliest) : '—'}
            sub={summary.latest && summary.latest !== summary.earliest ? `to ${formatDate(summary.latest)}` : undefined}
            accent="#8B5CF6"
          />
        </div>

        {/* ── Records table ── */}
        {filtered.length > 0 ? (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, overflow: 'hidden',
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                    {['Date', 'Check In', 'Check Out', 'Status'].map(col => (
                      <th key={col} style={{
                        padding: '10px 16px', textAlign: 'left',
                        fontSize: 11, fontWeight: 600, color: colors.tertiary,
                        textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                      }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRecords.map((rec, i) => (
                    <tr
                      key={rec.id}
                      style={{ borderBottom: i < pageRecords.length - 1 ? `1px solid ${colors.border}` : 'none' }}
                    >
                      <td style={{ padding: '11px 16px', color: colors.primary, whiteSpace: 'nowrap' }}>
                        {formatDate(rec.attendance_date)}
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

            {/* Pagination footer */}
            <div style={{
              padding: '12px 16px', borderTop: `1px solid ${colors.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 12, color: colors.tertiary,
            }}>
              <span>Page {page} of {totalPages} · {filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setPage(p => p - 1)}
                  disabled={page <= 1}
                  style={{
                    padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                    border: `1px solid ${colors.border}`, cursor: page <= 1 ? 'not-allowed' : 'pointer',
                    background: colors.base, color: colors.primary, opacity: page <= 1 ? 0.4 : 1,
                  }}
                >Previous</button>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={page >= totalPages}
                  style={{
                    padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                    border: `1px solid ${colors.border}`, cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                    background: colors.base, color: colors.primary, opacity: page >= totalPages ? 0.4 : 1,
                  }}
                >Next</button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            No attendance records found{fromDate || toDate ? ' for the selected date range' : ''}.
          </div>
        )}

      </div>
    </AttendanceLayout>
  )
}
