'use client'

// My Payroll — the detail of one month, as the employee whose payslip it is.
//
// Renders the SAME workspace an admin sees on
// /payroll/results/[periodId]/[employeeId]. It used to be a separate, thinner
// layout, which meant every improvement to the admin page quietly widened the
// gap between what an admin could see about a payslip and what its owner could.
//
// The difference between the two readers is `canEdit={false}` and no `onEdit`
// callback — so the correction controls are absent rather than disabled. That is
// presentation only. The real boundary is the endpoint: /api/payroll/my-result
// substitutes the caller's own id and has no employee_id parameter to tamper
// with, and every mutating payroll route keeps its own admin check.

import { useEffect, useState, useMemo, useCallback } from 'react'
import { formatRupees } from '@/lib/payroll/money'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  PayrollDetailWorkspace,
  fmtDayDate,
  CLASSIFICATION_LABELS,
  type DetailPayload,
  type CorrectionRow,
  type TabKey,
} from '@/app/payroll/results/[periodId]/[employeeId]/PayrollDetailView'
import {
  DeductionExplanationModal,
  type ExplanationDayContext,
} from '@/app/payroll/results/[periodId]/[employeeId]/DeductionExplanationModal'
import { RaiseIssueModal } from '@/components/objections/RaiseIssueModal'
import { employeeStatusLabel, statusTone as objectionTone, type ObjectionRow } from '@/lib/objections'

export default function MyPayrollDetailPage() {
  const params   = useParams()
  const periodId = params.periodId as string

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [data,    setData]    = useState<DetailPayload | null>(null)
  const [token,   setToken]   = useState('')
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [tab,     setTab]     = useState<TabKey>('deductions')
  const [explainingDate, setExplainingDate] = useState<string | null>(null)

  const [reviewing,   setReviewing]   = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const [objection,  setObjection]  = useState<ObjectionRow | null>(null)
  const [issueOpen,  setIssueOpen]  = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const load = useCallback(async (accessToken: string) => {
    const auth = { authorization: `Bearer ${accessToken}` }
    const [detailRes, objRes] = await Promise.all([
      fetch(`/api/payroll/my-result?period_id=${periodId}`, { headers: auth }),
      fetch('/api/objections', { headers: auth }),
    ])

    const json = await detailRes.json()
    if (!detailRes.ok) setError(json.error ?? 'Failed to load your payroll')
    else setData(json)

    if (objRes.ok) {
      const { objections } = await objRes.json()
      const mine = (objections ?? []).find(
        (o: ObjectionRow) => o.payroll_result_id && o.payroll_result_id === json?.result?.id,
      )
      setObjection(mine ?? null)
    }
  }, [periodId])

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

      if (!prof) { router.push('/login'); return }
      setProfile(prof)

      await load(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  const result = data?.result ?? null

  const correctionsByDate = useMemo(
    () => new Map<string, CorrectionRow>((data?.corrections ?? []).map(c => [c.attendance_date, c])),
    [data?.corrections],
  )

  // The popup reads the same DeductionDay the row was rendered from, so every
  // figure inside it is the figure on the row by construction.
  const explainingContext: ExplanationDayContext | null = useMemo(() => {
    if (!explainingDate || !data) return null
    const day = data.deduction_days.find(d => d.date === explainingDate)
    if (!day) return null
    const correction = correctionsByDate.get(explainingDate)
    return {
      date: day.date,
      dateLabel: fmtDayDate(day.date),
      classification: day.classification,
      classificationLabel: CLASSIFICATION_LABELS[day.classification] ?? day.classification,
      check_in_at: day.check_in_at,
      check_out_at: day.check_out_at,
      is_corrected: day.is_corrected,
      correctionRemark: correction?.remark ?? null,
      lines: day.lines,
      total_amount: day.total_amount,
    }
  }, [explainingDate, data, correctionsByDate])

  const handleMarkReviewed = async () => {
    if (reviewing || result?.employee_reviewed_at) return
    setReviewing(true)
    setReviewError(null)
    try {
      const res = await fetch('/api/payroll/my-result/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ period_id: periodId }),
      })
      const json = await res.json()
      if (!res.ok) setReviewError(json.error ?? 'Failed to mark as reviewed')
      else setData(prev => prev
        ? { ...prev, result: { ...prev.result, employee_reviewed_at: new Date().toISOString() } }
        : prev)
    } finally {
      setReviewing(false)
    }
  }

  const submitIssue = async (reason: string): Promise<string | null> => {
    if (!result) return 'Payroll not loaded.'
    const res = await fetch('/api/objections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ payroll_result_id: result.id, reason }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not submit your issue.'
    setObjection(json.objection)
    return null
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const reviewed = !!result?.employee_reviewed_at

  return (
    <AttendanceLayout
      profile={profile}
      title="My Payroll"
      subtitle="Your salary for this month, and how it was worked out"
      onSignOut={handleSignOut}
    >
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => router.push('/my-payroll')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#8C94A6', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 4, padding: 0,
          }}
        >
          ← Back to My Payroll
        </button>
      </div>

      {(error || reviewError) && (
        <div role="alert" style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error ?? reviewError}
        </div>
      )}

      {result && data && (
        <PayrollDetailWorkspace
          result={result}
          data={data}
          tab={tab}
          onSelectTab={setTab}
          corrections={correctionsByDate}
          correctableDates={new Set()}
          canEdit={false}
          onExplain={setExplainingDate}
          // No onEditCarryForward and no onEditPayment. Same statement as the
          // missing onEdit above: the employee has no settlement controls to
          // disable, because there is no edit path here to reach. The real
          // boundary is /api/payroll/settlement, which is admin-only, and the
          // RLS on payroll_settlements, which grants employees SELECT alone.
          issuePanel={
            <div style={{
              marginBottom: 16, padding: '12px 16px', borderRadius: 9,
              background: '#FAFBFC', border: '1px solid #E8EBF0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, flexWrap: 'wrap',
            }}>
              <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.55, minWidth: 220, flex: 1 }}>
                {objection
                  ? <>You reported an issue with this month&rsquo;s payroll.{objection.review_note ? ` Admin replied: ${objection.review_note}` : ''}</>
                  : <>Something look wrong? Raise it with your admin — this does not change your salary by itself.</>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {objection ? (
                  <span style={{
                    display: 'inline-block', padding: '3px 11px', borderRadius: 20,
                    fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                    background: objectionTone(objection.status).bg,
                    color: objectionTone(objection.status).fg,
                  }}>
                    {employeeStatusLabel(objection.status)}
                  </span>
                ) : (
                  <button
                    onClick={() => setIssueOpen(true)}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '5px 12px', fontSize: 12.5, whiteSpace: 'nowrap' }}
                  >
                    Raise Issue
                  </button>
                )}
                <button
                  onClick={handleMarkReviewed}
                  disabled={reviewed || reviewing}
                  className={reviewed ? 'boe-btn boe-btn-ghost' : 'boe-btn boe-btn-primary'}
                  style={{ padding: '5px 12px', fontSize: 12.5, whiteSpace: 'nowrap', opacity: reviewed ? 0.7 : 1 }}
                >
                  {reviewed ? 'Reviewed' : reviewing ? 'Saving…' : 'Mark as reviewed'}
                </button>
              </div>
            </div>
          }
        />
      )}

      {/* Read-only, and available whatever the period's lock state: a locked
          payroll still has to explain itself. */}
      {explainingContext && result && (
        <DeductionExplanationModal
          employeeName={result.employee_name}
          day={explainingContext}
          onClose={() => setExplainingDate(null)}
        />
      )}

      {issueOpen && result && (
        <RaiseIssueModal
          subject={{
            title: `${data ? `${String(data.period.payroll_month).padStart(2, '0')}/${data.period.payroll_year}` : ''}`,
            summary: `Gross ${formatRupees(Number(result.gross_salary ?? 0))} · Deductions ${formatRupees(Number(result.total_deductions ?? 0))} · Net payable ${formatRupees(Number(result.net_salary ?? 0))}`,
          }}
          onClose={() => setIssueOpen(false)}
          onSubmit={submitIssue}
        />
      )}
    </AttendanceLayout>
  )
}
