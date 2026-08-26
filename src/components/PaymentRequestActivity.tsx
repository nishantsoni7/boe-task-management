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
  // THE SAME WORDS THE BADGES USE (src/lib/finance/paymentDestination.ts).
  // "Order No. Pending" said a Confirmed-Order payment was still waiting for a
  // number it was never going to be given — the destination lives in the
  // allocation ledger, and "unallocated" is what the state actually is.
  approved_unlinked:   'Received — Unallocated',
  approved_linked:     'Received Payment',
  rejected:            'Rejected',
}

function statusLabel(status: unknown): string {
  return (typeof status === 'string' && STATUS_LABEL[status]) || String(status ?? '')
}

// Which of the three submission targets the payment was raised against, read
// from the request_submitted payload (20260715). Absent on rows written before
// that migration, in which case the event reads as it always did.
// 'unallocated' IS DELIBERATELY BLANK, and the suffix is then omitted entirely.
//
// It used to read "New Order", which was already a guess and became a false one:
// submit_payment_request leaves order_id NULL for EVERY destination
// (20261013000000 §3), so payment_target_type reads 'unallocated' on a request
// that names a Confirmed Order just as it does on a Suspense entry. The event
// payload cannot tell them apart — what the request was for lives in its
// allocation intent, which this trail does not read — so the honest thing is to
// say nothing rather than to name the wrong one. The detail modal answers the
// question properly, from finance_payment_destinations.
const TARGET_LABEL: Record<string, string> = {
  unallocated:     '',
  order_request:   'Order Request',
  confirmed_order: 'Confirmed Order',
}

function submittedTargetSuffix(p: Record<string, unknown>): string {
  const target = typeof p.payment_target_type === 'string' ? p.payment_target_type : null
  if (!target) return ''
  const label = TARGET_LABEL[target] ?? target
  if (!label) return ''
  // Name the record, not just the kind — "against Order Request ORD-REQ-…" is
  // what makes the trail answer which one was chosen.
  const named = p.order_request_number ?? p.order_number ?? null
  return typeof named === 'string' && named
    ? ` against ${label} ${named}`
    : ` against ${label}`
}

// One side of a target change, described by what it points at rather than by a
// column name.
function targetSide(type: unknown, requestNumber: unknown, orderNumber: unknown): string {
  const label = typeof type === 'string' ? (TARGET_LABEL[type] ?? type) : 'no target'
  if (typeof requestNumber === 'string' && requestNumber) return `${label} ${requestNumber}`
  if (typeof orderNumber === 'string' && orderNumber)     return `${label} ${orderNumber}`
  return label
}

function eventLabel(row: ActivityRow): string {
  const p = row.payload ?? {}
  switch (row.event_type) {
    case 'request_submitted':  return `Payment Request submitted${submittedTargetSuffix(p)}`
    // A pre-approval correction. Deliberately NOT called a link or an unlink:
    // nothing has been approved yet, so no money has moved anywhere.
    case 'target_changed':
      return `Payment target changed from ${targetSide(p.from_target_type, p.from_order_request_number, p.from_order_number)} to ${targetSide(p.to_target_type, p.to_order_request_number, p.to_order_number)}`
    case 'order_linked':
      // from_order_request_* is present only when the link happened as an
      // automatic transfer during Order Request conversion (20260698).
      return p.from_order_request_number || p.from_order_request_id
        ? `Payment transferred to Confirmed Order ${p.order_number ?? p.order_id ?? ''} from Order Request ${p.from_order_request_number ?? p.from_order_request_id}`
        : `Linked to Order ${p.order_number ?? p.order_id ?? ''}`
    case 'order_unlinked':     return `Unlinked from Order ${p.order_number ?? p.order_id ?? ''}`
    case 'order_request_linked':   return `Linked to Order Request ${p.order_request_number ?? p.order_request_id ?? ''}`
    case 'order_request_unlinked': return `Unlinked from Order Request ${p.order_request_number ?? p.order_request_id ?? ''}`
    case 'order_link_changed': return `Order link changed from ${p.from_order_number ?? p.from_order_id ?? ''} to ${p.to_order_number ?? p.to_order_id ?? ''}`
    // The decision events. Named for what was DECIDED rather than described as a
    // status transition, so the trail never says "received" about money that is
    // still pending, and says "approved" plainly when it is not.
    case 'status_changed': {
      const to = p.to_status
      if (to === 'approved_unlinked' || to === 'approved_linked') return 'Payment request approved'
      if (to === 'needs_clarification')                          return 'Clarification requested'
      if (to === 'rejected')                                     return 'Payment request rejected'
      if (to === 'pending_approval')                             return 'Resubmitted for approval'
      return `Status changed from ${statusLabel(p.from_status)} to ${statusLabel(p.to_status)}`
    }
    // The cash trail (20260716). Names come from the payload, resolved
    // server-side at write time — the timeline never renders a uuid, and never
    // has to join a user table that may since have changed.
    case 'collection_details_updated': return 'Cash collection details updated'
    case 'cash_handover_recorded': {
      const to = typeof p.to_handed_over_to_name === 'string' ? p.to_handed_over_to_name : ''
      // Cleared: the handover was recorded and has been taken back off. Named
      // honestly rather than reported as a handover to nobody.
      if (!p.to_handed_over_to_id) return 'Cash handover cleared'
      return to ? `Cash handed over to ${to}` : 'Cash handover recorded'
    }
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
  if (row.event_type === 'order_request_linked')   return colors.green
  if (row.event_type === 'order_request_unlinked') return colors.amber
  // A pre-approval correction is neither good news nor bad — it is a change the
  // reader should notice.
  if (row.event_type === 'target_changed')         return colors.amber
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
