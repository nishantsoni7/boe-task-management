'use client'

// Payroll Monthly Preview — one employee, one month, computed live.
//
// This is the PREVIEW of a payroll that has not been generated yet: nothing here
// is stored, and every figure comes back from /api/payroll/monthly-review/detail
// exactly as src/lib/payroll/engine.ts settled it. Nothing in this file computes
// money — the only arithmetic below groups the deduction lines the API already
// returned so a reason can state how many days it covers.
//
// The presentation is the approved Payroll Result Detail one, imported rather
// than re-drawn: identity card, .payroll-detail-workspace grid, summary rail,
// ledger table. See PayrollDetailView.tsx for why those primitives live in one
// place — two payroll screens that look different are two screens that drift.

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { Avatar, LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { periodLabel } from '@/lib/payroll/months'
import {
  fmt,
  fmtHours,
  fmtPunches,
  fmtSignedAmount,
  signTone,
  DayDateCell,
  DEDUCTION_LABELS,
  MetaField,
  Pill,
  SectionHeader,
  SettlementRow,
  SettlementRule,
  SummaryDivider,
  SummaryGroup,
  SummaryLine,
  PUNCH_LINE,
  ROW_DIVIDER,
  TD,
  TFOOT_LABEL,
  TFOOT_VALUE,
  TH,
  THEAD_ROW,
} from '@/app/payroll/results/[periodId]/[employeeId]/PayrollDetailView'

// ─── Types ────────────────────────────────────────────────────────────────────

type DeductionLine = {
  line_date:       string
  deduction_type:  string
  hours_deducted:  number
  amount_deducted: number
  check_in_at:     string | null
  check_out_at:    string | null
}

type AdjustmentRow = {
  id:              string
  adjustment_type: 'addition' | 'deduction'
  amount:          number
  description:     string
}

type Summary = {
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
  short_hours_deduction:     number
  missing_punch_hours:       number
  total_deductions:          number
  adjustment_total:          number
  net_salary:                number
}

type EmployeeInfo = {
  id:             string
  full_name:      string
  employee_code:  string | null
  monthly_salary: number
}

type DetailData = {
  employee:        EmployeeInfo
  skipped:         false
  summary:         Summary
  deduction_lines: DeductionLine[]
  adjustments:     AdjustmentRow[]
} | {
  employee:    EmployeeInfo
  skipped:     true
  skip_reason: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Day counts are written out in full — "0 days", not "0d".
 *
 * The rail is read by people who are not looking at it every day, and a bare
 * "0" beside "Paid Leave Used" is ambiguous in a way the word is not.
 */
function fmtDays(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`
}

/**
 * The deduction lines, folded by reason.
 *
 * Presentation only: it sums the amounts the engine already stamped on each
 * line and counts the dates they fall on. It never derives a rate, a rule or a
 * total of its own — Total Deductions on screen is always summary.total_deductions.
 */
type DeductionGroup = {
  type:   string
  days:   number
  hours:  number
  amount: number
}

function groupDeductions(lines: DeductionLine[]): DeductionGroup[] {
  const by = new Map<string, { dates: Set<string>; hours: number; amount: number }>()
  for (const l of lines) {
    let g = by.get(l.deduction_type)
    if (!g) {
      g = { dates: new Set<string>(), hours: 0, amount: 0 }
      by.set(l.deduction_type, g)
    }
    g.dates.add(l.line_date)
    g.hours  += l.hours_deducted
    g.amount += l.amount_deducted
  }
  return Array.from(by.entries())
    .map(([type, g]) => ({ type, days: g.dates.size, hours: g.hours, amount: g.amount }))
    .sort((a, b) => b.amount - a.amount || b.days - a.days)
}

function deductionLabel(type: string): string {
  return DEDUCTION_LABELS[type] ?? type
}

const SKIP_LABELS: Record<string, string> = {
  period_locked:         'Period is locked',
  employee_inactive:     'Employee is not payroll-active',
  no_salary_configured:  'No monthly salary configured',
}

const CARD: React.CSSProperties = {
  background: '#fff', borderRadius: 12,
  border: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden',
  marginBottom: 16,
}

const PREVIEW_TONE = { bg: 'rgba(232,160,48,0.15)', color: '#B45309' }

/**
 * One explanatory row under the calculation: what the reason was, how many days
 * and hours it covered, and what it cost.
 *
 * A row that cost nothing stays quiet — muted label, no red, and its own note —
 * so the reasons that actually took money are the ones the eye lands on.
 */
function ReasonRow({
  label, meta, amount, note, last,
}: {
  label:  string
  meta:   string
  amount: number
  note?:  string
  last?:  boolean
}) {
  const charged = amount > 0.005
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 14, padding: '9px 0',
      borderBottom: last ? 'none' : ROW_DIVIDER,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: charged ? '#3D4455' : '#6B7280' }}>
          {label}
        </div>
        <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
          {meta}
        </div>
        {note && (
          <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 2 }}>{note}</div>
        )}
      </div>
      <div style={{
        fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        color: charged ? '#DC2626' : '#8C94A6',
      }}>
        {charged ? `−${fmt(amount)}` : fmt(0)}
      </div>
    </div>
  )
}

// ─── Manual adjustments (admin only) ──────────────────────────────────────────
//
// Behaviour is unchanged: the same POST and DELETE, the same validation, the
// same admin gate at the call site and again in /api/payroll/adjustments. Only
// the surface it sits on is the module's.

function AdjustmentsPanel({
  adjustments,
  onAdd,
  onDelete,
  saving,
}: {
  adjustments: AdjustmentRow[]
  onAdd: (type: 'addition' | 'deduction', amount: number, note: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  saving: boolean
}) {
  const [adjType,   setAdjType]   = useState<'addition' | 'deduction'>('addition')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote,   setAdjNote]   = useState('')
  const [formErr,   setFormErr]   = useState('')
  const [deleting,  setDeleting]  = useState<string | null>(null)

  const handleSubmit = async () => {
    setFormErr('')
    const amt = parseFloat(adjAmount)
    if (!adjAmount || isNaN(amt) || amt <= 0) {
      setFormErr('Enter a valid positive amount.')
      return
    }
    if (!adjNote.trim()) {
      setFormErr('Note is required.')
      return
    }
    await onAdd(adjType, amt, adjNote.trim())
    setAdjAmount('')
    setAdjNote('')
  }

  const handleDelete = async (id: string) => {
    setDeleting(id)
    await onDelete(id)
    setDeleting(null)
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8,
    background: '#fff', color: '#111318', outline: 'none',
    padding: '8px 11px', boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 10.5, fontWeight: 700, color: '#8C94A6',
    textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5,
  }

  const netAdj = adjustments.reduce((s, a) => s + (a.adjustment_type === 'addition' ? a.amount : -a.amount), 0)

  return (
    <div style={CARD}>
      <SectionHeader title="Manual Adjustments" />

      {/* Add form */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label htmlFor="adj-type" style={labelStyle}>Type</label>
            <select
              id="adj-type"
              value={adjType}
              onChange={e => setAdjType(e.target.value as 'addition' | 'deduction')}
              style={{ ...inputStyle, width: 132 }}
            >
              <option value="addition">Addition</option>
              <option value="deduction">Deduction</option>
            </select>
          </div>
          <div>
            <label htmlFor="adj-amount" style={labelStyle}>Amount (₹)</label>
            <input
              id="adj-amount"
              type="number"
              min="1"
              step="0.01"
              placeholder="0.00"
              value={adjAmount}
              onChange={e => setAdjAmount(e.target.value)}
              style={{ ...inputStyle, width: 124 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="adj-note" style={labelStyle}>Note (required)</label>
            <input
              id="adj-note"
              type="text"
              placeholder="Reason for adjustment…"
              value={adjNote}
              onChange={e => setAdjNote(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: 13, flexShrink: 0 }}
          >
            {saving ? 'Saving…' : adjType === 'addition' ? 'Add' : 'Deduct'}
          </button>
        </div>
        {formErr && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: '#DC2626' }}>{formErr}</div>
        )}
      </div>

      {/* History */}
      {adjustments.length === 0 ? (
        <div style={{ padding: '20px 18px', fontSize: 13, color: '#8C94A6' }}>
          No adjustments for this employee this month.
        </div>
      ) : (
        <div style={{ padding: '10px 18px 14px' }}>
          {adjustments.map(a => {
            const signed = a.adjustment_type === 'addition' ? a.amount : -a.amount
            return (
              <div
                key={a.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  gap: 12, padding: '8px 0', borderBottom: ROW_DIVIDER,
                }}
              >
                <div style={{ minWidth: 0, fontSize: 13, color: '#3D4455' }}>
                  {a.description}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexShrink: 0 }}>
                  <span style={{
                    fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                    color: signTone(signed) ?? '#3D4455', whiteSpace: 'nowrap',
                  }}>
                    {fmtSignedAmount(signed)}
                  </span>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={deleting === a.id}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '2px 10px', fontSize: 12 }}
                  >
                    {deleting === a.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>
            )
          })}
          <div style={{ marginTop: 4 }}>
            <SettlementRow
              label="Net Adjustment"
              value={fmtSignedAmount(netAdj)}
              tone={signTone(netAdj)}
              strong
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollMonthlyReviewDetailPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [fetching, setFetching] = useState(false)
  const [data,     setData]     = useState<DetailData | null>(null)
  const [error,    setError]    = useState('')
  const [token,    setToken]    = useState('')
  const [saving,   setSaving]   = useState(false)

  const params       = useParams()
  const searchParams = useSearchParams()
  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])

  const userId = params.userId as string
  const year   = parseInt(searchParams.get('year')  ?? '0', 10)
  const month  = parseInt(searchParams.get('month') ?? '0', 10)

  const loadDetail = async (tok: string) => {
    setFetching(true)
    const res  = await fetch(
      `/api/payroll/monthly-review/detail?year=${year}&month=${month}&employee_id=${userId}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    )
    const json = await res.json()
    if (res.ok) setData(json as DetailData)
    else setError(json.error ?? 'Failed to load detail')
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

      if (userId && year && month) await loadDetail(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, year, month])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const handleAddAdjustment = async (adjType: 'addition' | 'deduction', amount: number, note: string) => {
    setSaving(true)
    const res = await fetch('/api/payroll/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ employee_id: userId, year, month, adjustment_type: adjType, amount, note }),
    })
    if (res.ok) await loadDetail(token)
    else {
      const json = await res.json()
      setError(json.error ?? 'Failed to save adjustment')
    }
    setSaving(false)
  }

  const handleDeleteAdjustment = async (id: string) => {
    const res = await fetch(`/api/payroll/adjustments/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) await loadDetail(token)
    else {
      const json = await res.json()
      setError(json.error ?? 'Failed to delete adjustment')
    }
  }

  if (loading) return <LoadingScreen />

  const monthLabel = year && month ? periodLabel(month, year) : ''
  const backHref   = year && month
    ? `/payroll/monthly-review?year=${year}&month=${month}`
    : '/payroll/monthly-review'

  // Everything below reads from the payload; nothing recomputes it.
  const summary  = data && !data.skipped ? data.summary : null
  const lines    = data && !data.skipped ? data.deduction_lines : []
  const groups   = groupDeductions(lines)
  const charged  = groups.filter(g => g.amount > 0.005)
  const waived   = groups.filter(g => g.amount <= 0.005)

  // The itemised rows must add up to the engine's total, so whatever they do not
  // account for is stated as its own line rather than left to go missing.
  const itemisedTotal = charged.reduce((s, g) => s + g.amount, 0)
  const residual      = summary ? summary.total_deductions - itemisedTotal : 0

  const lateDays = groups.find(g => g.type === 'late_arrival')?.days ?? 0

  return (
    <AttendancePayrollLayout
      profile={profile}
      title={data && !data.skipped ? `${data.employee.full_name} — ${monthLabel}` : 'Payroll Preview Detail'}
      subtitle="Engine-computed payroll breakdown"
      onSignOut={handleSignOut}
    >
      {/* Back link — secondary, and kept to a single tight line, as on Payroll
          Result Detail. */}
      <div style={{ marginBottom: 12 }}>
        <Link
          href={backHref}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 12.5, color: '#8C94A6', textDecoration: 'none',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#111318')}
          onMouseLeave={e => (e.currentTarget.style.color = '#8C94A6')}
        >
          ← Back to Monthly Preview
        </Link>
      </div>

      <div className="payroll-detail-page">

        {error && (
          <div style={{
            marginBottom: 16, padding: '10px 16px', borderRadius: 8,
            background: 'rgba(239,68,68,0.08)', color: '#DC2626',
            border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* Who this preview belongs to, and which month it covers. */}
        {data && (
          <div className="payroll-identity-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
              <Avatar name={data.employee.full_name} size={32} />
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 15, fontWeight: 700, color: '#111318',
                  letterSpacing: '-0.01em', lineHeight: 1.25,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {data.employee.full_name}
                </div>
                {data.employee.employee_code && (
                  <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.3 }}>
                    {data.employee.employee_code}
                  </div>
                )}
              </div>
            </div>

            <div className="payroll-identity-meta">
              {monthLabel && <MetaField label="Payroll Month">{monthLabel}</MetaField>}
              {/* This route only ever renders a preview run — the engine is
                  called with a draft period that is never stored — so the badge
                  states exactly that, and never claims Generated or Locked. */}
              <MetaField label="Status"><Pill tone={PREVIEW_TONE}>Preview</Pill></MetaField>
              {data.employee.monthly_salary != null && (
                <MetaField label="Monthly Salary">{fmt(data.employee.monthly_salary)}</MetaField>
              )}
            </div>
          </div>
        )}

        {!year || !month ? (
          <div style={{ ...CARD, padding: '28px 20px', fontSize: 13, color: '#8C94A6' }}>
            No payroll month selected. Open this employee from the Monthly Preview list.
          </div>
        ) : null}

        {fetching && (
          <div style={{ ...CARD, padding: '32px 20px', fontSize: 13, color: '#8C94A6' }}>
            Computing payroll…
          </div>
        )}

        {!fetching && data?.skipped && (
          <div style={{ ...CARD, padding: '22px 20px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#B45309', marginBottom: 5 }}>
              Skipped
            </div>
            <div style={{ fontSize: 13, color: '#6B7280' }}>
              {SKIP_LABELS[data.skip_reason] ?? data.skip_reason}
            </div>
          </div>
        )}

        {/* Calculation (left) + payroll summary rail (right).
            Below 1024 this stacks and the rail moves above the calculation. */}
        {!fetching && data && !data.skipped && summary && (
            <div className="payroll-detail-workspace">
              <div className="payroll-detail-main">

                {/* ── A. The whole calculation, in one column of figures ── */}
                <div style={CARD}>
                  <SectionHeader title="Pay Calculation" />
                  <div style={{ padding: '13px 18px 15px' }}>
                    <SettlementRow label="Gross Salary" value={fmt(summary.gross_salary)} />

                    {charged.length === 0 && residual <= 0.005 ? (
                      <SettlementRow
                        label="Deductions"
                        value={fmt(0)}
                        muted
                        remark="No deductions applied this month"
                      />
                    ) : (
                      <>
                        {charged.map(g => (
                          <SettlementRow
                            key={g.type}
                            label={`${deductionLabel(g.type)} · ${fmtDays(g.days)}`}
                            value={`−${fmt(g.amount)}`}
                            tone="#DC2626"
                          />
                        ))}
                        {residual > 0.005 && (
                          <SettlementRow
                            label="Other Deductions"
                            value={`−${fmt(residual)}`}
                            tone="#DC2626"
                          />
                        )}
                      </>
                    )}

                    <SettlementRule />
                    <SettlementRow
                      label="Total Deductions"
                      value={summary.total_deductions > 0.005 ? `−${fmt(summary.total_deductions)}` : fmt(0)}
                      tone={summary.total_deductions > 0.005 ? '#DC2626' : undefined}
                      strong
                    />

                    {/* One row per adjustment, each with its own reason — an
                        unexplained figure on a payslip is never acceptable. */}
                    {data.adjustments.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        {data.adjustments.map(a => {
                          const signed = a.adjustment_type === 'addition' ? a.amount : -a.amount
                          return (
                            <SettlementRow
                              key={a.id}
                              label={a.description || 'Adjustment'}
                              value={fmtSignedAmount(signed)}
                              tone={signTone(signed)}
                            />
                          )
                        })}
                        <SettlementRow
                          label="Net Adjustments"
                          value={fmtSignedAmount(summary.adjustment_total)}
                          tone={signTone(summary.adjustment_total)}
                          strong
                        />
                      </div>
                    )}

                    {/* The result, under a rule, as the strongest row here. The
                        display-size figure lives once, in the rail. */}
                    <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '11px 0 9px' }} />
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'baseline', gap: 10,
                    }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.08em', color: '#3D4455',
                      }}>
                        Net Payable
                      </span>
                      <span style={{
                        fontSize: 17, fontWeight: 700, color: '#111318',
                        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                      }}>
                        {fmt(summary.net_salary)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* ── B. Why the deductions happened ── */}
                {groups.length > 0 && (
                  <div style={CARD}>
                    <SectionHeader title="Why Deductions Applied" />
                    <div style={{ padding: '4px 18px 12px' }}>
                      {charged.map((g, i) => (
                        <ReasonRow
                          key={g.type}
                          label={deductionLabel(g.type)}
                          meta={g.hours > 0 ? `${fmtDays(g.days)} · ${fmtHours(g.hours)}` : fmtDays(g.days)}
                          amount={g.amount}
                          last={i === charged.length - 1 && waived.length === 0}
                        />
                      ))}
                      {/* A reason that cost nothing still gets a line — it is
                          why a day appears in the ledger below at ₹0. */}
                      {waived.map((g, i) => (
                        <ReasonRow
                          key={g.type}
                          label={deductionLabel(g.type)}
                          meta={g.hours > 0 ? `${fmtDays(g.days)} · ${fmtHours(g.hours)}` : fmtDays(g.days)}
                          amount={g.amount}
                          note="No deduction applied"
                          last={i === waived.length - 1}
                        />
                      ))}
                    </div>

                    {/* The hours the engine measured before paid leave absorbed
                        any of them. Carried through from the summary as-is. */}
                    {(summary.late_deduction_hours > 0 || summary.missing_punch_hours > 0 || summary.short_hours_deduction > 0) && (
                      <div style={{
                        padding: '11px 18px 13px',
                        borderTop: '1px solid rgba(0,0,0,0.06)',
                        background: 'rgba(0,0,0,0.012)',
                      }}>
                        <SummaryGroup title="Hours measured before absorption" />
                        {summary.late_deduction_hours > 0 && (
                          <SummaryLine label="Late / Early Checkout" value={fmtHours(summary.late_deduction_hours)} />
                        )}
                        {summary.missing_punch_hours > 0 && (
                          <SummaryLine label="Missing Punch" value={fmtHours(summary.missing_punch_hours)} />
                        )}
                        {summary.short_hours_deduction > 0 && (
                          <SummaryLine label="Short Hours" value={fmtHours(summary.short_hours_deduction)} />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── The day-level evidence, as a ledger ── */}
                {lines.length > 0 && (
                  <div style={CARD}>
                    <SectionHeader title="Day-Level Deductions" />
                    <div style={{ overflowX: 'auto' }}>
                      <table className="payroll-ledger" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                        <colgroup>
                          <col style={{ width: '22%' }} />
                          <col style={{ width: '30%' }} />
                          <col style={{ width: '26%' }} />
                          <col style={{ width: '22%' }} />
                        </colgroup>
                        <thead>
                          <tr style={THEAD_ROW}>
                            <th style={TH}>Date</th>
                            <th style={TH}>Attendance Issue</th>
                            <th style={TH}>Attendance</th>
                            <th style={{ ...TH, textAlign: 'right' }}>Deduction</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l, i) => (
                            <tr
                              key={`${l.line_date}-${l.deduction_type}-${i}`}
                              style={{ borderBottom: i < lines.length - 1 ? ROW_DIVIDER : 'none' }}
                            >
                              <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                                <DayDateCell iso={l.line_date} />
                              </td>
                              <td style={TD}>
                                <span style={{ color: '#3D4455', fontWeight: 500 }}>
                                  {deductionLabel(l.deduction_type)}
                                </span>
                                {l.hours_deducted > 0 && (
                                  <span style={{ color: '#8C94A6', fontVariantNumeric: 'tabular-nums' }}>
                                    {' · '}{fmtHours(l.hours_deducted)}
                                  </span>
                                )}
                              </td>
                              <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                                <div style={PUNCH_LINE}>{fmtPunches(l.check_in_at, l.check_out_at)}</div>
                              </td>
                              {/* A ₹0 date is muted and unsigned: nothing was
                                  taken, and "−₹0.00" would read as if it were.
                                  Muted rather than green — this payload does not
                                  carry WHY the line came to nothing, so the row
                                  states the amount and claims nothing else. */}
                              <td style={{
                                ...TD, textAlign: 'right', fontWeight: 600,
                                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                                color: l.amount_deducted > 0 ? '#DC2626' : '#8C94A6',
                              }}>
                                {l.amount_deducted > 0 ? `−${fmt(l.amount_deducted)}` : fmt(0)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td style={TFOOT_LABEL} colSpan={3}>Total Deductions</td>
                            <td style={{ ...TFOOT_VALUE, color: summary.total_deductions > 0.005 ? '#DC2626' : '#3D4455' }}>
                              {summary.total_deductions > 0.005 ? `−${fmt(summary.total_deductions)}` : fmt(0)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}

                {/* Creating and deleting an adjustment moves money, so it stays
                    admin-only — /api/payroll/adjustments enforces the same line.
                    A member Control Center granted the module to reads the
                    review; they do not edit it. */}
                {profile?.role === 'admin' && (
                  <AdjustmentsPanel
                    adjustments={data.adjustments}
                    onAdd={handleAddAdjustment}
                    onDelete={handleDeleteAdjustment}
                    saving={saving}
                  />
                )}

                <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.6 }}>
                  <strong style={{ color: '#6B7280' }}>Preview only</strong> — adjustments are
                  included in net payable above, but payroll for this month has not been generated
                  or locked yet.
                </div>
              </div>

              {/* ── The answer, and the attendance behind it ── */}
              <aside className="payroll-detail-aside">
                <div className="payroll-detail-aside-inner">
                  <div style={{
                    background: '#fff', borderRadius: 12,
                    border: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden',
                  }}>
                    <SectionHeader title="Payroll Summary" />

                    <div style={{ padding: '16px 18px 18px' }}>
                      <SummaryLine label="Gross Salary" value={fmt(summary.gross_salary)} />
                      <SummaryLine
                        label="Deductions"
                        value={summary.total_deductions > 0.005 ? `−${fmt(summary.total_deductions)}` : fmt(0)}
                        tone={summary.total_deductions > 0.005 ? '#DC2626' : undefined}
                      />
                      {summary.adjustment_total !== 0 && (
                        <SummaryLine
                          label="Adjustments"
                          value={fmtSignedAmount(summary.adjustment_total)}
                          tone={signTone(summary.adjustment_total)}
                        />
                      )}

                      <div style={{ height: 1, background: 'rgba(0,0,0,0.13)', margin: '11px 0 9px' }} />
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        alignItems: 'baseline', gap: 10,
                      }}>
                        <span style={{
                          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '0.09em', color: '#6B7384',
                        }}>
                          Net Payable
                        </span>
                        <span style={{
                          fontSize: 27, fontWeight: 700, lineHeight: 1.05, color: '#111318',
                          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                        }}>
                          {fmt(summary.net_salary)}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 5 }}>
                        {monthLabel ? `${monthLabel} · Preview` : 'Preview'}
                      </div>

                      <SummaryDivider />
                      <SummaryGroup title="Attendance" />
                      <SummaryLine label="Working Days" value={fmtDays(summary.working_days_in_month)} />
                      <SummaryLine label="Present"      value={fmtDays(summary.days_present)} />
                      {/* Red only where there is a genuine exception to look at. */}
                      <SummaryLine
                        label="Absent"
                        value={fmtDays(summary.days_absent)}
                        tone={summary.days_absent > 0 ? '#DC2626' : undefined}
                      />
                      {summary.half_day_count > 0 && (
                        <SummaryLine label="Half Days" value={fmtDays(summary.half_day_count)} />
                      )}
                      {lateDays > 0 && (
                        <SummaryLine label="Late Arrivals" value={fmtDays(lateDays)} />
                      )}
                      <SummaryLine label="Paid Leave Available" value={fmtDays(summary.paid_leave_available)} />
                      <SummaryLine
                        label="Paid Leave Used"
                        value={summary.paid_leave_used > 0 ? fmtDays(summary.paid_leave_used) : 'Not used'}
                        tone={summary.paid_leave_used > 0 ? undefined : '#8C94A6'}
                      />

                      {summary.leave_absorbed_deductions && (
                        <div style={{
                          marginTop: 10, padding: '9px 12px', borderRadius: 8,
                          background: 'rgba(0,0,0,0.028)', fontSize: 12,
                          color: '#3D4455', lineHeight: 1.5,
                        }}>
                          Paid leave absorbed all hourly deductions this month.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </aside>
            </div>
        )}

      </div>
    </AttendancePayrollLayout>
  )
}
