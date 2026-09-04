'use client'

// Payroll Result Detail — the ADMIN reader.
//
// The presentation lives in PayrollDetailView.tsx and is shared with the
// employee's own view of the same payslip, so the two cannot drift apart again.
// What is left here is what only an admin does: fetch the whole-company detail
// endpoint, and correct an attendance day.

import { useEffect, useState, useMemo, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
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
import { useScrollLock } from '@/hooks/useScrollLock'
import { useObjections } from '@/components/objections/useObjections'
import { ObjectionReviewPanel } from '@/components/objections/ObjectionReviewPanel'
import { issueChainKey } from '@/lib/objections'
import { periodLabel } from '@/lib/payroll/months'
import {
  PayrollDetailWorkspace,
  fmtDayDate,
  fmt,
  CLASSIFICATION_LABELS,
  type DetailPayload,
  type CorrectionRow,
  type TabKey,
} from './PayrollDetailView'
import { CarryForwardModal, PaymentModal } from './SettlementModal'

// ─── Busy overlay ─────────────────────────────────────────────────────────────

/**
 * A blocking, full-viewport busy state for the moment a settlement write is in
 * flight.
 *
 * Page-local on purpose. There is an app-wide LoadingScreen, but it REPLACES a
 * page rather than covering one, and this has to sit over a dialog that stays
 * mounted with the admin's typed values in it. So the spinner is the existing
 * .boe-loading-spinner and only the covering layer is new — no second loading
 * framework, and no new stylesheet rules.
 *
 * z-index 300 clears the payroll modal, which layers its scrim at 200 and its
 * dialog at 201 (PayrollModal.tsx). Covering the dialog too is the point: the
 * Save button, the direction toggle and the Cancel control must all be
 * unreachable while the write is happening.
 */
function SavingOverlay({ message }: { message: string }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Through the shared counter, not a local remembered value. This overlay
  // mounts ON TOP of a dialog that has already locked scrolling, so the value
  // it would observe for itself is the dialog's lock, not the page's. Restoring
  // that on the way out is what left the page unscrollable after a save.
  useScrollLock()

  useEffect(() => {
    // Where focus was before the overlay took it, so it can be handed back to
    // the control the admin was using once the write finishes.
    const previouslyFocused = document.activeElement as HTMLElement | null

    overlayRef.current?.focus()

    // Pointer events are already blocked by the covering layer; this closes the
    // keyboard route to the same controls. Tab cannot walk into the dialog
    // behind, and Escape cannot dismiss anything mid-write.
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        overlayRef.current?.focus()
      }
    }
    document.addEventListener('keydown', trap, true)

    return () => {
      document.removeEventListener('keydown', trap, true)
      previouslyFocused?.focus?.()
    }
  }, [])

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16,
        background: 'rgba(17,24,39,0.55)',
        backdropFilter: 'blur(2px)',
        outline: 'none',
        // Belt and braces with the keydown trap: nothing behind this layer can
        // be reached with a pointer either.
        touchAction: 'none',
      }}
    >
      <div className="boe-loading-spinner" />
      <p style={{
        margin: 0, color: '#FFFFFF', fontSize: 13.5, fontWeight: 600,
        letterSpacing: '0.01em', textAlign: 'center', padding: '0 24px',
      }}>
        {message}
      </p>
    </div>
  )
}

// ─── Selectors ────────────────────────────────────────────────────────────────

/** One entry in the Payroll Month dropdown. */
type PeriodOption = { id: string; payroll_month: number; payroll_year: number }
/** One entry in the Employee dropdown — this period's own employees only. */
type EmployeeOption = { employee_id: string; employee_name: string }

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

  // Month/employee selectors — populated once per period id, so routine
  // review (checking one employee after another, or a month after another)
  // never has to leave this page and re-find the results list.
  const [periodOptions,   setPeriodOptions]   = useState<PeriodOption[]>([])
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([])
  const [switching, setSwitching] = useState(false)

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

  // Settlement editing. Two dialogs, one save path — see saveSettlement below.
  const [carryForwardOpen,  setCarryForwardOpen]  = useState(false)
  const [paymentOpen,       setPaymentOpen]       = useState(false)
  const [settlementSaving,  setSettlementSaving]  = useState(false)
  const [settlementError,   setSettlementError]   = useState<string | null>(null)

  // Guards against a second mutation from a repeated click. Refs, not state,
  // because two clicks in one tick both read the pre-update state value.
  const savingRef    = useRef(false)
  const correctingRef = useRef(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  /** Returns whether the payslip was actually refreshed, so a caller cannot
   *  report success on the back of a reload that failed. */
  const load = async (accessToken: string): Promise<boolean> => {
    const res = await fetch(
      `/api/payroll/results/detail?period_id=${periodId}&employee_id=${employeeId}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? 'Failed to load result'); return false }
    setError(null)
    setData(json as DetailPayload)
    return true
  }

  // Every generated or locked period — a draft with no stored results has
  // nothing for this page to show. `payroll_periods` is readable by any
  // authenticated user (20260611_create_payroll_periods.sql), same technique
  // View Payroll already uses for its own month lookup — no new API route
  // just to populate a dropdown.
  const loadPeriodOptions = async () => {
    const { data: rows } = await supabase
      .from('payroll_periods')
      .select('id, payroll_month, payroll_year, status')
      .in('status', ['generated', 'locked'])
      .order('payroll_year', { ascending: false })
      .order('payroll_month', { ascending: false })
    setPeriodOptions((rows ?? []) as PeriodOption[])
  }

  // The same list the results page itself is built from — see
  // src/app/payroll/results/[periodId]/page.tsx and GET /api/payroll/results.
  const loadEmployeeOptions = async (accessToken: string, forPeriodId: string): Promise<EmployeeOption[]> => {
    const res  = await fetch(`/api/payroll/results?period_id=${forPeriodId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const json = await res.json()
    if (!res.ok) return []
    const rows: EmployeeOption[] = (json.results ?? [])
      .map((r: { employee_id: string; employee_name: string }) => ({ employee_id: r.employee_id, employee_name: r.employee_name }))
      .sort((a: EmployeeOption, b: EmployeeOption) => a.employee_name.localeCompare(b.employee_name))
    if (forPeriodId === periodId) setEmployeeOptions(rows)
    return rows
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

      await Promise.all([
        load(session.access_token),
        loadPeriodOptions(),
        loadEmployeeOptions(session.access_token, periodId),
      ])
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, employeeId])

  /** Employee → Employee: same period, immediate navigation, existing route. */
  const handleEmployeeChange = (newEmployeeId: string) => {
    if (newEmployeeId === employeeId) return
    router.push(`/payroll/results/${periodId}/${newEmployeeId}`)
  }

  /**
   * Month → Month: find the period, try to retain the current employee, and
   * land somewhere predictable — never on fabricated data — when they have no
   * result there.
   */
  const handlePeriodChange = async (newPeriodId: string) => {
    if (newPeriodId === periodId || switching) return
    setSwitching(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const employees = await loadEmployeeOptions(session.access_token, newPeriodId)
      const stillHasResult = employees.some(e => e.employee_id === employeeId)
      router.push(
        stillHasResult
          ? `/payroll/results/${newPeriodId}/${employeeId}`
          // No result for this employee in the new period — the results LIST
          // for that period, not a silently different employee's payslip.
          : `/payroll/results/${newPeriodId}`,
      )
    } finally {
      setSwitching(false)
    }
  }

  // Every hook runs before the first early return. This one sat below the
  // `if (loading)` guard, so the hook order changed between the loading render
  // and the loaded one — React reported it, and it would have surfaced as a
  // stale or crossed-over objection rather than an obvious crash.
  const objections = useObjections(token)

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

  // ── Settlement ────────────────────────────────────────────────────────────
  // One request shape for both edits; the route branches on `action`.
  //
  // The response now carries the recomputed settlement block, so the page takes
  // its new figures from the write that produced them instead of reloading the
  // whole payslip to ask what happened. That reload cost a full engine
  // recomputation and seven further round trips — most of the several-second
  // wait after Save — to re-derive a day view and a deduction ledger that a
  // settlement write cannot affect: this route has no path to the payroll
  // engine, by construction (see the header of the settlement route).
  //
  // These are still SERVER figures, not optimistic ones. `json.settlement` is
  // computed by buildSettlementBlock from the row the database returned, by the
  // same function the detail endpoint uses, so what shows after saving and what
  // shows after a reload cannot disagree.
  const saveSettlement = async (
    action: 'carry_forward' | 'payment',
    payload: Record<string, unknown>,
  ) => {
    // One mutation per click, even if the click lands several times. A ref, not
    // the `settlementSaving` state: state updates are asynchronous, so two
    // clicks in the same tick would both read the old value and both fire.
    if (savingRef.current) return
    savingRef.current = true

    setSettlementSaving(true)
    setSettlementError(null)
    try {
      // The access token is read again here rather than reused from state.
      //
      // `token` is captured once, at mount, and Supabase access tokens expire
      // about an hour later. The client refreshes its own session in the
      // background, but this component's copy does not move with it, so a
      // payslip left open long enough sent a token the auth server no longer
      // accepted — and the route answered that with a permission error. Nothing
      // was wrong with the admin's permissions; the page was quoting a stale
      // credential at it.
      //
      // getSession() hands back the current token, refreshing it first if it
      // has to. Same shape as submitIssue in src/app/my-issues/page.tsx.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setSettlementError('Your session has expired. Please sign in again and retry.')
        return
      }
      const accessToken = session.access_token
      setToken(accessToken)

      const res = await fetch('/api/payroll/settlement', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          payroll_period_id: periodId,
          employee_id:       employeeId,
          action,
          ...payload,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSettlementError(json.error ?? 'Failed to save')
        return
      }
      const notice = action === 'carry_forward'
        ? 'Previous balance updated.'
        : 'Amount paid recorded.'

      if (json.settlement) {
        // One state update carrying the new figures, the closed dialog and the
        // notice together, so React commits them in a single paint. Closing
        // first and filling in afterwards is what would flash the old numbers.
        setData(prev => prev
          ? { ...prev, settlement: { ...prev.settlement, ...json.settlement } }
          : prev)
        setCarryForwardOpen(false)
        setPaymentOpen(false)
        setSavedNotice(notice)
        return
      }

      // No settlement block came back — the period has no stored result to
      // compute figures against. Fall back to the full reload, and refresh
      // BEFORE closing so the dialog is never dismissed onto stale figures.
      //
      // The refreshed token, not the one in state: setToken above has not been
      // applied yet, and reloading with the expired credential would blank the
      // page straight after a successful save.
      const refreshed = await load(accessToken)
      if (!refreshed) {
        // The write landed; the re-read did not. Saying "updated" here would
        // claim a screen state that is not on screen. Retrying is the wrong
        // advice too — the mutation already succeeded.
        setSettlementError('Saved, but the payslip could not be refreshed. Please reload the page.')
        return
      }
      setCarryForwardOpen(false)
      setPaymentOpen(false)
      setSavedNotice(notice)
    } catch (e) {
      // Reaching here means the request never completed — the dialog stays
      // open with the entered values, and the browser console keeps the detail.
      console.error('[payroll/settlement] request failed:', e)
      setSettlementError('Settlement details could not be saved. Please try again.')
    } finally {
      savingRef.current = false
      setSettlementSaving(false)
    }
  }

  const handleSaveCorrection = async (payload: CorrectionPayload) => {
    if (correctingRef.current) return
    correctingRef.current = true

    setSaving(true)
    setSaveError(null)
    try {
      // Same reason as saveSettlement above: `token` is captured once at mount
      // and goes stale about an hour later, so a payslip left open sends a
      // credential the auth server has stopped accepting. Correcting a day is
      // the other mutation on this page and had the identical exposure.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setSaveError('Your session has expired. Please sign in again and retry.')
        return
      }
      const accessToken = session.access_token
      setToken(accessToken)

      const res = await fetch('/api/payroll/attendance-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ...payload, payroll_period_id: periodId, employee_id: employeeId }),
      })
      const json = await res.json()
      if (!res.ok) { setSaveError(json.error ?? 'Failed to save the correction'); return }

      // Refresh BEFORE closing. Unlike a settlement write, a correction reruns
      // the engine and restates the day view, the deduction ledger and the
      // totals, so there is no shortcut here — the whole payslip genuinely has
      // to come back. Closing first would show the pre-correction figures for
      // the length of that reload.
      //
      // The refreshed token, not the one in state: setToken has not been
      // applied yet, and reloading with the expired one would blank the page
      // immediately after a correction succeeded.
      const refreshed = await load(accessToken)
      if (!refreshed) {
        setSaveError('Corrected, but the payslip could not be refreshed. Please reload the page.')
        return
      }

      // Success closes the modal; a failure above leaves it open with the
      // entered values intact.
      setEditingDate(null)
      setSavedNotice(
        `${fmtDayDate(payload.attendance_date)} corrected — payroll recalculated. Net salary ${fmt(json.net_salary)}.`,
      )
    } catch (e) {
      // The raw error object used to be rendered into the dialog. It goes to
      // the console, where it is diagnosable, and the screen gets a sentence.
      console.error('[payroll/attendance-correction] request failed:', e)
      setSaveError('The correction could not be saved. Please try again.')
    } finally {
      correctingRef.current = false
      setSaving(false)
    }
  }

  if (loading) return <LoadingScreen />

  const canEdit = data?.can_edit ?? false

  // What this employee said about this payslip, on the screen where the admin
  // is already reviewing it.
  const objection = data?.result ? objections.byResult.get(data.result.id) : undefined

  // Everything ever raised against this payslip, not just the current row — an
  // employee may raise the matter again after a decision, and the admin
  // deciding the repeat needs to see what was decided the first time.
  const objectionChain = objection
    ? objections.chains.get(issueChainKey(objection) ?? '')
    : undefined

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Payroll Result Detail"
      onSignOut={handleSignOut}
    >
      {/* Month + Employee selectors — changing either navigates immediately to
          the existing route for that combination. Routine review (one
          employee after another, or the same employee across months) should
          never need Back → list → next employee. */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap',
        marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid rgba(0,0,0,0.07)',
      }}>
        <button
          onClick={() => router.push(`/payroll/results/${periodId}`)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#8C94A6', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 4,
            padding: 0, marginBottom: 3,
          }}
        >
          ← All employees
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Payroll Month
            </label>
            <select
              value={periodId}
              onChange={e => { void handlePeriodChange(e.target.value) }}
              disabled={switching}
              style={{
                fontSize: 13, border: '1px solid rgba(0,0,0,0.13)', borderRadius: 7,
                background: '#fff', color: '#111318', outline: 'none',
                padding: '6px 10px', minWidth: 150, cursor: switching ? 'wait' : 'pointer',
              }}
            >
              {/* The currently open period is always an option, even if it fell
                  outside the fetched list for some reason — never a dropdown
                  that cannot represent the page it is on. */}
              {!periodOptions.some(p => p.id === periodId) && data && (
                <option value={periodId}>{periodLabel(data.period.payroll_month, data.period.payroll_year)}</option>
              )}
              {periodOptions.map(p => (
                <option key={p.id} value={p.id}>{periodLabel(p.payroll_month, p.payroll_year)}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Employee
            </label>
            <select
              value={employeeId}
              onChange={e => handleEmployeeChange(e.target.value)}
              style={{
                fontSize: 13, border: '1px solid rgba(0,0,0,0.13)', borderRadius: 7,
                background: '#fff', color: '#111318', outline: 'none',
                padding: '6px 10px', minWidth: 170, cursor: 'pointer',
              }}
            >
              {!employeeOptions.some(e => e.employee_id === employeeId) && result && (
                <option value={employeeId}>{result.employee_name}</option>
              )}
              {employeeOptions.map(e => (
                <option key={e.employee_id} value={e.employee_id}>{e.employee_name}</option>
              ))}
            </select>
          </div>
        </div>
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
          // Present only for an admin. `canEdit` then decides whether they are
          // live — it is false on a locked period, and the API refuses anyway.
          onEditCarryForward={() => { setSettlementError(null); setCarryForwardOpen(true) }}
          onEditPayment={() => { setSettlementError(null); setPaymentOpen(true) }}
          issuePanel={objection && (
            <ObjectionReviewPanel
              objection={objection}
              chain={objectionChain}
              token={token}
              subjectLabel={periodLabel(data.period.payroll_month, data.period.payroll_year)}
              employeeLabel={data.result.employee_name ?? 'Employee'}
              onReviewed={objections.reload}
            />
          )}
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

      {carryForwardOpen && result && data?.settlement && (
        <CarryForwardModal
          employeeName={result.employee_name}
          currentAmount={data.settlement.figures.carry_forward}
          proposedAmount={data.settlement.carry_forward?.proposed ?? 0}
          isManual={data.settlement.carry_forward?.is_manual ?? false}
          currentRemark={data.settlement.carry_forward?.remark ?? null}
          saving={settlementSaving}
          error={settlementError}
          onSubmit={payload => saveSettlement('carry_forward', payload)}
          onClose={() => { setCarryForwardOpen(false); setSettlementError(null) }}
        />
      )}

      {paymentOpen && result && data?.settlement && (
        <PaymentModal
          employeeName={result.employee_name}
          salaryPayable={data.settlement.figures.salary_payable}
          currentAmount={data.settlement.figures.amount_paid}
          currentDate={data.settlement.payment?.payment_date ?? null}
          currentRemark={data.settlement.payment?.remark ?? null}
          saving={settlementSaving}
          error={settlementError}
          onSubmit={payload => saveSettlement('payment', payload)}
          onClose={() => { setPaymentOpen(false); setSettlementError(null) }}
        />
      )}

      {/* Last in the tree and above every dialog, so it covers whichever one is
          open. Both mutations on this page show it: a settlement write and an
          attendance correction are each a save the admin must not be able to
          interrupt, duplicate or navigate away from mid-flight. */}
      {(settlementSaving || saving) && (
        <SavingOverlay message="Saving and recalculating payroll…" />
      )}
    </AttendancePayrollLayout>
  )
}
