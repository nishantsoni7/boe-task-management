'use client'

// BOE Credits — the management view.
//
// Access: /payroll is admin-only (PayrollGuard → resolveManagementAccess), and
// every /api/boe-credits route this page calls refuses a non-admin regardless.
// This page adds no access decision of its own.
//
// FOUR THINGS, IN THE ORDER AN ADMINISTRATOR NEEDS THEM:
//   1. the settings — the five numbers that drive every future transaction;
//   2. the month close — which employees' review months are waiting, who
//      still has reviews in the verification queue, and the one button that
//      finalizes;
//   3. every employee's balance — spendable, pending (provisional), recorded —
//      with History and Adjust;
//   4. the settings history, as the audit trail it is.
// No charts, no monthly earned/used reporting, no analytics.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { Badge, Notice, ui, type Tone } from '@/components/attendancePayroll/ui'
import styles from './credits.module.css'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { formatCredits, reviewMonthLabel } from '@/lib/boeCredits/ledger'
import { DEFAULT_BOE_CREDIT_SETTINGS, formatCreditValue } from '@/lib/boeCredits/settings'
import { CREDITS_GUIDE_PATH } from '@/lib/boeCredits/paths'
import type { BoeCreditSettings, CreditReviewMonth, EmployeeCreditBalance } from '@/lib/boeCredits/types'
import { CreditHistoryModal, type CreditHistoryRow } from '@/components/boeCredits/CreditHistoryModal'
import { AdjustCreditsModal } from '@/components/boeCredits/AdjustCreditsModal'
import { CreditSettingsForm } from '@/components/boeCredits/CreditSettingsForm'
import { istToday, istMonthStartOffset } from '@/lib/istDate'

type SettingsHistoryRow = BoeCreditSettings & {
  id: string
  note: string | null
  created_at: string
  created_by_name: string | null
}

type HistoryState = {
  employee: EmployeeCreditBalance
  available: number
  spendable: number
  provisional: number
  rows: CreditHistoryRow[]
}

type MonthCloseRow = {
  employee_id: string
  full_name: string
  employee_code: string | null
  month: CreditReviewMonth | null
  unresolved_reviews: number
}

type MonthClose = {
  review_month: string
  can_finalize: boolean
  minimum_monthly_reviews: number
  rows: MonthCloseRow[]
  open_count: number
  unresolved_count: number
}

function stamp(at: string | null): string {
  if (!at) return '—'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function monthStatusBadge(m: CreditReviewMonth | null) {
  const meta: { label: string; tone: Tone } = !m
    ? { label: 'No reviews', tone: 'neutral' }
    : m.status === 'qualified'
      ? { label: m.finalized_at ? 'Qualified · closed' : 'Qualified', tone: 'good' }
      : m.status === 'lapsed'
        ? { label: 'Lapsed · closed', tone: 'bad' }
        : { label: 'Below target', tone: 'warn' }
  return <Badge tone={meta.tone}>{meta.label}</Badge>
}

/** The months an admin can choose: the last twelve, newest first. */
function monthOptions(): { value: string; label: string }[] {
  const today = istToday()
  const out: { value: string; label: string }[] = []
  for (let i = 1; i <= 12; i++) {
    const first = istMonthStartOffset(today, i)
    out.push({ value: first.slice(0, 7), label: reviewMonthLabel(first) })
  }
  return out
}

export default function BoeCreditsPage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [token,    setToken]    = useState('')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [okMsg,    setOkMsg]    = useState('')

  const [balances, setBalances] = useState<EmployeeCreditBalance[]>([])
  const [balancesLoaded, setBalancesLoaded] = useState(false)
  const [settings, setSettings] = useState<BoeCreditSettings>(DEFAULT_BOE_CREDIT_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState<string | null>(null)
  const [usingDefaults, setUsingDefaults] = useState(false)
  const [settingsHistory, setSettingsHistory] = useState<SettingsHistoryRow[]>([])
  const [showSettingsHistory, setShowSettingsHistory] = useState(false)

  const [monthParam, setMonthParam] = useState<string>(() => monthOptions()[0].value)
  const [monthClose, setMonthClose] = useState<MonthClose | null>(null)
  const [monthLoading, setMonthLoading] = useState(false)
  const [closing, setClosing] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const [search,    setSearch]    = useState('')
  const [history,   setHistory]   = useState<HistoryState | null>(null)
  const [adjusting, setAdjusting] = useState<EmployeeCreditBalance | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const options  = useMemo(() => monthOptions(), [])

  const authHeaders = useCallback((t: string) => ({ authorization: `Bearer ${t}` }), [])

  const loadBalances = useCallback(async (t: string) => {
    const res  = await fetch('/api/boe-credits/balances', { headers: authHeaders(t) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error ?? 'Could not load credit balances.')
    setBalances(json.balances ?? [])
    setBalancesLoaded(true)
  }, [authHeaders])

  const loadSettings = useCallback(async (t: string) => {
    const res  = await fetch('/api/boe-credits/settings', { headers: authHeaders(t) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error ?? 'Could not load credit settings.')
    setSettings(json.settings as BoeCreditSettings)
    setSettingsUpdatedAt(json.updated_at ?? null)
    setUsingDefaults(json.using_defaults === true)
    setSettingsHistory(json.history ?? [])
    setSettingsLoaded(true)
  }, [authHeaders])

  const loadMonthClose = useCallback(async (t: string, month: string) => {
    setMonthLoading(true)
    try {
      const res  = await fetch(`/api/boe-credits/review-months?month=${encodeURIComponent(month)}`, { headers: authHeaders(t) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? 'Could not load the month close.')
      setMonthClose(json as MonthClose)
    } finally {
      setMonthLoading(false)
    }
  }, [authHeaders])

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
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      // The shell renders as soon as the profile is known; each section fills
      // in as its own read lands.
      setLoading(false)

      const results = await Promise.allSettled([
        loadBalances(session.access_token),
        loadSettings(session.access_token),
        loadMonthClose(session.access_token, monthOptions()[0].value),
      ])
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "Try again" after a failed read: the same three reads the page makes on load.
  const reloadAll = async () => {
    setError('')
    const results = await Promise.allSettled([
      loadBalances(token),
      loadSettings(token),
      loadMonthClose(token, monthParam),
    ])
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
  }

  const changeMonth = async (value: string) => {
    setMonthParam(value)
    setConfirmClose(false)
    setError('')
    try { await loadMonthClose(token, value) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const openHistory = async (employee: EmployeeCreditBalance) => {
    setError('')
    const res  = await fetch(`/api/boe-credits/ledger?employee_id=${encodeURIComponent(employee.employee_id)}&limit=500`, {
      headers: authHeaders(token),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error ?? 'Could not load the credit history.'); return }
    setHistory({
      employee,
      available:   json.available_credits ?? 0,
      spendable:   json.spendable_credits ?? json.available_credits ?? 0,
      provisional: json.provisional_credits ?? 0,
      rows: json.transactions ?? [],
    })
  }

  const updateBalance = (employeeId: string, figures: { available_credits?: number; spendable_credits?: number; provisional_credits?: number }, addEntry: boolean) => {
    setBalances(prev => prev.map(b => b.employee_id === employeeId
      ? {
          ...b,
          available_credits:   figures.available_credits   ?? b.available_credits,
          spendable_credits:   figures.spendable_credits   ?? b.spendable_credits,
          provisional_credits: figures.provisional_credits ?? b.provisional_credits,
          transaction_count:   b.transaction_count + (addEntry ? 1 : 0),
          last_transaction_at: addEntry ? new Date().toISOString() : b.last_transaction_at,
        }
      : b))
  }

  const submitAdjustment = async (employee: EmployeeCreditBalance, input: { credits: number; reason: string }) => {
    const res = await fetch('/api/boe-credits/adjustments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ employee_id: employee.employee_id, credits: input.credits, reason: input.reason }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not record the adjustment.'

    setOkMsg(`Recorded ${formatCredits(input.credits, { signed: true })} for ${employee.full_name}.`)
    // The balance the server derived, not one computed here.
    updateBalance(employee.employee_id, json, true)
    return null
  }

  const reverseEntry = async (row: CreditHistoryRow, reason: string): Promise<string | null> => {
    const res = await fetch('/api/boe-credits/reversals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ transaction_id: row.id, reason }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not reverse that entry.'
    updateBalance(row.employee_id, json, true)
    // Re-read the history so the reversal row appears with its explanation.
    if (history) await openHistory(history.employee)
    setOkMsg(`Reversed ${formatCredits(Math.abs(row.credits))} for ${history?.employee.full_name ?? 'the employee'}.`)
    return null
  }

  const submitSettings = async (input: { settings: BoeCreditSettings; note: string | null }) => {
    const res = await fetch('/api/boe-credits/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(input),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const issues = (json.issues ?? []) as { message: string }[]
      return issues.length > 0 ? issues.map(i => i.message).join(' ') : json.error ?? 'Could not save the settings.'
    }
    try { await loadSettings(token) } catch { /* the save succeeded; the reload is presentational */ }
    return null
  }

  const closeMonth = async () => {
    if (!monthClose || closing) return
    setClosing(true)
    setError('')
    setOkMsg('')
    try {
      const res = await fetch('/api/boe-credits/review-months', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ review_month: monthClose.review_month }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error ?? 'Could not close the month.'); return }
      const n = json.finalized ?? 0
      const lapsed = json.lapsed_credits ?? 0
      setOkMsg(
        n === 0
          ? `${reviewMonthLabel(monthClose.review_month)} was already closed for everyone. Nothing changed.`
          : `${reviewMonthLabel(monthClose.review_month)} closed for ${n} employee${n === 1 ? '' : 's'}${lapsed > 0 ? ` · ${formatCredits(lapsed)} lapsed` : ' · nothing lapsed'}.`,
      )
      setConfirmClose(false)
      await Promise.all([loadMonthClose(token, monthParam), loadBalances(token)])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setClosing(false)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const needle = search.trim().toLowerCase()
  const shown = needle
    ? balances.filter(b => b.full_name.toLowerCase().includes(needle) || (b.employee_code ?? '').toLowerCase().includes(needle))
    : balances
  const totalSpendable = balances.reduce((sum, b) => sum + b.spendable_credits, 0)
  const totalProvisional = balances.reduce((sum, b) => sum + b.provisional_credits, 0)

  const openRows = monthClose?.rows.filter(r => r.month?.status === 'open') ?? []
  const closedRows = monthClose?.rows.filter(r => r.month && r.month.status !== 'open') ?? []
  const closeRows = monthClose
    ? [...openRows, ...closedRows, ...monthClose.rows.filter(r => !r.month)]
    : []
  const belowTargetCount = openRows.filter(r => r.month && r.month.qualifying_review_count < r.month.minimum_reviews_snapshot).length

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="BOE Credits"
      subtitle="Credit settings, month close and every employee's balance."
      onSignOut={handleSignOut}
      actions={
        <Link href={CREDITS_GUIDE_PATH} className="boe-btn boe-btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px' }}>
          How credits work
        </Link>
      }
    >
      <div className={ui.stack}>
        {error && (
          <Notice
            kind="error"
            action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => void reloadAll()}>Try again</button>}
          >
            {error}
          </Notice>
        )}
        {okMsg && (
          <Notice
            kind="success"
            action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setOkMsg('')}>Dismiss</button>}
          >
            {okMsg}
          </Notice>
        )}
        {usingDefaults && (
          <Notice kind="warning">Showing built-in defaults — no settings row could be read. Saving will create one.</Notice>
        )}

        {/* ── 1. Settings ─────────────────────────────────────────────────── */}
        <CreditSettingsForm
          key={`${settingsLoaded}-${settingsUpdatedAt ?? ''}`}
          current={settings}
          loading={!settingsLoaded}
          updatedAt={settingsUpdatedAt}
          onSubmit={submitSettings}
        />

        {/* ── 2. Month close ──────────────────────────────────────────────── */}
        <section aria-labelledby="month-close-heading" className={ui.surface}>
          <div className={ui.surfaceHead}>
            <div>
              <h2 id="month-close-heading" className={ui.surfaceTitle}>Month close</h2>
              <p className={ui.surfaceSub}>
                Review months below the target of {monthClose?.minimum_monthly_reviews ?? settings.minimum_monthly_reviews} verified reviews lapse when closed. Closing twice changes nothing.
              </p>
            </div>
            <div className={ui.row}>
              <label htmlFor="close-month" className={ui.label}>Month</label>
              <select
                id="close-month"
                value={monthParam}
                onChange={e => void changeMonth(e.target.value)}
                className={ui.input}
                style={{ width: 'auto', minWidth: 150 }}
              >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div className={ui.surfaceBody}>
            {monthLoading || !monthClose ? (
              <div className={styles.inlineNote} role="status" aria-busy="true">Loading…</div>
            ) : monthClose.rows.length === 0 ? (
              <div className={styles.inlineNote}>
                Nobody earned review credits in {reviewMonthLabel(monthClose.review_month)}. There is nothing to close.
              </div>
            ) : (
              <>
                {monthClose.unresolved_count > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Notice kind="warning">
                      {monthClose.unresolved_count} review{monthClose.unresolved_count === 1 ? '' : 's'} submitted in{' '}
                      {reviewMonthLabel(monthClose.review_month)} {monthClose.unresolved_count === 1 ? 'is' : 'are'} still waiting to be verified.
                      Verify or return them first — closing now would lapse credits those employees may still earn.
                    </Notice>
                  </div>
                )}

                <div className={ui.desktopOnly}>
                  <div className={ui.tableWrap}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Verified</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Credits</th>
                          <th>Status</th>
                          <th className={ui.num} style={{ textAlign: 'right' }}>Awaiting verification</th>
                        </tr>
                      </thead>
                      <tbody>
                        {closeRows.map(r => (
                          <tr key={r.employee_id}>
                            <td>
                              <div className={ui.strong}>{r.full_name}</div>
                              {r.employee_code && <div className={ui.sub}>{r.employee_code}</div>}
                            </td>
                            <td className={ui.num}>
                              {r.month ? `${r.month.qualifying_review_count} of ${r.month.minimum_reviews_snapshot}` : '—'}
                            </td>
                            <td className={ui.num}>{r.month ? r.month.earned_review_credits : '—'}</td>
                            <td>{monthStatusBadge(r.month)}</td>
                            <td className={`${ui.num} ${r.unresolved_reviews > 0 ? styles.warnStrong : ui.muted}`}>
                              {r.unresolved_reviews}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Phone: one card per employee. */}
                <ul className={ui.cards}>
                  {closeRows.map(r => (
                    <li key={r.employee_id} className={`${ui.surface} ${ui.card}`}>
                      <div className={ui.cardHead}>
                        <div>
                          <div className={ui.strong}>{r.full_name}</div>
                          {r.employee_code && <div className={ui.sub}>{r.employee_code}</div>}
                        </div>
                        {monthStatusBadge(r.month)}
                      </div>
                      <div className={ui.sub}>
                        Verified {r.month ? `${r.month.qualifying_review_count} of ${r.month.minimum_reviews_snapshot}` : '—'}
                        {' · '}Credits {r.month ? r.month.earned_review_credits : '—'}
                        {' · '}Awaiting verification {r.unresolved_reviews}
                      </div>
                    </li>
                  ))}
                </ul>

                <div className={styles.closeBar}>
                  {!monthClose.can_finalize ? (
                    <span className={ui.muted} style={{ fontSize: 13 }}>This month has not ended yet.</span>
                  ) : monthClose.open_count === 0 ? (
                    <span className={styles.closedText}>
                      {reviewMonthLabel(monthClose.review_month)} is closed for everyone.
                    </span>
                  ) : !confirmClose ? (
                    <button
                      type="button"
                      onClick={() => setConfirmClose(true)}
                      className={`boe-btn boe-btn-primary ${ui.btn}`}
                    >
                      Close {reviewMonthLabel(monthClose.review_month)} ({monthClose.open_count} open)
                    </button>
                  ) : (
                    <>
                      <span className={styles.confirmText}>
                        {belowTargetCount > 0
                          ? `${belowTargetCount} employee(s) are below target: their ${reviewMonthLabel(monthClose.review_month, { year: false })} review credits will lapse. Older credits are not affected.`
                          : 'Every open month reached the target. Closing records that; nothing lapses.'}
                        {monthClose.unresolved_count > 0 ? ' Reviews still awaiting verification will NOT count.' : ''}
                      </span>
                      <button type="button" onClick={() => void closeMonth()} disabled={closing} className={`boe-btn boe-btn-primary ${ui.btn}`}>
                        {closing ? 'Closing…' : 'Yes, close the month'}
                      </button>
                      <button type="button" onClick={() => setConfirmClose(false)} disabled={closing} className={`boe-btn boe-btn-ghost ${ui.btn}`}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        {/* ── 3. Balances ─────────────────────────────────────────────────── */}
        <section aria-labelledby="balances-heading" className={ui.surface}>
          <div className={ui.surfaceHead}>
            <div>
              <h2 id="balances-heading" className={ui.surfaceTitle}>Employee credits</h2>
              <p className={ui.surfaceSub} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {balances.length} {balances.length === 1 ? 'employee' : 'employees'} · {formatCredits(totalSpendable)} spendable
                {totalProvisional > 0 ? ` · ${formatCredits(totalProvisional)} pending this month's target` : ''}
                {' · '}1 credit = {formatCreditValue(settings.credit_value)}
              </p>
            </div>
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or code"
              aria-label="Search employees"
              className={ui.input}
              style={{ maxWidth: 260 }}
            />
          </div>

          {!balancesLoaded ? (
            <div className={styles.inlineNote} style={{ padding: "16px 18px" }} role="status" aria-busy="true">Loading…</div>
          ) : shown.length === 0 ? (
            <div className={styles.inlineNote} style={{ textAlign: 'center', padding: '32px 18px' }}>
              {needle ? 'Nobody matches that search.' : 'No employees to show.'}
            </div>
          ) : (
            <>
              <div className={`${ui.tableWrap} ${ui.desktopOnly}`}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Spendable</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Pending target</th>
                      <th className={ui.num} style={{ textAlign: 'right' }}>Recorded</th>
                      <th>Last activity</th>
                      <th><span className={ui.srOnly}>Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(b => (
                      <tr key={b.employee_id}>
                        <td>
                          <div className={ui.strong}>{b.full_name}</div>
                          {b.employee_code && <div className={ui.sub}>{b.employee_code}</div>}
                        </td>
                        <td className={`${ui.num} ${ui.strong} ${b.spendable_credits < 0 ? styles.neg : ''}`}>
                          {b.spendable_credits.toLocaleString('en-IN')}
                        </td>
                        <td className={`${ui.num} ${b.provisional_credits > 0 ? styles.warnText : ui.muted}`}>
                          {b.provisional_credits > 0 ? b.provisional_credits.toLocaleString('en-IN') : '—'}
                        </td>
                        <td className={ui.num}>{b.available_credits.toLocaleString('en-IN')}</td>
                        <td className={ui.nowrap}>{stamp(b.last_transaction_at)}</td>
                        <td>
                          <div className={styles.rowActions}>
                            <button type="button" onClick={() => void openHistory(b)} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>History</button>
                            <button type="button" onClick={() => { setOkMsg(''); setAdjusting(b) }} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>Adjust</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Phone: one card per employee. */}
              <ul className={ui.cards} style={{ padding: 12 }}>
                {shown.map(b => (
                  <li key={b.employee_id} className={`${ui.surface} ${ui.card}`}>
                    <div className={ui.cardHead}>
                      <div>
                        <div className={ui.strong}>{b.full_name}</div>
                        {b.employee_code && <div className={ui.sub}>{b.employee_code}</div>}
                      </div>
                      <div className={styles.cardBalance}>
                        <div className={`${ui.strong} ${b.spendable_credits < 0 ? styles.neg : ''}`}>{b.spendable_credits.toLocaleString('en-IN')}</div>
                        <div className={ui.sub}>Spendable</div>
                      </div>
                    </div>
                    <div className={ui.sub}>
                      Pending target {b.provisional_credits > 0 ? b.provisional_credits.toLocaleString('en-IN') : '—'}
                      {' · '}Recorded {b.available_credits.toLocaleString('en-IN')}
                      {' · '}Last activity {stamp(b.last_transaction_at)}
                    </div>
                    <div className={styles.rowActions}>
                      <button type="button" onClick={() => void openHistory(b)} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>History</button>
                      <button type="button" onClick={() => { setOkMsg(''); setAdjusting(b) }} className={`boe-btn boe-btn-ghost ${ui.btnSm}`}>Adjust</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* ── 4. Settings history ─────────────────────────────────────────── */}
        {settingsHistory.length > 0 && (
          <section className={ui.surface}>
            <button
              type="button"
              onClick={() => setShowSettingsHistory(v => !v)}
              aria-expanded={showSettingsHistory}
              className={`${ui.surfaceHead} ${styles.historyToggle}`}
              style={{ borderBottom: showSettingsHistory ? undefined : 'none' }}
            >
              <span className={ui.surfaceTitle}>Settings history</span>
              <span className={ui.surfaceSub} style={{ margin: 0 }}>{showSettingsHistory ? 'Hide' : `Show ${settingsHistory.length}`}</span>
            </button>
            {showSettingsHistory && (
              <div className={styles.historyList}>
                {settingsHistory.map(h => (
                  <div key={h.id} className={styles.historyRow}>
                    <strong>{stamp(h.created_at)}</strong>
                    {' — '}{h.created_by_name ?? 'System'}
                    {/*
                      BOTH REWARDS, because the history is the audit record of
                      what somebody chose. A line that showed only the text
                      reward would make a change to the image reward look like a
                      row that changed nothing.
                    */}
                    {' · '}{formatCredits(h.review_reward_credits)} per text review
                    {' · '}{formatCredits(h.image_review_reward_credits)} per image review
                    {' · '}{formatCreditValue(h.credit_value)} per credit
                    {' · '}Half Day {h.half_day_redemption_credits}{h.half_day_redemption_enabled ? '' : ' (off)'} · Full Day {h.full_day_redemption_credits}{h.full_day_redemption_enabled ? '' : ' (off)'} · {h.minimum_monthly_reviews} reviews a month
                    {' · '}at most {h.max_monthly_review_submissions} submissions, {h.minimum_monthly_image_reviews} of them image
                    {h.note ? ` · ${h.note}` : ''}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {history && (
        <CreditHistoryModal
          transactions={history.rows}
          availableCredits={history.available}
          spendableCredits={history.spendable}
          provisionalCredits={history.provisional}
          employeeLabel={history.employee.full_name}
          onClose={() => setHistory(null)}
          onReverse={reverseEntry}
        />
      )}

      {adjusting && (
        <AdjustCreditsModal
          employeeName={adjusting.full_name}
          availableCredits={adjusting.spendable_credits}
          onClose={() => setAdjusting(null)}
          onSubmit={input => submitAdjustment(adjusting, input)}
        />
      )}
    </AttendancePayrollLayout>
  )
}
