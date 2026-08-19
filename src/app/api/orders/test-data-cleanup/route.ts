import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { removeAllObjectsForSubmission } from '@/lib/orders/submissionFilesServer'
import { removeAllObjectsForRequest } from '@/lib/orderRequestAttachmentsServer'

// Test Data Cleanup, as ONE request that owns the whole destructive sequence.
//
// ═══ WHY THIS ROUTE EXISTS AT ALL ═══════════════════════════════════════════
//
// Postgres and Supabase Storage cannot share a transaction, so a cleanup that
// removes files AND rows has a window between them. The first version of this
// feature left the browser to coordinate that window: one call to purge storage,
// then a separate call to delete the rows. That is unsafe in two distinct ways,
// and BOTH of them end in the same place:
//
//   * removeAllObjectsForSubmission() deletes in batches and reports failures
//     AFTERWARDS. A partial success is a real outcome — some files are already
//     gone when the failure is returned.
//   * even a completely successful sweep is followed by a SEPARATE database
//     call, which can refuse: cleanup disabled meanwhile, eligibility changed, a
//     dropped connection, a lost response, a closed laptop.
//
// AN APPROVED PI THEN SURVIVES WITH ITS WORKBOOK AND PRODUCT IMAGES DESTROYED.
// Silent, permanent, and indistinguishable from a healthy record until somebody
// opens it. It is the same defect 20260914000000 exists to prevent for ordinary
// PI deletion, and it has the same remedy: a DURABLE CLAIM.
//
// ═══ THE SEQUENCE ═══════════════════════════════════════════════════════════
//
//   1. begin_test_data_cleanup(root, reason, confirmation)
//        every gate, the chain resolved, the rows locked, the provenance pair
//        proved, the permanent audit written, and a durable claim taken. The
//        Order and the PI are FROZEN. Nothing is destroyed.
//   2. remove the Order Request attachments and the PI files, with the bounded,
//      fully-settled sweeps. Both read their keys FROM THE DATABASE.
//   3a. everything gone -> finalize_test_data_cleanup(token).
//   3b. nothing removed  -> release_test_data_cleanup(token): the records are
//        given back, whole, and the audit records that it was released.
//   3c. SOMETHING removed but not all -> THE CLAIM IS KEPT. The rows are
//        untouched and the records stay frozen. Asking again re-claims, removes
//        what is left and finalizes.
//
// THE CLAIM TOKEN NEVER REACHES THE BROWSER. It lives in this function's scope
// for the length of one request and is in no response body.
//
// THE BROWSER SENDS root type, root id, reason and confirmation — and nothing
// else. Never a submission id, never a path list, never a claim token. Every
// destructive target is derived from the database inside the claim.
//
// THERE IS DELIBERATELY NO TIMEOUT. A promise race is not cancellation, and
// storage-js's remove() accepts no AbortSignal: abandoning a request that is
// still deleting objects is how files get lost. The full reasoning is in
// submissionFilesServer.ts. This returns only once every list and every remove
// it started has settled.

/** Above this, one cleanup is worth a line in the server log. */
const SLOW_CLEANUP_MS = 6_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT_TYPES = new Set(['order', 'order_request', 'payment'])

type Body = {
  rootType?: unknown
  rootId?: unknown
  reason?: unknown
  confirmation?: unknown
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  let body: Body
  try {
    body = await req.json() as Body
  } catch {
    return bad('A cleanup request is required.')
  }

  const { rootType, rootId, reason, confirmation } = body
  if (typeof rootType !== 'string' || !ROOT_TYPES.has(rootType)) return bad('Unknown record type.')
  if (typeof rootId !== 'string' || !UUID_RE.test(rootId)) return bad('A valid record id is required.')
  if (typeof reason !== 'string' || reason.trim() === '') return bad('Enter why this test data is being removed.')
  if (typeof confirmation !== 'string') return bad('Type DELETE TEST DATA exactly to confirm.')

  // Cleanup must be ATTEMPTABLE before anything is claimed, let alone destroyed.
  // A missing service key is a deployment fault, not a permission one, and it
  // must not be discovered with a claim already standing.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return bad('Storage cleanup is not configured.', 500)
  const service = createServiceClient(url, serviceKey)

  // Trusted admin authorization, server-side. Checked HERE as well as inside
  // every RPC: this route holds the service role, and a route that reaches for
  // it before proving who is asking is one edit away from being an open door.
  const { data: me, error: roleErr } = await service
    .from('users').select('role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (roleErr) return bad('Authorization check failed.', 500)
  if (!me || me.role !== 'admin' || me.is_active === false || me.is_deleted === true) {
    return bad('Only an admin may run Test Data Cleanup.', 403)
  }

  const timing: Record<string, number> = {}
  let removedObjects = 0
  let sweptAnything = false

  /** One line, and only when it is worth reading: a failure, or a slow run. */
  const report = (note: string) => {
    const total = Object.values(timing).reduce((sum, ms) => sum + ms, 0)
    if (note === '' && total < SLOW_CLEANUP_MS) return
    console.info('[orders:test-data-cleanup]', {
      note: note === '' ? 'slow cleanup' : note,
      totalMs: total, ...timing, objects: removedObjects,
    })
  }

  // ── Step 1. Claim. Run as the SIGNED-IN ADMIN so auth.uid(), every gate and
  //    every row lock apply to them. Nothing is destroyed if this refuses.
  const claimStarted = Date.now()
  const { data: claimData, error: claimErr } = await authClient.rpc('begin_test_data_cleanup', {
    p_root_type: rootType, p_root_id: rootId,
    p_reason: reason, p_confirmation: confirmation,
  })
  timing.claim = Date.now() - claimStarted

  if (claimErr) {
    // The database's refusals are already written for a person — CLEANUP_DISABLED,
    // CLEANUP_NOT_ELIGIBLE, CLEANUP_PROVENANCE_MISMATCH and the rest all carry a
    // sentence after the marker — so the message is passed through rather than
    // replaced by a vaguer one. Nothing has been touched.
    const message = String((claimErr as { message?: unknown }).message ?? '')
    const conflict = /CLEANUP_CLAIMED_BY_OTHER/.test(message)
    report('claim refused')
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 })
  }

  const claim = claimData as {
    claim_token?: string
    resumed?: boolean
    root_number?: string
    order_id?: string | null
    order_request_id?: string | null
    order_submission_id?: string | null
  } | null

  const token = claim?.claim_token
  if (!token) return bad('The cleanup claim could not be taken.', 500)

  /**
   * Give the records back — ONLY safe while nothing has been destroyed.
   *
   * Never throws over the error it is reporting: a failed release leaves the
   * claim standing, which is the safe direction, and replacing the real failure
   * with a cleanup one would hide what actually went wrong.
   */
  const release = async () => {
    try {
      await authClient.rpc('release_test_data_cleanup', { p_claim_token: token })
    } catch { /* the claim stays; the records stay frozen and intact */ }
  }

  /**
   * A storage failure, at any point.
   *
   * THE CLAIM IS KEPT WHENEVER A SINGLE OBJECT HAS GONE. Unfreezing a record
   * whose files are already partly missing is precisely the corruption this
   * design exists to prevent, so the record stays frozen, the rows stay whole,
   * and the operation is resumed by asking again — the claim is re-issued to the
   * same admin, the sweep removes what remains (an already-deleted key is a
   * no-op), and finalization proceeds.
   */
  const storageFailed = async (detail: string) => {
    if (!sweptAnything) await release()
    report(`storage cleanup failed: ${detail}`)
    return NextResponse.json({
      error: sweptAnything
        ? 'Some files could not be removed. Nothing has been deleted from the database, and this cleanup is reserved — run it again to finish it.'
        : 'Files could not be removed from storage. Nothing was deleted — please retry.',
      reserved: sweptAnything,
      failed: [detail],
    }, { status: 502 })
  }

  // ── Step 2a. Order Request attachments, if the chain has a request.
  //
  // Moved inside the claim window rather than left to the browser: it has
  // exactly the same failure mode as the PI files, and the claim is what makes
  // that window safe. The helper itself is unchanged and still loads its paths
  // from order_request_attachments.
  const sweepStarted = Date.now()
  if (claim?.order_request_id) {
    try {
      const attachments = await removeAllObjectsForRequest(service, claim.order_request_id)
      if (attachments.removed.length > 0) sweptAnything = true
      if (attachments.failed.length > 0) {
        timing.sweep = Date.now() - sweepStarted
        return await storageFailed('order_request_attachments')
      }
    } catch {
      timing.sweep = Date.now() - sweepStarted
      return await storageFailed('order_request_attachments_unreadable')
    }
  }

  // ── Step 2b. The PI's files.
  //
  // The keys come from test_cleanup_claim_storage(), which answers only for the
  // submission named by THIS claim — so they are the database's, never the
  // browser's, and cannot be pointed at a live PI.
  if (claim?.order_submission_id) {
    const { data: storageData, error: storageErr } = await authClient.rpc(
      'test_cleanup_claim_storage', { p_claim_token: token })

    if (storageErr) {
      timing.sweep = Date.now() - sweepStarted
      return await storageFailed('pi_storage_unresolved')
    }

    const info = storageData as {
      found?: boolean
      submission_id?: string
      storage_paths?: string[]
    } | null

    // `found: false` means the PI is already gone — a previous attempt whose
    // finalization committed. A retry must not treat that as an error.
    if (info?.found && typeof info.submission_id === 'string') {
      try {
        const removal = await removeAllObjectsForSubmission(
          service, info.submission_id, info.storage_paths ?? [])
        removedObjects += removal.removed.length
        if (removal.removed.length > 0) sweptAnything = true
        if (removal.failed.length > 0) {
          timing.sweep = Date.now() - sweepStarted
          return await storageFailed('pi_files')
        }
      } catch {
        // A SETTLED failure: every request this sweep started has finished.
        timing.sweep = Date.now() - sweepStarted
        return await storageFailed('pi_storage_unreadable')
      }
    }
  }
  timing.sweep = Date.now() - sweepStarted

  // ── Step 3. The point of no return, on the claim that froze the records.
  const finalizeStarted = Date.now()
  const { data: result, error: finalErr } = await authClient.rpc(
    'finalize_test_data_cleanup', { p_claim_token: token })
  timing.finalize = Date.now() - finalizeStarted

  if (finalErr) {
    // THE CLAIM IS DELIBERATELY NOT RELEASED. The files are gone; the records
    // must stay frozen until this completes, and asking again resumes it.
    report('finalization refused after storage cleanup')
    return NextResponse.json({
      error: 'The files were removed but the records could not be deleted. This cleanup is reserved — run it again to finish it.',
      reserved: true,
      detail: String((finalErr as { message?: unknown }).message ?? ''),
    }, { status: 502 })
  }

  report('')

  return NextResponse.json({
    ...(result as Record<string, unknown> ?? {}),
    resumed: claim?.resumed === true,
    removedFiles: removedObjects,
  })
}
