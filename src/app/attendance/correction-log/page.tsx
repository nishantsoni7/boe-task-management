'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ObjectionQueue } from '@/components/objections/ObjectionQueue'
import { Badge, Notice, StateBlock, ui, type Tone } from '@/components/attendancePayroll/ui'

// ─── Types ────────────────────────────────────────────────────────────────────

type CorrectionRow = {
  id:               string
  attendance_date:  string
  employee_name:    string
  employee_code:    string | null
  change_type:      'New' | 'Modified'
  old_check_in_at:  string | null
  new_check_in_at:  string | null
  old_check_out_at: string | null
  new_check_out_at: string | null
  corrected_by:     string
  corrected_at:     string
  source_file_name: string | null
  payroll_status:   string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

const PAYROLL: Record<string, { tone: Tone; label: string }> = {
  locked:        { tone: 'warn',    label: 'Locked' },
  generated:     { tone: 'info',    label: 'Generated' },
  draft:         { tone: 'neutral', label: 'Draft' },
  not_generated: { tone: 'neutral', label: 'Not generated' },
}

function PayrollBadge({ status }: { status: string }) {
  const s = PAYROLL[status] ?? PAYROLL.not_generated
  return <Badge tone={s.tone}>{s.label}</Badge>
}

function ChangeTypeBadge({ type }: { type: 'New' | 'Modified' }) {
  return <Badge tone={type === 'New' ? 'good' : 'warn'}>{type}</Badge>
}

// ─── Month options ────────────────────────────────────────────────────────────

function monthOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [{ value: '', label: 'All months' }]
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    opts.push({ value, label })
  }
  return opts
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function CorrectionLogPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [loaded,   setLoaded]   = useState(false)
  const [rows,     setRows]     = useState<CorrectionRow[]>([])
  const [total,    setTotal]    = useState(0)
  const [page,     setPage]     = useState(1)
  const [month,    setMonth]    = useState('')
  const [token,    setToken]    = useState('')
  const [error,    setError]    = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const months   = useMemo(() => monthOptions(), [])

  const loadLog = async (tok: string, pg: number, mo: string) => {
    setFetching(true)
    setError('')
    const params = new URLSearchParams({ page: String(pg) })
    if (mo) params.set('month', mo)
    try {
      const res  = await fetch(`/api/attendance/correction-log?${params}`, {
        headers: { Authorization: `Bearer ${tok}` },
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) {
        setRows(json.results)
        setTotal(json.total)
        setLoaded(true)
      } else {
        setError(json.error ?? 'Failed to load correction log')
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    }
    setFetching(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      // Module access is decided once, by the route guard in
      // src/app/{attendance,payroll}/layout.tsx, through
      // src/lib/moduleAccess.ts. A second 'is this an admin?' here is what let
      // the launcher and the route disagree; admin-only ACTIONS on this page
      // are gated where they are rendered, and again in their API routes.
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      setToken(session.access_token)
      setLoading(false)
      await loadLog(session.access_token, 1, '')
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMonthChange = async (mo: string) => {
    setMonth(mo)
    setPage(1)
    await loadLog(token, 1, mo)
  }

  const handlePage = async (pg: number) => {
    setPage(pg)
    await loadLog(token, pg, month)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Correction log"
      subtitle="Attendance records created or changed by imports, and issues employees have reported"
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>

        {/* Employee-reported issues sit above the import audit trail: this is
            the screen an admin is already on when investigating a disputed
            day, and resolving one usually means making a correction. The
            correction itself is still a separate, deliberate action. */}
        <ObjectionQueue
          subject="attendance"
          token={token}
          title="Reported attendance issues"
          emptyLabel="No employee has reported an attendance issue."
        />

        {/* Filter bar */}
        <div className={ui.toolbar} style={{ marginBottom: 0 }}>
          <div className={ui.row}>
            <label className={ui.label} htmlFor="log-month">Month</label>
            <select
              id="log-month"
              className={ui.input}
              style={{ width: 'auto', minWidth: 170 }}
              value={month}
              onChange={e => handleMonthChange(e.target.value)}
            >
              {months.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <span style={{ fontSize: 13, color: '#4A5261' }} aria-live="polite">
            {fetching ? 'Loading…' : <><strong style={{ color: '#111318' }}>{total}</strong> record{total !== 1 ? 's' : ''}</>}
          </span>
        </div>

        {error && (
          <Notice
            kind="error"
            action={
              <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void loadLog(token, page, month)} disabled={fetching}>
                Try again
              </button>
            }
          >
            {error}
          </Notice>
        )}

        {/* Results */}
        {rows.length === 0 ? (
          fetching || !loaded
            ? (error ? null : <StateBlock kind="loading">Loading the correction log…</StateBlock>)
            : (
              <StateBlock kind="empty" title="No correction records found">
                {month ? 'Nothing was created or changed by an import in this month.' : 'No import has created or changed an attendance record yet.'}
              </StateBlock>
            )
        ) : (
          <div className={ui.stack} aria-busy={fetching}>
            <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }}>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th scope="col">Employee</th>
                      <th scope="col">Date</th>
                      <th scope="col">Change</th>
                      <th scope="col">Old in → out</th>
                      <th scope="col">New in → out</th>
                      <th scope="col">Source file</th>
                      <th scope="col">Corrected by</th>
                      <th scope="col">Corrected at</th>
                      <th scope="col">Payroll</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id}>
                        <td className={ui.nowrap}>
                          <div className={ui.strong}>{r.employee_name}</div>
                          {r.employee_code && <div className={ui.sub}>{r.employee_code}</div>}
                        </td>
                        <td className={ui.nowrap}>{fmtDate(r.attendance_date)}</td>
                        <td><ChangeTypeBadge type={r.change_type} /></td>
                        <td className={`${ui.nowrap} ${ui.muted}`}>
                          {r.change_type === 'New' ? '—' : <>{fmtTime(r.old_check_in_at)} → {fmtTime(r.old_check_out_at)}</>}
                        </td>
                        <td className={ui.nowrap}>{fmtTime(r.new_check_in_at)} → {fmtTime(r.new_check_out_at)}</td>
                        <td className={ui.muted} style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{r.source_file_name ?? '—'}</td>
                        <td className={ui.nowrap}>{r.corrected_by}</td>
                        <td className={`${ui.nowrap} ${ui.muted}`}>{fmtDateTime(r.corrected_at)}</td>
                        <td><PayrollBadge status={r.payroll_status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <ul className={ui.cards}>
              {rows.map(r => (
                <li key={r.id} className={`${ui.surface} ${ui.card}`}>
                  <div className={ui.cardHead}>
                    <div>
                      <div className={ui.strong}>{r.employee_name}</div>
                      <div className={ui.sub}>{fmtDate(r.attendance_date)}{r.employee_code ? ` · ${r.employee_code}` : ''}</div>
                    </div>
                    <ChangeTypeBadge type={r.change_type} />
                  </div>
                  <div style={{ fontSize: 13, color: '#111318' }}>
                    {r.change_type !== 'New' && (
                      <span className={ui.muted}>{fmtTime(r.old_check_in_at)} → {fmtTime(r.old_check_out_at)} then </span>
                    )}
                    {fmtTime(r.new_check_in_at)} → {fmtTime(r.new_check_out_at)}
                  </div>
                  <div className={ui.sub}>
                    By {r.corrected_by} · {fmtDateTime(r.corrected_at)}
                    {r.source_file_name ? ` · ${r.source_file_name}` : ''}
                  </div>
                  <div><PayrollBadge status={r.payroll_status} /></div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className={ui.row} style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
              onClick={() => handlePage(page - 1)}
              disabled={page <= 1 || fetching}
            >
              Previous
            </button>
            <span style={{ fontSize: 13, color: '#6B7384' }}>Page {page} of {totalPages}</span>
            <button
              type="button"
              className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
              onClick={() => handlePage(page + 1)}
              disabled={page >= totalPages || fetching}
            >
              Next
            </button>
          </div>
        )}

        <p style={{ margin: 0, fontSize: 12.5, color: '#6B7384', lineHeight: 1.6 }}>
          <strong style={{ color: '#4A5261' }}>Note:</strong>{' '}Only records modified during import are logged here.
          Unchanged records from re-uploads do not appear.
          &ldquo;New&rdquo; means the employee had no prior record for that date; &ldquo;Modified&rdquo; means an existing record was updated.
        </p>

      </div>
    </AttendancePayrollLayout>
  )
}
