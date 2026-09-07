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

// ── Order Requests: retired ───────────────────────────────────────────────────
//
// `notifyOrders` and the six `order_*` events it sent lived here. Every one of
// them announced a step in the Order Request workflow — submitted, reassigned,
// clarification, resubmitted, rejected, converted — and that workflow is
// retired (20261007000000): there is no longer an action that could raise one.
//
// The helper is gone rather than left unused, because a fire-and-forget
// notifier nothing calls is an invitation to call it. HISTORICAL NOTIFICATIONS
// ARE UNTOUCHED: the rows stay in `notifications`, getNotificationMeta still
// badges and deep-links them, and their links land on the retired-workflow
// notice at /orders/requests/[id], which offers PI Drafts and — where the
// request was converted before the retirement — the Confirmed Order it became.
//
// The PI workflow's own notifications are below, and are unaffected.

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
  // A revised PI on a Confirmed Order (20261119000000): proposed → the people
  // who may decide it; approved / rejected → whoever proposed it. Same contract.
  | 'pi_revision_proposed'
  | 'pi_revision_approved'
  | 'pi_revision_rejected'

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
