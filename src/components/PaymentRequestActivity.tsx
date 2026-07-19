'use client'

import { useEffect, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'

// Read-only activity timeline for a Finance payment request. Renders nothing
// while loading or when there are no entries yet, so it can be dropped into
// any details/review modal without extra guards — same convention as
// PaymentProofView.

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

const STATUS_LABEL: Record<string, string> = {
  pending_approval:    'Pending Review',
  needs_clarification: 'Needs Clarification',
  approved_unlinked:   'Received — Order No. Pending',
  approved_linked:     'Received — Order No. Added',
  rejected:            'Rejected',
}

function statusLabel(status: unknown): string {
  return (typeof status === 'string' && STATUS_LABEL[status]) || String(status ?? '')
}

function eventLabel(row: ActivityRow): string {
  const p = row.payload ?? {}
  switch (row.event_type) {
    case 'request_submitted':  return 'Payment Request submitted'
    case 'order_linked':       return `Linked to Order ${p.order_number ?? p.order_id ?? ''}`
    case 'order_unlinked':     return `Unlinked from Order ${p.order_number ?? p.order_id ?? ''}`
    case 'order_link_changed': return `Order link changed from ${p.from_order_number ?? p.from_order_id ?? ''} to ${p.to_order_number ?? p.to_order_id ?? ''}`
    case 'status_changed':     return `Status changed from ${statusLabel(p.from_status)} to ${statusLabel(p.to_status)}`
    default:                   return row.event_type
  }
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
  return colors.muted
}

export function PaymentRequestActivity({
  supabase,
  paymentRequestId,
}: {
  supabase: ReturnType<typeof createClient>
  paymentRequestId: string
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
      <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Activity
      </div>
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
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, lineHeight: 1.4 }}>{eventLabel(row)}</div>
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
