'use client'

import { Suspense, useEffect, useState, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { periodLabel } from '@/lib/payroll/months'
import {
  payrollAttention,
  type PayrollPeriodAction,
} from '@/lib/payroll/periodActions'
import {
  PAYROLL_ROW_CSS,
  PayrollAttentionIndicator,
  PayrollAttentionModal,
  PayrollRowActionBar,
} from './PayrollRowActions'
import { CreatePeriodModal, type EligibleMonth } from './CreatePeriodModal'
import { UnlockPayrollModal } from './UnlockPayrollModal'
import { DeletePayrollModal, type DeletePayrollPreview } from './DeletePayrollModal'
import { ParticipationModal, type ParticipationMember } from './ParticipationModal'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ISSUE_PARAM, payrollObjectionHref, type AdminObjectionRow } from '@/lib/objections'

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusEvent = {
  event: 'locked' | 'unlocked'
  actor_name: string | null
  reason: string | null
  created_at: string
}

type PayrollPeriodRow = {
  id: string
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  notes: string | null
  created_at: string
  /**
   * Employees this period currently holds a payroll result for.
   *
   * Counted from payroll_results, NOT from the last generation run. Those two
   * numbers are only equal when the run happened to cover everybody, and every
   * attendance correction regenerates exactly one employee — which is how a
   * 12-person month came to display "1". See countResultsByPeriod in
   * src/app/api/payroll/periods/route.ts.
   */
  employee_count: number
  /** How many employees the last completed run processed. Diagnostics only. */
  last_run_employee_count: number | null
  last_generated_at: string | null
  out_of_date: boolean
  /** The most recent lock/unlock, for Last Activity. Null until one happens. */
  last_status_event: StatusEvent | null
  /** The most recent reopening after finalisation, for Attention. */
  last_unlock: StatusEvent | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

/**
 * The single most recent thing that happened to this period, and what it was.
 *
 * Generation and finalisation are separate trails (payroll_generation and
 * payroll_period_status_events), so "last activity" is whichever of the two is
 * newer — otherwise a period locked yesterday would still read as last touched
 * when it was generated a week ago.
 */
function lastActivity(p: PayrollPeriodRow): { label: string; at: string } | null {
  const generated = p.last_generated_at ? { label: 'Generated', at: p.last_generated_at } : null
  const finalised = p.last_status_event
    ? { label: p.last_status_event.event === 'locked' ? 'Locked' : 'Unlocked', at: p.last_status_event.created_at }
    : null

  if (!generated) return finalised
  if (!finalised) return generated
  return new Date(finalised.at).getTime() >= new Date(generated.at).getTime() ? finalised : generated
}

function StatusBadge({ status }: { status: PayrollPeriodRow['status'] }) {
  const map = {
    draft:     { bg: 'rgba(140,148,166,0.12)', color: '#6B7280', label: 'Draft' },
    generated: { bg: 'rgba(16,185,129,0.12)',  color: '#059669', label: 'Generated' },
    locked:    { bg: 'rgba(232,160,48,0.15)',  color: '#B45309', label: 'Locked' },
  }
  const s = map[status]
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.color,
      whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// `?issue=<objection id>` arrives here from a Payroll-issue notification, so the
// page reads search params — which needs the Suspense boundary Next requires
// around useSearchParams. Same shape as /finance/received.
export default function PayrollPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PayrollPeriodsPage />
    </Suspense>
  )
}

function PayrollPeriodsPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [periods,      setPeriods]      = useState<PayrollPeriodRow[]>([])
  const [loading,      setLoading]      = useState(true)
  const [token,        setToken]        = useState('')
  const [busy,         setBusy]         = useState<Record<string, boolean>>({})
  const [error,        setError]        = useState<string | null>(null)
  const [success,      setSuccess]      = useState<string | null>(null)

  const [createOpen,   setCreateOpen]   = useState(false)
  const [creating,     setCreating]     = useState(false)
  const [createError,  setCreateError]  = useState<string | null>(null)
  const [createInfo,   setCreateInfo]   = useState<string | null>(null)
  // Same eligibility source View Payroll's own Create action uses (see
  // src/app/payroll/monthly-review/page.tsx) — a period may only be created
  // for a month that already has attendance, enforced server-side either way.
  const [eligibleMonths, setEligibleMonths] = useState<EligibleMonth[]>([])
  const [currentMonthUnavailable, setCurrentMonthUnavailable] = useState<EligibleMonth | null>(null)
  const [loadingEligibility, setLoadingEligibility] = useState(false)

  const [unlockTarget, setUnlockTarget] = useState<PayrollPeriodRow | null>(null)
  const [unlocking,    setUnlocking]    = useState(false)
  const [unlockError,  setUnlockError]  = useState<string | null>(null)

  // Deletion carries four pieces of state rather than one: the row, the server's
  // preview of what deleting it would do, whether that preview is still loading,
  // and whether the deletion itself is in flight. `deleting` is what prevents a
  // second submission — the dialog reads it too.
  const [deleteTarget,  setDeleteTarget]  = useState<PayrollPeriodRow | null>(null)
  const [deletePreview, setDeletePreview] = useState<DeletePayrollPreview | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleting,      setDeleting]      = useState(false)
  const [deleteError,   setDeleteError]   = useState<string | null>(null)

  // The row whose Attention icon was clicked. Held here, like the other two
  // dialogs, so the cell itself stays a stateless button.
  const [attentionTarget, setAttentionTarget] = useState<PayrollPeriodRow | null>(null)

  // Attendance & Payroll participation. Loaded only when the dialog is opened —
  // it is not needed to render the periods table and would be one more request
  // on every visit to a page that does not otherwise ask about employees.
  const [participationOpen,    setParticipationOpen]    = useState(false)
  const [participationMembers, setParticipationMembers] = useState<ParticipationMember[]>([])
  const [participationLoading, setParticipationLoading] = useState(false)
  const [participationError,   setParticipationError]   = useState<string | null>(null)
  const [participationSaving,  setParticipationSaving]  = useState<string | null>(null)

  const [highlightedPeriodId, setHighlightedPeriodId] = useState<string | null>(null)

  const router  = useRouter()
  const searchParams = useSearchParams()
  const supabase = useMemo(() => createClient(), [])

  /**
   * A Payroll-issue notification lands here carrying the objection id, and this
   * turns it into the disputed payslip.
   *
   * The period and employee come from /api/objections, which reads them back
   * through the objection's own foreign key and only hands them to an admin.
   * Nothing is taken from the URL except the objection id itself, and an id
   * belonging to somebody else's objection resolves to nothing — the route
   * behind it is admin-only regardless.
   *
   * Returns true when it has navigated away, so the caller can stop.
   */
  const resolveIssueDeepLink = async (accessToken: string): Promise<boolean> => {
    const issueId = searchParams.get(ISSUE_PARAM)
    if (!issueId) return false

    const res = await fetch(`/api/objections?id=${encodeURIComponent(issueId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return false

    const { objections } = await res.json().catch(() => ({ objections: [] }))
    const objection: AdminObjectionRow | undefined = objections?.[0]
    const href = objection ? payrollObjectionHref(objection) : null

    // No href means the objection is gone, is an attendance one, or its payroll
    // result was removed by a regeneration. The periods list is then the right
    // place to have landed, so this falls through rather than erroring.
    if (!href) return false

    router.replace(href)
    return true
  }

  // Own the highlight's lifetime here rather than in the click handler, so the
  // timer is cleared if the id changes again (re-highlighting a different row)
  // or the component unmounts before the 3s window elapses.
  useEffect(() => {
    if (!highlightedPeriodId) return
    const timer = setTimeout(() => setHighlightedPeriodId(null), 3000)
    return () => clearTimeout(timer)
  }, [highlightedPeriodId])

  const loadPeriods = async (accessToken: string) => {
    const res = await fetch('/api/payroll/periods', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) { setError('Failed to load payroll periods'); return }
    const json = await res.json()
    setPeriods(json.periods ?? [])
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

      // Nothing to re-decide here: PayrollGuard (src/app/payroll/layout.tsx)
      // wraps this route and has already resolved module access through
      // src/lib/moduleAccess.ts. Restating it as `role === 'admin'` was exactly
      // the second opinion that sent every non-admin to /coming-soon while the
      // launcher was still showing them the card.
      //
      // The period ACTIONS on this page — Generate, Lock, Unlock — remain
      // admin-only, in the UI below and in their API routes.
      if (!prof) {
        router.push('/coming-soon')
        return
      }

      setProfile(prof)

      // Before the list is built: a notification deep link is only passing
      // through here. Resolving it while the loading screen is still up means
      // the admin never sees the periods table flash on the way to the payslip.
      if (await resolveIssueDeepLink(session.access_token)) return

      await loadPeriods(session.access_token)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleGenerate = async (period: PayrollPeriodRow) => {
    if (busy[period.id]) return
    setBusy(b => ({ ...b, [period.id]: true }))
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/payroll/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ payroll_period_id: period.id }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Generation failed'); return }
      await loadPeriods(token)
    } finally {
      setBusy(b => ({ ...b, [period.id]: false }))
    }
  }

  const handleLock = async (period: PayrollPeriodRow) => {
    if (busy[period.id]) return
    const label = periodLabel(period.payroll_month, period.payroll_year)
    // Deliberately no longer says "this cannot be undone": an admin can reopen
    // the month through Unlock Payroll, and the confirmation must not claim
    // otherwise.
    if (!confirm(
      `Lock payroll for ${label}?\n\n` +
      'Regeneration, attendance correction and employee review are disabled while a period is locked. ' +
      'An admin can reopen it later with a stated reason.',
    )) return

    setBusy(b => ({ ...b, [period.id]: true }))
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/payroll/lock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ payroll_period_id: period.id }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Lock failed'); return }
      await loadPeriods(token)
      setSuccess(`${label} payroll is locked.`)
    } finally {
      setBusy(b => ({ ...b, [period.id]: false }))
    }
  }

  const handleUnlock = async (reason: string) => {
    const period = unlockTarget
    // `unlocking` is what blocks a second submission, so the dialog cannot fire
    // two unlock requests for the same period from a double click.
    if (!period || unlocking) return

    setUnlocking(true)
    setUnlockError(null)
    try {
      const res = await fetch('/api/payroll/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ payroll_period_id: period.id, reason }),
      })
      const json = await res.json()
      if (!res.ok) {
        // A failed unlock keeps the dialog open with the typed reason intact.
        setUnlockError(json.error ?? 'Unlock failed')
        return
      }
      // Reload before closing so the row behind is already showing its new
      // state — no manual browser refresh.
      await loadPeriods(token)
      setUnlockTarget(null)
      setError(null)
      setSuccess(
        `${periodLabel(period.payroll_month, period.payroll_year)} payroll is unlocked. ` +
        'Regeneration and attendance corrections are available again.',
      )
      setHighlightedPeriodId(period.id)
    } finally {
      setUnlocking(false)
    }
  }

  /**
   * Open the deletion dialog and ask the server what deleting this would do.
   *
   * The counts and the permission both come from GET /api/payroll/delete rather
   * than from the row already on screen: the row knows the period's status and
   * its result count, but not whether a payment has been recorded or a
   * generation is running, and those are the two answers that decide whether
   * this dialog offers a Delete button at all.
   */
  const openDelete = async (period: PayrollPeriodRow) => {
    setDeleteTarget(period)
    setDeletePreview(null)
    setDeleteError(null)
    setDeleteLoading(true)
    try {
      const res = await fetch(`/api/payroll/delete?period_id=${encodeURIComponent(period.id)}`, {
        headers: { authorization: `Bearer ${token}` },
        // Never a cached answer: whether a payroll may be deleted depends on
        // whether a payment was recorded a moment ago.
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok) { setDeleteError(json.error ?? 'Could not check this payroll.'); return }
      setDeletePreview(json as DeletePayrollPreview)
    } catch {
      setDeleteError('Could not check this payroll. Reload and try again.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const closeDelete = () => {
    // Never mid-flight: closing the dialog while the request is running would
    // leave the admin with no way to learn whether it succeeded.
    if (deleting) return
    setDeleteTarget(null)
    setDeletePreview(null)
    setDeleteError(null)
  }

  const handleDelete = async ({ reason, confirmation }: { reason: string; confirmation: string }) => {
    const period = deleteTarget
    if (!period || deleting) return

    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch('/api/payroll/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          payroll_period_id: period.id,
          payroll_month:     period.payroll_month,
          payroll_year:      period.payroll_year,
          confirmation,
          reason,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        // A failed deletion keeps the dialog open with the typed text intact,
        // and the payroll is still there — the route says so in the message.
        setDeleteError(json.error ?? 'Deletion failed.')
        return
      }

      const label = periodLabel(period.payroll_month, period.payroll_year)
      // Reload BEFORE closing, so the row is already gone behind the dialog and
      // no stale payroll remains on screen for even a frame.
      await loadPeriods(token)
      setDeleteTarget(null)
      setDeletePreview(null)
      setError(null)
      setSuccess(
        `${label} payroll has been permanently deleted. ` +
        `${json.results_deleted ?? 0} employee result${json.results_deleted === 1 ? '' : 's'} removed. ` +
        'Attendance records, employee profiles and salary settings are unchanged.',
      )
    } catch {
      setDeleteError('Deletion failed. The payroll was not deleted and nothing was changed.')
    } finally {
      setDeleting(false)
    }
  }

  const openCreateModal = async () => {
    setCreateError(null)
    setCreateInfo(null)
    setCreateOpen(true)
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

  const handleCreatePeriod = async (month: number, year: number) => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    setCreateInfo(null)
    try {
      const res = await fetch('/api/payroll/periods', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ month, year }),
      })
      const json = await res.json()
      if (!res.ok) { setCreateError(json.error ?? 'Failed to create period'); return }

      await loadPeriods(token)

      if (res.status === 200) {
        // Duplicate: the existing Draft/Generated period was reused, not
        // replaced. The dialog stays open saying so, and the row is highlighted
        // behind it.
        setCreateInfo(
          `A payroll period for ${periodLabel(month, year)} already exists — it is highlighted in the list. ` +
          'Use Regenerate Payroll on that row to recompute it with the latest attendance.',
        )
        const existingId = json.period?.id as string | undefined
        if (existingId) setHighlightedPeriodId(existingId)
        return
      }

      setCreateOpen(false)
      setSuccess(`${periodLabel(month, year)} payroll period created.`)
      const createdId = json.period?.id as string | undefined
      if (createdId) setHighlightedPeriodId(createdId)
    } finally {
      setCreating(false)
    }
  }

  // The popup's primary action is the row's own action, started from where the
  // warning was read. It routes through the same handlers — the dialog adds no
  // second path to generation or unlocking.
  const handleAttentionAction = (action: PayrollPeriodAction) => {
    const period = attentionTarget
    if (!period) return
    setAttentionTarget(null)
    if (action === 'unlock') { setUnlockError(null); setUnlockTarget(period); return }
    if (action === 'regenerate' || action === 'generate') void handleGenerate(period)
  }

  const closeCreate = () => {
    setCreateOpen(false)
    setCreateError(null)
    setCreateInfo(null)
  }

  // ── Attendance & Payroll participation ────────────────────────────────────

  const openParticipation = async () => {
    setParticipationOpen(true)
    setParticipationError(null)
    setParticipationLoading(true)
    try {
      const res  = await fetch('/api/payroll/participation', {
        headers: { authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setParticipationError(json.error ?? 'Failed to load members'); return }
      setParticipationMembers(json.members ?? [])
    } finally {
      setParticipationLoading(false)
    }
  }

  const handleParticipationChange = async (member: ParticipationMember, next: boolean) => {
    if (participationSaving) return
    setParticipationSaving(member.id)
    setParticipationError(null)
    try {
      const res = await fetch('/api/payroll/participation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ employee_id: member.id, participating: next }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setParticipationError(json.error ?? 'Failed to update participation'); return }

      // Patch the one row rather than refetching: the dialog stays open and the
      // member moves between the two groups immediately.
      setParticipationMembers(prev =>
        prev.map(m => (m.id === member.id ? { ...m, participating: next } : m)),
      )
      setSuccess(next
        ? `${member.full_name} is included in Attendance & Payroll again. They will be picked up the next time payroll is generated.`
        : `${member.full_name} is excluded from Attendance & Payroll. Existing records are unchanged.`)
    } finally {
      setParticipationSaving(null)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Running payroll is admin work; PayrollGuard has already decided whether the
  // module opens at all. See src/lib/moduleAccess.ts and the API routes for
  // generate / lock / unlock, which enforce the same line server-side.
  const isPayrollAdmin = profile?.role === 'admin'

  // ── Operational summary ───────────────────────────────────────────────────
  // Every figure below is derived from the list already fetched above — no
  // extra query, no extra round trip.
  const summary = useMemo(() => {
    // The API returns periods newest-first, so the first row is the current one.
    const current = periods[0] ?? null
    const latestGenerated = periods.find(p => p.last_generated_at != null) ?? null
    const attention = periods.filter(p => p.out_of_date).length
    return { current, latestGenerated, attention }
  }, [periods])

  if (loading) return <LoadingScreen />

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Payroll"
      subtitle={isPayrollAdmin
        ? 'Manage monthly payroll generation, review, locking, and corrections.'
        : 'Review monthly payroll results.'}
      onSignOut={handleSignOut}
      actions={isPayrollAdmin ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="boe-btn boe-btn-ghost"
            onClick={openParticipation}
            style={{ whiteSpace: 'nowrap' }}
          >
            Participation
          </button>
          <button
            className="boe-btn boe-btn-primary"
            onClick={() => { void openCreateModal() }}
            style={{ whiteSpace: 'nowrap' }}
          >
            Create Payroll Period
          </button>
        </div>
      ) : undefined}
    >
      {error && (
        <div role="alert" style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', color: '#DC2626',
          border: '1px solid rgba(239,68,68,0.2)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {success && (
        <div role="status" style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(69,168,112,0.10)', color: '#2E8A58',
          border: '1px solid rgba(69,168,112,0.28)', fontSize: 13,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <span>{success}</span>
          <button
            onClick={() => setSuccess(null)}
            aria-label="Dismiss"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#2E8A58', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0,
            }}
          >✕</button>
        </div>
      )}

      {/* Row hover, the Attention icon and the no-wrap action cell — colocated
          with the components they style, rendered once for the whole table. */}
      <style>{PAYROLL_ROW_CSS}</style>

      {/* Operational summary */}
      <div className="boe-kpi-grid" style={{ marginBottom: 12 }}>
        <SummaryTile
          label="Current Period"
          value={summary.current ? periodLabel(summary.current.payroll_month, summary.current.payroll_year) : '—'}
          meta={summary.current ? statusWord(summary.current.status) : 'No periods yet'}
        />
        <SummaryTile
          label="Latest Generated"
          value={summary.latestGenerated
            ? periodLabel(summary.latestGenerated.payroll_month, summary.latestGenerated.payroll_year)
            : '—'}
          meta={summary.latestGenerated
            ? formatDateTime(summary.latestGenerated.last_generated_at)
            : 'Not generated yet'}
        />
        <SummaryTile
          label="Employees Included"
          value={summary.latestGenerated ? String(summary.latestGenerated.employee_count) : '—'}
          meta={summary.latestGenerated
            ? `In ${periodLabel(summary.latestGenerated.payroll_month, summary.latestGenerated.payroll_year)}`
            : 'Not generated yet'}
        />
        <SummaryTile
          label="Attention Needed"
          value={String(summary.attention)}
          meta={summary.attention === 0
            ? 'No period is out of date'
            : `${summary.attention} period${summary.attention === 1 ? '' : 's'} need regeneration`}
          tone={summary.attention > 0 ? 'amber' : undefined}
        />
      </div>

      {/* Table card */}
      <div style={{
        background: '#fff', borderRadius: 12,
        border: '1px solid rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}>
        {periods.length === 0 ? (
          <div style={{
            padding: '48px 24px', textAlign: 'center',
            color: '#8C94A6', fontSize: 14,
          }}>
            No payroll periods found.
          </div>
        ) : (
          // Horizontal overflow is contained here, so the page itself never
          // scrolls sideways on a narrow screen.
          <div style={{ overflowX: 'auto' }}>
            {/* Narrower than before: the Attention column is now one icon wide,
                so the table reaches a phone without the card scrolling. */}
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 660 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                  {/* "Employees", not "Employees Included": the long header was
                      setting the column's width, so a two-digit number sat in a
                      column wide enough for a sentence. */}
                  {['Payroll Period', 'Status', 'Employees', 'Last Activity', 'Attention', 'Actions'].map(h => (
                    <th key={h} style={{
                      padding: '11px 16px', textAlign: 'left',
                      fontSize: 11.5, fontWeight: 700,
                      color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                      ...(h === 'Employees' ? { width: 96 } : null),
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periods.map((p, i) => {
                  const activity = lastActivity(p)
                  return (
                    <tr
                      key={p.id}
                      className="boe-payroll-row"
                      style={{
                        borderBottom: i < periods.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
                        // Inline wins over the hover rule, which is what keeps a
                        // freshly created row highlighted while the cursor is on it.
                        ...(p.id === highlightedPeriodId ? { background: 'rgba(232,160,48,0.14)' } : null),
                      }}
                    >
                      <td style={{ padding: '12px 16px', fontSize: 13.5, fontWeight: 500, color: '#111318', whiteSpace: 'nowrap' }}>
                        {periodLabel(p.payroll_month, p.payroll_year)}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <StatusBadge status={p.status} />
                      </td>
                      {/* Tabular figures so the column reads as a column. A
                          period with no results yet shows an em dash rather
                          than a zero, which would look like a failed run. */}
                      <td style={{
                        padding: '12px 16px', fontSize: 13.5, color: '#3D4455',
                        fontVariantNumeric: 'tabular-nums', width: 96,
                      }}>
                        {p.employee_count > 0 ? p.employee_count : '—'}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: 12.5, color: '#6B7280', whiteSpace: 'nowrap' }}>
                        {activity ? (
                          <>
                            <div style={{ color: '#3D4455' }}>{formatDateTime(activity.at)}</div>
                            <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>{activity.label}</div>
                          </>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <PayrollAttentionIndicator
                          detail={attentionOf(p)}
                          onOpen={() => setAttentionTarget(p)}
                        />
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <PayrollRowActionBar
                          status={p.status}
                          isBusy={!!busy[p.id]}
                          canManage={isPayrollAdmin}
                          onGenerate={() => handleGenerate(p)}
                          onLock={() => handleLock(p)}
                          onUnlock={() => { setUnlockError(null); setUnlockTarget(p) }}
                          onViewResults={() => router.push(`/payroll/results/${p.id}`)}
                          // Admins only. PayrollRowActionBar drops the control
                          // when no handler is given, so a Control Center member
                          // with Payroll visibility never sees it.
                          onDelete={isPayrollAdmin ? () => openDelete(p) : undefined}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
          onClose={closeCreate}
          onCreate={handleCreatePeriod}
        />
      )}

      {attentionTarget && attentionOf(attentionTarget) && (
        <PayrollAttentionModal
          detail={attentionOf(attentionTarget)!}
          periodLabel={periodLabel(attentionTarget.payroll_month, attentionTarget.payroll_year)}
          lastGeneratedLabel={formatDateTime(attentionTarget.last_generated_at)}
          reopened={attentionTarget.last_unlock
            ? {
                actorName: attentionTarget.last_unlock.actor_name,
                at:        formatDateTime(attentionTarget.last_unlock.created_at),
                reason:    attentionTarget.last_unlock.reason,
              }
            : null}
          onAct={handleAttentionAction}
          onClose={() => setAttentionTarget(null)}
        />
      )}

      {participationOpen && (
        <ParticipationModal
          members={participationMembers}
          loading={participationLoading}
          error={participationError}
          saving={participationSaving}
          onConfirm={handleParticipationChange}
          onClose={() => { setParticipationOpen(false); setParticipationError(null) }}
        />
      )}

      {unlockTarget && (
        <UnlockPayrollModal
          periodLabel={periodLabel(unlockTarget.payroll_month, unlockTarget.payroll_year)}
          saving={unlocking}
          error={unlockError}
          onCancel={() => { setUnlockTarget(null); setUnlockError(null) }}
          onConfirm={handleUnlock}
        />
      )}

      {deleteTarget && (
        <DeletePayrollModal
          // Keyed on the period, so opening the dialog for a different month
          // mounts a fresh one and nothing typed against the last period can
          // survive into a confirmation for this one.
          key={deleteTarget.id}
          preview={deletePreview}
          loading={deleteLoading}
          deleting={deleting}
          error={deleteError}
          onCancel={closeDelete}
          onConfirm={handleDelete}
        />
      )}
    </AttendancePayrollLayout>
  )
}

// ─── Summary tile ─────────────────────────────────────────────────────────────

function statusWord(status: PayrollPeriodRow['status']): string {
  return status === 'draft' ? 'Draft' : status === 'generated' ? 'Generated' : 'Locked'
}

/**
 * The KPI value, in the body face rather than the display face.
 *
 * `.boe-kpi-value` is Syne at 28/700 — a display type meant for a headline
 * number. Three of the four values on this page are not headline numbers: two
 * are month labels ("August 2026") and one is a headcount, and Syne's wide,
 * rounded figures made a two-digit count read as decorative while the long month
 * labels had to be shrunk to 16px to fit, so the row never sat on one baseline.
 *
 * Overridden here, on this page, rather than in .boe-kpi-value — that class is
 * every module's KPI card and this page is not entitled to restyle them all.
 * The existing BOE body stack is inherited (no new font), tabular figures keep
 * the numbers aligned as they change, and one size serves both a count and a
 * month so the four cards share a baseline.
 */
const KPI_VALUE: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 19,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  lineHeight: 1.15,
  fontVariantNumeric: 'tabular-nums',
}

function SummaryTile({
  label, value, meta, tone,
}: { label: string; value: string; meta: string; tone?: 'amber' }) {
  return (
    // Tightened here rather than in .boe-kpi: that class is every module's KPI
    // card, and this page is not entitled to shorten them all. The grid still
    // stretches its rows, so the four cards stay equal height.
    <div
      className={`boe-kpi${tone === 'amber' ? ' boe-kpi-amber' : ''}`}
      style={{ padding: '9px 12px' }}
    >
      <span className="boe-kpi-label">{label}</span>
      <span className="boe-kpi-value" style={KPI_VALUE}>{value}</span>
      <span className="boe-kpi-meta" style={{ marginTop: 4 }}>{meta}</span>
    </div>
  )
}

// ─── Attention ────────────────────────────────────────────────────────────────

/**
 * What this row's Attention icon stands for, or null for a period with nothing
 * outstanding.
 *
 * The warning text itself no longer sits in the cell: a two-line staleness note
 * beside a one-line neighbour is what made the rows uneven, and it crowded out
 * the actions. The wording lives in payrollAttention() and is shown in the
 * popup the icon opens.
 */
function attentionOf(period: PayrollPeriodRow) {
  return payrollAttention({
    status:     period.status,
    outOfDate:  period.out_of_date,
    reopened:   period.last_unlock != null,
  })
}
