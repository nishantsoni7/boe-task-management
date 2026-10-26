// ── WHICH ACTIVITY EVENTS ARE KEY EVENTS ─────────────────────────────────────
//
// The Activity section lists every event; a short navigation beside it lists
// the milestones so a reader can jump to them. A milestone is an event that
// changed what the order IS or whether it can proceed: creation, a PI decision,
// an amendment, a status or production change, a payment decision, a hold.
// Notes, links and other bookkeeping are not.
//
// Display only. It decides nothing about the order.

/** Order-side event types (order_activity_log.event_type) that are milestones. */
export const KEY_ORDER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'created',
  'order_created_from_pi_submission',
  'order_created_from_request',
  'status_changed',
  'order_amended',
  'order_client_details_amended',
  'order_schedule_terms_amended',
  'order_workbook_replaced',
  'pi_revision_proposed',
  'pi_revision_approved',
  'pi_revision_rejected',
  'production_alignment_changed',
  'payment_verified',
  'payment_rejected',
  'order_advance_hold_opened',
  'order_advance_exception_approved',
  'order_advance_exception_voided',
])

/** The source PI's own trail is worded, not typed: these words mark its milestones. */
const KEY_PI_LABEL = /^(PI approved|Revised PI (uploaded|approved|rejected)|Payment (verified|rejected) by Finance|Sent to operations|Operations (accepted|flagged)|PI returned|PI rejected)/i

export function isKeyActivityEvent(input: {
  source: 'order' | 'pi'
  label: string
  /** The Order-side event_type, when the entry is the Order's own. */
  eventType?: string | null
}): boolean {
  if (input.source === 'order' && input.eventType) return KEY_ORDER_EVENT_TYPES.has(input.eventType)
  return KEY_PI_LABEL.test(input.label.trim())
}
