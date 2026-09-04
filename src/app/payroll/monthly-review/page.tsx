'use client'

import { useEffect, useState, useMemo } from 'react'
import { formatRupees } from '@/lib/payroll/money'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { CreatePeriodModal, type EligibleMonth } from '@/app/payroll/CreatePeriodModal'
import { periodLabel } from '@/lib/payroll/months'

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

/** The month's payroll state, as far as this page needs to know it. */
type MonthState =
  | { kind: 'no_attendance' }
  | { kind: 'no_period' }
  | { kind: 'draft'; periodId: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function currentYearMonth() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollMonthlyReviewPage() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [fetching,  setFetching]  = useState(false)
  const [results,   setResults]   = useState<AnyResult[] | null>(null)
  const [token,     setToken]     = useState('')
  const [error,     setError]     = useState('')
  const [showSkip,  setShowSkip]  = useState(false)

  // The month the table below is actually showing, which is not the month in
  // the two selectors: those change the moment an admin picks a different one.
  const [shown, setShown] = useState<{ year: number; month: number } | null>(null)
  // What the SHOWN month's payroll state is — drives the primary action and
  // the readiness strip. Null while it is still being decided.
  const [monthState, setMonthState] = useState<MonthState | null>(null)

  const def = currentYearMonth()
  const [year,  setYear]  = useState(def.year)
  const [month, setMonth] = useState(def.month)

  // Create Payroll Period — the one Payroll Runs action that applies to a
  // month with no period at all, so it lives here rather than on the results
  // page (which only ever exists once a period does).
  const [createOpen,   setCreateOpen]   = useState(false)
  const [creating,     setCreating]     = useState(false)
  const [createError,  setCreateError]  = useState<string | null>(null)
  const [createInfo,   setCreateInfo]   = useState<string | null>(null)
  const [eligibleMonths, setEligibleMonths] = useState<EligibleMonth[]>([])
  const [currentMonthUnavailable, setCurrentMonthUnavailable] = useState<EligibleMonth | null>(null)
  const [loadingEligibility, setLoadingEligibility] = useState(false)

  // Generate Payroll — for a month that already has a Draft period.
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // Whether the selected month already has a generated (or locked) payroll
  // run — and if so, which period id. `payroll_periods` is readable by any
  // authenticated user (see 20260611_create_payroll_periods.sql), so this is
  // a direct client read rather than a new API route: nothing here needs the
  // service role, and generated/locked is exactly the distinction the RESULTS
  // page already enforces on its own admin-only data.
  const periodFor = async (y: number, m: number): Promise<{ id: string; status: string } | null> => {
    const { data } = await supabase
      .from('payroll_periods')
      .select('id, status')
      .eq('payroll_year', y)
      .eq('payroll_month', m)
      .maybeSingle()
    return data ?? null
  }

  const loadPreview = async (accessToken: string, y: number, m: number) => {
    const res  = await fetch(`/api/payroll/monthly-review?year=${y}&month=${m}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const json = await res.json()
    if (res.ok) {
      setResults(json.attendance_uploaded ? json.results : null)
      setShown({ year: y, month: m })
      setError('')
      return json.attendance_uploaded as boolean
    }
    setError(json.error ?? 'Failed to load preview')
    setResults(null)
    setShown(null)
    return null
  }

  // Decided BEFORE fetching the preview, not after: checking first and only
  // then fetching (or redirecting) is what keeps a generated month from
  // flashing the live-preview table on its way to /payroll/results/{periodId}
  // — the admin should not have to notice two different payroll screens exist.
  //
  // A Draft period stays on THIS page (Generate Payroll is its primary
  // action here); only generated/locked redirect to the stored experience.
  const openMonth = async (accessToken: string, y: number, m: number) => {
    const period = await periodFor(y, m)
    if (period && (period.status === 'generated' || period.status === 'locked')) {
      router.push(`/payroll/results/${period.id}?from=view-payroll`)
      return
    }

    if (period && period.status === 'draft') {
      setMonthState({ kind: 'draft', periodId: period.id })
      await loadPreview(accessToken, y, m)
      return
    }

    const attendanceUploaded = await loadPreview(accessToken, y, m)
    setMonthState(attendanceUploaded ? { kind: 'no_period' } : { kind: 'no_attendance' })
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
      setProfile(prof as UserProfile)

      // Open the current month exactly as a month picked from the selector
      // would be. The full-page loading screen stays up for the whole
      // decision, specifically so a generated month never flashes this
      // page's own placeholder or table on its way to the results page.
      const { year: y, month: m } = currentYearMonth()
      const period = await periodFor(y, m)
      if (period && (period.status === 'generated' || period.status === 'locked')) {
        router.push(`/payroll/results/${period.id}?from=view-payroll`)
        return
      }
      setLoading(false)
      if (period && period.status === 'draft') {
        setMonthState({ kind: 'draft', periodId: period.id })
        await loadPreview(session.access_token, y, m)
      } else {
        const attendanceUploaded = await loadPreview(session.access_token, y, m)
        setMonthState(attendanceUploaded ? { kind: 'no_period' } : { kind: 'no_attendance' })
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLoad = async () => {
    setFetching(true)
    setError('')
    await openMonth(token, year, month)
    setFetching(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const openCreateModal = async () => {
    setCreateOpen(true)
    setCreateError(null)
    setCreateInfo(null)
    setLoadingEligibility(true)
    try {
      const res  = await fetch('/api/payroll/periods/eligible-months', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      if (res.ok) {
        setEligibleMonths(json.eligible ?? [])
        setCurrentMonthUnavailable(json.current_month_unavailable ?? null)
      } else {
        setCreateError(json.error ?? 'Failed to load available months')
      }
    } finally {
      setLoadingEligibility(false)
    }
  }

  const handleCreatePeriod = async (m: number, y: number) => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    setCreateInfo(null)
    try {
      const res = await fetch('/api/payroll/periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ month: m, year: y }),
      })
      const json = await res.json()
      if (!res.ok) { setCreateError(json.error ?? 'Failed to create period'); return }

      if (res.status === 200) {
        // Reused an existing Draft/Generated period rather than creating a
        // new one — not an error, just not a fresh row.
        setCreateInfo(`A payroll period for ${periodLabel(m, y)} already exists.`)
        return
      }

      setCreateOpen(false)
      // Land on the month just created, which is now Draft → Generate Payroll.
      setYear(y)
      setMonth(m)
      setFetching(true)
      await openMonth(token, y, m)
      setFetching(false)
    } finally {
      setCreating(false)
    }
  }

  const handleGeneratePayroll = async () => {
    if (generating || monthState?.kind !== 'draft') return
    setGenerating(true)
    setGenerateError(null)
    try {
      const res = await fetch('/api/payroll/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ payroll_period_id: monthState.periodId }),
      })
      const json = await res.json()
      if (!res.ok) { setGenerateError(json.error ?? 'Generation failed'); return }
      // A successful generation moves the period to 'generated', which
      // redirects to the stored results experience — reuse the same decision
      // logic rather than re-deriving it here.
      await openMonth(token, year, month)
    } finally {
      setGenerating(false)
    }
  }

  if (loading) return <LoadingScreen />

  const yearOptions: number[] = []
  for (let y = def.year; y >= def.year - 2; y--) yearOptions.push(y)

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 12px', boxSizing: 'border-box',
  }

  const active   = results ? results.filter((r): r is EmployeeResult => !r.skipped) : null
  const skipped  = results ? results.filter((r): r is SkippedResult  =>  r.skipped) : null
  const sorted   = active ? [...active].sort((a, b) => b.net_salary - a.net_salary) : null

  const shownLabel = shown ? periodLabel(shown.month, shown.year) : ''

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="View Payroll"
      subtitle="Select a month to see payroll for all employees"
      onSignOut={handleSignOut}
      actions={
        // Rare period administration — delete, participation — stays on its
        // own page rather than competing for space with the primary
        // Create/Generate/Lock actions above. A lateral link, not a "back":
        // View Payroll is not a sub-page of it.
        <Link
          href="/payroll"
          style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.13)',
            fontSize: 13, fontWeight: 600, color: '#111318', textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Manage Payroll Runs
        </Link>
      }
    >
      <div style={{ maxWidth: 1100, padding: '24px 0' }}>

        {/* Month selector */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '16px 20px', marginBottom: 14,
          display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Month</label>
            <select value={month} onChange={e => setMonth(parseInt(e.target.value))} style={{ ...inputStyle, width: 160 }}>
              {MONTH_NAMES.map((name, i) => (
                <option key={i + 1} value={i + 1}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Year</label>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ ...inputStyle, width: 110 }}>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button
            onClick={handleLoad}
            disabled={fetching || !token}
            style={{
              padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 7,
              border: 'none', cursor: fetching ? 'not-allowed' : 'pointer',
              background: '#1A2035', color: '#E8A030', opacity: fetching ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            {fetching ? 'Loading…' : 'View'}
          </button>

          {/* Relevant primary action — reflects the SHOWN month's state, not
              the selectors, so it never offers to act on a month that has not
              actually loaded yet. */}
          {monthState?.kind === 'no_period' && (
            <button
              onClick={openCreateModal}
              style={{
                marginLeft: 'auto', padding: '9px 18px', fontSize: 13, fontWeight: 600, borderRadius: 7,
                border: 'none', cursor: 'pointer', background: '#DC1F2E', color: '#fff',
              }}
            >
              Create Payroll Period
            </button>
          )}
          {monthState?.kind === 'draft' && (
            <button
              onClick={handleGeneratePayroll}
              disabled={generating}
              style={{
                marginLeft: 'auto', padding: '9px 18px', fontSize: 13, fontWeight: 600, borderRadius: 7,
                border: 'none', cursor: generating ? 'not-allowed' : 'pointer',
                background: '#DC1F2E', color: '#fff', opacity: generating ? 0.6 : 1,
              }}
            >
              {generating ? 'Generating…' : 'Generate Payroll'}
            </button>
          )}
        </div>

        {/* Compact readiness strip — only the states this pre-generation page
            can actually know. Review count, issues and lock state only exist
            once payroll is generated, at which point this month redirects to
            the results page, which carries its own strip. */}
        {monthState && shown && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
            padding: '9px 16px', marginBottom: 20, borderRadius: 8,
            background: colors.raised, border: `1px solid ${colors.border}`,
            fontSize: 12.5,
          }}>
            <span style={{ color: colors.tertiary }}>{shownLabel}</span>
            <span style={{ color: colors.border }}>·</span>
            <span>
              <span style={{ color: colors.tertiary }}>Attendance </span>
              <strong style={{ color: monthState.kind === 'no_attendance' ? '#DC2626' : '#059669' }}>
                {monthState.kind === 'no_attendance' ? '✕ Not uploaded' : '✓ Uploaded'}
              </strong>
            </span>
            <span style={{ color: colors.border }}>·</span>
            <span>
              <span style={{ color: colors.tertiary }}>Payroll </span>
              <strong style={{ color: monthState.kind === 'draft' ? '#B45309' : colors.tertiary }}>
                {monthState.kind === 'draft' ? 'Draft — not yet generated'
                  : monthState.kind === 'no_attendance' ? 'Cannot create yet'
                  : 'Not created'}
              </strong>
            </span>
          </div>
        )}

        {/* No attendance — explain why, offer the way out. No preview table:
            showing computed rows for a month with no attendance would read
            as real figures for people who were not actually marked absent,
            they simply have not been uploaded yet. */}
        {monthState?.kind === 'no_attendance' && (
          <div style={{
            background: 'rgba(85,133,232,0.07)', border: '1px solid rgba(85,133,232,0.25)',
            borderRadius: 10, padding: '20px 22px', marginBottom: 16,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1F3A8A', marginBottom: 4 }}>
              {shownLabel} payroll is not available yet.
            </div>
            <div style={{ fontSize: 13, color: '#3D4455', marginBottom: 12 }}>
              Attendance for {shownLabel} has not been uploaded.
            </div>
            <Link
              href="/attendance/upload"
              style={{
                display: 'inline-block', padding: '8px 16px', borderRadius: 7,
                background: '#1A2035', color: '#E8A030', fontSize: 13, fontWeight: 600, textDecoration: 'none',
              }}
            >
              Upload Attendance
            </Link>
          </div>
        )}

        {generateError && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#DC2626',
          }}>
            {generateError}
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            fontSize: 13, color: '#DC2626',
          }}>
            {error}
          </div>
        )}

        {/* Main table — an exception scanner, not a dashboard: no KPI cards
            above it, exceptions (absences, zero attendance) carry their own
            colour in the rows themselves. */}
        {sorted !== null && (
          <>
            <div style={{ fontSize: 13, color: colors.secondary, marginBottom: 12 }}>
              {sorted.length} employee{sorted.length !== 1 ? 's' : ''} — {shownLabel} preview
              {skipped && skipped.length > 0 && (
                <button
                  onClick={() => setShowSkip(v => !v)}
                  style={{
                    marginLeft: 12, fontSize: 12, color: colors.tertiary,
                    background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline',
                  }}
                >
                  {showSkip ? 'Hide' : 'Show'} {skipped.length} skipped
                </button>
              )}
            </div>

            <div style={{
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: 10, overflow: 'hidden', marginBottom: 16,
            }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.border}`, background: colors.raised }}>
                      {[
                        { label: 'Employee',      align: 'left'   },
                        { label: 'Work Days',     align: 'center' },
                        { label: 'Present',       align: 'center' },
                        { label: 'Absent',        align: 'center' },
                        { label: 'Half Days',     align: 'center' },
                        { label: 'PL Used',       align: 'center' },
                        { label: 'Gross',         align: 'right'  },
                        { label: 'Deductions',    align: 'right'  },
                        { label: 'Adjustments',   align: 'right'  },
                        { label: 'Net Salary',    align: 'right'  },
                        { label: '',              align: 'left'   },
                      ].map(col => (
                        <th key={col.label} style={{
                          padding: '10px 14px',
                          textAlign: col.align as React.CSSProperties['textAlign'],
                          fontSize: 11, fontWeight: 600, color: colors.tertiary,
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                        }}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => (
                      <tr
                        key={r.employee_id}
                        style={{ borderBottom: i < sorted.length - 1 ? `1px solid ${colors.border}` : 'none' }}
                      >
                        <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                          <div style={{ fontSize: 13.5, fontWeight: 500, color: colors.primary }}>{r.employee_name}</div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                            {r.employee_code && (
                              <span style={{ fontSize: 11, color: colors.tertiary }}>{r.employee_code}</span>
                            )}
                            <span style={{ fontSize: 11, color: colors.tertiary }}>
                              {fmt(r.monthly_salary)}/mo
                            </span>
                            {r.leave_absorbed_deductions && (
                              <span style={{
                                fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 20,
                                background: 'rgba(124,58,237,0.1)', color: '#7C3AED',
                              }}>
                                PL Absorbed
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'center', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
                          {r.working_days_in_month}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'center', color: '#059669', fontVariantNumeric: 'tabular-nums' }}>
                          {r.days_present}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
                          color: r.days_absent > 0 ? '#DC2626' : colors.tertiary,
                          fontWeight: r.days_absent > 0 ? 600 : 400,
                        }}>
                          {r.days_absent}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
                          color: r.half_day_count > 0 ? '#D97706' : colors.tertiary,
                        }}>
                          {r.half_day_count}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
                          color: r.paid_leave_used > 0 ? '#7C3AED' : colors.tertiary,
                        }}>
                          {r.paid_leave_used > 0 ? `${r.paid_leave_used}d` : '—'}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
                          {fmtExact(r.gross_salary)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                          color: r.total_deductions > 0 ? '#DC2626' : colors.tertiary,
                          fontWeight: r.total_deductions > 0 ? 600 : 400,
                        }}>
                          {r.total_deductions > 0 ? `−${fmtExact(r.total_deductions)}` : '—'}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                          color: (r.adjustment_total ?? 0) > 0 ? '#059669' : (r.adjustment_total ?? 0) < 0 ? '#DC2626' : colors.tertiary,
                          fontWeight: (r.adjustment_total ?? 0) !== 0 ? 600 : 400,
                        }}>
                          {(r.adjustment_total ?? 0) !== 0
                            ? `${(r.adjustment_total ?? 0) > 0 ? '+' : '−'}${fmtExact(Math.abs(r.adjustment_total ?? 0))}`
                            : '—'}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtExact(r.net_salary)}
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <Link
                            href={`/payroll/monthly-review/${r.employee_id}?year=${year}&month=${month}`}
                            style={{
                              fontSize: 12, fontWeight: 600, color: '#3B82F6',
                              textDecoration: 'none', whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                          >
                            Detail →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {sorted.length === 0 && (
                <div style={{ padding: '48px 24px', textAlign: 'center', color: colors.tertiary, fontSize: 13 }}>
                  No payroll-active employees found.
                </div>
              )}
            </div>

            {/* Skipped employees */}
            {showSkip && skipped && skipped.length > 0 && (
              <div style={{
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: 10, overflow: 'hidden', marginBottom: 16,
              }}>
                <div style={{
                  padding: '10px 16px', fontSize: 11, fontWeight: 600,
                  color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em',
                  borderBottom: `1px solid ${colors.border}`, background: colors.raised,
                }}>
                  Skipped Employees
                </div>
                {skipped.map((r, i) => (
                  <div key={r.employee_id} style={{
                    padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    borderBottom: i < skipped.length - 1 ? `1px solid ${colors.border}` : 'none',
                    fontSize: 13,
                  }}>
                    <span style={{ color: colors.primary }}>
                      {r.employee_name}
                      {r.employee_code && <span style={{ fontSize: 11, color: colors.tertiary, marginLeft: 6 }}>{r.employee_code}</span>}
                    </span>
                    <span style={{ color: colors.tertiary, fontSize: 12 }}>
                      {SKIP_LABELS[r.skip_reason] ?? r.skip_reason}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 12, color: colors.tertiary, lineHeight: 1.7 }}>
              <strong style={{ color: colors.secondary }}>Preview</strong> — computed live from attendance records using V1 engine rules.
              Per-day rate = salary ÷ 26. Paid leave: 0.5d if present &gt;10 days, 1d if &gt;15 days.
              Adjustments are included in net salary. Click Detail to manage adjustments per employee, or Generate Payroll above once it looks right.
            </div>
          </>
        )}

        {results === null && !fetching && !error && monthState?.kind !== 'no_attendance' && (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            Select a month and click View to see the payroll summary.
          </div>
        )}

      </div>

      {createOpen && (
        <CreatePeriodModal
          saving={creating}
          error={createError}
          info={createInfo}
          eligibleMonths={eligibleMonths}
          currentMonthUnavailable={currentMonthUnavailable}
          loadingEligibility={loadingEligibility}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreatePeriod}
        />
      )}
    </AttendancePayrollLayout>
  )
}
