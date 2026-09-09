'use client'

import { useEffect, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import {
  paymentActivityLabel,
  type ActivityTargetResolver,
} from '@/lib/finance/paymentActivityLabels'

// Read-only activity timeline for a Finance payment request. Renders nothing
// while loading or when there are no entries yet, so it can be dropped into
// any details/review modal without extra guards — same convention as
// PaymentProofView.
//
// THE WORDS ARE NOT THIS COMPONENT'S. Every row is named by
// paymentActivityLabel, a pure function with its own tests, so the two Finance
// detail surfaces cannot drift into describing the same audit row differently
// — and so a raw `event_type` can never reach a reader through either of them.

type ActivityRow = {
  id: string
  event_type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>
  created_at: string
  actor: { full_name: string } | { full_name: string }[] | null
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${date}, ${time}`
}

function actorName(actor: ActivityRow['actor']): string {
  const a = Array.isArray(actor) ? actor[0] : actor
  // A null actor means no logged-in user was attributed (a system/service
  // action). Shown honestly as "System" rather than as an unknown employee.
  return a?.full_name ?? 'System'
}

// Subtle timeline marker colour derived from the event — informative, not
// decorative. Purely visual; never changes the event data or ordering.
function markerColor(row: ActivityRow): string {
  if (row.event_type === 'status_changed') {
    const to = row.payload?.to_status
    if (to === 'rejected')            return colors.red
    if (to === 'needs_clarification') return colors.blue
    if (to === 'approved_unlinked' || to === 'approved_linked') return colors.green
  }
  if (row.event_type === 'order_linked')   return colors.green
  if (row.event_type === 'order_unlinked') return colors.amber
  if (row.event_type === 'order_request_linked')   return colors.green
  if (row.event_type === 'order_request_unlinked') return colors.amber
  // A pre-approval correction is neither good news nor bad — it is a change the
  // reader should notice.
  if (row.event_type === 'target_changed')         return colors.amber
  // Money finding a home is the good outcome; taking it back off, and moving it
  // from a PI onto the Order that PI became, are both changes worth noticing.
  if (row.event_type === 'allocation_created')  return colors.green
  if (row.event_type === 'allocation_reversed') return colors.amber
  if (row.event_type === 'allocation_moved')    return colors.blue
  // A completed handover is the outcome the business waits for; clearing one is
  // a change worth noticing. Colour is never the only signal — the event text
  // above says which of the two happened.
  if (row.event_type === 'cash_handover_recorded') {
    return row.payload?.to_handed_over_to_id ? colors.green : colors.amber
  }
  return colors.muted
}

export function PaymentRequestActivity({
  supabase,
  paymentRequestId,
  resolveTarget,
  heading,
}: {
  supabase: ReturnType<typeof createClient>
  paymentRequestId: string
  /**
   * Replaces the default "Activity" label — and, like it, is drawn only once
   * there are entries to draw it over. A host that wants a divider above the
   * section passes it in here rather than wrapping this component, because
   * whether there is anything to divide is known here and nowhere else.
   */
  heading?: React.ReactNode
  /**
   * Names an allocation's target from records the HOST has already loaded.
   *
   * Optional, and absent is not a defect: the allocation events carry uuids
   * only, so without a resolver they read "Payment allocated to a Confirmed
   * Order" — true, just less specific. No extra query is issued either way.
   */
  resolveTarget?: ActivityTargetResolver
}) {
  const [rows,    setRows]    = useState<ActivityRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      const { data } = await supabase
        .from('finance_payment_request_activity_log')
        .select('id, event_type, payload, created_at, actor:users!actor_id(full_name)')
        .eq('payment_request_id', paymentRequestId)
        .order('created_at', { ascending: false })
      if (!active) return
      setRows((data as ActivityRow[] | null) ?? [])
      setLoading(false)
    })()
    return () => { active = false }
  }, [supabase, paymentRequestId])

  if (loading || rows.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {heading ?? (
        <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Activity
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((row, idx) => {
          const isLast = idx === rows.length - 1
          const note = typeof row.payload?.note === 'string' ? row.payload.note : ''
          return (
            <div key={row.id} style={{ display: 'flex', gap: '12px' }}>
              {/* Marker + connector */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: markerColor(row), marginTop: '4px' }} />
                {!isLast && <span style={{ width: '1px', flex: 1, background: colors.border, marginTop: '3px' }} />}
              </div>
              {/* Content */}
              <div style={{ minWidth: 0, paddingBottom: isLast ? 0 : '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, lineHeight: 1.4 }}>{paymentActivityLabel(row, resolveTarget)}</div>
                <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
                  {actorName(row.actor)} · {fmtDateTime(row.created_at)}
                </div>
                {note && (
                  <div style={{ fontSize: '13px', color: colors.secondary, marginTop: '4px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {note}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
