'use client'

// The admin side of "Raise Issue": what employees have reported, and the two
// things an admin can do about the report itself.
//
// Deliberately NOT a module. It is a panel dropped into the admin screens that
// already exist — attendance objections on the correction log, payroll
// objections on the period results — because an objection is only ever read
// alongside the record it disputes.
//
// Resolving or rejecting changes the OBJECTION and nothing else. If the
// employee was right, the admin still makes the correction through the existing
// correction workflow on the same screen, which keeps its own audit trail. That
// separation is enforced in the database: review_employee_record_objection()
// touches four columns of one row and cannot reach attendance or payroll.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { colors } from '@/lib/tokens'
import { IssueHistoryModal } from '@/components/objections/IssueHistoryModal'
import {
  employeeStatusLabel,
  statusTone,
  groupIssueChains,
  issueChainKey,
  payrollPeriodScopeQuery,
  type ObjectionRow,
  type PayrollPeriodScope,
} from '@/lib/objections'

type Subject = 'attendance' | 'payroll'

type Row = ObjectionRow & { employee?: { full_name?: string | null; employee_code?: string | null } | null }

export function ObjectionQueue({
  subject, token, title, emptyLabel, period,
}: {
  subject: Subject
  /** Bearer token of the signed-in admin. */
  token: string
  title: string
  emptyLabel: string
  /**
   * The payroll run whose issues these are. Payroll only.
   *
   * Given, the list is exactly that run's — resolved server-side through
   * payroll_result_id → payroll_period_id, never by month text — and the panel
   * stays on screen when the run has no issues, because "August has none" and
   * "we did not ask about August" are different statements and only one of them
   * is safe to make silently.
   *
   * Omitted (the attendance correction log, which is keyed by date and not by a
   * run), the behaviour is unchanged: the whole list, hidden when empty.
   */
  period?: PayrollPeriodScope
}) {
  const [rows,    setRows]    = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId,  setBusyId]  = useState<string | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [historyKey, setHistoryKey] = useState<string | null>(null)

  // A period turns the request into "this run's issues"; without one the
  // endpoint answers with everything, as the attendance queue needs.
  const scopeQuery = period ? payrollPeriodScopeQuery(period) : ''

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    const url = scopeQuery ? `/api/objections?${scopeQuery}` : '/api/objections'
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error ?? 'Could not load reported issues'); setLoading(false); return }

    const all: Row[] = json.objections ?? []
    setRows(all.filter(o => (subject === 'attendance' ? o.attendance_date : o.payroll_result_id)))
    setLoading(false)
  }, [token, subject, scopeQuery])

  useEffect(() => { void load() }, [load])

  const review = async (id: string, status: 'approved' | 'rejected') => {
    // A rejection without a word back is a dead end for the employee, so the
    // note is asked for here rather than being optional in the UI.
    const note = status === 'rejected'
      ? window.prompt('Why is this being rejected? The employee sees this.')
      : window.prompt('Note for the employee (optional):') ?? ''
    if (status === 'rejected' && !note?.trim()) return

    setBusyId(id)
    setError(null)
    const res = await fetch('/api/objections/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ objection_id: id, status, review_note: note }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) setError(json.error ?? 'Could not update that issue.')
    else await load()
    setBusyId(null)
  }

  const pending = rows.filter(r => r.status === 'pending')

  // An employee may raise the same matter again after a decision, so a row in
  // this queue can be the second or third attempt at one record. The admin
  // deciding it needs the earlier decisions in front of them — otherwise the
  // same reason gets rejected twice for reasons nobody can see.
  const chains = useMemo(() => groupIssueChains(rows), [rows])
  const historyChain = historyKey ? chains.get(historyKey) : undefined
  const employeeOfChain = historyChain?.[0]?.employee?.full_name ?? 'Employee'

  if (loading) return null
  // An unscoped queue disappears when there is nothing in it. A scoped one must
  // not: an admin looking at a payroll run has to be able to tell "no issues
  // were reported for this run" apart from "the section is somewhere else".
  if (rows.length === 0 && !period) return null

  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: 12,
      background: colors.base, marginBottom: 20, overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318' }}>{title}</div>
        {pending.length > 0 && (
          <span style={{
            padding: '2px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
            background: statusTone('pending').bg, color: statusTone('pending').fg,
          }}>
            {pending.length} awaiting review
          </span>
        )}
      </div>

      {error && (
        <div role="alert" style={{
          padding: '9px 16px', fontSize: 12.5, color: '#C13030',
          background: 'rgba(217,79,79,0.08)',
        }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ padding: '20px 16px', fontSize: 13, color: colors.muted }}>{emptyLabel}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Employee', subject === 'attendance' ? 'Date' : 'Period', 'Issue', 'Submitted', 'Status', ''].map((h, i) => (
                  <th key={h || `a${i}`} style={{
                    textAlign: 'left', padding: '9px 16px', fontSize: 11, fontWeight: 600,
                    color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td style={{ padding: '10px 16px', fontSize: 12.5, color: '#111318', whiteSpace: 'nowrap' }}>
                    {r.employee?.full_name ?? '—'}
                    {r.employee?.employee_code && (
                      <span style={{ color: colors.muted }}> · {r.employee.employee_code}</span>
                    )}
                  </td>
                  {/* The snapshot, so the row still reads sensibly after the
                      day it disputes has been corrected. */}
                  <td style={{ padding: '10px 16px', fontSize: 12.5, color: '#3D4455', whiteSpace: 'nowrap' }}>
                    {r.attendance_date ?? r.subject_snapshot.split(' · ')[0]}
                  </td>
                  <td style={{ padding: '10px 16px', fontSize: 12.5, color: '#3D4455', minWidth: 220 }}>
                    {r.reason}
                    <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
                      As recorded: {r.subject_snapshot}
                    </div>
                    {r.review_note && (
                      <div style={{ fontSize: 11, color: '#3B63B8', marginTop: 3 }}>
                        Reply: {r.review_note}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 16px', fontSize: 12, color: colors.muted, whiteSpace: 'nowrap' }}>
                    {new Date(r.created_at).toLocaleDateString('en-IN')}
                  </td>
                  <td style={{ padding: '10px 16px' }}>
                    <span style={{
                      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
                      fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
                      background: statusTone(r.status).bg, color: statusTone(r.status).fg,
                    }}>
                      {employeeStatusLabel(r.status)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {r.status === 'pending' && (
                        <>
                          <button
                            onClick={() => void review(r.id, 'approved')}
                            disabled={busyId === r.id}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 10px', fontSize: 12 }}
                          >
                            Resolve
                          </button>
                          <button
                            onClick={() => void review(r.id, 'rejected')}
                            disabled={busyId === r.id}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 10px', fontSize: 12 }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setHistoryKey(issueChainKey(r))}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                      >
                        History
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {historyChain && (
        <IssueHistoryModal
          chain={historyChain}
          employeeLabel={employeeOfChain}
          onClose={() => setHistoryKey(null)}
        />
      )}
    </div>
  )
}
