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
  'order_dispatch_recorded',
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

// ── WHICH EVENTS THE ACTIVITY SECTION SHOWS (owner, 2026-10-27) ──────────────
//
// "Only the main activity": what was modified, updated, approved or rejected —
// not every step of bookkeeping (an order number reserved, product codes
// assigned, payments moved, a reviewer assigned, a document generated). The
// minor events are NOT deleted: the full trail is still recorded, and the
// section offers it behind "Show minor events".
//
// An event is MAIN when it is one of the Order's decisions or changes:
//   · created, status changed, cancelled
//   · a PI approved, rejected, revised, replaced, corrected
//   · the Order, its client details, schedule or terms amended
//   · production alignment, operations' acceptance / refusal / withdrawal
//   · a payment verified or rejected, an advance hold or exception
//   · a document or fabric / finish approval accepted, rejected or amended

/** Order-side events that are bookkeeping, whatever else their name says. */
const MINOR_ORDER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'note_added',
  'payment_linked',
  'payment_unlinked',
  'operations_handoff_recorded',
  'operations_reviewer_assigned',
  'operations_reviewer_unassigned',
  'factory_focus_selected',
  'factory_focus_removed',
])

/** A type that names a decision or a change reads as main. */
const MAIN_ORDER_TYPE_PATTERN = /(_accepted|_rejected|_refused|_amended|_approved|_withdrawn|_clarification|_realigned|_cancel|_decided|_changed|_updated|_reopened|approval)/

/** The source PI's trail is worded: these words mark a decision or a change. */
const MAIN_PI_LABEL_PATTERN = /(approved|rejected|refused|replaced|updated|amended|changes requested|correction requested|verified|exception|confirmed order created)/i

export function isMainActivityEvent(input: {
  source: 'order' | 'pi'
  label: string
  eventType?: string | null
}): boolean {
  if (input.source === 'order' && input.eventType) {
    const type = input.eventType
    if (MINOR_ORDER_EVENT_TYPES.has(type)) return false
    return KEY_ORDER_EVENT_TYPES.has(type) || MAIN_ORDER_TYPE_PATTERN.test(type)
  }
  return MAIN_PI_LABEL_PATTERN.test(input.label.trim())
}
