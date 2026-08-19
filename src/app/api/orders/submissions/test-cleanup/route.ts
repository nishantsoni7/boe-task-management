import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { removeAllObjectsForSubmission } from '@/lib/orders/submissionFilesServer'

// Admin-only PURGE of the storage objects belonging to the PI submission a TEST
// Order was created from.
//
// WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM THE CLEANUP RPC
// ------------------------------------------------------------
// Postgres and Supabase Storage cannot share a transaction. The PI's files have
// to go on one side of the commit or the other, and only one order is safe:
//
//   files first, rows second — a failure leaves a complete, retryable record
//                              whose file keys are still discoverable from it
//   rows first, files second — a failure strands objects nothing can name any
//                              more, because the row that named them is gone
//
// So this runs BEFORE execute_test_data_cleanup(), exactly as the sibling
// /api/orders/requests/attachments/cleanup does for Order Request attachments,
// and the caller aborts the whole operation if it fails.
//
// WHY A ROUTE AND NOT A BROWSER CALL. The order-files DELETE policy admits the
// OWNER of a draft only — never an administrator, and never for an APPROVED PI.
// Removing these objects needs the service role, which must never be within
// reach of browser code.
//
// THE BROWSER SUPPLIES ONE ORDER ID AND NOTHING ELSE
// ---------------------------------------------------
// Not a submission id, and above all not a path list. The submission is derived
// from the Order by test_cleanup_submission_storage(), which runs as the
// SIGNED-IN ADMIN and refuses to answer for:
//
//   * an Order that is not marked is_test_data;
//   * an Order with no PI provenance;
//   * a provenance pair whose two rows do not name each other.
//
// So an admin cannot aim this at a real PI by guessing a uuid: the worst a wrong
// id achieves is `found: false`, and nothing is touched. Every key it does
// return was read from the database and is confined to submissions/{id}/, a
// prefix the path CHECK constraints in 20260908000000 and 20260909000000 make
// exclusive to one submission — and removeAllObjectsForSubmission confines the
// sweep to that prefix again on its own account.
//
// NOTHING IS RESERVED. The ordinary PI deletion path takes a deletion claim to
// freeze the record against a concurrent submit; here the Test Data Cleanup
// transaction takes its own row locks moments later, and an approved PI has no
// transition left to race — approval is terminal. A second freeze would only be
// a second thing to leak.
//
// THERE IS DELIBERATELY NO TIMEOUT. The full reasoning is in
// submissionFilesServer.ts: a promise race is not cancellation, storage-js's
// remove() accepts no AbortSignal, and abandoning a request that is still
// deleting objects is how files get lost. This returns only once every list and
// every remove it started has settled.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Why this Order has no PI files to remove. All are ordinary, none is an error. */
type NotFoundReason =
  | 'order_not_found'
  | 'order_not_test_data'
  | 'no_submission'
  | 'submission_missing'
  | 'provenance_mismatch'

/**
 * Which of those the CALLER should treat as "nothing to do" rather than "stop".
 *
 * `no_submission` is the ordinary case for every Order converted from an Order
 * Request — it has no PI at all — and must not block a cleanup that was always
 * going to be a plain Order deletion.
 *
 * The other three are refusals. A cleanup that proceeded past them would either
 * be acting on a real Order or acting on a pair whose rows disagree, and the
 * cleanup RPC refuses both anyway — this simply refuses first, before any file
 * is touched.
 */
const SKIPPABLE: ReadonlySet<string> = new Set<NotFoundReason>(['no_submission'])

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let orderId: unknown
  try {
    ({ orderId } = await req.json() as { orderId?: unknown })
  } catch {
    return NextResponse.json({ error: 'A valid orderId is required.' }, { status: 400 })
  }
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
    return NextResponse.json({ error: 'A valid orderId is required.' }, { status: 400 })
  }

  // Cleanup must be ATTEMPTABLE before anything is read, let alone destroyed. A
  // missing service key is a deployment fault, not a permission one.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json(
      { error: 'Storage cleanup is not configured.', failed: ['unconfigured'] }, { status: 500 })
  }

  // Trusted admin authorization, server-side. Checked HERE as well as inside the
  // RPC: this route holds the service role, and a route that reaches for it
  // before proving who is asking is one edit away from being an open door.
  const service = createServiceClient(url, serviceKey)
  const { data: me, error: roleErr } = await service
    .from('users').select('role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (roleErr) {
    return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })
  }
  if (!me || me.role !== 'admin' || me.is_active === false || me.is_deleted === true) {
    return NextResponse.json(
      { error: 'Only an admin may clean up PI storage.' }, { status: 403 })
  }

  // Derive the submission and its keys AS THE SIGNED-IN ADMIN, so the RPC's own
  // admin check, its test-data rule and its provenance rule all apply to them.
  const { data: resolved, error: resolveErr } = await authClient.rpc(
    'test_cleanup_submission_storage', { p_order_id: orderId })

  if (resolveErr) {
    return NextResponse.json(
      { error: 'Could not resolve the PI for this Order.', failed: ['unresolved'] }, { status: 500 })
  }

  const info = resolved as {
    found?: boolean
    reason?: string
    submission_id?: string
    storage_paths?: string[]
  } | null

  if (!info?.found) {
    const reason = info?.reason ?? 'no_submission'
    // Nothing to remove, and nothing wrong: this Order carries no PI.
    if (SKIPPABLE.has(reason)) {
      return NextResponse.json({ skipped: true, reason, removed: 0, failed: [] })
    }
    // A refusal. The caller must not proceed to delete rows.
    return NextResponse.json(
      { error: 'This Order is not eligible for PI storage cleanup.', reason, failed: [reason] },
      { status: 409 })
  }

  const submissionId = info.submission_id
  if (typeof submissionId !== 'string' || !UUID_RE.test(submissionId)) {
    return NextResponse.json(
      { error: 'The PI for this Order could not be identified.', failed: ['unresolved'] }, { status: 500 })
  }

  try {
    // The recorded keys AND a bounded sweep of the prefix, so objects a Change PI
    // or an interrupted parse left behind go too. Both halves are confined to
    // submissions/{id}/ by removeAllObjectsForSubmission itself.
    const removal = await removeAllObjectsForSubmission(
      service, submissionId, info.storage_paths ?? [])

    if (removal.failed.length > 0) {
      // Rows are NOT deleted. The record survives, its keys stay discoverable
      // from it, and the whole operation retries cleanly.
      return NextResponse.json({
        error: 'One or more PI files could not be removed from storage.',
        submissionId,
        removed: removal.removed.length,
        failed: removal.failed.map(() => 'unremoved'),
      }, { status: 502 })
    }

    return NextResponse.json({
      submissionId,
      removed: removal.removed.length,
      found: removal.found.length,
      failed: [],
    })
  } catch {
    // A SETTLED failure: every request this sweep started has finished. Nothing
    // is in flight, so the caller may safely abort.
    return NextResponse.json(
      { error: 'Could not read PI storage for cleanup.', failed: ['unknown'] }, { status: 500 })
  }
}
