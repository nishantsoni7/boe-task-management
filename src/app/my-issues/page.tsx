'use client'

// "My Issues" — an employee's own attendance and payroll reports, on a page of
// their own.
//
// WHY THIS EXISTS
// ---------------
// Raising an issue used to be reachable only from inside a record: a row on
// /my-attendance, a row on /my-payroll. That works while you are looking at the
// record, and fails at every other moment — an employee who wants to know what
// happened to the issue they raised last week had to remember which month it
// was in, open that month, find the day, and read a badge. There was no answer
// to "what have I reported, and where did it get to".
//
// So this is the third SELF-SERVICE route of the Attendance & Payroll module,
// beside /my-attendance and /my-payroll. Not a new module: the sidebar, the
// shell, the API and the permission model are all the module's existing ones —
// see SELF_SERVICE_MODULE_KEYS in src/lib/moduleAccess.ts.
//
// Deliberately operational rather than dashboard-like: a list, a status, a
// history, and the one action an employee can take. No charts, no counts, no
// explanation panels — the record itself already explains itself, on its own
// page.
//
// AUTHORISATION
// -------------
// There is no employee id anywhere in this file and there could not be one.
// /api/objections pins a non-admin to their own rows whatever the query string
// says, and the RLS policy on employee_record_objections says the same thing
// again for any client reaching PostgREST directly. The `?issue=` parameter a
// notification arrives with is a FILTER over rows the caller already owns — an
// id belonging to a colleague simply selects nothing.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { colors } from '@/lib/tokens'
import { RaiseIssueModal } from '@/components/objections/RaiseIssueModal'
import { IssueHistoryModal } from '@/components/objections/IssueHistoryModal'
import { istToday } from '@/lib/istDate'
import {
  ISSUE_PARAM,
  canRaiseIssue,
  raiseActionLabel,
  groupIssueChains,
  issueChainKey,
  issueSubjectKind,
  issueSubjectLabel,
  employeeStatusLabel,
  statusTone,
  type ObjectionRow,
} from '@/lib/objections'

// ─── Types ────────────────────────────────────────────────────────────────────

type MyResultRow = {
  id: string
  payroll_month: number | null
  payroll_year: number | null
  gross_salary: number | null
  total_deductions: number | null
  net_salary: number | null
}

/** What the picker, or a re-raise, has settled on. */
type Target =
  | { kind: 'attendance'; attendanceDate: string }
  | { kind: 'payroll';    payrollResultId: string }

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function money(n: number | null): string {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function periodLabel(r: MyResultRow): string {
  return `${r.payroll_month ? MONTHS[r.payroll_month - 1] : '—'} ${r.payroll_year ?? ''}`.trim()
}

function stamp(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString('en-IN')
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyIssuesPage() {
  // useSearchParams needs a Suspense boundary; same shape as /payroll.
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MyIssues />
    </Suspense>
  )
}

function MyIssues() {
  const [profile,   setProfile]   = useState<UserProfile | null>(null)
  const [rows,      setRows]      = useState<ObjectionRow[]>([])
  const [results,   setResults]   = useState<MyResultRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  const [raising,    setRaising]    = useState<Target | 'picking' | null>(null)
  const [historyKey, setHistoryKey] = useState<string | null>(null)
  // Whether the reader has closed the history the notification link opened.
  // Without it, closing the modal would reopen it on the next render, since the
  // link is still in the URL.
  const [deepLinkClosed, setDeepLinkClosed] = useState(false)

  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])

  const focusedIssueId = searchParams.get(ISSUE_PARAM)

  /** Own issues, plus own payroll results so the picker can name a month. */
  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return null }

    const auth = { authorization: `Bearer ${session.access_token}` }
    const [objRes, payRes] = await Promise.all([
      fetch('/api/objections', { headers: auth }),
      fetch('/api/payroll/my-result', { headers: auth }),
    ])

    const objJson = await objRes.json().catch(() => ({}))
    if (!objRes.ok) {
      setError(objJson.error ?? 'Could not load your issues.')
      setRows([])
    } else {
      // An ADMIN calling this endpoint gets the company-wide queue back; this
      // page is one person's own list, so it is scoped to the viewer here
      // rather than trusting the answer whole. An admin's own issues are the
      // only ones that belong on their own page.
      const own: ObjectionRow[] = (objJson.objections ?? [])
        .filter((o: ObjectionRow) => o.employee_id === session.user.id)
      setRows(own)
      setError(null)
    }

    if (payRes.ok) {
      const payJson = await payRes.json().catch(() => ({}))
      setResults(payJson.results ?? [])
    }
    return session
  }, [supabase, router])

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

      await load()
      setLoading(false)
    }
    void init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Every issue grouped by the record it disputes, each chain oldest first. */
  const chains = useMemo(() => groupIssueChains(rows), [rows])

  /** Newest attempt first, so the most recent thing reported is at the top. */
  const orderedChains = useMemo(() => {
    const list = [...chains.entries()]
    list.sort((a, b) => {
      const aLatest = a[1][a[1].length - 1].created_at
      const bLatest = b[1][b[1].length - 1].created_at
      return aLatest < bLatest ? 1 : aLatest > bLatest ? -1 : 0
    })
    return list
  }, [chains])

  // A notification link names one ISSUE; what the employee should see is that
  // issue's whole trail, so the id is resolved to the chain it belongs to and
  // the history opens on arrival.
  //
  // DERIVED, not set in an effect. `?issue=` is a filter over rows the API has
  // already pinned to this caller, so an id belonging to a colleague — or one
  // whose payroll result has since been regenerated away — simply finds
  // nothing, and the page says so rather than opening anything.
  const deepLinkedChainKey = useMemo(() => {
    if (!focusedIssueId) return null
    const target = rows.find(o => o.id === focusedIssueId)
    return target ? issueChainKey(target) : null
  }, [focusedIssueId, rows])

  const openChainKey  = historyKey ?? (deepLinkClosed ? null : deepLinkedChainKey)
  const deepLinkLost  = !!focusedIssueId && !deepLinkedChainKey

  // ─── Submitting ─────────────────────────────────────────────────────────────

  const submitIssue = async (target: Target, reason: string): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return 'Session expired.' }

    const res = await fetch('/api/objections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(
        target.kind === 'attendance'
          ? { attendance_date: target.attendanceDate, reason }
          : { payroll_result_id: target.payrollResultId, reason },
      ),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not submit your issue.'

    // Reload rather than splice: a new submission joins an existing chain, and
    // the chain is what this page is built from.
    setRows(prev => [json.objection, ...prev])
    void load()
    return null
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const historyChain = openChainKey ? chains.get(openChainKey) : undefined

  const closeHistory = () => { setHistoryKey(null); setDeepLinkClosed(true) }

  return (
    <AttendanceLayout
      profile={profile}
      title="My Issues"
      subtitle="Attendance and payroll problems you have reported"
      onSignOut={handleSignOut}
      actions={
        <button
          type="button"
          onClick={() => setRaising('picking')}
          className="boe-btn boe-btn-primary"
          style={{ padding: '7px 14px', fontSize: 12.5, whiteSpace: 'nowrap' }}
        >
          Raise Issue
        </button>
      }
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

      {deepLinkLost && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8,
          background: 'rgba(232,160,48,0.10)', border: '1px solid rgba(232,160,48,0.30)',
          fontSize: 12.5, color: '#8A5A12',
        }}>
          That issue is not available. Your own reports are listed below.
        </div>
      )}

      {orderedChains.length === 0 ? (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: 12,
          background: colors.base, padding: '34px 24px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111318', marginBottom: 6 }}>
            You have not reported anything
          </div>
          <div style={{ fontSize: 13, color: colors.tertiary, lineHeight: 1.55 }}>
            If a day on My Attendance or a figure on My Payroll looks wrong, raise an
            issue here or from the record itself. An admin reviews it — raising an
            issue does not change your attendance or salary by itself.
          </div>
        </div>
      ) : (
        /* Wide content scrolls inside its own box, so the page never does. */
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: 12,
          background: colors.base, overflowX: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Record', 'What you reported', 'Last update', 'Status', ''].map((h, i) => (
                  <th key={h || `a${i}`} style={{
                    textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 600,
                    color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orderedChains.map(([key, chain]) => {
                const latest = chain[chain.length - 1]
                const kind   = issueSubjectKind(latest)
                const tone   = statusTone(latest.status)
                const target: Target | null =
                  latest.attendance_date
                    ? { kind: 'attendance', attendanceDate: latest.attendance_date }
                    : latest.payroll_result_id
                      ? { kind: 'payroll', payrollResultId: latest.payroll_result_id }
                      : null

                return (
                  <tr key={key} style={{ borderTop: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>
                        {issueSubjectLabel(latest)}
                      </div>
                      <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 2 }}>
                        {kind === 'attendance' ? 'Attendance' : 'Payroll'}
                        {chain.length > 1 && ` · ${chain.length} submissions`}
                      </div>
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12.5, color: '#3D4455', minWidth: 220 }}>
                      {latest.reason}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: colors.muted, whiteSpace: 'nowrap' }}>
                      {stamp(latest.reviewed_at ?? latest.created_at)}
                    </td>
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                        fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                        background: tone.bg, color: tone.fg,
                      }}>
                        {employeeStatusLabel(latest.status)}
                      </span>
                    </td>
                    <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => setHistoryKey(key)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 10px', fontSize: 12 }}
                        >
                          View History
                        </button>
                        {/* A decided issue may be raised again; a pending one
                            may not. The old submission is never reopened —
                            this files a new one against the same record. */}
                        {canRaiseIssue(latest) && target && (
                          <button
                            type="button"
                            onClick={() => setRaising(target)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 10px', fontSize: 12 }}
                          >
                            {raiseActionLabel(latest)}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {raising && (
        <RaiseIssueDialog
          initial={raising === 'picking' ? null : raising}
          results={results}
          onClose={() => setRaising(null)}
          onSubmit={submitIssue}
        />
      )}

      {historyChain && (
        <IssueHistoryModal
          chain={historyChain}
          employeeLabel="You"
          onClose={closeHistory}
        />
      )}
    </AttendanceLayout>
  )
}

// ─── The raise dialog ─────────────────────────────────────────────────────────

/**
 * The same Raise Issue form the record pages use, with the record chosen here
 * instead of implied by the row it opened from.
 *
 * `initial` is set when re-raising: the record is already known, so the picker
 * is skipped entirely and the employee only writes the new reason.
 */
function RaiseIssueDialog({
  initial, results, onClose, onSubmit,
}: {
  initial: Target | null
  results: MyResultRow[]
  onClose: () => void
  onSubmit: (target: Target, reason: string) => Promise<string | null>
}) {
  // Today in IST, not in the browser's zone — an employee abroad must not be
  // offered a date the company has not reached.
  const today = useMemo(() => istToday(), [])

  const [kind,     setKind]     = useState<'attendance' | 'payroll'>(initial?.kind ?? 'attendance')
  const [date,     setDate]     = useState(initial?.kind === 'attendance' ? initial.attendanceDate : '')
  const [resultId, setResultId] = useState(initial?.kind === 'payroll' ? initial.payrollResultId : '')

  const chosenResult = results.find(r => r.id === resultId)

  const target: Target | null =
    kind === 'attendance'
      ? (date ? { kind: 'attendance', attendanceDate: date } : null)
      : (resultId ? { kind: 'payroll', payrollResultId: resultId } : null)

  const title = initial
    ? (initial.kind === 'attendance'
        ? initial.attendanceDate
        : (results.find(r => r.id === initial.payrollResultId)
            ? periodLabel(results.find(r => r.id === initial.payrollResultId)!)
            : 'Payroll'))
    : 'Choose the record this is about'

  const summary = !initial && kind === 'payroll' && chosenResult
    ? `Gross ${money(chosenResult.gross_salary)} · Deductions ${money(chosenResult.total_deductions)} · Net payable ${money(chosenResult.net_salary)}`
    : ''

  return (
    <RaiseIssueModal
      subject={{ title, summary }}
      targetChosen={target != null}
      targetPicker={initial ? undefined : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['attendance', 'payroll'] as const).map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`boe-btn ${kind === k ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
                style={{ padding: '5px 12px', fontSize: 12.5 }}
                aria-pressed={kind === k}
              >
                {k === 'attendance' ? 'An attendance day' : 'A payslip'}
              </button>
            ))}
          </div>

          {kind === 'attendance' ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{
                fontSize: 11, fontWeight: 600, color: colors.muted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Which day?
              </span>
              <input
                type="date"
                value={date}
                max={today}
                onChange={e => setDate(e.target.value)}
                className="boe-input"
                style={{ fontSize: 13, padding: '8px 10px' }}
              />
            </label>
          ) : (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{
                fontSize: 11, fontWeight: 600, color: colors.muted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                Which payslip?
              </span>
              <select
                value={resultId}
                onChange={e => setResultId(e.target.value)}
                className="boe-input"
                style={{ fontSize: 13, padding: '8px 10px' }}
              >
                <option value="">Select a month…</option>
                {results.map(r => (
                  <option key={r.id} value={r.id}>{periodLabel(r)}</option>
                ))}
              </select>
              {results.length === 0 && (
                <span style={{ fontSize: 11.5, color: colors.muted }}>
                  No payslip has been generated for you yet.
                </span>
              )}
            </label>
          )}
        </div>
      )}
      onClose={onClose}
      onSubmit={reason => (target ? onSubmit(target, reason) : Promise.resolve('Choose a record first.'))}
    />
  )
}
