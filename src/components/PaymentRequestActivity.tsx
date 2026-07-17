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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Activity
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '10px',
        background: colors.raised, border: `1px solid ${colors.border}`,
        borderRadius: '8px', padding: '12px 14px', maxHeight: '220px', overflowY: 'auto',
      }}>
        {rows.map(row => (
          <div key={row.id} style={{ fontSize: '12.5px', lineHeight: 1.5 }}>
            <div style={{ color: colors.primary, fontWeight: 600 }}>{eventLabel(row)}</div>
            <div style={{ color: colors.muted, fontSize: '11.5px' }}>
              {actorName(row.actor)} · {fmtDateTime(row.created_at)}
            </div>
            {typeof row.payload?.note === 'string' && row.payload.note && (
              <div style={{ color: colors.secondary, marginTop: '2px' }}>{row.payload.note}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
