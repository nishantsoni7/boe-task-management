'use client'

// Monthly Preview — an engine-computed PREVIEW of a month's payroll. Nothing on
// this page is saved: the figures are recalculated from attendance and salary
// settings every time Preview runs. Saved payroll lives under Payroll Runs.
//
// `?year=&month=` (the attendance Monthly Review links here with them) picks the
// month shown on load; anything that is not a real, non-future month falls back
// to the current month, exactly as before.

import { Suspense, useEffect, useState, useMemo } from 'react'
import { formatRupees } from '@/lib/payroll/money'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ObjectionQueue } from '@/components/objections/ObjectionQueue'
import { Badge, Notice, StateBlock, ui } from '@/components/attendancePayroll/ui'
import styles from './preview.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

type EmployeeResult = {
  employee_id:               string
  employee_name:             string
  employee_code:             string | null
  skipped:                   false
  monthly_salary:            number
  gross_salary:              number
  working_days_in_month:     number
  days_present:              number
  days_absent:               number
  half_day_count:            number
  paid_leave_available:      number
  paid_leave_used:           number
  leave_absorbed_deductions: boolean
  late_deduction_hours:      number
  missing_punch_hours:       number
  total_deductions:          number
  adjustment_total:          number
  net_salary:                number
}

type SkippedResult = {
  employee_id:   string
  employee_name: string
  employee_code: string | null
  skipped:       true
  skip_reason:   string
}

type AnyResult = EmployeeResult | SkippedResult

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function currentYearMonth() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

/** A month from the address, or the current month when it is absent, malformed or in the future. */
function monthFromParams(params: URLSearchParams): { year: number; month: number } {
  const now = currentYearMonth()
  const rawYear = params.get('year')
  const rawMonth = params.get('month')
  if (!rawYear || !rawMonth || !/^\d+$/.test(rawYear) || !/^\d+$/.test(rawMonth)) return now
  const year = Number(rawYear)
  const month = Number(rawMonth)
  if (month < 1 || month > 12 || year < 2000 || year > now.year) return now
  if (year === now.year && month > now.month) return now
  return { year, month }
}

function fmt(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function fmtExact(n: number): string {
  // Whole rupees: every payroll figure is stored whole since the whole-rupee
  // rule, and a payslip that printed paise would not match what was paid.
  return formatRupees(n)
}

const SKIP_LABELS: Record<string, string> = {
  period_locked:         'Period locked',
  employee_inactive:     'Not payroll-active',
  no_salary_configured:  'No salary set',
}

function deductionText(r: EmployeeResult): string {
  return r.total_deductions > 0 ? `−${fmtExact(r.total_deductions)}` : '—'
}

function adjustmentText(r: EmployeeResult): string {
  const a = r.adjustment_total ?? 0
  return a !== 0 ? `${a > 0 ? '+' : '−'}${fmtExact(Math.abs(a))}` : '—'
}

function adjustmentClass(r: EmployeeResult): string {
  const a = r.adjustment_total ?? 0
  return a > 0 ? styles.pos : a < 0 ? styles.neg : styles.dim
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// useSearchParams needs a Suspense boundary; same shape as /attendance/monthly-review.
export default function PayrollMonthlyReviewPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <KeyedPreview />
    </Suspense>
  )
}

/** Re-mounts on a new ?year=&month= so a link to another month starts from that month. */
function KeyedPreview() {
  const params = useSearchParams()
  const initial = monthFromParams(params)
  return <PayrollMonthlyPreview key={`${initial.year}-${initial.month}`} initial={initial} />
}

function PayrollMonthlyPreview({ initial }: { initial: { year: number; month: number } }) {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [fetching,  setFetching]  = useState(false)
  const [results,   setResults]   = useState<AnyResult[] | null>(null)
  const [token,     setToken]     = useState('')
  const [error,     setError]     = useState('')
  // Set when the month is still in progress: the preview then stops at this
  // date and days after it are not charged (src/lib/payroll/periodCompletion.ts).
  const [calculatedThrough, setCalculatedThrough] = useState<string | null>(null)
  const [showSkip,  setShowSkip]  = useState(false)

  // The month the table below is actually showing, which is not the month in
  // the two selectors: those change the moment an admin picks a different one,
  // and the historical issues must stay with the figures they were raised
  // against until Preview is pressed again.
  const [shown, setShown] = useState<{ year: number; month: number } | null>(null)

  const def = currentYearMonth()
  const [year,  setYear]  = useState(initial.year)
  const [month, setMonth] = useState(initial.month)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

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
      setProfile(prof as UserProfile)
      setLoading(false)

      // Auto-load the preview for the month on load (the current month, or the
      // one named in the address) once the token is available.
      const { year: y, month: m } = initial
      setFetching(true)
      try {
        const res  = await fetch(`/api/payroll/monthly-review?year=${y}&month=${m}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (res.ok) { setResults(json.results); setShown({ year: y, month: m }); setCalculatedThrough(json.calculated_through ?? null) }
        else setError(json.error ?? 'Failed to load preview')
      } catch {
        setError('Failed to load preview')
      } finally {
        setFetching(false)
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLoad = async () => {
    setFetching(true)
    setError('')
    try {
      const res  = await fetch(`/api/payroll/monthly-review?year=${year}&month=${month}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (res.ok) {
        setResults(json.results)
        setShown({ year, month })
        setCalculatedThrough(json.calculated_through ?? null)
      } else {
        setError(json.error ?? 'Failed to load preview')
        setResults(null)
        setShown(null)
      }
    } catch {
      setError('Failed to load preview')
      setResults(null)
      setShown(null)
    } finally {
      setFetching(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const yearOptions: number[] = []
  for (let y = def.year; y >= def.year - 2; y--) yearOptions.push(y)
  if (!yearOptions.includes(initial.year)) yearOptions.push(initial.year)
  if (!yearOptions.includes(year)) yearOptions.push(year)
  yearOptions.sort((a, b) => b - a)

  const active   = results ? results.filter((r): r is EmployeeResult => !r.skipped) : null
  const skipped  = results ? results.filter((r): r is SkippedResult  =>  r.skipped) : null

  const kpi = active ? {
    totalEmployees:   active.length,
    totalGross:       active.reduce((s, r) => s + r.gross_salary,      0),
    totalDeductions:  active.reduce((s, r) => s + r.total_deductions,  0),
    totalAdjustments: active.reduce((s, r) => s + (r.adjustment_total ?? 0), 0),
    totalNet:         active.reduce((s, r) => s + r.net_salary,        0),
    totalAbsent:      active.reduce((s, r) => s + r.days_absent,       0),
    leaveAbsorbed:    active.filter(r => r.leave_absorbed_deductions).length,
  } : null

  const sorted = active ? [...active].sort((a, b) => b.net_salary - a.net_salary) : null

  const zeroAttendanceCount = active
    ? active.filter(r => r.days_present === 0 && r.working_days_in_month > 0).length
    : 0

  const context = shown ?? { year, month }
  const detailHref = (id: string) => `/payroll/monthly-review/${id}?year=${year}&month=${month}`

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Monthly Preview"
      subtitle={`${MONTH_NAMES[context.month - 1]} ${context.year} — calculated now from attendance, not saved.`}
      onSignOut={handleSignOut}
    >
      <div className={ui.stack}>

        <Notice kind="info">
          <strong>Preview only.</strong> These figures are calculated live and have not been saved.
          Saved payroll is under <Link href="/payroll" className={ui.link}>Payroll Runs</Link>.
        </Notice>

        {/* Month selector */}
        <div className={ui.toolbar} style={{ marginBottom: 0 }}>
          <div className={ui.row} role="group" aria-label="Month to preview">
            <label className={ui.srOnly} htmlFor="preview-month">Month</label>
            <select
              id="preview-month" className={ui.input} style={{ width: 'auto', minWidth: 130 }}
              value={month} onChange={e => setMonth(parseInt(e.target.value))}
            >
              {MONTH_NAMES.map((name, i) => (
                <option key={i + 1} value={i + 1}>{name}</option>
              ))}
            </select>
            <label className={ui.srOnly} htmlFor="preview-year">Year</label>
            <select
              id="preview-year" className={ui.input} style={{ width: 'auto', minWidth: 90 }}
              value={year} onChange={e => setYear(parseInt(e.target.value))}
            >
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={handleLoad}
            disabled={fetching || !token}
            className={`boe-btn boe-btn-primary ${ui.btn}`}
          >
            {fetching ? 'Computing…' : 'Preview'}
          </button>
        </div>

        {/* A month still in progress: say what the figures cover. */}
        {calculatedThrough && shown && (
          <Notice kind="warning">
            This month is still in progress. The preview covers days up to {calculatedThrough} only; days after it
            have not happened and are not counted or charged. Payroll for the month can be generated and locked
            once it has ended.
          </Notice>
        )}

        {error && (
          <Notice
            kind="error"
            action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={handleLoad} disabled={fetching}>Try again</button>}
          >
            {error}
          </Notice>
        )}

        {/* Zero-attendance warning */}
        {zeroAttendanceCount > 0 && (
          <Notice kind="warning">
            <strong>{zeroAttendanceCount} employee{zeroAttendanceCount !== 1 ? 's' : ''}</strong> have no attendance records for this month.
            Check that fingerprint import is complete before generating payroll.
          </Notice>
        )}

        {fetching && results === null && (
          <StateBlock kind="loading" title="Computing preview…">This can take a few seconds.</StateBlock>
        )}

        {sorted !== null && kpi && (
          <>
            <p className={styles.totals}>
              <strong>{kpi.totalEmployees}</strong> employee{kpi.totalEmployees !== 1 ? 's' : ''}
              {' · '}gross <strong>{fmt(kpi.totalGross)}</strong>
              {' · '}deductions <strong className={kpi.totalDeductions > 0 ? styles.neg : undefined}>{fmt(kpi.totalDeductions)}</strong>
              {' · '}adjustments <strong className={kpi.totalAdjustments > 0 ? styles.pos : kpi.totalAdjustments < 0 ? styles.neg : undefined}>
                {(kpi.totalAdjustments >= 0 ? '+' : '−') + fmt(Math.abs(kpi.totalAdjustments))}
              </strong>
              {' · '}net <strong>{fmt(kpi.totalNet)}</strong>
              {' · '}{kpi.totalAbsent} absent day{kpi.totalAbsent !== 1 ? 's' : ''}
              {' · '}{kpi.leaveAbsorbed} with leave absorbed
            </p>

            {sorted.length === 0 ? (
              <StateBlock kind="empty" title="No payroll-active employees found." />
            ) : (
              <>
                <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }}>
                  <div className={ui.surfaceHead}>
                    <div>
                      <h2 className={ui.surfaceTitle}>Preview — {MONTH_NAMES[context.month - 1]} {context.year}</h2>
                      <p className={ui.surfaceSub}>Highest net salary first. Not saved.</p>
                    </div>
                  </div>
                  <div className={ui.tableWrap}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th className={ui.center} style={{ textAlign: 'center' }}>Work days</th>
                          <th className={ui.center} style={{ textAlign: 'center' }}>Present</th>
                          <th className={ui.center} style={{ textAlign: 'center' }}>Absent</th>
                          <th className={ui.center} style={{ textAlign: 'center' }}>Half days</th>
                          <th className={ui.center} style={{ textAlign: 'center' }}>PL used</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Gross</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Deductions</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Adjustments</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Net salary</th>
                          <th><span className={ui.srOnly}>Detail</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map(r => (
                          <tr key={r.employee_id}>
                            <td className={ui.nowrap}>
                              <div className={ui.strong}>{r.employee_name}</div>
                              <div className={ui.sub}>
                                {r.employee_code && <>{r.employee_code} · </>}
                                {fmt(r.monthly_salary)}/mo
                                {r.leave_absorbed_deductions && <> {' '}<Badge tone="info">PL absorbed</Badge></>}
                              </div>
                            </td>
                            <td className={`${ui.center} ${ui.num}`}>{r.working_days_in_month}</td>
                            <td className={`${ui.center} ${ui.num} ${styles.pos}`}>{r.days_present}</td>
                            <td className={`${ui.center} ${ui.num} ${r.days_absent > 0 ? styles.negBold : styles.dim}`}>{r.days_absent}</td>
                            <td className={`${ui.center} ${ui.num} ${r.half_day_count > 0 ? styles.warnc : styles.dim}`}>{r.half_day_count}</td>
                            <td className={`${ui.center} ${ui.num} ${r.paid_leave_used > 0 ? styles.pl : styles.dim}`}>
                              {r.paid_leave_used > 0 ? `${r.paid_leave_used}d` : '—'}
                            </td>
                            <td className={ui.num}>{fmtExact(r.gross_salary)}</td>
                            <td className={`${ui.num} ${r.total_deductions > 0 ? styles.negBold : styles.dim}`}>{deductionText(r)}</td>
                            <td className={`${ui.num} ${adjustmentClass(r)}`}>{adjustmentText(r)}</td>
                            <td className={`${ui.num} ${ui.strong}`}>{fmtExact(r.net_salary)}</td>
                            <td className={ui.nowrap}>
                              <Link href={detailHref(r.employee_id)} className={ui.link} aria-label={`Detail for ${r.employee_name}`}>
                                Detail →
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Phone: one card per employee. */}
                <ul className={ui.cards} aria-label={`Payroll preview, ${MONTH_NAMES[context.month - 1]} ${context.year}`}>
                  {sorted.map(r => (
                    <li key={r.employee_id} className={`${ui.surface} ${ui.card}`}>
                      <div className={ui.cardHead}>
                        <div>
                          <div className={ui.strong}>{r.employee_name}</div>
                          <div className={ui.sub}>
                            {r.employee_code && <>{r.employee_code} · </>}{fmt(r.monthly_salary)}/mo
                          </div>
                        </div>
                        <div className={styles.cardNet}>
                          <div className={ui.strong} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtExact(r.net_salary)}</div>
                          <div className={ui.sub}>Net salary</div>
                        </div>
                      </div>
                      {r.leave_absorbed_deductions && <div><Badge tone="info">PL absorbed</Badge></div>}
                      <dl className={styles.cardFacts}>
                        <div><dt>Work days</dt><dd>{r.working_days_in_month}</dd></div>
                        <div><dt>Present</dt><dd className={styles.pos}>{r.days_present}</dd></div>
                        <div><dt>Absent</dt><dd className={r.days_absent > 0 ? styles.negBold : styles.dim}>{r.days_absent}</dd></div>
                        <div><dt>Half days</dt><dd className={r.half_day_count > 0 ? styles.warnc : styles.dim}>{r.half_day_count}</dd></div>
                        <div><dt>PL used</dt><dd className={r.paid_leave_used > 0 ? styles.pl : styles.dim}>{r.paid_leave_used > 0 ? `${r.paid_leave_used}d` : '—'}</dd></div>
                        <div><dt>Gross</dt><dd>{fmtExact(r.gross_salary)}</dd></div>
                        <div><dt>Deductions</dt><dd className={r.total_deductions > 0 ? styles.negBold : styles.dim}>{deductionText(r)}</dd></div>
                        <div><dt>Adjustments</dt><dd className={adjustmentClass(r)}>{adjustmentText(r)}</dd></div>
                      </dl>
                      <Link href={detailHref(r.employee_id)} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>
                        Detail →
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {skipped && skipped.length > 0 && (
              <div className={ui.surface}>
                <div className={ui.surfaceHead}>
                  <h2 className={ui.surfaceTitle}>{skipped.length} skipped employee{skipped.length !== 1 ? 's' : ''}</h2>
                  <button
                    type="button"
                    className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
                    aria-expanded={showSkip}
                    onClick={() => setShowSkip(v => !v)}
                  >
                    {showSkip ? 'Hide' : 'Show'} {skipped.length} skipped
                  </button>
                </div>
                {showSkip && (
                  <ul className={styles.skipList}>
                    {skipped.map(r => (
                      <li key={r.employee_id}>
                        <span>
                          {r.employee_name}
                          {r.employee_code && <span className={ui.muted} style={{ fontSize: 12, marginLeft: 6 }}>{r.employee_code}</span>}
                        </span>
                        <span className={ui.muted}>{SKIP_LABELS[r.skip_reason] ?? r.skip_reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <p className={styles.footnote}>
              <strong>Preview</strong>{' '}— computed live from attendance records using V1 engine rules.
              Per-day rate = salary ÷ 26. Paid leave: 0.5d if present &gt;10 days, 1d if &gt;15 days.
              Adjustments are included in net salary. Click Detail to manage adjustments per employee.
            </p>

            {/* What employees reported about the payroll run for THIS month.
                An audit record, so it is read where the month is read.

                The same panel the period results page uses, given the month on
                screen instead of a period id — the route resolves the run
                through payroll_periods' UNIQUE (payroll_month, payroll_year),
                so a month can only ever answer with its own issues. A month
                that was never generated has no run and therefore no issues,
                which the panel states rather than hides. */}
            {shown && (
              <ObjectionQueue
                subject="payroll"
                token={token}
                period={{ year: shown.year, month: shown.month }}
                title={`Reported payroll issues — ${MONTH_NAMES[shown.month - 1]} ${shown.year}`}
                emptyLabel="No payroll issues were reported for this period."
              />
            )}
          </>
        )}

        {results === null && !fetching && !error && (
          <StateBlock kind="empty" title="No preview yet">
            Select a month and click Preview to compute the payroll summary.
          </StateBlock>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
