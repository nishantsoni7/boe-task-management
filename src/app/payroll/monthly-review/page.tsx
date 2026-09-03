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
import { ObjectionQueue } from '@/components/objections/ObjectionQueue'

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
  // the two selectors: those change the moment an admin picks a different one,
  // and the historical issues must stay with the figures they were raised
  // against until Preview is pressed again.
  const [shown, setShown] = useState<{ year: number; month: number } | null>(null)

  const def = currentYearMonth()
  const [year,  setYear]  = useState(def.year)
  const [month, setMonth] = useState(def.month)

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

      // Auto-load current month preview once token is available
      const { year: y, month: m } = currentYearMonth()
      const res  = await fetch(`/api/payroll/monthly-review?year=${y}&month=${m}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (res.ok) { setResults(json.results); setShown({ year: y, month: m }) }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLoad = async () => {
    setFetching(true)
    setError('')
    const res  = await fetch(`/api/payroll/monthly-review?year=${year}&month=${month}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json()
    if (res.ok) {
      setResults(json.results)
      setShown({ year, month })
    } else {
      setError(json.error ?? 'Failed to load preview')
      setResults(null)
      setShown(null)
    }
    setFetching(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
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

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Payroll Monthly Preview"
      subtitle="Engine-computed payroll summary for the selected month"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 1100, padding: '24px 0' }}>

        <Link
          href="/payroll"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.tertiary, textDecoration: 'none', marginBottom: 24 }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Payroll
        </Link>

        {/* Month selector */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '20px 24px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            Select Month
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
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
              {fetching ? 'Computing…' : 'Preview'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            fontSize: 13, color: '#DC2626',
          }}>
            {error}
          </div>
        )}

        {/* KPI cards */}
        {kpi && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Employees',        value: String(kpi.totalEmployees),           color: colors.primary },
              { label: 'Total Gross',      value: fmt(kpi.totalGross),                  color: '#3B82F6' },
              { label: 'Total Deductions', value: fmt(kpi.totalDeductions),             color: kpi.totalDeductions > 0 ? '#DC2626' : colors.tertiary },
              { label: 'Total Adjustments',value: (kpi.totalAdjustments >= 0 ? '+' : '−') + fmt(Math.abs(kpi.totalAdjustments)), color: kpi.totalAdjustments > 0 ? '#059669' : kpi.totalAdjustments < 0 ? '#DC2626' : colors.tertiary },
              { label: 'Total Net',        value: fmt(kpi.totalNet),                    color: '#059669' },
              { label: 'Absent Days',      value: String(kpi.totalAbsent),              color: kpi.totalAbsent > 0 ? '#D97706' : colors.tertiary },
              { label: 'Leave Absorbed',   value: String(kpi.leaveAbsorbed),            color: kpi.leaveAbsorbed > 0 ? '#7C3AED' : colors.tertiary },
            ].map(k => (
              <div key={k.label} style={{
                background: colors.base, border: `1px solid ${colors.border}`,
                borderRadius: 10, padding: '16px 18px',
              }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: k.color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                  {k.value}
                </div>
                <div style={{ fontSize: 11, color: colors.tertiary, marginTop: 6 }}>{k.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Zero-attendance warning */}
        {zeroAttendanceCount > 0 && (
          <div style={{
            background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.35)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            fontSize: 13, color: '#92400E', display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>⚠</span>
            <span>
              <strong>{zeroAttendanceCount} employee{zeroAttendanceCount !== 1 ? 's' : ''}</strong> have no attendance records for this month.
              Check that fingerprint import is complete before generating payroll.
            </span>
          </div>
        )}

        {/* Main table */}
        {sorted !== null && (
          <>
            <div style={{ fontSize: 13, color: colors.secondary, marginBottom: 12 }}>
              {sorted.length} employee{sorted.length !== 1 ? 's' : ''} — {MONTH_NAMES[month - 1]} {year} preview
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
              Adjustments are included in net salary. Click Detail to manage adjustments per employee.
            </div>

            {/* What employees reported about the payroll run for THIS month.
                An audit record, so it is read where the month is read.

                The same panel the period results page uses, given the month on
                screen instead of a period id — the route resolves the run
                through payroll_periods' UNIQUE (payroll_month, payroll_year),
                so a month can only ever answer with its own issues. A month
                that was never generated has no run and therefore no issues,
                which the panel states rather than hides. */}
            {shown && (
              <div style={{ marginTop: 24 }}>
                <ObjectionQueue
                  subject="payroll"
                  token={token}
                  period={{ year: shown.year, month: shown.month }}
                  title={`Reported payroll issues — ${MONTH_NAMES[shown.month - 1]} ${shown.year}`}
                  emptyLabel="No payroll issues were reported for this period."
                />
              </div>
            )}
          </>
        )}

        {results === null && !fetching && !error && (
          <div style={{
            background: colors.base, border: `1px solid ${colors.border}`,
            borderRadius: 10, padding: '48px 24px', textAlign: 'center',
            color: colors.tertiary, fontSize: 13,
          }}>
            Select a month and click Preview to compute the payroll summary.
          </div>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
