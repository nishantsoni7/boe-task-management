'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'

type EmployeeRow = Pick<
  UserProfile,
  | 'id'
  | 'full_name'
  | 'team'
  | 'position'
  | 'is_active'
  | 'employee_code'
  | 'joining_date'
  | 'monthly_salary'
  | 'office_timing'
>

const CELL: React.CSSProperties = {
  padding: '11px 14px',
  fontSize: 13,
  color: colors.primary,
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: 'nowrap',
}

const HEAD: React.CSSProperties = {
  ...CELL,
  fontSize: 11,
  fontWeight: 600,
  color: colors.tertiary,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  background: colors.raised,
  borderBottom: `1px solid ${colors.border}`,
}

function fmt(val: string | number | null | undefined, fallback = '—') {
  if (val === null || val === undefined || val === '') return fallback
  return String(val)
}

function fmtSalary(val: number | null | undefined) {
  if (val === null || val === undefined) return '—'
  return '₹' + Number(val).toLocaleString('en-IN')
}

function fmtDate(val: string | null | undefined) {
  if (!val) return '—'
  return new Date(val).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function EmployeeMasterPage() {
  const [profile, setProfile]     = useState<UserProfile | null>(null)
  const [employees, setEmployees] = useState<EmployeeRow[]>([])
  const [filter, setFilter]       = useState<'active' | 'inactive' | 'all'>('active')
  const [search, setSearch]       = useState('')
  const [loading, setLoading]     = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: me }, empRes] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
          .eq('id', session.user.id)
          .single(),
        // Direct browser query is blocked by RLS — use service-role API route instead
        fetch('/api/employee-list', {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        }).then(r => r.json()),
      ])

      setProfile(me as UserProfile)
      if (empRes?.error) {
        console.error('[employee-list] API error:', empRes.error)
        setFetchError(empRes.error)
      } else {
        setEmployees((empRes.employees ?? []) as EmployeeRow[])
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const visible = useMemo(() => {
    let rows = employees
    if (filter === 'active')   rows = rows.filter(e => e.is_active)
    if (filter === 'inactive') rows = rows.filter(e => !e.is_active)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(e =>
        e.full_name.toLowerCase().includes(q) ||
        (e.team ?? '').toLowerCase().includes(q) ||
        (e.position ?? '').toLowerCase().includes(q) ||
        (e.employee_code ?? '').toLowerCase().includes(q)
      )
    }
    return rows
  }, [employees, filter, search])

  if (loading) return <LoadingScreen />

  const counts = {
    all:      employees.length,
    active:   employees.filter(e => e.is_active).length,
    inactive: employees.filter(e => !e.is_active).length,
  }

  return (
    <AttendanceLayout
      profile={profile}
      title="Employee Master"
      subtitle="All BOE employee records"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 1100, padding: '24px 0' }}>

        {fetchError && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
            fontSize: 13, color: '#DC2626',
          }}>
            <strong>Error loading employees:</strong> {fetchError}
          </div>
        )}

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 4, background: colors.raised, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 3 }}>
            {(['active', 'inactive', 'all'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 12,
                  fontWeight: filter === f ? 600 : 400,
                  cursor: 'pointer',
                  background: filter === f ? colors.base : 'transparent',
                  color: filter === f ? colors.primary : colors.tertiary,
                  boxShadow: filter === f ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  transition: 'all 0.15s',
                  textTransform: 'capitalize',
                }}
              >
                {f === 'all' ? `All (${counts.all})` : f === 'active' ? `Active (${counts.active})` : `Inactive (${counts.inactive})`}
              </button>
            ))}
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="Search by name, department, designation…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 220,
              padding: '7px 12px',
              fontSize: 13,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              background: colors.base,
              color: colors.primary,
              outline: 'none',
            }}
          />

          <span style={{ fontSize: 12, color: colors.tertiary, whiteSpace: 'nowrap' }}>
            {visible.length} employee{visible.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <div style={{
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Emp. Code', 'Name', 'Department', 'Designation', 'Joining Date', 'Monthly Salary', 'Office Timing', 'Status'].map(h => (
                    <th key={h} style={HEAD}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ ...CELL, textAlign: 'center', color: colors.tertiary, padding: '40px 14px' }}>
                      No employees found.
                    </td>
                  </tr>
                ) : visible.map(emp => (
                  <tr
                    key={emp.id}
                    style={{ transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = colors.raised)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ ...CELL, fontFamily: 'monospace', fontSize: 12, color: colors.tertiary }}>
                      {fmt(emp.employee_code)}
                    </td>
                    <td style={{ ...CELL, fontWeight: 600 }}>
                      {emp.full_name}
                    </td>
                    <td style={CELL}>{fmt(emp.team)}</td>
                    <td style={{ ...CELL, color: colors.secondary }}>{fmt(emp.position)}</td>
                    <td style={CELL}>{fmtDate(emp.joining_date)}</td>
                    <td style={{ ...CELL, fontVariantNumeric: 'tabular-nums' }}>{fmtSalary(emp.monthly_salary)}</td>
                    <td style={{ ...CELL, color: colors.secondary }}>{fmt(emp.office_timing)}</td>
                    <td style={CELL}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '3px 9px',
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 600,
                        background: emp.is_active ? 'rgba(16,185,129,0.1)' : 'rgba(156,163,175,0.15)',
                        color: emp.is_active ? '#059669' : '#6B7280',
                      }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: emp.is_active ? '#10B981' : '#9CA3AF',
                        }} />
                        {emp.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </AttendanceLayout>
  )
}
