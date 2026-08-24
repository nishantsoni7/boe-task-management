import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { PROOF_BUCKET } from '@/lib/paymentProof'
import {
  PAYMENT_DELETE_RETRY_MESSAGE,
  classifyPaymentDeletionError,
  type PaymentDeletionCode,
} from '@/lib/finance/paymentDeletionProtocol'

// Deleting one unapproved payment, together with its proof objects.
//
// WHY A ROUTE AND NOT A DELETE FROM THE BROWSER
// ---------------------------------------------
// The proof objects live in the private payment-proofs bucket, and the storage
// policy that authorises removing an orphaned one resolves ownership THROUGH the
// payment row — which, by the time the object is orphaned, is gone. So the sweep
// needs the service role, which must never be within reach of browser code.
//
// THE DEFECT THIS EXISTS TO PREVENT
// ----------------------------------
// The previous sequence deleted the payment and then removed its objects.
// payment_proof_attachments cascades with the payment (20260672), so a storage
// failure arrived at the one moment when the trusted list of object keys had
// ALREADY BEEN DESTROYED. Nothing could retry, because nothing could still say
// what to retry, and the application called it a partial success.
//
// Reversing the order is no better: removing the files first destroys the
// evidence for a payment that may then turn out to be undeletable.
//
// So the manifest is written down BEFORE either system is touched, into a claim
// row that outlives the payment:
//
//   1. authenticate;
//   2. validate the payment id;
//   3. confirm the service role is configured, so the sweep is ATTEMPTABLE
//      before anything is frozen;
//   4. begin_finance_payment_deletion — authorize, lock, refuse verified money,
//      FREEZE verification, proof mutation and allocation, and return the frozen
//      manifest. A standing claim is RESUMED rather than refused, which is what
//      makes the whole operation retryable;
//   5. remove exactly the keys the manifest names, with the service role, and
//      report each confirmed removal back to the claim as it lands;
//   6. finalize_finance_payment_deletion — refuses while any object survives,
//      then deletes the payment with the release trigger firing inside the same
//      statement, and keeps the claim as the record that it happened.
//
// EVERY KEY IS DERIVED, NEVER RECEIVED. The one input is a payment id. The paths
// come from the claim, which read them from payment_proof_attachments; the route
// re-checks that each one is under that payment's own prefix before asking
// storage to remove it, because a module that deletes objects with the service
// role does not get to assume anything about where they point.
//
// NOTHING IS REPORTED AS DELETED UNTIL IT IS. A sweep that leaves an object
// behind returns a RETRYABLE failure with the claim still standing — the next
// attempt resumes from the same manifest and removes the difference.

type Failure = { code: PaymentDeletionCode; status: number; detail?: unknown }

const fail = ({ code, status, detail }: Failure) =>
  NextResponse.json({ ok: false, code, ...(detail === undefined ? {} : { detail }) }, { status })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const HTTP_FOR: Partial<Record<PaymentDeletionCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  APPROVED: 409,
  CLAIM_INVALID: 409,
  PROOF_PENDING: 409,
  IN_PROGRESS: 409,
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail({ code: 'UNAUTHORIZED', status: 401 })

  let paymentId: unknown
  try {
    ({ paymentId } = await req.json() as { paymentId?: unknown })
  } catch {
    return fail({ code: 'DELETE_FAILED', status: 400 })
  }
  if (typeof paymentId !== 'string' || !UUID_RE.test(paymentId)) {
    return fail({ code: 'DELETE_FAILED', status: 400 })
  }

  // Step 3. The sweep must be ATTEMPTABLE before anything is frozen. A missing
  // service key is a deployment fault, and discovering it with a claim already
  // standing would freeze a payment nobody can then finish deleting.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return fail({ code: 'STORAGE_UNAVAILABLE', status: 500 })
  const service = createServiceClient(url, serviceKey)

  // Step 4. Authorize, freeze, and take the manifest. Run as the signed-in USER
  // so auth.uid(), the ownership rule and the admin check all apply to them.
  const { data: claim, error: claimErr } = await authClient.rpc(
    'begin_finance_payment_deletion', { p_payment_id: paymentId })
  if (claimErr) {
    const code = classifyPaymentDeletionError(claimErr)
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
  }

  const reservation = claim as {
    claim_token?: string
    storage_paths?: string[]
    storage_removed?: string[]
  } | null
  const claimToken = reservation?.claim_token
  if (!claimToken) return fail({ code: 'DELETE_FAILED', status: 500 })

  const manifest = reservation?.storage_paths ?? []
  const already = new Set(reservation?.storage_removed ?? [])

  // WHAT IS LEFT TO DO, not what was there to begin with. A resumed deletion
  // sweeps only the difference, so an object storage already confirmed gone is
  // never asked about twice.
  const outstanding = manifest.filter(path => !already.has(path))

  // EVERY KEY RE-CHECKED AGAINST ITS OWN PAYMENT'S PREFIX. buildProofPath writes
  // `{paymentId}/…` and the migration asserts the convention holds across every
  // existing row — this is the same rule applied one more time, at the moment it
  // matters, so a manifest that somehow named an object elsewhere cannot make
  // the service role reach it.
  const confined = outstanding.filter(path => path.startsWith(`${paymentId}/`))
  if (confined.length !== outstanding.length) {
    return fail({ code: 'DELETE_FAILED', status: 500 })
  }

  // Step 5. Remove them, and tell the claim what actually went.
  if (confined.length > 0) {
    const { data: removed, error: rmErr } = await service.storage
      .from(PROOF_BUCKET).remove(confined)

    // A key storage confirms is recorded even when others failed, so the next
    // attempt has less to do rather than the same amount.
    const confirmed = (removed ?? []).map(entry => entry.name).filter(Boolean)
    if (confirmed.length > 0) {
      await authClient.rpc('record_finance_payment_proof_removed', {
        p_payment_id: paymentId, p_claim_token: claimToken, p_removed: confirmed,
      })
    }

    if (rmErr || confirmed.length < confined.length) {
      // THE CLAIM STANDS. The payment, its allocations and every object still in
      // the bucket are exactly as they were; retrying resumes from the manifest.
      return fail({
        code: 'STORAGE_INCOMPLETE',
        status: 502,
        detail: { removed: confirmed.length, outstanding: confined.length - confirmed.length },
      })
    }
  }

  // Step 6. The point of no return, on the claim that froze the payment.
  const { data: result, error: finErr } = await authClient.rpc(
    'finalize_finance_payment_deletion',
    { p_payment_id: paymentId, p_claim_token: claimToken })
  if (finErr) {
    const code = classifyPaymentDeletionError(finErr)
    return fail({ code, status: HTTP_FOR[code] ?? 500, detail: { retry: PAYMENT_DELETE_RETRY_MESSAGE } })
  }

  const counts = result as { allocations_released?: number; already_deleted?: boolean } | null
  return NextResponse.json({
    ok: true,
    paymentId,
    allocationsReleased: counts?.allocations_released ?? 0,
    alreadyDeleted: counts?.already_deleted === true,
    proofsRemoved: manifest.length,
  })
}
