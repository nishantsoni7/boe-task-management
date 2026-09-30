'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useRefresh } from '@/contexts/RefreshContext'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Badge, Notice, StateBlock, ui, type Tone } from '@/components/attendancePayroll/ui'

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

const STATUS: Record<string, { tone: Tone; label: string }> = {
  present:    { tone: 'good',    label: 'Present' },
  checked_in: { tone: 'info',    label: 'Checked In' },
  absent:     { tone: 'bad',     label: 'Absent' },
  half_day:   { tone: 'warn',    label: 'Half Day' },
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as Tone, label: status }
  return <Badge tone={s.tone}>{s.label}</Badge>
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
  const [error,     setError]     = useState<string | null>(null)
  const PAGE_SIZE = 50

  const [employeeId, setEmployeeId] = useState('')
  const [fromDate,   setFromDate]   = useState('')
  const [toDate,     setToDate]     = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)

      const [{ data: me }, { data: emps }] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
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
  }, [refreshKey])

  const fetchPage = async (targetPage: number) => {
    setFetching(true)
    setError(null)
    const params = new URLSearchParams()
    if (employeeId) params.set('employee_id', employeeId)
    if (fromDate)   params.set('from', fromDate)
    if (toDate)     params.set('to', toDate)
    params.set('page', String(targetPage))

    try {
      const res  = await fetch(`/api/attendance/records?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) {
        setRecords(json.records)
        setTotal(json.total)
        setPage(targetPage)
      } else {
        setError(json.error ?? 'Could not load the records.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    }
    setFetching(false)
  }

  const handleSearch = () => fetchPage(1)

  const handleExportCSV = async () => {
    setExporting(true)
    setError(null)
    const params = new URLSearchParams()
    if (employeeId) params.set('employee_id', employeeId)
    if (fromDate)   params.set('from', fromDate)
    if (toDate)     params.set('to', toDate)
    params.set('format', 'csv')

    try {
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
      } else {
        setError('Could not export the records. Try again.')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    }
    setExporting(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const totalPages = total !== null ? Math.ceil(total / PAGE_SIZE) : 1

  if (loading) return <LoadingScreen />

  const retry = (
    <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void fetchPage(page)} disabled={fetching}>
      Try again
    </button>
  )

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Records"
      subtitle="Imported fingerprint attendance, day by day"
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>
        {/* ── Filters ── */}
        <form
          className={`${ui.surface} ${ui.surfaceBody}`}
          onSubmit={e => { e.preventDefault(); if (!fetching) void handleSearch() }}
        >
          <div className={ui.fieldGrid} style={{ alignItems: 'end', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr)) auto' }}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="rec-employee">Employee</label>
              <select
                id="rec-employee"
                className={ui.input}
                value={employeeId}
                onChange={e => setEmployeeId(e.target.value)}
              >
                <option value="">All Employees</option>
                {employees.map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name}{emp.employee_code ? ` (${emp.employee_code})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="rec-from">From date</label>
              <input id="rec-from" type="date" className={ui.input} value={fromDate} onChange={e => setFromDate(e.target.value)} />
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="rec-to">To date</label>
              <input id="rec-to" type="date" className={ui.input} value={toDate} onChange={e => setToDate(e.target.value)} />
            </div>

            <button type="submit" className={`boe-btn boe-btn-primary ${ui.btn}`} disabled={fetching}>
              {fetching ? 'Loading…' : 'Search'}
            </button>
          </div>
        </form>

        {error && <Notice kind="error" action={retry}>{error}</Notice>}

        {/* ── Results header: count + export ── */}
        {total !== null && (
          <div className={ui.toolbar} style={{ marginBottom: 0 }}>
            <span style={{ fontSize: 13, color: '#4A5261' }} aria-live="polite">
              <strong style={{ color: '#111318' }}>{total}</strong> record{total !== 1 ? 's' : ''} found
            </span>
            <div className={ui.toolbarEnd}>
              <button
                type="button"
                className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
                onClick={handleExportCSV}
                disabled={exporting || total === 0}
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {records.length > 0 ? (
          <div aria-busy={fetching} className={ui.stack}>
            <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }}>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Employee</th>
                      <th scope="col">Check in</th>
                      <th scope="col">Check out</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(rec => (
                      <tr key={rec.id}>
                        <td className={ui.nowrap}>{formatDate(rec.attendance_date)}</td>
                        <td>
                          <span className={ui.strong}>{rec.users?.full_name ?? '—'}</span>
                          {rec.users?.employee_code && (
                            <span className={ui.muted} style={{ fontSize: 12, marginLeft: 6 }}>{rec.users.employee_code}</span>
                          )}
                        </td>
                        <td className={ui.nowrap}>{formatTime(rec.check_in_at)}</td>
                        <td className={ui.nowrap}>{formatTime(rec.check_out_at)}</td>
                        <td><StatusBadge status={rec.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <ul className={ui.cards}>
              {records.map(rec => (
                <li key={rec.id} className={`${ui.surface} ${ui.card}`}>
                  <div className={ui.cardHead}>
                    <div>
                      <div className={ui.strong}>{rec.users?.full_name ?? '—'}</div>
                      <div className={ui.sub}>
                        {formatDate(rec.attendance_date)}
                        {rec.users?.employee_code ? ` · ${rec.users.employee_code}` : ''}
                      </div>
                    </div>
                    <StatusBadge status={rec.status} />
                  </div>
                  <div style={{ fontSize: 13, color: '#4A5261' }}>
                    In {formatTime(rec.check_in_at)} · Out {formatTime(rec.check_out_at)}
                  </div>
                </li>
              ))}
            </ul>

            <div className={ui.row} style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: '#6B7384' }}>Page {page} of {totalPages}</span>
              <div className={ui.row}>
                <button
                  type="button"
                  className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
                  onClick={() => fetchPage(page - 1)}
                  disabled={fetching || page <= 1}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
                  onClick={() => fetchPage(page + 1)}
                  disabled={fetching || page >= totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        ) : fetching ? (
          <StateBlock kind="loading">Loading records…</StateBlock>
        ) : total === 0 ? (
          <StateBlock kind="empty" title="No records match">
            Try a wider date range or a different employee.
          </StateBlock>
        ) : !error ? (
          <StateBlock kind="empty" title="No records shown yet">
            Choose an employee or dates if you like, then press Search.
          </StateBlock>
        ) : null}
      </div>
    </AttendancePayrollLayout>
  )
}
