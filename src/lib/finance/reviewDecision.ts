// "Needs clarification" and "Reject" from the Payment Requests review — through
// the doors, never a table write (launch audit, PR #172, 20261219000000).
//
// The review modal used to send both as a direct UPDATE of
// finance_payment_requests. Production refuses that: the Order/Finance reset
// guard on the table runs as the caller and calls functions a signed-in
// employee may not execute, so both actions failed. They now go through the
// SECURITY DEFINER doors that lock the row and re-check the verifier:
//
//   needs_clarification → request_finance_payment_clarification (20261219000000),
//                         which answers `changed: false` when the payment is no
//                         longer pending;
//   reject              → reject_finance_payment_request (20261211000000), which
//                         refuses a payment that is no longer pending.
//
// Either way a decision somebody else already took is reported as STALE — and
// the caller notifies the creator only on `changed`.

export type SendBackOrRejectAction = 'needs_clarification' | 'reject'

export type ReviewDecisionOutcome =
  | { kind: 'changed' }
  | { kind: 'stale' }
  | { kind: 'refused'; message: string }

export const REVIEW_STALE_MESSAGE =
  'This request is no longer awaiting a decision — someone may have acted on it already. Refresh to see where it stands.'

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>
}

export function reviewDecisionErrorMessage(error: { message?: string; code?: string } | null | undefined): string {
  const m = error?.message ?? ''
  if (!error || typeof error.code !== 'string' || error.code.trim() === '') {
    return 'The connection dropped before Finance answered. Refresh to see whether the decision was recorded before trying again.'
  }
  if (m.includes('PAYMENT_SELF_DECISION_FORBIDDEN')) {
    return 'You recorded this payment, so another payment verifier must decide it.'
  }
  if (m.includes('Only a payment verifier')) {
    return 'Only a payment verifier can send back or reject a payment.'
  }
  if (m.includes('PAYMENT_REJECTION_REASON_REQUIRED') || m.includes('PAYMENT_CLARIFICATION_NOTE_REQUIRED')) {
    return 'Add a note for the person who recorded this payment before confirming.'
  }
  if (m.includes('Authentication required')) {
    return 'Your session has ended. Sign in again to decide this payment.'
  }
  return 'Could not record the decision. Please try again.'
}

export async function sendBackOrReject(
  client: RpcClient,
  input: { requestId: string; action: SendBackOrRejectAction; note: string },
): Promise<ReviewDecisionOutcome> {
  const note = input.note.trim()
  if (input.action === 'needs_clarification') {
    const { data, error } = await client.rpc('request_finance_payment_clarification', {
      p_request_id: input.requestId,
      p_note: note,
    })
    if (error) return { kind: 'refused', message: reviewDecisionErrorMessage(error) }
    return (data as { changed?: unknown } | null)?.changed === true ? { kind: 'changed' } : { kind: 'stale' }
  }

  const { error } = await client.rpc('reject_finance_payment_request', {
    p_request_id: input.requestId,
    p_reason: note,
  })
  if (error) {
    if ((error.message ?? '').includes('Only a pending payment request can be rejected')) return { kind: 'stale' }
    return { kind: 'refused', message: reviewDecisionErrorMessage(error) }
  }
  return { kind: 'changed' }
}
