'use client'

// Salary Processing Report — pick who is being paid, check the text, send it.
//
// Access: /payroll is admin-only (PayrollGuard → resolveManagementAccess), and
// /api/payroll/salary-report refuses a non-admin regardless. This page adds no
// access decision of its own.
//
// Every figure shown here comes from the stored payroll results the API
// returned. buildSalaryReport groups and formats them; it does not derive a
// salary. Changing the selection re-renders from data already in hand, which is
// why the checkboxes are instant and why the totals cannot drift from the
// payslips they summarise.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen, AlertBanner, EmptyState } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatRupees } from '@/lib/payroll/money'
import {
  buildSalaryReport,
  renderReportText,
  prepareWhatsApp,
  monthLabel,
  WHATSAPP_URL_TEXT_LIMIT,
  type ReportResultRow,
  type ReportAdjustmentRow,
  type ReportSettlementRow,
} from '@/lib/payroll/salaryReport'

type PeriodInfo = { id: string; month: number; year: number; status: string }

export default function SalaryProcessingReportPage() {
  const params   = useParams<{ periodId: string }>()
  const periodId = params.periodId

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [notice,  setNotice]  = useState('')

  const [period,      setPeriod]      = useState<PeriodInfo | null>(null)
  const [results,     setResults]     = useState<ReportResultRow[]>([])
  const [adjustments, setAdjustments] = useState<ReportAdjustmentRow[]>([])
  const [settlements, setSettlements] = useState<ReportSettlementRow[]>([])
  const [selected,    setSelected]    = useState<Set<string>>(new Set())
  const [showPreview, setShowPreview] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)

      const res  = await fetch(`/api/payroll/salary-report?period_id=${encodeURIComponent(periodId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (res.ok) {
        setPeriod(json.period)
        setResults(json.results ?? [])
        setAdjustments(json.adjustments ?? [])
        setSettlements(json.settlements ?? [])
        // Everyone starts selected: the common case is paying the whole month,
        // and an admin removing a few is less work than adding twenty.
        setSelected(new Set((json.results ?? []).map((r: ReportResultRow) => r.employee_id)))
      } else {
        setError(json.error ?? 'Could not load the salary report.')
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  const report = useMemo(
    () => period
      ? buildSalaryReport(period.month, period.year, results, adjustments, [...selected], settlements)
      : null,
    [period, results, adjustments, settlements, selected],
  )

  const reportText = useMemo(() => (report ? renderReportText(report) : ''), [report])
  const whatsapp   = useMemo(() => (report ? prepareWhatsApp(report) : null), [report])

  const allSelected = results.length > 0 && selected.size === results.length

  const toggleAll = () => {
    setNotice('')
    setSelected(allSelected ? new Set() : new Set(results.map(r => r.employee_id)))
  }

  const toggleOne = (id: string) => {
    setNotice('')
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopy = async () => {
    setError(''); setNotice('')
    try {
      // The same string the preview renders. An admin who checks the preview and
      // pastes something else has been shown a different document.
      await navigator.clipboard.writeText(reportText)
      setNotice('Report copied.')
    } catch {
      setError('Could not copy automatically. Open Preview and copy the text manually.')
      setShowPreview(true)
    }
  }

  const handleWhatsApp = () => {
    setError(''); setNotice('')
    if (!whatsapp) return
    if (!whatsapp.ok) {
      // No truncation, and no link. Preview and Copy stay available — the report
      // is not lost, only this one channel is unavailable for it.
      setError(whatsapp.message)
      return
    }
    window.open(whatsapp.url, '_blank', 'noopener,noreferrer')
  }

  if (loading || !profile) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Salary Processing Report"
      subtitle={period ? monthLabel(period.month, period.year) : undefined}
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
    >
      <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {error  && <AlertBanner variant="red">{error}</AlertBanner>}
        {notice && <AlertBanner variant="green">{notice}</AlertBanner>}

        {results.length === 0 ? (
          <EmptyState
            message="No payroll results for this period"
            hint="Generate payroll for the month before producing a processing report."
          />
        ) : (
          <>
            {/* Actions */}
            <section style={card}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <button onClick={toggleAll} style={secondaryButton}>
                  {allSelected ? 'Clear selection' : 'Select all'}
                </button>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.primary }}>
                  {selected.size} of {results.length} selected
                </span>
                <div style={{ flex: 1 }} />
                <button onClick={() => setShowPreview(p => !p)} style={secondaryButton}>
                  {showPreview ? 'Hide preview' : 'Preview'}
                </button>
                <button onClick={handleCopy} disabled={selected.size === 0} style={primaryButton(selected.size === 0)}>
                  Copy
                </button>
                <button onClick={handleWhatsApp} disabled={selected.size === 0} style={primaryButton(selected.size === 0)}>
                  Share on WhatsApp
                </button>
              </div>

              {whatsapp && selected.size > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: whatsapp.ok ? colors.tertiary : colors.red }}>
                  WhatsApp message length: {whatsapp.encodedLength.toLocaleString('en-IN')} / {WHATSAPP_URL_TEXT_LIMIT.toLocaleString('en-IN')} characters
                  {!whatsapp.ok && ' — too long to send as a link. Select fewer employees, or use Copy.'}
                </div>
              )}
            </section>

            {/* Selection list */}
            <section style={{ ...card, padding: 0, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 520 }}>
                <thead>
                  <tr style={{ background: colors.raised }}>
                    <th style={{ ...th, width: 40 }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all employees"
                      />
                    </th>
                    <th style={th}>Employee</th>
                    <th style={{ ...th, textAlign: 'right' }}>Salary</th>
                    <th style={{ ...th, textAlign: 'right' }}>Deductions</th>
                    <th style={{ ...th, textAlign: 'right' }}>Net payable</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => {
                    const isOn = selected.has(r.employee_id)
                    return (
                      <tr
                        key={r.employee_id}
                        style={{ borderTop: `1px solid ${colors.border}`, opacity: isOn ? 1 : 0.45 }}
                      >
                        <td style={td}>
                          <input
                            type="checkbox"
                            checked={isOn}
                            onChange={() => toggleOne(r.employee_id)}
                            aria-label={`Include ${r.employee_name}`}
                          />
                        </td>
                        <td style={td}>
                          <div style={{ fontWeight: 600, color: colors.primary }}>{r.employee_name}</div>
                          {r.employee_code && (
                            <div style={{ fontSize: 11.5, color: colors.tertiary }}>{r.employee_code}</div>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>{formatRupees(r.gross_salary ?? 0)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{formatRupees(r.total_deductions ?? 0)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 650 }}>{formatRupees(r.net_salary ?? 0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                {report && report.employees.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: `2px solid ${colors.borderMed}`, background: colors.raised }}>
                      <td style={td} />
                      <td style={{ ...td, fontWeight: 650 }}>
                        Total — {report.employees.length} selected
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 650 }}>
                        {formatRupees(report.totals.gross_salary)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 650 }}>
                        {formatRupees(report.totals.attendance_deduction)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 650 }}>
                        {formatRupees(report.totals.net_payable)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </section>

            {showPreview && (
              <section style={card}>
                <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8, color: colors.primary }}>
                  Preview — this is exactly what Copy puts on your clipboard
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    background: colors.raised,
                    borderRadius: 8,
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: colors.primary,
                  }}
                >
                  {reportText}
                </pre>
              </section>
            )}
          </>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}

const card: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: 10,
  padding: '14px 16px',
  background: colors.base,
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 11.5,
  fontWeight: 600,
  color: colors.tertiary,
  textTransform: 'uppercase',
  letterSpacing: 0.3,
}

const td: React.CSSProperties = { padding: '10px 12px', color: colors.secondary }

const secondaryButton: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: 'transparent',
  fontSize: 13,
  fontWeight: 600,
  color: colors.primary,
  cursor: 'pointer',
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: 'none',
    background: disabled ? colors.borderMed : colors.primary,
    fontSize: 13,
    fontWeight: 600,
    color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}
