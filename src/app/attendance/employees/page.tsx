'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

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
  | 'fingerprint_employee_code'
  | 'payroll_active'
  | 'employment_type'
  | 'payroll_notes'
>

type EditState = {
  employee_code: string
  fingerprint_employee_code: string
  joining_date: string
  monthly_salary: string
  office_timing: string
  payroll_active: boolean
  employment_type: string
  payroll_notes: string
}

type AddState = {
  full_name: string
  employee_code: string
  fingerprint_employee_code: string
  team: string
}

const TEAMS = ['sales', 'operations', 'design', 'purchase', 'bdm', 'management']

const OFFICE_TIMINGS = [
  { value: 'General Shift',  label: 'General Shift — 10:00 AM – 06:30 PM' },
  { value: 'Factory Shift',  label: 'Factory Shift — 09:00 AM – 06:00 PM' },
  { value: 'Sales Shift',    label: 'Sales Shift — 10:00 AM – 06:30 PM' },
  { value: 'Half Day',       label: 'Half Day — 10:00 AM – 01:30 PM' },
]

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

function canEdit(role: string | undefined) {
  return role === 'admin' || role === 'manager'
}

// ─── Add Employee Modal ───────────────────────────────────────────────────────

function AddModal({
  token,
  onClose,
  onCreated,
}: {
  token: string
  onClose: () => void
  onCreated: (emp: EmployeeRow) => void
}) {
  const [form, setForm] = useState<AddState>({
    full_name: '', employee_code: '', fingerprint_employee_code: '', team: '',
  })
  const [saving, setSaving]   = useState(false)
  const [error,  setError]    = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const set = (key: keyof AddState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }))

  const handleCreate = async () => {
    if (!form.full_name.trim())     { setError('Name is required'); return }
    if (!form.employee_code.trim()) { setError('Employee HR code is required'); return }
    setSaving(true)
    setError(null)
    try {
      const res  = await fetch('/api/create-employee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Create failed'); setSaving(false); return }
      setSuccess(true)
      onCreated({
        id:                        json.id,
        full_name:                 form.full_name.trim(),
        employee_code:             form.employee_code.trim() || null,
        fingerprint_employee_code: form.fingerprint_employee_code.trim() || null,
        team:                      form.team.trim() || '',
        position:                  null,
        is_active:                 true,
        joining_date:              null,
        monthly_salary:            null,
        office_timing:             null,
        payroll_active:            true,
        employment_type:           null,
        payroll_notes:             null,
      })
      setTimeout(onClose, 900)
    } catch {
      setError('Network error, please retry.')
      setSaving(false)
    }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: colors.tertiary,
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block',
  }
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 13,
    border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        width: '100%', maxWidth: 460,
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>Add Attendance Employee</div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: colors.tertiary, lineHeight: 1, padding: 4 }}
            aria-label="Close"
          >×</button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Full Name <span style={{ color: '#EF4444' }}>*</span></label>
            <input style={inputStyle} value={form.full_name} onChange={set('full_name')} placeholder="e.g. Ashok Choudhary" autoFocus />
          </div>
          <div>
            <label style={labelStyle}>Employee HR Code <span style={{ color: '#EF4444' }}>*</span></label>
            <input style={inputStyle} value={form.employee_code} onChange={set('employee_code')} placeholder="e.g. BOE-017" />
          </div>
          <div>
            <label style={labelStyle}>Fingerprint Code</label>
            <input style={inputStyle} value={form.fingerprint_employee_code} onChange={set('fingerprint_employee_code')} placeholder="e.g. 0017" />
            <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 4 }}>
              Machine code from fingerprint export (0017, 0027 …)
            </div>
          </div>
          <div>
            <label style={labelStyle}>Department / Team</label>
            <select style={inputStyle} value={form.team} onChange={e => setForm(f => ({ ...f, team: e.target.value }))}>
              <option value="">— Select team —</option>
              {TEAMS.map(t => (
                <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 13,
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
              color: '#DC2626',
            }}>{error}</div>
          )}
          {success && (
            <div style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 13,
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
              color: '#059669',
            }}>Employee created successfully!</div>
          )}
        </div>

        <div style={{
          padding: '12px 20px',
          borderTop: `1px solid ${colors.border}`,
          display: 'flex', justifyContent: 'flex-end', gap: 10,
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '8px 18px', fontSize: 13, borderRadius: 7, cursor: 'pointer',
              border: `1px solid ${colors.border}`, background: 'transparent', color: colors.secondary,
            }}
          >Cancel</button>
          <button
            onClick={handleCreate}
            disabled={saving || success}
            style={{
              padding: '8px 18px', fontSize: 13, fontWeight: 600, borderRadius: 7,
              cursor: saving || success ? 'not-allowed' : 'pointer',
              border: 'none', background: '#3B82F6', color: '#fff',
              opacity: saving || success ? 0.7 : 1,
            }}
          >{saving ? 'Creating…' : 'Create Employee'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditModal({
  emp,
  token,
  onClose,
  onSaved,
}: {
  emp: EmployeeRow
  token: string
  onClose: () => void
  onSaved: (updated: Partial<EmployeeRow>) => void
}) {
  const [form, setForm] = useState<EditState>({
    employee_code:             emp.employee_code             ?? '',
    fingerprint_employee_code: emp.fingerprint_employee_code ?? '',
    joining_date:              emp.joining_date              ?? '',
    monthly_salary:            emp.monthly_salary != null ? String(emp.monthly_salary) : '',
    office_timing:             emp.office_timing             ?? '',
    payroll_active:            emp.payroll_active            ?? true,
    employment_type:           emp.employment_type           ?? '',
    payroll_notes:             emp.payroll_notes             ?? '',
  })
  const [saving, setSaving]   = useState(false)
  const [error,  setError]    = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const set = (key: keyof EditState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/update-employee', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          id:                        emp.id,
          employee_code:             form.employee_code,
          fingerprint_employee_code: form.fingerprint_employee_code,
          joining_date:              form.joining_date,
          monthly_salary:            form.monthly_salary,
          office_timing:             form.office_timing,
          payroll_active:            form.payroll_active,
          employment_type:           form.employment_type,
          payroll_notes:             form.payroll_notes,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Update failed'); setSaving(false); return }
      setSuccess(true)
      onSaved({
        employee_code:             form.employee_code             || null,
        fingerprint_employee_code: form.fingerprint_employee_code || null,
        joining_date:              form.joining_date              || null,
        monthly_salary:            form.monthly_salary !== '' ? Number(form.monthly_salary) : null,
        office_timing:             form.office_timing             || null,
        payroll_active:            form.payroll_active,
        employment_type:           (form.employment_type as 'permanent' | 'contract') || null,
        payroll_notes:             form.payroll_notes             || null,
      })
      setTimeout(onClose, 900)
    } catch {
      setError('Network error, please retry.')
      setSaving(false)
    }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: colors.tertiary,
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block',
  }
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 13,
    border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        width: '100%', maxWidth: 460,
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>{emp.full_name}</div>
            <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 2 }}>
              {emp.team ?? '—'} · {emp.position ?? '—'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 20, color: colors.tertiary, lineHeight: 1, padding: 4,
            }}
            aria-label="Close"
          >×</button>
        </div>

        {/* Form */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div>
            <label style={labelStyle}>Employee Code</label>
            <input style={inputStyle} value={form.employee_code} onChange={set('employee_code')} placeholder="e.g. BOE-001" />
          </div>

          <div>
            <label style={labelStyle}>Fingerprint Code</label>
            <input style={inputStyle} value={form.fingerprint_employee_code} onChange={set('fingerprint_employee_code')} placeholder="e.g. 0014" />
          </div>

          <div>
            <label style={labelStyle}>Joining Date</label>
            <input style={inputStyle} type="date" value={form.joining_date} onChange={set('joining_date')} />
          </div>

          <div>
            <label style={labelStyle}>Monthly Salary (₹)</label>
            <input style={inputStyle} type="number" min="0" step="1" value={form.monthly_salary} onChange={set('monthly_salary')} placeholder="e.g. 25000" />
          </div>

          <div>
            <label style={labelStyle}>Office Timing</label>
            <select style={inputStyle} value={form.office_timing} onChange={set('office_timing')}>
              <option value="">— Select shift —</option>
              {OFFICE_TIMINGS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Payroll configuration */}
          <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Payroll Configuration
            </div>

            <div>
              <label style={labelStyle}>Employment Type</label>
              <select style={inputStyle} value={form.employment_type} onChange={set('employment_type')}>
                <option value="">— Select type —</option>
                <option value="permanent">Permanent</option>
                <option value="contract">Contract</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                id="payroll_active_toggle"
                type="checkbox"
                checked={form.payroll_active}
                onChange={e => setForm(f => ({ ...f, payroll_active: e.target.checked }))}
                style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#3B82F6' }}
              />
              <label htmlFor="payroll_active_toggle" style={{ fontSize: 13, color: colors.primary, cursor: 'pointer' }}>
                Payroll Active
              </label>
            </div>

            <div>
              <label style={labelStyle}>Payroll Notes</label>
              <textarea
                style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }}
                value={form.payroll_notes}
                onChange={e => setForm(f => ({ ...f, payroll_notes: e.target.value }))}
                placeholder="e.g. On probation, salary revision pending…"
              />
            </div>
          </div>

          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 13,
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
              color: '#DC2626',
            }}>{error}</div>
          )}

          {success && (
            <div style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 13,
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
              color: '#059669',
            }}>Saved successfully!</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px',
          borderTop: `1px solid ${colors.border}`,
          display: 'flex', justifyContent: 'flex-end', gap: 10,
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '8px 18px', fontSize: 13, borderRadius: 7, cursor: 'pointer',
              border: `1px solid ${colors.border}`, background: 'transparent', color: colors.secondary,
            }}
          >Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || success}
            style={{
              padding: '8px 18px', fontSize: 13, fontWeight: 600, borderRadius: 7, cursor: saving || success ? 'not-allowed' : 'pointer',
              border: 'none', background: '#3B82F6', color: '#fff',
              opacity: saving || success ? 0.7 : 1,
            }}
          >{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeeMasterPage() {
  const [profile, setProfile]     = useState<UserProfile | null>(null)
  const [employees, setEmployees] = useState<EmployeeRow[]>([])
  const [filter, setFilter]       = useState<'active' | 'inactive' | 'all'>('active')
  const [search, setSearch]       = useState('')
  const [loading, setLoading]     = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [token, setToken]         = useState('')
  const [editEmp, setEditEmp]     = useState<EmployeeRow | null>(null)
  const [showAdd, setShowAdd]     = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)

      const [{ data: me }, empRes] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing')
          .eq('id', session.user.id)
          .single(),
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

  const handleSaved = (id: string, updated: Partial<EmployeeRow>) => {
    setEmployees(prev => prev.map(e => e.id === id ? { ...e, ...updated } : e))
  }

  const handleCreated = (emp: EmployeeRow) => {
    setEmployees(prev => [...prev, emp])
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

  const showEdit = canEdit(profile?.role)

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

          {showEdit && (
            <button
              onClick={() => setShowAdd(true)}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8,
                border: 'none', background: '#3B82F6', color: '#fff', cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              + Add Employee
            </button>
          )}
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
                  {['Emp. Code', 'Name', 'Department', 'Joining Date', 'Monthly Salary', 'Status', '', ...(showEdit ? [''] : [])].map((h, i) => (
                    <th key={i} style={HEAD}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={showEdit ? 8 : 7} style={{ ...CELL, textAlign: 'center', color: colors.tertiary, padding: '40px 14px' }}>
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
                    <td style={{ ...CELL, fontWeight: 600 }}>{emp.full_name}</td>
                    <td style={CELL}>{fmt(emp.team)}</td>
                    <td style={CELL}>{fmtDate(emp.joining_date)}</td>
                    <td style={{ ...CELL, fontVariantNumeric: 'tabular-nums' }}>{fmtSalary(emp.monthly_salary)}</td>
                    <td style={CELL}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
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
                    <td style={{ ...CELL, width: 60 }}>
                      <Link
                        href={`/attendance/employees/${emp.id}`}
                        style={{
                          display: 'inline-block',
                          padding: '4px 12px', fontSize: 12, fontWeight: 500,
                          border: `1px solid ${colors.border}`, borderRadius: 6,
                          color: colors.secondary, textDecoration: 'none',
                          background: 'transparent',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = colors.raised }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                      >View</Link>
                    </td>
                    {showEdit && (
                      <td style={{ ...CELL, width: 60 }}>
                        <button
                          onClick={() => setEditEmp(emp)}
                          style={{
                            padding: '4px 12px', fontSize: 12, fontWeight: 500,
                            border: `1px solid ${colors.border}`, borderRadius: 6,
                            background: 'transparent', color: colors.secondary,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = colors.raised }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                        >Edit</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {showAdd && (
        <AddModal
          token={token}
          onClose={() => setShowAdd(false)}
          onCreated={emp => { handleCreated(emp); }}
        />
      )}

      {editEmp && (
        <EditModal
          emp={editEmp}
          token={token}
          onClose={() => setEditEmp(null)}
          onSaved={updated => { handleSaved(editEmp.id, updated); }}
        />
      )}
    </AttendanceLayout>
  )
}
