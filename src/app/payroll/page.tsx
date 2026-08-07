'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { PayrollLayout } from '@/components/layout/PayrollLayout'
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
import { CreatePeriodModal } from './CreatePeriodModal'
import { UnlockPayrollModal } from './UnlockPayrollModal'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

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
  generated_employees: number | null
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

export default function PayrollPage() {
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

  const [unlockTarget, setUnlockTarget] = useState<PayrollPeriodRow | null>(null)
  const [unlocking,    setUnlocking]    = useState(false)
  const [unlockError,  setUnlockError]  = useState<string | null>(null)

  // The row whose Attention icon was clicked. Held here, like the other two
  // dialogs, so the cell itself stays a stateless button.
  const [attentionTarget, setAttentionTarget] = useState<PayrollPeriodRow | null>(null)

  const [highlightedPeriodId, setHighlightedPeriodId] = useState<string | null>(null)

  const router  = useRouter()
  const supabase = useMemo(() => createClient(), [])

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
    <PayrollLayout
      profile={profile}
      title="Payroll"
      subtitle={isPayrollAdmin
        ? 'Manage monthly payroll generation, review, locking, and corrections.'
        : 'Review monthly payroll results.'}
      onSignOut={handleSignOut}
      actions={isPayrollAdmin ? (
        <button
          className="boe-btn boe-btn-primary"
          onClick={() => { setCreateError(null); setCreateInfo(null); setCreateOpen(true) }}
          style={{ whiteSpace: 'nowrap' }}
        >
          Create Payroll Period
        </button>
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
          value={summary.latestGenerated?.generated_employees != null
            ? String(summary.latestGenerated.generated_employees)
            : '—'}
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
                  {['Payroll Period', 'Status', 'Employees Included', 'Last Activity', 'Attention', 'Actions'].map(h => (
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
                      <td style={{ padding: '12px 16px', fontSize: 13.5, color: '#3D4455' }}>
                        {p.generated_employees != null ? p.generated_employees : '—'}
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

      {unlockTarget && (
        <UnlockPayrollModal
          periodLabel={periodLabel(unlockTarget.payroll_month, unlockTarget.payroll_year)}
          saving={unlocking}
          error={unlockError}
          onCancel={() => { setUnlockTarget(null); setUnlockError(null) }}
          onConfirm={handleUnlock}
        />
      )}
    </PayrollLayout>
  )
}

// ─── Summary tile ─────────────────────────────────────────────────────────────

function statusWord(status: PayrollPeriodRow['status']): string {
  return status === 'draft' ? 'Draft' : status === 'generated' ? 'Generated' : 'Locked'
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
      <span className="boe-kpi-value" style={{ fontSize: value.length > 8 ? 16 : 23 }}>{value}</span>
      <span className="boe-kpi-meta">{meta}</span>
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
