'use client'

import { useEffect, useState, useMemo } from 'react'
import { formatRupees } from '@/lib/payroll/money'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ObjectionQueue } from '@/components/objections/ObjectionQueue'
import { useObjections } from '@/components/objections/useObjections'
import { employeeStatusLabel, statusTone as objectionTone } from '@/lib/objections'
import { runLockFlow } from '@/lib/attendance/lockWarning'
import { Badge, Notice, StateBlock, ui, type Tone } from '@/components/attendancePayroll/ui'
import styles from './results.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

type PeriodMeta = {
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  locked_at: string | null
}

type ResultRow = {
  id: string
  employee_id: string
  employee_name: string
  employee_code: string | null
  working_days_in_month: number | null
  gross_salary: number | null
  total_deductions: number | null
  pending_adjustment_total: number | null
  net_salary: number | null
  status: 'draft' | 'locked'
  employee_reviewed_at: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function fmt(n: number | null): string {
  if (n == null) return '—'
  // Whole rupees: every payroll figure is stored whole since the whole-rupee
  // rule, and a payslip that printed paise would not match what was paid.
  return formatRupees(n)
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  }) + ' ' + new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
}

function ReviewBadge({ reviewedAt }: { reviewedAt: string | null }) {
  return reviewedAt
    ? <Badge tone="good">Reviewed</Badge>
    : <Badge tone="neutral">Pending</Badge>
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollResultsPage() {
  const params   = useParams()
  const periodId = params.periodId as string

  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  const [period,      setPeriod]      = useState<PeriodMeta | null>(null)
  const [results,     setResults]     = useState<ResultRow[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [token,       setToken]       = useState('')
  const [locking,     setLocking]     = useState(false)
  const [lockError,   setLockError]   = useState<string | null>(null)

  // What employees have reported about this period, so a complaint travels
  // with the row instead of living only in the queue above the table.
  const objections = useObjections(token)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const loadData = async (accessToken: string) => {
    const res  = await fetch(`/api/payroll/results?period_id=${periodId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? 'Failed to load results'); return }
    setPeriod(json.period ?? null)
    setResults(json.results ?? [])
  }

  // Same request as the first load, run again on demand.
  const retryLoad = async () => {
    setError(null)
    await loadData(token)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)

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
      setProfile(prof)

      await loadData(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  const handleLock = async () => {
    if (locking) return
    const label = period
      ? `${MONTHS[period.payroll_month - 1]} ${period.payroll_year}`
      : 'this period'
    // No longer claims the lock is permanent: an admin can reopen a locked
    // period from the Payroll dashboard, with a recorded reason.
    setLocking(true)
    setLockError(null)
    try {
      // Open attendance-review items need a stated acknowledgement the server
      // checks and records (src/lib/payroll/lockPeriod.ts).
      const outcome = await runLockFlow(token, periodId,
        `Lock payroll for ${label}?\n\nEmployees who have not yet reviewed will no longer be able to do so. An admin can reopen the period later with a stated reason.`)
      if (outcome.status === 'error') setLockError(outcome.error ?? 'Lock failed')
      else if (outcome.status === 'locked') await loadData(token)
    } finally {
      setLocking(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const isLocked    = period?.status === 'locked'
  // Locking a period is admin work even for someone Control Center granted the
  // Payroll module to — /api/payroll/lock enforces the same line, so showing
  // the button to anyone else would only ever produce a 403.
  const canLock     = period?.status === 'generated' && profile?.role === 'admin'
  const periodLabel = period
    ? `${MONTHS[period.payroll_month - 1]} ${period.payroll_year}`
    : ''

  const reviewedCount = results.filter(r => r.employee_reviewed_at).length
  const totalCount    = results.length

  const totals = results.length > 0 ? {
    gross:       results.reduce((s, r) => s + (r.gross_salary             ?? 0), 0),
    deductions:  results.reduce((s, r) => s + (r.total_deductions         ?? 0), 0),
    adjustments: results.reduce((s, r) => s + (r.pending_adjustment_total ?? 0), 0),
    net:         results.reduce((s, r) => s + (r.net_salary               ?? 0), 0),
  } : null

  const statusTone: Tone = isLocked ? 'info' : period?.status === 'generated' ? 'good' : 'neutral'
  const statusText = isLocked ? 'Locked' : period?.status === 'generated' ? 'Generated' : 'Draft'

  // One review badge plus the objection tag, shared by the table and the cards.
  const reviewCell = (r: ResultRow) => {
    const objection = objections.byResult.get(r.id)
    return (
      <div className={ui.row} style={{ gap: 6 }}>
        <ReviewBadge reviewedAt={r.employee_reviewed_at} />
        {objection && (
          <span
            title={objection.reason}
            className={styles.objectionTag}
            style={{
              background: objectionTone(objection.status).bg,
              color: objectionTone(objection.status).fg,
            }}
          >
            {employeeStatusLabel(objection.status)}
          </span>
        )}
      </div>
    )
  }

  return (
    <AttendancePayrollLayout
      profile={profile}
      title={periodLabel ? `${periodLabel} Payroll` : 'Payroll Results'}
      subtitle="Saved payroll results — review each payslip, then lock the month."
      onSignOut={handleSignOut}
      actions={
        // The processing report reads the same stored results this page shows,
        // so it is reachable from here rather than from a separate nav entry.
        <Link
          href={`/payroll/results/${periodId}/salary-report`}
          className="boe-btn boe-btn-ghost"
          style={{ whiteSpace: 'nowrap' }}
        >
          Salary Processing Report
        </Link>
      }
    >
      <div className={ui.stack}>
        {/* True detail page: one way back to its list. */}
        <div>
          <Link href="/payroll" className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>← Payroll Runs</Link>
        </div>

        {error && (
          <Notice
            kind="error"
            action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void retryLoad()}>Try again</button>}
          >
            {error}
          </Notice>
        )}

        {lockError && <Notice kind="error">{lockError}</Notice>}

        {/* The state of this saved run. */}
        {period && (
          <div className={`${ui.surface} ${ui.surfaceBody} ${styles.runState}`}>
            <div className={styles.runStateText}>
              <div className={ui.row} style={{ gap: 8 }}>
                <Badge tone={statusTone}>{statusText}</Badge>
                {isLocked ? (
                  <span className={styles.runStateLine}>
                    <strong>Payroll locked</strong>
                    {period.locked_at ? ` · ${fmtDateTime(period.locked_at)}` : ''}
                    {' — Regeneration and employee review are disabled.'}
                  </span>
                ) : canLock ? (
                  <span className={styles.runStateLine}>
                    Lock this payroll period to finalise it. Generation and employee review will be disabled.
                  </span>
                ) : (
                  <span className={styles.runStateLine}>
                    {period.status === 'generated' ? 'Only an admin can lock this period.' : 'This period has not been generated.'}
                  </span>
                )}
              </div>
              {canLock && totalCount > 0 && (
                <div className={styles.reviewLine} style={{ color: reviewedCount === totalCount ? '#047857' : '#B45309' }}>
                  {reviewedCount} of {totalCount} employee{totalCount !== 1 ? 's' : ''} have reviewed their payslip.
                </div>
              )}
            </div>
            {canLock && (
              <button
                type="button"
                onClick={handleLock}
                disabled={locking}
                className={`boe-btn boe-btn-primary ${ui.btn}`}
                style={{ whiteSpace: 'nowrap' }}
              >
                {locking ? 'Locking…' : 'Lock Payroll'}
              </button>
            )}
          </div>
        )}

        {results.length === 0 ? (
          error ? null : (
            <StateBlock kind="empty" title="No payroll results yet">
              No payroll results generated for this period yet.
            </StateBlock>
          )
        ) : (
          <>
            <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }}>
              <div className={ui.surfaceHead}>
                <div>
                  <h2 className={ui.surfaceTitle}>Employee results</h2>
                  <p className={ui.surfaceSub}>Saved figures for {periodLabel || 'this period'}.</p>
                </div>
              </div>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Working days</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Gross salary</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Deductions</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Adjustments</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Net salary</th>
                      <th>Employee review</th>
                      <th><span className={ui.srOnly}>Details</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(r => (
                      <tr key={r.id}>
                        <td>
                          <div className={ui.strong}>{r.employee_name}</div>
                          {r.employee_code && <div className={ui.sub}>{r.employee_code}</div>}
                        </td>
                        <td className={ui.num}>{r.working_days_in_month ?? '—'}</td>
                        <td className={ui.num}>{fmt(r.gross_salary)}</td>
                        <td className={`${ui.num} ${r.total_deductions ? styles.neg : ''}`}>{fmt(r.total_deductions)}</td>
                        <td className={ui.num}>{fmt(r.pending_adjustment_total)}</td>
                        <td className={`${ui.num} ${ui.strong}`}>{fmt(r.net_salary)}</td>
                        <td>{reviewCell(r)}</td>
                        <td className={ui.nowrap}>
                          <Link href={`/payroll/results/${periodId}/${r.employee_id}`} className={ui.link}>
                            View Details
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {totals && (
                    <tfoot>
                      <tr className={styles.totalRow}>
                        <td>Total ({totalCount})</td>
                        <td />
                        <td className={ui.num}>{fmt(totals.gross)}</td>
                        <td className={`${ui.num} ${totals.deductions > 0 ? styles.neg : ''}`}>{fmt(totals.deductions)}</td>
                        <td className={ui.num}>{fmt(totals.adjustments)}</td>
                        <td className={ui.num}>{fmt(totals.net)}</td>
                        <td />
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>

            {/* Phone: one card per employee, and the totals as a line. */}
            <ul className={ui.cards} aria-label="Employee results">
              {results.map(r => (
                <li key={r.id} className={`${ui.surface} ${ui.card}`}>
                  <div className={ui.cardHead}>
                    <div>
                      <div className={ui.strong}>{r.employee_name}</div>
                      {r.employee_code && <div className={ui.sub}>{r.employee_code}</div>}
                    </div>
                    <div className={styles.cardNet}>
                      <div className={ui.strong}>{fmt(r.net_salary)}</div>
                      <div className={ui.sub}>Net salary</div>
                    </div>
                  </div>
                  <dl className={styles.cardFacts}>
                    <div><dt>Working days</dt><dd>{r.working_days_in_month ?? '—'}</dd></div>
                    <div><dt>Gross</dt><dd>{fmt(r.gross_salary)}</dd></div>
                    <div><dt>Deductions</dt><dd className={r.total_deductions ? styles.neg : ''}>{fmt(r.total_deductions)}</dd></div>
                    <div><dt>Adjustments</dt><dd>{fmt(r.pending_adjustment_total)}</dd></div>
                  </dl>
                  {reviewCell(r)}
                  <Link href={`/payroll/results/${periodId}/${r.employee_id}`} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>
                    View Details
                  </Link>
                </li>
              ))}
            </ul>
            {totals && (
              <p className={`${styles.totalsLine} ${styles.phoneOnly}`}>
                <strong>Total ({totalCount})</strong>
                {' · '}gross {fmt(totals.gross)}
                {' · '}deductions {fmt(totals.deductions)}
                {' · '}adjustments {fmt(totals.adjustments)}
                {' · '}net <strong>{fmt(totals.net)}</strong>
              </p>
            )}
          </>
        )}

        {/* What employees have reported about THIS payroll run, on the screen
            where an admin reviews that run's payslips. Resolving one records the
            outcome; any actual correction is still made through the existing
            adjustment and correction tools.

            Scoped to `periodId` — the run this page is — so a period generated
            in August no longer carries July's objections underneath August's
            salaries. Earlier runs keep their issues; they are read on Payroll
            Monthly Preview for the month they belong to. */}
        <ObjectionQueue
          subject="payroll"
          token={token}
          period={{ periodId }}
          title="Reported payroll issues"
          emptyLabel="No payroll issues were reported for this period."
        />
      </div>
    </AttendancePayrollLayout>
  )
}
