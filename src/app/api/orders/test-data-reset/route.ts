import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  classifyResetError,
  isResetScope,
  projectRefFromUrl,
  RESET_CONFIRMATION,
  type ResetFailureCode,
  type ResetScope,
} from '@/lib/orders/testDataReset'
import { parseResetManifest, removeResetStorage } from '@/lib/orders/testDataResetServer'

// Clearing one Order/Finance module, as ONE request that owns the whole
// destructive sequence.
//
// ═══ THE SEQUENCE ═══════════════════════════════════════════════════════════
//
//   1. authenticate, and prove the caller is an ACTIVE ADMIN with the service
//      role — before the service role is used for anything else;
//   2. confirm storage cleanup is ATTEMPTABLE, so a missing service key is not
//      discovered with a module already frozen;
//   3. begin_order_finance_test_reset — every gate, the census re-taken and
//      compared to the plan the admin confirmed, the permanent audit written,
//      and the module FROZEN. Nothing is destroyed;
//   4. remove exactly the objects the claim's manifest names;
//   5a. everything gone -> report it, then finalize on the claim;
//   5b. nothing destructive was ever ISSUED -> release, and the module comes
//       back whole;
//   5c. something was issued but not everything -> THE CLAIM IS KEPT. No row is
//       touched, the module stays frozen, and asking again finishes it.
//
// THE CLAIM TOKEN NEVER REACHES THE BROWSER. It lives in this function's scope
// for the length of one request and is in no response body. A resumed cleanup
// re-derives it from the database, which is why the page needs no token to
// finish something it did not start.
//
// THE BROWSER SENDS A SCOPE, A REASON, A PHRASE AND A PLAN HASH — and nothing
// else. Never an id, never a storage path, never a claim token. Every
// destructive target is derived from the database inside the claim, and the
// phrase is checked again there: a phrase enforced only in the browser is a
// label, not a gate.
//
// THERE IS DELIBERATELY NO TIMEOUT. A promise race is not cancellation and
// storage-js's remove() accepts no AbortSignal; abandoning a request that is
// still deleting objects is how files get lost. The full reasoning is in
// submissionFilesServer.ts. This returns only once every list and every remove
// it started has settled.

/** Above this, one reset is worth a line in the server log. */
const SLOW_RESET_MS = 8_000

type Failure = { code: ResetFailureCode; status: number; detail?: unknown }

const fail = ({ code, status, detail }: Failure) =>
  NextResponse.json({ ok: false, code, ...(detail === undefined ? {} : { detail }) }, { status })

const HTTP_FOR: Partial<Record<ResetFailureCode, number>> = {
  FORBIDDEN: 403,
  DISABLED: 403,
  IN_PROGRESS: 409,
  CLAIM_INVALID: 409,
  PLAN_STALE: 409,
  SCOPE_CHANGED: 409,
  BLOCKED: 409,
  CONFIRMATION_INVALID: 400,
  REASON_REQUIRED: 400,
  SCOPE_INVALID: 400,
  STORAGE_FAILED: 502,
}

type Body = {
  action?: unknown
  scope?: unknown
  reason?: unknown
  confirmation?: unknown
  planHash?: unknown
  resetOrderNumbers?: unknown
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail({ code: 'UNAUTHORIZED', status: 401 })

  let body: Body
  try {
    body = await req.json() as Body
  } catch {
    return fail({ code: 'RESET_FAILED', status: 400 })
  }

  const action = body.action
  if (action !== 'status' && action !== 'preview' && action !== 'run') {
    return fail({ code: 'RESET_FAILED', status: 400 })
  }

  // Step 2, before step 1's service client is used for anything destructive: a
  // missing service key is a deployment fault, not a permission one, and it must
  // not be discovered with a module already frozen.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return fail({ code: 'STORAGE_FAILED', status: 500 })
  const service = createServiceClient(url, serviceKey)

  // ── Step 1. Trusted admin authorization, server-side ──────────────────────
  //
  // Checked HERE as well as inside every RPC. This route holds the service role,
  // and a route that reaches for it before proving who is asking is one edit
  // away from being an open door. The canonical check and nothing looser: a
  // Manager, a Finance user, a Sales user and a Custom user all fail it, and so
  // does an admin whose account has been switched off.
  const { data: me, error: roleErr } = await service
    .from('users').select('role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (roleErr) return fail({ code: 'RESET_FAILED', status: 500 })
  if (!me || me.role !== 'admin' || me.is_active === false || me.is_deleted === true) {
    return fail({ code: 'FORBIDDEN', status: 403 })
  }

  // THE PROJECT, AND ONLY ITS REF. Derived server-side from the URL so no key
  // and no host ever travels to produce it. Null means the environment could not
  // be identified, and the screen fails closed on that rather than guessing.
  const projectRef = projectRefFromUrl(url)

  // ── status ────────────────────────────────────────────────────────────────
  if (action === 'status') {
    const { data, error } = await authClient.rpc('order_finance_test_reset_status')
    if (error) {
      const code = classifyResetError(error)
      return fail({ code, status: HTTP_FOR[code] ?? 500 })
    }
    return NextResponse.json({ ok: true, projectRef, status: data })
  }

  const scope = body.scope
  if (!isResetScope(scope)) return fail({ code: 'SCOPE_INVALID', status: 400 })

  // ── preview ───────────────────────────────────────────────────────────────
  if (action === 'preview') {
    const { data, error } = await authClient.rpc(
      'preview_order_finance_test_reset', { p_scope: scope })
    if (error) {
      const code = classifyResetError(error)
      return fail({ code, status: HTTP_FOR[code] ?? 500 })
    }
    const census = data as Record<string, unknown> | null
    // THE IDS DO NOT LEAVE THE SERVER. The preview shows counts; the delete list
    // is the claim's business and a browser has no use for it.
    return NextResponse.json({
      ok: true,
      projectRef,
      scope,
      counts:   census?.counts ?? {},
      blocking: census?.blocking ?? [],
      retained: census?.retained ?? {},
      planHash: census?.plan_hash ?? null,
    })
  }

  // ── run ───────────────────────────────────────────────────────────────────
  const reason = body.reason
  const confirmation = body.confirmation
  const planHash = body.planHash
  if (typeof reason !== 'string' || reason.trim() === '') {
    return fail({ code: 'REASON_REQUIRED', status: 400 })
  }
  if (typeof confirmation !== 'string' || confirmation !== RESET_CONFIRMATION[scope as ResetScope]) {
    // Refused here AND in the database. This one only saves a round trip; the
    // one that matters is the RPC's, which no client can skip.
    return fail({ code: 'CONFIRMATION_INVALID', status: 400 })
  }
  if (typeof planHash !== 'string' || planHash === '') {
    return fail({ code: 'PLAN_STALE', status: 409 })
  }

  const timing: Record<string, number> = {}
  let confirmedRemoved = 0

  /**
   * Whether a DESTRUCTIVE request was ISSUED — not whether one succeeded.
   *
   * CONFLATING THE TWO IS A DATA-LOSS BUG. A `.remove()` can delete objects on
   * the server and then lose its response to a network failure: the client sees
   * a throw, or a reply naming nothing, and the confirmed count is zero while
   * the files are already gone. Releasing there unfreezes a module whose objects
   * have been destroyed. The flag is set by a callback that fires immediately
   * BEFORE each remove request, so it is true even if the helper throws.
   *
   * A FALSE-POSITIVE RESERVATION IS ACCEPTABLE — it leaves a frozen module that
   * one more click finishes off. The opposite mistake is unrecoverable.
   */
  let removalAttempted = false

  const report = (note: string) => {
    const total = Object.values(timing).reduce((sum, ms) => sum + ms, 0)
    if (note === '' && total < SLOW_RESET_MS) return
    // DURATIONS AND COUNTS ONLY. No key, no id, no claim token, no project ref
    // and no service credential goes anywhere near this.
    console.info('[orders:test-data-reset]', {
      note: note === '' ? 'slow reset' : note,
      scope, totalMs: total, ...timing, confirmedRemoved, removalAttempted,
    })
  }

  // ── Step 3. Every gate, then the freeze ───────────────────────────────────
  const claimStarted = Date.now()
  const { data: claimData, error: claimErr } = await authClient.rpc(
    'begin_order_finance_test_reset', {
      p_scope: scope, p_reason: reason,
      p_confirmation: confirmation, p_plan_hash: planHash,
    })
  timing.claim = Date.now() - claimStarted

  if (claimErr) {
    const code = classifyResetError(claimErr)
    report('claim refused')
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
  }

  const claim = claimData as {
    claim_token?: string
    resumed?: boolean
    storage_manifest?: unknown
  } | null
  const token = claim?.claim_token
  if (!token) return fail({ code: 'RESET_FAILED', status: 500 })

  /** Give the module back. Never throws over the error it is reporting. */
  const release = async () => {
    try {
      await authClient.rpc('release_order_finance_test_reset', { p_claim_token: token })
    } catch { /* the claim stays; the module stays frozen and every row intact */ }
  }

  /** Record why an admin reopening the page is looking at a frozen module. */
  const recordFailure = async (message: string) => {
    try {
      await authClient.rpc('order_finance_test_reset_failed', {
        p_claim_token: token, p_failure: message,
      })
    } catch { /* the page still shows the stage; a missing sentence is not fatal */ }
  }

  // ── Step 4. The objects, and only the ones the claim names ────────────────
  const sweepStarted = Date.now()
  let outcome
  try {
    outcome = await removeResetStorage(
      service,
      parseResetManifest(claim?.storage_manifest),
      { onRemoveAttempt: () => { removalAttempted = true } })
    if (outcome.removalAttempted) removalAttempted = true
    confirmedRemoved = outcome.removed
  } catch {
    // A SETTLED failure: every request this sweep started has finished, so
    // nothing is in flight and a release cannot be overtaken by a late deletion.
    timing.sweep = Date.now() - sweepStarted
    if (!removalAttempted) await release()
    else await recordFailure('Some files could not be removed. No record was deleted.')
    report('storage cleanup failed')
    return fail({ code: 'STORAGE_FAILED', status: 502, detail: { reserved: removalAttempted } })
  }
  timing.sweep = Date.now() - sweepStarted

  if (outcome.failed.length > 0) {
    if (!removalAttempted) await release()
    else await recordFailure(
      `${outcome.failed.length} file(s) could not be removed. No record was deleted.`)
    report('storage objects survived cleanup')
    return fail({
      code: 'STORAGE_FAILED', status: 502,
      detail: { removed: outcome.removed, failed: outcome.failed.length, reserved: removalAttempted },
    })
  }

  // ── Step 5. Say the sweep finished, then erase ────────────────────────────
  //
  // TWO CALLS, NOT ONE. The database will not finalize a claim it has not been
  // told is past storage — so "the files are confirmed gone" is a state the
  // database holds rather than a promise this route makes in passing.
  const { error: markErr } = await authClient.rpc(
    'order_finance_test_reset_storage_done', { p_claim_token: token, p_removed: confirmedRemoved })
  if (markErr) {
    await recordFailure('The files were removed but the cleanup could not be advanced.')
    report('could not record storage completion')
    return fail({ code: 'RESET_FAILED', status: 502, detail: { reserved: true } })
  }

  const finalizeStarted = Date.now()
  const { data: result, error: finalErr } = await authClient.rpc(
    'finalize_order_finance_test_reset', { p_claim_token: token })
  timing.finalize = Date.now() - finalizeStarted

  if (finalErr) {
    // THE CLAIM IS DELIBERATELY NOT RELEASED. The files are gone; the module must
    // stay frozen until this completes, and asking again resumes it.
    const code = classifyResetError(finalErr)
    await recordFailure('The files were removed but the records could not be deleted. Run it again to finish.')
    report('finalization refused after storage cleanup')
    return fail({ code, status: HTTP_FOR[code] ?? 502, detail: { reserved: true } })
  }

  // ── The Order number series, only if it was asked for ─────────────────────
  //
  // A SEPARATE ACT WITH A SEPARATE OUTCOME. It runs after finalization, on the
  // same claim token, through the canonical function — which has its own gates
  // and refuses while any Order, any submitted or approved PI, or any allocation
  // survives. A refusal here is NOT a failed cleanup: the records really are
  // gone, and saying otherwise would send an admin looking for them.
  let numbering: unknown = null
  let numberingRefused: string | null = null
  if (body.resetOrderNumbers === true && scope === 'order_finance_module') {
    const { data: reset, error: resetErr } = await authClient.rpc(
      'reset_confirmed_order_number_cycle', { p_claim_token: token })
    if (resetErr) numberingRefused = classifyResetError(resetErr)
    else numbering = reset
  }

  report('')

  return NextResponse.json({
    ok: true,
    scope,
    resumed: claim?.resumed === true,
    // CONFIRMED removals. Named for what it is: storage may have removed more
    // than it managed to report, which is why it never decides anything here.
    confirmedRemovedFiles: confirmedRemoved,
    deleted: result ?? {},
    numbering,
    numberingRefused,
  })
}
