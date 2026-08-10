'use client'

import { useEffect, useState, useMemo } from 'react'
import { formatRupees } from '@/lib/payroll/money'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { RaiseIssueModal } from '@/components/objections/RaiseIssueModal'
import { IssueHistoryModal } from '@/components/objections/IssueHistoryModal'
import {
  employeeStatusLabel,
  statusTone as objectionTone,
  canRaiseIssue,
  raiseActionLabel,
  groupIssueChains,
  type ObjectionRow,
} from '@/lib/objections'

// ─── Types ────────────────────────────────────────────────────────────────────

type MyResultRow = {
  id: string
  period_id: string
  payroll_month: number | null
  payroll_year: number | null
  gross_salary: number | null
  total_deductions: number | null
  net_salary: number | null
  status: 'draft' | 'locked'
  employee_reviewed_at: string | null
  generated_at: string | null
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

function ReviewBadge({ reviewedAt }: { reviewedAt: string | null }) {
  if (reviewedAt) {
    return (
      <span style={{
        display: 'inline-block', padding: '2px 10px', borderRadius: 20,
        fontSize: 11.5, fontWeight: 600,
        background: 'rgba(16,185,129,0.12)', color: '#059669',
      }}>
        Reviewed
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600,
      background: 'rgba(140,148,166,0.12)', color: '#6B7280',
    }}>
      Pending Review
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyPayrollPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [results, setResults] = useState<MyResultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [objections,  setObjections]  = useState<ObjectionRow[]>([])
  const [issueResult, setIssueResult] = useState<MyResultRow | null>(null)
  const [historyResultId, setHistoryResultId] = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      if (!prof) { router.push('/login'); return }
      setProfile(prof)

      const auth = { authorization: `Bearer ${session.access_token}` }
      const [res, objRes] = await Promise.all([
        fetch('/api/payroll/my-result', { headers: auth }),
        // Own objections only — the route pins a non-admin to their own rows.
        fetch('/api/objections', { headers: auth }),
      ])

      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Failed to load payroll data')
      else setResults(json.results ?? [])

      if (objRes.ok) {
        const { objections } = await objRes.json()
        setObjections((objections ?? []).filter((o: ObjectionRow) => o.payroll_result_id))
      }

      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** The newest objection per payroll result — what the row badge reflects. */
  const objectionByResult = useMemo(() => {
    const m = new Map<string, ObjectionRow>()
    for (const o of objections) {
      if (o.payroll_result_id && !m.has(o.payroll_result_id)) m.set(o.payroll_result_id, o)
    }
    return m
  }, [objections])

  /** Every attempt against each payslip, oldest first — what History shows. */
  const chainsByResult = useMemo(() => {
    const byResult = new Map<string, ObjectionRow[]>()
    for (const chain of groupIssueChains(objections).values()) {
      const resultId = chain[0].payroll_result_id
      if (resultId) byResult.set(resultId, chain)
    }
    return byResult
  }, [objections])

  const submitIssue = async (resultId: string, reason: string): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return 'Session expired.' }

    const res = await fetch('/api/objections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ payroll_result_id: resultId, reason }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not submit your issue.'

    setObjections(prev => [json.objection, ...prev])
    return null
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="My Payroll"
      subtitle="View your salary summaries"
      onSignOut={handleSignOut}
    >
      {error && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      <div style={{
        background: '#fff', borderRadius: 12,
        border: '1px solid rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}>
        {results.length === 0 ? (
          <div style={{
            padding: '48px 24px', textAlign: 'center',
            color: '#8C94A6', fontSize: 14,
          }}>
            No payroll results available yet. Check back after your admin generates payroll.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  {['Month', 'Gross Salary', 'Deductions', 'Net Payable', 'Review Status', ''].map(h => (
                    <th key={h} style={{
                      padding: '11px 16px', textAlign: 'left',
                      fontSize: 11.5, fontWeight: 700,
                      color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr
                    key={r.id}
                    style={{ borderBottom: i < results.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111318' }}>
                        {r.payroll_month ? MONTHS[r.payroll_month - 1] : '—'}{' '}
                        {r.payroll_year ?? ''}
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.gross_salary)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, color: r.total_deductions ? '#DC2626' : '#3D4455', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.total_deductions)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13.5, fontWeight: 600, color: '#111318', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(r.net_salary)}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <ReviewBadge reviewedAt={r.employee_reviewed_at} />
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          onClick={() => router.push(`/my-payroll/${r.period_id}`)}
                          style={{
                            fontSize: 12.5, fontWeight: 600,
                            color: '#4F6FD0', cursor: 'pointer',
                            padding: '4px 10px', borderRadius: 6,
                            border: '1px solid rgba(79,111,208,0.3)',
                            background: 'none', whiteSpace: 'nowrap',
                          }}
                        >
                          View &amp; Review
                        </button>
                        {/* Reporting a problem, not editing one. No amount on
                            this row is touchable from here.

                            Status, history and the action sit side by side: a
                            resolved or rejected issue must not take away the
                            employee's ability to raise the matter again. */}
                        {(() => {
                          const objection = objectionByResult.get(r.id)
                          return (
                            <>
                              {objection && (
                                <>
                                  <span
                                    title={objection.review_note ?? undefined}
                                    style={{
                                      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                                      fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                                      background: objectionTone(objection.status).bg,
                                      color: objectionTone(objection.status).fg,
                                    }}
                                  >
                                    {employeeStatusLabel(objection.status)}
                                  </span>
                                  <button
                                    onClick={() => setHistoryResultId(r.id)}
                                    className="boe-btn boe-btn-ghost"
                                    style={{ padding: '3px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                                  >
                                    History
                                  </button>
                                </>
                              )}
                              {canRaiseIssue(objection) && (
                                <button
                                  onClick={() => setIssueResult(r)}
                                  className="boe-btn boe-btn-ghost"
                                  style={{ padding: '3px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                                >
                                  {raiseActionLabel(objection)}
                                </button>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {issueResult && (
        <RaiseIssueModal
          subject={{
            title: `${issueResult.payroll_month ? MONTHS[issueResult.payroll_month - 1] : ''} ${issueResult.payroll_year ?? ''}`.trim(),
            summary: `Gross ${fmt(issueResult.gross_salary)} · Deductions ${fmt(issueResult.total_deductions)} · Net payable ${fmt(issueResult.net_salary)}`,
          }}
          onClose={() => setIssueResult(null)}
          onSubmit={reason => submitIssue(issueResult.id, reason)}
        />
      )}

      {historyResultId && chainsByResult.get(historyResultId) && (
        <IssueHistoryModal
          chain={chainsByResult.get(historyResultId)!}
          employeeLabel="You"
          onClose={() => setHistoryResultId(null)}
        />
      )}
    </AttendancePayrollLayout>
  )
}
