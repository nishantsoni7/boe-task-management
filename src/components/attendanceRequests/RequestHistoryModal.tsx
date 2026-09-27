'use client'

// The audit trail of one request chain — every submission, correction,
// cancellation and decision, with who and when. Read-only; shared by the
// employee's list and the admin queue.

import { useEffect, useState } from 'react'
import { PayrollModal, PayrollModalError } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import { formatIstDateTime } from './format'

type HistoryEvent = {
  id: string
  action: string
  status_from: string | null
  status_to: string
  note: string | null
  created_at: string
  actor: { full_name: string | null } | { full_name: string | null }[] | null
}

const ACTION_LABEL: Record<string, string> = {
  submitted:        'Submitted',
  corrected:        'Correction submitted',
  replaced:         'Replaced by a correction',
  cancelled:        'Cancelled',
  approved:         'Approved',
  rejected:         'Rejected',
  decision_revised: 'Decision changed',
}

export function RequestHistoryModal({
  requestId, getToken, onClose,
}: {
  requestId: string
  getToken: () => Promise<string | null>
  onClose: () => void
}) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      const token = await getToken()
      const res = await fetch(`/api/attendance-requests/${requestId}/history`, {
        headers: { authorization: `Bearer ${token ?? ''}` },
      })
      const json = await res.json().catch(() => ({}))
      if (!live) return
      if (!res.ok) setError(json.error ?? 'Could not load the history.')
      else setEvents(json.events ?? [])
    })()
    return () => { live = false }
  }, [requestId, getToken])

  return (
    <PayrollModal title="Request history" onClose={onClose} width={440}>
      {error && <PayrollModalError message={error} />}
      {!events && !error && <div style={{ fontSize: 13, color: colors.muted }}>Loading…</div>}
      {events && (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {events.map(e => {
            const actor = Array.isArray(e.actor) ? e.actor[0] : e.actor
            return (
              <li key={e.id} style={{ borderLeft: `3px solid ${colors.border}`, paddingLeft: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.primary }}>
                  {ACTION_LABEL[e.action] ?? e.action}
                </div>
                <div style={{ fontSize: 12, color: colors.tertiary }}>
                  {formatIstDateTime(e.created_at)} · {actor?.full_name ?? 'System'}
                </div>
                {e.note && <div style={{ fontSize: 12.5, color: colors.primary, marginTop: 2 }}>{e.note}</div>}
              </li>
            )
          })}
        </ol>
      )}
    </PayrollModal>
  )
}
