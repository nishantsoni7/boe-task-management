// Fire-and-forget notification triggers for Finance & Order Management.
//
// These reuse the shared `notifications` table through small server routes that
// mirror the Samples notify pattern (see src/app/api/samples/notify/route.ts).
// Recipients and the actor-skip are resolved server-side; the client only
// supplies the business context.
//
// Both helpers swallow and log their own errors: a notification problem must
// never fail the underlying business action, which has already succeeded by the
// time these are called.

export type FinanceNotifyEvent =
  | 'finance_submitted'
  | 'finance_resubmitted'
  | 'finance_clarification'
  | 'finance_approved_suspense'
  | 'finance_approved_linked'
  | 'finance_rejected'
  | 'finance_linked'
  | 'finance_status_corrected'

export type FinanceNotifyPayload = {
  event: FinanceNotifyEvent
  requestNumber: string
  /** The payment-request UUID — stored as entity_id for exact deep-linking. */
  entityId?: string | null
  clientName?: string | null
  /** The request creator (submitted_by) — notified for outcome events. */
  creatorId?: string | null
  orderNumber?: string | null
  statusLabel?: string | null
}

export async function notifyFinance(payload: FinanceNotifyPayload): Promise<void> {
  try {
    const res = await fetch('/api/finance/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      // Non-fatal: the business action already succeeded. Surface enough to
      // debug a swallowed notify (HTTP status + event + server error message)
      // without logging the full payload or any secrets. A missing enum value
      // (unapplied migration) shows up here as a 500 with the PG error text.
      const detail = await res.json().catch(() => null)
      console.error(`[notifyFinance] ${payload.event} not delivered (HTTP ${res.status}):`, detail?.error ?? res.statusText)
    }
  } catch (err) {
    console.error('[notifyFinance] failed:', err)
  }
}

export type OrderNotifyEvent =
  | 'order_submitted'
  | 'order_reassigned'
  | 'order_clarification'
  | 'order_resubmitted'
  | 'order_rejected'
  | 'order_converted'

export type OrderNotifyPayload = {
  event: OrderNotifyEvent
  requestNumber: string
  /** The order-request UUID — stored as entity_id for exact deep-linking. */
  entityId?: string | null
  clientName?: string | null
  /** The request creator (requested_by) — notified for outcome events. */
  creatorId?: string | null
  /** The assigned reviewer/user — notified on submit and conversion. */
  assignedTo?: string | null
  orderNumber?: string | null
}

// Returns true when the notification was accepted by the API, false on any
// failure. NEVER throws — a notification is always non-fatal to the action that
// triggered it, so callers can `void` it (fire-and-forget) OR await the boolean
// to surface a soft "created, but not notified" message. A false result must not
// roll back or fail the underlying action.
export async function notifyOrders(payload: OrderNotifyPayload): Promise<boolean> {
  try {
    const res = await fetch('/api/orders/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      // Non-fatal: mirrors notifyFinance — log HTTP status + event + server
      // error so a swallowed notify (e.g. unapplied enum migration) is visible.
      const detail = await res.json().catch(() => null)
      console.error(`[notifyOrders] ${payload.event} not delivered (HTTP ${res.status}):`, detail?.error ?? res.statusText)
      return false
    }
    return true
  } catch (err) {
    console.error('[notifyOrders] failed:', err)
    return false
  }
}

// ── PI submissions: the reduced-payment exception ─────────────────────────────
//
// The same fire-and-forget shape, for the one workflow Phase 3 introduces: a
// salesperson asks to confirm an Order below the standard verified-payment
// requirement, and an authorised approver accepts or refuses it.
//
// THE PAYLOAD IS ONE ID. The client name, the submission's owner and the set of
// people who may decide are all resolved server-side — a browser that could name
// its own recipients could notify anybody.

export type PiSubmissionNotifyEvent =
  | 'pi_exception_requested'
  | 'pi_exception_approved'
  | 'pi_exception_rejected'
  // The owner's correction request and its answer (20260930000000). Same
  // contract as the three above: the payload is one id, and the recipients are
  // resolved server-side from the database's own authority.
  | 'pi_correction_requested'
  | 'pi_correction_resolved'
  | 'pi_correction_rejected'

export type PiSubmissionNotifyPayload = {
  event: PiSubmissionNotifyEvent
  /** order_submissions.id — also stored as entity_id for exact deep-linking. */
  submissionId: string
}

export async function notifyPiSubmission(payload: PiSubmissionNotifyPayload): Promise<boolean> {
  try {
    const res = await fetch('/api/orders/submissions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      console.error(`[notifyPiSubmission] ${payload.event} not delivered (HTTP ${res.status}):`, detail?.error ?? res.statusText)
      return false
    }
    return true
  } catch (err) {
    console.error('[notifyPiSubmission] failed:', err)
    return false
  }
}
