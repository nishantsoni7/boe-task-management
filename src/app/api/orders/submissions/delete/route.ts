import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { classifyDeletionError, type SubmissionDeletionCode } from '@/lib/orders/submissionDeletion'
import {
  SUBMISSION_ID_RE,
  removeAllObjectsForSubmission,
} from '@/lib/orders/submissionFilesServer'

// Permanently deleting one PI submission, together with its stored files.
//
// WHY A ROUTE AND NOT A PLAIN RPC CALL FROM THE BROWSER
// -----------------------------------------------------
// The storage DELETE policy on order-files admits the owner of a DRAFT only —
// not an administrator, and not anybody deleting a REJECTED PI. Both of those
// are cases this feature exists to serve, so the object removal needs the
// service role, which must never be within reach of browser code.
//
// THE SEQUENCE, AND THE DEFECT IT EXISTS TO PREVENT
// -------------------------------------------------
// Postgres and Supabase Storage cannot share a transaction, so the files are
// removed between two database calls. An earlier version of this route swept
// storage and then deleted the row, which left one intolerable outcome: the
// owner submits the PI from another tab in the gap, the delete is correctly
// refused, and A VALID SUBMITTED PI SURVIVES WITH ITS WORKBOOK AND EVERY PRODUCT
// IMAGE DESTROYED. Silent, permanent, and landing on the reviewer.
//
// The gap is now closed rather than narrowed. The record is RESERVED before a
// byte is touched, and while the reservation stands no caller — through any
// route, including direct SQL and the service role — can submit, resubmit,
// replace, review or otherwise transition it:
//
//   1. authenticate the caller;
//   2. validate the submission id;
//   3. confirm the service role is configured, so cleanup is ATTEMPTABLE before
//      anything is reserved or destroyed;
//   4. begin_order_submission_deletion — authorize, verify status, RESERVE, and
//      receive the storage keys the record owns, read from the database and
//      never from anything the browser sent;
//   5. remove those objects with the service role;
//   6. finalize_order_submission_deletion, on the claim. It cannot be refused by
//      an ordinary status race, because step 4 made one impossible;
//   7. on any storage failure, release_order_submission_deletion — the record and
//      all of its metadata are untouched, so it returns to exactly the state it
//      was in and the whole call retries cleanly.
//
// THE CLAIM TOKEN NEVER REACHES THE BROWSER. It lives in this function's scope
// for the length of one request and is not in any response body.
//
// A CRASHED REQUEST DOES NOT BLOCK A PI FOREVER. The reservation goes stale
// after order_submission_deletion_claim_ttl(), after which another deletion
// attempt takes it over — issuing a new token and invalidating the abandoned
// one — or an owner or admin releases it by hand. Neither is automatic, and
// deliberately so: a reservation left standing after a crash means files MAY
// already be gone, and quietly unfreezing the record would assert something this
// system cannot know. Even then the invariant holds independently, because
// submit_order_submission_* verifies that the workbook and every image still
// exist in storage before it will submit anything.

type Failure = { code: SubmissionDeletionCode; status: number; detail?: unknown }

const fail = ({ code, status, detail }: Failure) =>
  NextResponse.json({ ok: false, code, ...(detail === undefined ? {} : { detail }) }, { status })

/** The HTTP status each refusal deserves. 409 for "the world moved", 403 for authority. */
const HTTP_FOR: Partial<Record<SubmissionDeletionCode, number>> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STATUS_CHANGED: 409,
  IN_PROGRESS: 409,
  CLAIM_INVALID: 409,
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail({ code: 'UNAUTHORIZED', status: 401 })

  let submissionId: unknown
  try {
    ({ submissionId } = await req.json() as { submissionId?: unknown })
  } catch {
    return fail({ code: 'DELETE_FAILED', status: 400 })
  }
  if (typeof submissionId !== 'string' || !SUBMISSION_ID_RE.test(submissionId)) {
    return fail({ code: 'DELETE_FAILED', status: 400 })
  }

  // Step 3. Cleanup must be ATTEMPTABLE before anything is reserved, let alone
  // destroyed. A missing service key is a deployment fault, not a permission
  // one, and it must not be discovered with a claim already standing.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return fail({ code: 'STORAGE_CLEANUP_FAILED', status: 500 })
  const service = createServiceClient(url, serviceKey)

  // Step 4. Authorize and RESERVE. Run as the signed-in USER so auth.uid(), the
  // ownership rule, the admin check and the row lock all apply to them. Nothing
  // has been destroyed if this refuses.
  const { data: claim, error: claimErr } = await authClient.rpc(
    'begin_order_submission_deletion',
    { p_submission_id: submissionId },
  )
  if (claimErr) {
    const code = classifyDeletionError(claimErr)
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
  }

  const reservation = claim as {
    claim_token?: string
    storage_paths?: string[]
  } | null
  const claimToken = reservation?.claim_token
  if (!claimToken) return fail({ code: 'DELETE_FAILED', status: 500 })

  /** Give the record back, whole. Never throws over the error it is reporting. */
  const release = async () => {
    try {
      await authClient.rpc('release_order_submission_deletion', {
        p_submission_id: submissionId,
        p_claim_token: claimToken,
      })
    } catch {
      // The reservation goes stale on its own and the record is intact either
      // way. Throwing here would replace the real failure with a cleanup one.
    }
  }

  // Step 5. Remove the objects. The record is frozen, so nothing can be done to
  // it while this runs and nothing can contradict it afterwards.
  let removal
  try {
    removal = await removeAllObjectsForSubmission(
      service, submissionId, reservation?.storage_paths ?? [])
  } catch {
    await release()
    return fail({ code: 'STORAGE_CLEANUP_FAILED', status: 500 })
  }
  if (removal.failed.length > 0) {
    await release()
    return fail({
      code: 'STORAGE_CLEANUP_FAILED',
      status: 502,
      detail: { removed: removal.removed.length, failed: removal.failed.length },
    })
  }

  // Step 6. The point of no return, on the claim that froze the record.
  const { data: result, error: delErr } = await authClient.rpc(
    'finalize_order_submission_deletion',
    { p_submission_id: submissionId, p_claim_token: claimToken },
  )
  if (delErr) {
    // Near-unreachable: the reservation ruled out every ordinary race. If it
    // happens the claim is released so the record is usable again — its files
    // are gone, which the owner resolves with Change PI, and which
    // submit_order_submission_* refuses to let past review in the meantime.
    await release()
    const code = classifyDeletionError(delErr)
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
  }

  const counts = result as { items?: number; images?: number; activity?: number } | null

  return NextResponse.json({
    ok: true,
    submissionId,
    removedFiles: removal.removed.length,
    items:    counts?.items    ?? 0,
    images:   counts?.images   ?? 0,
    activity: counts?.activity ?? 0,
  })
}
