'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { useRefresh } from '@/contexts/RefreshContext'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Badge, Notice, StateBlock, StatusFilter, ui } from '@/components/attendancePayroll/ui'
import styles from './employees.module.css'

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
  | 'performance_tracking_enabled'
  | 'performance_tracking_note'
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
  performance_tracking_enabled: boolean
  performance_tracking_note: string
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

// ─── Dialog shell ─────────────────────────────────────────────────────────────

function Dialog({
  title, subtitle, onClose, footer, children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  footer: React.ReactNode
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className={styles.overlay}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.dialogHead}>
          <div>
            <h2 className={styles.dialogTitle}>{title}</h2>
            {subtitle && <div className={styles.dialogSub}>{subtitle}</div>}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.dialogBody}>{children}</div>
        <div className={styles.dialogFoot}>{footer}</div>
      </div>
    </div>
  )
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

  return (
    <Dialog
      title="Add attendance employee"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={`boe-btn boe-btn-ghost ${ui.btn}`} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className={`boe-btn boe-btn-primary ${ui.btn}`} onClick={handleCreate} disabled={saving || success}>
            {saving ? 'Creating…' : 'Create employee'}
          </button>
        </>
      }
    >
      <div className={ui.field}>
        <label className={ui.label} htmlFor="add-name">Full name <span className={styles.req} aria-hidden="true">*</span></label>
        <input id="add-name" className={ui.input} value={form.full_name} onChange={set('full_name')} placeholder="e.g. Ashok Choudhary" autoFocus />
      </div>
      <div className={ui.field}>
        <label className={ui.label} htmlFor="add-code">Employee HR code <span className={styles.req} aria-hidden="true">*</span></label>
        <input id="add-code" className={ui.input} value={form.employee_code} onChange={set('employee_code')} placeholder="e.g. BOE-017" />
      </div>
      <div className={ui.field}>
        <label className={ui.label} htmlFor="add-fp">Fingerprint code</label>
        <input id="add-fp" className={ui.input} value={form.fingerprint_employee_code} onChange={set('fingerprint_employee_code')} placeholder="e.g. 0017" />
        <div className={ui.hint}>Machine code from the fingerprint export (0017, 0027 …)</div>
      </div>
      <div className={ui.field}>
        <label className={ui.label} htmlFor="add-team">Department / team</label>
        <select id="add-team" className={ui.input} value={form.team} onChange={e => setForm(f => ({ ...f, team: e.target.value }))}>
          <option value="">— Select team —</option>
          {TEAMS.map(t => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {success && <Notice kind="success">Employee created successfully.</Notice>}
    </Dialog>
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
    // Column is NOT NULL DEFAULT true; `?? true` covers a caller that did not
    // select it, so the checkbox never renders an employee as excluded by accident.
    performance_tracking_enabled: emp.performance_tracking_enabled ?? true,
    performance_tracking_note:    emp.performance_tracking_note    ?? '',
  })
  const [saving, setSaving]   = useState(false)
  const [error,  setError]    = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // The employee list does not carry performance_tracking_note — it is admin-only
  // and that endpoint is open to any authenticated user. So the field starts empty
  // and is sent only once actually edited; otherwise saving the toggle would blank
  // a reason the admin never saw.
  const [noteTouched, setNoteTouched] = useState(false)

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
          performance_tracking_enabled: form.performance_tracking_enabled,
          ...(noteTouched ? { performance_tracking_note: form.performance_tracking_note } : {}),
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
        performance_tracking_enabled: form.performance_tracking_enabled,
        ...(noteTouched ? { performance_tracking_note: form.performance_tracking_note || null } : {}),
      })
      setTimeout(onClose, 900)
    } catch {
      setError('Network error, please retry.')
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={emp.full_name}
      subtitle={`${emp.team ?? '—'} · ${emp.position ?? '—'}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={`boe-btn boe-btn-ghost ${ui.btn}`} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className={`boe-btn boe-btn-primary ${ui.btn}`} onClick={handleSave} disabled={saving || success}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className={ui.field}>
        <label className={ui.label} htmlFor="edit-code">Employee code</label>
        <input id="edit-code" className={ui.input} value={form.employee_code} onChange={set('employee_code')} placeholder="e.g. BOE-001" />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="edit-fp">Fingerprint code</label>
        <input id="edit-fp" className={ui.input} value={form.fingerprint_employee_code} onChange={set('fingerprint_employee_code')} placeholder="e.g. 0014" />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="edit-join">Joining date</label>
        <input id="edit-join" className={ui.input} type="date" value={form.joining_date} onChange={set('joining_date')} />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="edit-salary">Monthly salary (₹)</label>
        <input id="edit-salary" className={ui.input} type="number" inputMode="numeric" min="0" step="1" value={form.monthly_salary} onChange={set('monthly_salary')} placeholder="e.g. 25000" />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="edit-timing">Office timing</label>
        <select id="edit-timing" className={ui.input} value={form.office_timing} onChange={set('office_timing')}>
          <option value="">— Select shift —</option>
          {OFFICE_TIMINGS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Payroll configuration */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>Payroll configuration</h3>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="edit-type">Employment type</label>
          <select id="edit-type" className={ui.input} value={form.employment_type} onChange={set('employment_type')}>
            <option value="">— Select type —</option>
            <option value="permanent">Permanent</option>
            <option value="contract">Contract</option>
          </select>
        </div>

        <label className={styles.check} htmlFor="payroll_active_toggle">
          <input
            id="payroll_active_toggle"
            type="checkbox"
            checked={form.payroll_active}
            onChange={e => setForm(f => ({ ...f, payroll_active: e.target.checked }))}
          />
          Payroll active
        </label>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="edit-notes">Payroll notes</label>
          <textarea
            id="edit-notes"
            className={ui.input}
            rows={3}
            value={form.payroll_notes}
            onChange={e => setForm(f => ({ ...f, payroll_notes: e.target.value }))}
            placeholder="e.g. On probation, salary revision pending…"
          />
        </div>
      </div>

      {/* Performance reporting — separate from payroll on purpose: this decides
          whether the employee is measured, not whether they are paid. */}
      <div className={styles.group}>
        <h3 className={styles.groupTitle}>Performance reporting</h3>

        <label className={styles.check} htmlFor="performance_tracking_toggle">
          <input
            id="performance_tracking_toggle"
            type="checkbox"
            checked={form.performance_tracking_enabled}
            onChange={e => setForm(f => ({ ...f, performance_tracking_enabled: e.target.checked }))}
          />
          Include in Performance tracking
        </label>

        <div className={ui.hint}>
          {form.performance_tracking_enabled
            ? 'Counted in team rankings, the team average and Performance coverage.'
            : 'Held out of every team Performance figure — rankings, team average, EOD '
              + 'and adoption totals. Keeps full system access, task history and View As.'}
        </div>

        {!form.performance_tracking_enabled && (
          <div className={ui.field}>
            <label className={ui.label} htmlFor="edit-exclusion">Exclusion reason</label>
            <textarea
              id="edit-exclusion"
              className={ui.input}
              rows={2}
              value={form.performance_tracking_note}
              onChange={e => {
                setNoteTouched(true)
                setForm(f => ({ ...f, performance_tracking_note: e.target.value }))
              }}
              placeholder="e.g. Administrative account, does not submit daily operational data"
            />
            <div className={ui.hint}>
              Visible to administrators only, in Performance Coverage.
              {!noteTouched && ' Leave blank to keep any existing reason.'}
            </div>
          </div>
        )}
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {success && <Notice kind="success">Saved successfully.</Notice>}
    </Dialog>
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
  const [retryKey, setRetryKey]   = useState(0)
  const [token, setToken]         = useState('')
  const [editEmp, setEditEmp]     = useState<EmployeeRow | null>(null)
  const [showAdd, setShowAdd]     = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/login'); return }

        setToken(session.access_token)
        setFetchError(null)

        const [{ data: me }, empRes] = await Promise.all([
          supabase
            .from('users')
            .select(USER_PROFILE_COLUMNS)
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
      } catch {
        setFetchError('Could not load employees. Check your connection and try again.')
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, retryKey])

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
    <AttendancePayrollLayout
      profile={profile}
      title="Employee directory"
      subtitle="Everyone on the BOE attendance roll: codes, teams, joining dates and payroll status."
      onSignOut={handleSignOut}
      actions={
        showEdit
          ? <button type="button" className="boe-btn boe-btn-primary" style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }} onClick={() => setShowAdd(true)}>+ Add employee</button>
          : undefined
      }
    >
      <div className={`${ui.stack} ${ui.wide}`}>

        {fetchError && (
          <Notice
            kind="error"
            action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setRetryKey(k => k + 1)}>Try again</button>}
          >
            <strong>Error loading employees:</strong> {fetchError}
          </Notice>
        )}

        <div className={ui.toolbar} style={{ marginBottom: 0 }}>
          <StatusFilter
            label="Filter employees by status"
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'active', label: 'Active', count: counts.active },
              { key: 'inactive', label: 'Inactive', count: counts.inactive },
              { key: 'all', label: 'All', count: counts.all },
            ]}
          />
          <div className={styles.searchBox}>
            <label className={ui.srOnly} htmlFor="employee-search">Search employees</label>
            <input
              id="employee-search"
              type="search"
              className={ui.input}
              placeholder="Search by name, department, designation…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {!fetchError && (
          visible.length === 0 ? (
            <StateBlock kind="empty" title="No employees found">
              {search.trim() || filter !== 'all'
                ? 'Nothing matches the current filter or search. Try All, or clear the search.'
                : 'No employee records yet.'}
            </StateBlock>
          ) : (
            <div>
              <p className={styles.total} aria-live="polite">
                {visible.length} employee{visible.length !== 1 ? 's' : ''}
              </p>

              {/* Desktop table */}
              <div className={`${ui.surface} ${ui.desktopOnly}`}>
                <div className={ui.tableWrap}>
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th scope="col">Emp. code</th>
                        <th scope="col">Name</th>
                        <th scope="col">Department</th>
                        <th scope="col">Joining date</th>
                        <th scope="col" className={ui.num}>Monthly salary</th>
                        <th scope="col">Status</th>
                        <th scope="col"><span className={ui.srOnly}>Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(emp => (
                        <tr key={emp.id}>
                          <td className={`${styles.code} ${ui.nowrap}`}>{fmt(emp.employee_code)}</td>
                          <td>
                            <div className={styles.name}>{emp.full_name}</div>
                            {emp.position && <div className={ui.sub}>{emp.position}</div>}
                          </td>
                          <td className={styles.cap}>{fmt(emp.team)}</td>
                          <td className={ui.nowrap}>{fmtDate(emp.joining_date)}</td>
                          <td className={ui.num}>{fmtSalary(emp.monthly_salary)}</td>
                          <td>
                            <Badge tone={emp.is_active ? 'good' : 'neutral'}>{emp.is_active ? 'Active' : 'Inactive'}</Badge>
                          </td>
                          <td>
                            <div className={styles.rowActions}>
                              <Link href={`/attendance/employees/${emp.id}`} className={`boe-btn boe-btn-ghost ${ui.btnSm}`} aria-label={`View ${emp.full_name}`}>View</Link>
                              {showEdit && (
                                <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setEditEmp(emp)} aria-label={`Edit ${emp.full_name}`}>Edit</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Phone cards */}
              <ul className={ui.cards}>
                {visible.map(emp => (
                  <li key={emp.id} className={`${ui.surface} ${ui.card}`}>
                    <div className={ui.cardHead}>
                      <div>
                        <div className={styles.cardTitle}>{emp.full_name}</div>
                        <div className={ui.sub}>
                          <span className={styles.code}>{fmt(emp.employee_code)}</span>
                          {emp.position ? ` · ${emp.position}` : ''}
                        </div>
                      </div>
                      <Badge tone={emp.is_active ? 'good' : 'neutral'}>{emp.is_active ? 'Active' : 'Inactive'}</Badge>
                    </div>
                    <dl className={ui.facts}>
                      <dt>Department</dt><dd className={styles.cap}>{fmt(emp.team)}</dd>
                      <dt>Joined</dt><dd>{fmtDate(emp.joining_date)}</dd>
                      <dt>Salary</dt><dd>{fmtSalary(emp.monthly_salary)}</dd>
                    </dl>
                    <div className={styles.cardActions}>
                      <Link href={`/attendance/employees/${emp.id}`} className={`boe-btn boe-btn-ghost ${ui.btnSm}`} aria-label={`View ${emp.full_name}`}>View</Link>
                      {showEdit && (
                        <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setEditEmp(emp)} aria-label={`Edit ${emp.full_name}`}>Edit</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
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
    </AttendancePayrollLayout>
  )
}
