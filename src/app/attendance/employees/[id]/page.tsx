'use client'

import { useEffect, useState, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Badge, Notice, StateBlock, ui, type Tone } from '@/components/attendancePayroll/ui'
import Link from 'next/link'
import styles from './detail.module.css'

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

const STATUS_BADGES: Record<string, { tone: Tone; label: string }> = {
  present:    { tone: 'good',    label: 'Present' },
  checked_in: { tone: 'info',    label: 'Checked In' },
  absent:     { tone: 'bad',     label: 'Absent' },
  half_day:   { tone: 'warn',    label: 'Half Day' },
  late:       { tone: 'warn',    label: 'Late' },
}

function statusBadge(status: string) {
  const s = STATUS_BADGES[status] ?? { tone: 'neutral' as Tone, label: status }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

const PAGE_SIZE = 50

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeeDetailPage() {
  const params = useParams()
  const id     = params?.id as string

  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [employee,  setEmployee]  = useState<EmployeeDetail | null>(null)
  const [records,   setRecords]   = useState<AttendanceRecord[]>([])
  const [recordsFailed, setRecordsFailed] = useState(false)
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

      // The caller's own profile comes straight from the table; the TARGET
      // employee's does not. This card shows monthly_salary and payroll_notes,
      // which `authenticated` no longer holds a SELECT grant on — so those
      // fields arrive through an admin-verified service-role route instead.
      // attendance_records likewise comes from an API, to bypass RLS.
      const [{ data: me }, empRes] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        fetch(`/api/admin/employee-profile?employee_id=${id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ])

      setProfile(me as UserProfile)

      if (!empRes.ok) { setNotFound(true); setLoading(false); return }
      const empJson = await empRes.json()
      if (!empJson.employee) { setNotFound(true); setLoading(false); return }
      setEmployee(empJson.employee as EmployeeDetail)

      // Use the service-role API so RLS does not block reading other employees' records.
      const recsRes = await fetch(`/api/attendance/employee-records?employee_id=${id}`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (recsRes.ok) {
        const json = await recsRes.json()
        setRecords(json.records as AttendanceRecord[])
      } else {
        setRecordsFailed(true)
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

  // ── Totals ──
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

  const backLink = (
    <Link href="/attendance/employees" className={styles.back}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
      </svg>
      Employee directory
    </Link>
  )

  if (notFound) {
    return (
      <AttendancePayrollLayout profile={profile} title="Employee not found" subtitle="This record does not exist or you cannot open it." onSignOut={handleSignOut}>
        <div className={ui.stack}>
          {backLink}
          <StateBlock kind="empty" title="Employee not found">
            The link may be out of date, or the employee record may have been removed.
          </StateBlock>
        </div>
      </AttendancePayrollLayout>
    )
  }

  const emp = employee!
  const hasFilter = Boolean(fromDate || toDate)

  return (
    <AttendancePayrollLayout
      profile={profile}
      title={emp.full_name}
      subtitle={`${fmt(emp.position)}${emp.team ? ` · ${emp.team}` : ''} — employee record and attendance history.`}
      onSignOut={handleSignOut}
    >
      <div className={`${ui.stack} ${ui.wide}`}>

        {backLink}

        {/* ── Details, grouped ── */}
        <div className={styles.sections}>
          <section className={ui.surface} aria-labelledby="sec-profile">
            <div className={ui.surfaceHead}><h2 id="sec-profile" className={ui.surfaceTitle}>Profile</h2></div>
            <div className={ui.surfaceBody}>
              <dl className={ui.facts}>
                <dt>Name</dt><dd>{emp.full_name}</dd>
                <dt>Status</dt><dd><Badge tone={emp.is_active ? 'good' : 'neutral'}>{emp.is_active ? 'Active' : 'Inactive'}</Badge></dd>
                <dt>Team</dt><dd className={styles.cap}>{fmt(emp.team)}</dd>
                <dt>Position</dt><dd>{fmt(emp.position)}</dd>
                <dt>Role</dt><dd className={styles.cap}>{fmt(emp.role)}</dd>
              </dl>
            </div>
          </section>

          <section className={ui.surface} aria-labelledby="sec-employment">
            <div className={ui.surfaceHead}><h2 id="sec-employment" className={ui.surfaceTitle}>Employment</h2></div>
            <div className={ui.surfaceBody}>
              <dl className={ui.facts}>
                <dt>HR employee code</dt><dd className={styles.mono}>{fmt(emp.employee_code)}</dd>
                <dt>Joining date</dt>
                <dd>
                  {emp.joining_date ? new Date(emp.joining_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                </dd>
                <dt>Employment type</dt><dd className={styles.cap}>{fmt(emp.employment_type)}</dd>
              </dl>
            </div>
          </section>

          <section className={ui.surface} aria-labelledby="sec-payroll">
            <div className={ui.surfaceHead}><h2 id="sec-payroll" className={ui.surfaceTitle}>Payroll settings</h2></div>
            <div className={ui.surfaceBody}>
              <dl className={ui.facts}>
                <dt>Monthly salary</dt>
                <dd>{emp.monthly_salary != null ? '₹' + Number(emp.monthly_salary).toLocaleString('en-IN') : '—'}</dd>
                <dt>Payroll active</dt>
                <dd><Badge tone={emp.payroll_active ? 'good' : 'neutral'}>{emp.payroll_active ? 'Yes' : 'No'}</Badge></dd>
                {emp.payroll_notes && (<><dt>Payroll notes</dt><dd className={styles.notes}>{emp.payroll_notes}</dd></>)}
              </dl>
            </div>
          </section>

          <section className={ui.surface} aria-labelledby="sec-fp">
            <div className={ui.surfaceHead}><h2 id="sec-fp" className={ui.surfaceTitle}>Fingerprint mapping</h2></div>
            <div className={ui.surfaceBody}>
              <dl className={ui.facts}>
                <dt>Fingerprint code</dt><dd className={styles.mono}>{fmt(emp.fingerprint_employee_code)}</dd>
              </dl>
              <p className={ui.hint} style={{ margin: '10px 0 0' }}>
                The machine code that links this person to fingerprint exports. Change it from the directory&rsquo;s Edit action.
              </p>
            </div>
          </section>
        </div>

        {/* ── Attendance history ── */}
        <section className={ui.stack} aria-labelledby="sec-records">
          <h2 id="sec-records" className={ui.surfaceTitle}>Attendance history</h2>

          {recordsFailed && (
            <Notice kind="error" action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => window.location.reload()}>Try again</button>}>
              Attendance records could not be loaded.
            </Notice>
          )}

          <div className={`${ui.surface} ${ui.surfaceBody}`}>
            <div className={styles.dates}>
              <div className={`${ui.field} ${styles.dateField}`}>
                <label className={ui.label} htmlFor="from-date">From date</label>
                <input id="from-date" type="date" className={ui.input} value={fromDate} onChange={e => setFromDate(e.target.value)} />
              </div>
              <div className={`${ui.field} ${styles.dateField}`}>
                <label className={ui.label} htmlFor="to-date">To date</label>
                <input id="to-date" type="date" className={ui.input} value={toDate} onChange={e => setToDate(e.target.value)} />
              </div>
              {hasFilter && (
                <button type="button" className={`boe-btn boe-btn-ghost ${ui.btn}`} onClick={() => { setFromDate(''); setToDate('') }}>
                  Clear
                </button>
              )}
            </div>
          </div>

          <p className={styles.total} aria-live="polite">
            {summary.total} record{summary.total !== 1 ? 's' : ''} · {summary.present} present · {summary.late} late
            {summary.earliest && (
              <> · {formatDate(summary.earliest)}{summary.latest && summary.latest !== summary.earliest ? ` to ${formatDate(summary.latest)}` : ''}</>
            )}
          </p>

          {filtered.length > 0 ? (
            <div className={ui.surface}>
              <div className={`${ui.tableWrap} ${ui.desktopOnly}`}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Check in</th>
                      <th scope="col">Check out</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRecords.map(rec => (
                      <tr key={rec.id}>
                        <td className={ui.nowrap}>{formatDate(rec.attendance_date)}</td>
                        <td className={ui.nowrap}>{formatTime(rec.check_in_at)}</td>
                        <td className={ui.nowrap}>{formatTime(rec.check_out_at)}</td>
                        <td>{statusBadge(rec.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className={ui.cards} style={{ padding: 10 }}>
                {pageRecords.map(rec => (
                  <li key={rec.id} className={`${ui.surface} ${ui.card}`}>
                    <div className={ui.cardHead}>
                      <div className={ui.strong}>{formatDate(rec.attendance_date)}</div>
                      {statusBadge(rec.status)}
                    </div>
                    <div className={ui.sub}>In {formatTime(rec.check_in_at)} · Out {formatTime(rec.check_out_at)}</div>
                  </li>
                ))}
              </ul>

              <div className={styles.pager}>
                <span>Page {page} of {totalPages} · {filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
                <div className={styles.pagerBtns}>
                  <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setPage(p => p - 1)} disabled={page <= 1}>Previous</button>
                  <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}>Next</button>
                </div>
              </div>
            </div>
          ) : (
            <StateBlock kind="empty" title="No attendance records found">
              {hasFilter ? 'Nothing falls inside the selected date range.' : 'No attendance has been recorded for this employee yet.'}
            </StateBlock>
          )}
        </section>

      </div>
    </AttendancePayrollLayout>
  )
}
