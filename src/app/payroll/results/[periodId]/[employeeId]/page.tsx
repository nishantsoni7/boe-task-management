'use client'

// Payroll Result Detail — the ADMIN reader.
//
// The presentation lives in PayrollDetailView.tsx and is shared with the
// employee's own view of the same payslip, so the two cannot drift apart again.
// What is left here is what only an admin does: fetch the whole-company detail
// endpoint, and correct an attendance day.

import { useEffect, useState, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { resolveMachineRecord } from '@/lib/payroll/correctionContext'
import {
  AttendanceCorrectionModal,
  type CorrectionDayContext,
  type CorrectionPayload,
} from './AttendanceCorrectionModal'
import {
  DeductionExplanationModal,
  type ExplanationDayContext,
} from './DeductionExplanationModal'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  PayrollDetailWorkspace,
  fmtDayDate,
  fmt,
  CLASSIFICATION_LABELS,
  type DetailPayload,
  type CorrectionRow,
  type TabKey,
} from './PayrollDetailView'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayrollResultDetailPage() {
  const params     = useParams()
  const periodId   = params.periodId as string
  const employeeId = params.employeeId as string

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [data,    setData]    = useState<DetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [token,   setToken]   = useState('')

  const [tab, setTab] = useState<TabKey>('deductions')
  const [editingDate, setEditingDate] = useState<string | null>(null)
  // Deliberately separate from `editingDate`: explaining a deduction and
  // correcting one are different actions with different consequences, and a
  // click meant for the first must never open the second. Explanations stay
  // available when payroll is locked; corrections do not.
  const [explainingDate, setExplainingDate] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const load = async (accessToken: string) => {
    const res = await fetch(
      `/api/payroll/results/detail?period_id=${periodId}&employee_id=${employeeId}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? 'Failed to load result'); return }
    setError(null)
    setData(json as DetailPayload)
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
      setProfile(prof)
      setToken(session.access_token)

      await load(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, employeeId])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const result = data?.result ?? null

  const correctionsByDate = useMemo(
    () => new Map((data?.corrections ?? []).map(c => [c.attendance_date, c])),
    [data?.corrections],
  )
  const correctableDates = useMemo(
    () => new Set(data?.correctable_dates ?? []),
    [data?.correctable_dates],
  )

  // The modal always works from the date-level picture, whichever tab opened it.
  const editingContext: CorrectionDayContext | null = useMemo(() => {
    if (!editingDate || !data) return null
    const deductionDay  = data.deduction_days.find(d => d.date === editingDate)
    const consideredDay = data.considered_days.find(d => d.date === editingDate)
    const correction    = correctionsByDate.get(editingDate)
    const source        = deductionDay ?? consideredDay
    if (!source) return null

    const machine = resolveMachineRecord(correction, source)

    return {
      date: editingDate,
      classification: source.classification,
      raw_check_in_at:  machine.check_in_at,
      raw_check_out_at: machine.check_out_at,
      effective_check_in_at:  source.check_in_at,
      effective_check_out_at: source.check_out_at,
      lines: deductionDay?.lines ?? [],
      total_amount: deductionDay?.total_amount ?? 0,
      existing: correction
        ? {
            remark: correction.remark,
            day_treatment: correction.day_treatment,
            waive_late_arrival:   correction.waive_late_arrival,
            waive_early_checkout: correction.waive_early_checkout,
            waive_missing_punch:  correction.waive_missing_punch,
            corrected_at: correction.corrected_at,
          }
        : null,
    }
  }, [editingDate, data, correctionsByDate])

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

  const handleSaveCorrection = async (payload: CorrectionPayload) => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/payroll/attendance-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...payload, payroll_period_id: periodId, employee_id: employeeId }),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Failed to save the correction'); return }

      // Success closes the modal; a failure above leaves it open with the
      // entered values intact.
      setEditingDate(null)
      await load(token)
      setSavedNotice(
        `${fmtDayDate(payload.attendance_date)} corrected — payroll recalculated. Net salary ${fmt(json.net_salary)}.`,
      )
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingScreen />

  const canEdit = data?.can_edit ?? false

  return (
    <PayrollLayout
      profile={profile}
      title="Payroll Result Detail"
      onSignOut={handleSignOut}
    >
      {/* Back link — secondary, and kept to a single tight line. */}
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => router.push(`/payroll/results/${periodId}`)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#8C94A6', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 4,
            padding: 0,
          }}
        >
          ← Back to Results
        </button>
      </div>

      {error && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {result && data && (
        <PayrollDetailWorkspace
          result={result}
          data={data}
          tab={tab}
          onSelectTab={setTab}
          corrections={correctionsByDate}
          correctableDates={correctableDates}
          canEdit={canEdit}
          onEdit={setEditingDate}
          onExplain={setExplainingDate}
          notices={savedNotice && (
            <div style={{
              marginBottom: 16, padding: '11px 16px', borderRadius: 9,
              background: 'rgba(5,150,105,0.09)', color: '#047857',
              border: '1px solid rgba(5,150,105,0.28)', fontSize: 13,
              display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center',
            }}>
              <span>{savedNotice}</span>
              <button
                onClick={() => setSavedNotice(null)}
                aria-label="Dismiss"
                style={{ background: 'none', border: 'none', color: '#047857', cursor: 'pointer', fontSize: 14 }}
              >✕</button>
            </div>
          )}
        />
      )}

      {/* Read-only, and deliberately not gated on `canEdit`: a locked payroll
          still has to explain itself. */}
      {explainingContext && result && (
        <DeductionExplanationModal
          employeeName={result.employee_name}
          day={explainingContext}
          onClose={() => setExplainingDate(null)}
        />
      )}

      {editingContext && result && (
        <AttendanceCorrectionModal
          employeeName={result.employee_name}
          day={editingContext}
          saving={saving}
          error={saveError}
          onCancel={() => { setEditingDate(null); setSaveError(null) }}
          onSave={handleSaveCorrection}
        />
      )}
    </PayrollLayout>
  )
}
