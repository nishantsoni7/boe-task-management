'use client'

// A month's attendance requests, shown BESIDE the attendance table and never
// merged into it.
//
// The table is what the machine recorded: punches, hours, lateness. This panel
// is what the employee asked for and what an admin decided. They stay apart on
// purpose — an approved request is permission on record, not a punch: it does
// not mark the day present, does not erase lateness, does not grant paid leave
// and does not change a deduction. Whether time is paid is decided in the
// payroll review, through the existing attendance correction.
//
// The requests come with the attendance answer itself
// (/api/attendance/employee-monthly-detail), so both the employee and an admin
// see the same records, including for a month whose attendance has not been
// imported yet.

import { useState } from 'react'
import Link from 'next/link'
import { colors } from '@/lib/tokens'
import {
  REASON_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  SUBMISSION_TIMING_LABEL,
  requestSummary,
  submissionTiming,
  type AttendanceRequestRow,
} from '@/lib/attendance/requests'
import { istDateRange } from '@/lib/istDate'
import { RequestHistoryModal } from './RequestHistoryModal'
import { formatIstDateTime, statusTone } from './format'

export type MonthRequest = AttendanceRequestRow & { decider?: { full_name: string | null } | null }

const isLive = (r: Pick<AttendanceRequestRow, 'status'>) => r.status === 'pending' || r.status === 'approved'

/** Live (pending or approved) requests by each IST date they cover. */
export function requestsByDate(requests: MonthRequest[]): Map<string, MonthRequest[]> {
  const byDate = new Map<string, MonthRequest[]>()
  for (const r of requests) {
    if (!isLive(r)) continue
    for (const d of istDateRange(r.start_date, r.end_date)) {
      const list = byDate.get(d) ?? []
      list.push(r)
      byDate.set(d, list)
    }
  }
  return byDate
}

/** Small status pills for one day of the attendance table. */
export function DayRequestChips({ items }: { items: MonthRequest[] | undefined }) {
  if (!items || items.length === 0) return null
  return (
    <>
      {items.map(r => {
        const tone = statusTone(r.status)
        return (
          <span
            key={r.id}
            title={`${REQUEST_TYPE_LABEL[r.request_type]} · ${requestSummary(r)}`}
            style={{
              display: 'inline-block', marginLeft: 8, padding: '1px 8px', borderRadius: 999,
              fontSize: 11, fontWeight: 700, background: tone.bg, color: tone.fg, whiteSpace: 'nowrap',
            }}
          >
            {REQUEST_STATUS_LABEL[r.status]} · {REQUEST_TYPE_LABEL[r.request_type]}
          </span>
        )
      })}
    </>
  )
}

export function MonthRequestsPanel({
  requests, error, monthLabel, getToken, audience,
}: {
  requests: MonthRequest[]
  /** A failed read is stated, never shown as "no requests". */
  error?: string | null
  monthLabel: string
  getToken: () => Promise<string | null>
  audience: 'employee' | 'admin'
}) {
  const [historyId, setHistoryId] = useState<string | null>(null)

  return (
    <section
      aria-labelledby="month-requests-heading"
      style={{
        marginTop: 16, border: `1px solid ${colors.border}`, borderRadius: 12,
        background: colors.base, padding: 14,
      }}
    >
      <div id="month-requests-heading" style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>
        Requests and permissions{requests.length > 0 ? ` · ${requests.length}` : ''}
      </div>
      <div style={{ fontSize: 12, color: colors.tertiary, marginTop: 2, lineHeight: 1.5 }}>
        Separate from the punches above. An approved request records permission only: it does not
        mark a day present, remove lateness, grant paid leave or change pay.
      </div>

      {error && (
        <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: '#DC2626' }}>
          Requests could not be loaded ({error}). The attendance above is unaffected.
        </div>
      )}

      {!error && requests.length === 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: colors.muted }}>
          No attendance requests for {monthLabel}.
        </div>
      )}

      {requests.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {requests.map(r => {
            const tone = statusTone(r.status)
            const timing = submissionTiming(r)
            return (
              <li
                key={r.id}
                style={{
                  border: `1px solid ${colors.border}`, borderRadius: 10, padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: 3,
                  opacity: isLive(r) ? 1 : 0.8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: colors.primary }}>
                    {REQUEST_TYPE_LABEL[r.request_type]}
                  </div>
                  <span style={{
                    fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: tone.bg, color: tone.fg, whiteSpace: 'nowrap',
                  }}>
                    {REQUEST_STATUS_LABEL[r.status]}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: colors.primary }}>{requestSummary(r)}</div>
                <div style={{ fontSize: 12, color: colors.tertiary }}>
                  {REASON_LABEL[r.reason_code]}{r.reason_note ? ` — ${r.reason_note}` : ''}
                </div>
                <div style={{ fontSize: 11.5, color: timing === 'after_date' ? '#B45309' : colors.muted }}>
                  Submitted {formatIstDateTime(r.submitted_at)} · {SUBMISSION_TIMING_LABEL[timing]}
                </div>
                {r.decided_at && (r.status === 'approved' || r.status === 'rejected') && (
                  <div style={{ fontSize: 11.5, color: colors.muted }}>
                    {REQUEST_STATUS_LABEL[r.status]} by {r.decider?.full_name ?? 'Admin'} · {formatIstDateTime(r.decided_at)}
                    {r.decision_note ? ` — ${r.decision_note}` : ''}
                  </div>
                )}
                {r.status === 'cancelled' && (
                  <div style={{ fontSize: 11.5, color: colors.muted }}>
                    {r.cancel_reason ?? 'Withdrawn'}{r.cancelled_at ? ` · ${formatIstDateTime(r.cancelled_at)}` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                  <button
                    type="button"
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '6px 12px', fontSize: 12.5, minHeight: 36 }}
                    onClick={() => setHistoryId(r.id)}
                  >
                    Details and history
                  </button>
                  {audience === 'admin' && (
                    <Link
                      href={`/attendance/requests?request=${r.id}`}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '6px 12px', fontSize: 12.5, minHeight: 36, display: 'inline-flex', alignItems: 'center' }}
                    >
                      Open in Requests
                    </Link>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {historyId && (
        <RequestHistoryModal requestId={historyId} getToken={getToken} onClose={() => setHistoryId(null)} />
      )}
    </section>
  )
}
