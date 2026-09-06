import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient, type AdminSupabaseClient } from '@/lib/supabase/admin'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { PI_MAX_WORKBOOK_BYTES } from '@/lib/pi/workbookReader'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'
import {
  buildSubmissionPlan,
  isUuid,
  isWorkbookPathFor,
  sha256Hex,
  verifyStoredImageBytes,
  MAX_IMAGE_OBJECT_BYTES,
  type PlannedImage,
} from '@/lib/orders/submissionPayload'

// The trusted half of "Save Draft".
//
// THE BROWSER'S PARSE IS NOT AN INPUT. This endpoint takes a submission id and
// a storage path and nothing else. It downloads the workbook from the private
// bucket, runs the SAME parser again here, and persists only what THIS parse
// produced. A client that lied about a price, a quantity or an image mapping
// changes nothing, because none of those words ever cross the wire.
//
// WHY THE FILE IS NOT POSTED HERE. A PI is up to 10 MiB and a serverless
// request body limit is smaller than that on most plans. The browser therefore
// uploads straight to Storage under its own draft — which the order-files
// policies already authorize for the owner of a draft holding orders.create —
// and this endpoint is handed the key. That also means the bytes are never
// base64-inflated and never sit in a function's memory twice.
//
// THE ORDER OF OPERATIONS, and why it is this order:
//
//   1-5   authorize, from the session and the database only
//   6     validate the path SHAPE and that it names THIS submission
//   7     ACQUIRE THE PROCESSING LEASE — everything below belongs to one run
//   8-10  download, re-check size and type, hash
//   11    parse, server-side
//   12-13 refuse to persist a failed or blocking parse
//   14    derive item ids deterministically, so image keys are known in advance
//         and a retry converges instead of accumulating orphans
//   15    create images that do not exist; VERIFY BY BYTES any that do
//   17    replace the database snapshot atomically, presenting the lease token
//   18    on failure, remove only what THIS attempt created — never the workbook
//   19    clean obsolete objects, still under the lease
//   20    return counts, never content
//   —     release the lease in `finally`, with the token that holds it
//
// Storage and Postgres cannot share a transaction, so images are written first
// and the database last: a failed database step leaves recoverable files, while
// a failed upload leaves the previous snapshot intact. The lease is what stops
// two attempts interleaving across those steps, which a reference re-check
// alone can only narrow and not close.
//
// PRIVACY. Nothing here logs or returns a client name, an address, a GST
// number, a phone number, a price, a product description, a filename or a byte
// of an image. Errors are stable codes plus counts. The only free text that
// leaves this route is a fixed message written in this file.

export const runtime = 'nodejs'

type ProcessRequest = {
  submissionId?: unknown
  sourceWorkbookPath?: unknown
  /**
   * WHY THIS PI IS BEING REPLACED. Required once the PI has left draft, ignored
   * before that — a draft is its owner's to shape, and a mandatory reason on
   * every re-upload of ordinary work is a ritual rather than an audit trail.
   * The database re-derives both the requirement and the authority; this is
   * checked here as well so an employee is told before a 10 MB download.
   */
  changeReason?: unknown
}

/** Matches assert_order_submission_workbook_editor. Kept in one place. */
export const CHANGE_REASON_MAX = 500

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// THE PRIVILEGED CLIENT COMES FROM ONE PLACE, and it is checked.
//
// This route used to build it inline with two non-null assertions. When either
// variable was absent, `createClient(url, undefined)` threw `supabaseKey is
// required.` at module scope of the handler — before any try/catch — and the
// employee saw a bare 500 with no `message` for the browser to render. The
// helper answers whether it is configured instead of asserting that it is.
type ServiceClient = AdminSupabaseClient

/**
 * Did the lease acquisition fail because somebody else holds it?
 *
 * 55P03 (lock_not_available) plus the named marker. A busy submission is
 * retryable and must never be reported as a save failure — nothing went wrong,
 * another attempt simply got there first.
 */
function isProcessingBusy(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown }
  if (String(e?.code ?? '') === '55P03') return true
  return String(e?.message ?? '').includes('ORDER_SUBMISSION_PROCESSING_BUSY')
}

/** A stable, non-sensitive failure. `code` is safe to show and to log. */
const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ error: code, message, ...extra }, { status })

export async function POST(req: NextRequest) {
  // ── 1. Authenticate from the session, never from the body ──
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: ProcessRequest
  try {
    body = (await req.json()) as ProcessRequest
  } catch {
    return fail(400, 'BAD_REQUEST', 'A submission id and workbook path are required.')
  }

  const submissionId = typeof body.submissionId === 'string' ? body.submissionId : ''
  const workbookPath = typeof body.sourceWorkbookPath === 'string' ? body.sourceWorkbookPath : ''
  const changeReason = typeof body.changeReason === 'string' ? body.changeReason.trim() : ''

  if (!isUuid(submissionId)) {
    return fail(400, 'BAD_REQUEST', 'A valid submission id is required.')
  }

  // ── THE SERVER IS CONFIGURED, or it says so plainly ──
  //
  // Named variables and a message a person can act on, rather than a bare 500.
  // The names are safe to print: they are the names, never the values.
  //
  // NEITHER LOGGED NOR RETURNED, and both halves are deliberate.
  //
  // Not returned, because /orders/[id]/documents already settled that question
  // for this codebase: a caller learns the deployment is misconfigured, not
  // which of its settings is absent. Not logged, because this handler is the
  // one place a PI's bytes are held in memory and it has a standing rule —
  // enforced by processDraftRoute.test.ts — that it writes to no console sink
  // at all, so no future edit can start logging beside a client name or a price.
  //
  // The operator is not left blind: the same absent variable breaks the
  // confirmed-document route, which DOES log the names, and the message below
  // tells the employee this is a server setting to report rather than a refusal
  // to work around.
  const admin = adminClient()
  if (!admin.ok) {
    return fail(500, 'SERVER_NOT_CONFIGURED',
      'Saving a PI is not configured on this deployment. This is a server setting, not something you can fix — please report it.')
  }
  const service = admin.client

  // ── 2-3. The actor is real, active and not soft-deleted ──
  const { data: me, error: meErr } = await service
    .from('users').select('id, role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (meErr) return fail(500, 'AUTH_CHECK_FAILED', 'Could not verify your account.')
  if (!me || me.is_active !== true || me.is_deleted === true) {
    return fail(403, 'ACCOUNT_INACTIVE', 'This account cannot save order drafts.')
  }

  // ── 4. orders.create, resolved by the permission engine ──
  let mayCreate = me.role === 'admin'
  if (!mayCreate) {
    const { data: allowed, error: permErr } = await service.rpc('resolve_permission', {
      p_user_id: user.id,
      p_module_key: 'orders',
      p_action_key: 'create',
    })
    if (permErr) return fail(500, 'AUTH_CHECK_FAILED', 'Could not verify your permissions.')
    mayCreate = allowed === true
  }
  if (!mayCreate) {
    return fail(403, 'FORBIDDEN', 'You do not have permission to create an order.')
  }

  // ── 5. The submission exists, is editable, and is THIS employee's ──
  //
  // The RPC re-derives all of this under a row lock and is the real boundary.
  // Checking here as well means an unauthorized caller is refused before a
  // single byte is downloaded, and gets an accurate reason.
  const { data: submission, error: subErr } = await service
    .from('order_submissions')
    .select('id, status, created_by, submitted_by, order_id, source_workbook_path')
    .eq('id', submissionId)
    .maybeSingle()
  if (subErr) return fail(500, 'LOOKUP_FAILED', 'Could not load this draft.')
  if (!submission) return fail(404, 'NOT_FOUND', 'This draft no longer exists.')

  // WHICH OF THE TWO CASES IS THIS. The same boundary the database draws:
  // everything the owner rule does not cover is an amendment.
  const afterSubmission =
    !['draft', 'needs_changes'].includes(submission.status) || Boolean(submission.order_id)

  if (!afterSubmission) {
    const owns = submission.created_by === user.id || submission.submitted_by === user.id
    if (!owns && me.role !== 'admin') {
      return fail(403, 'NOT_OWNED', 'This draft belongs to someone else.')
    }
  } else {
    // ── PAST DRAFT: ACTIVE ADMIN ONLY, WITH A REASON ──
    //
    // Owning the PI is not enough and never becomes enough; neither is holding
    // orders.approve_order. assert_order_submission_workbook_editor re-derives
    // all of this under a row lock and is the real boundary — this exists so
    // the refusal arrives before a 10 MB download and says which rule it is.
    if (me.role !== 'admin') {
      return fail(409, 'NOT_EDITABLE', 'This submission can no longer be changed.')
    }
    if (changeReason === '') {
      return fail(400, 'CHANGE_REASON_REQUIRED',
        'Replacing the PI of a submitted record needs a reason.')
    }
    if (changeReason.length > CHANGE_REASON_MAX) {
      return fail(400, 'CHANGE_REASON_TOO_LONG',
        `The reason may be at most ${CHANGE_REASON_MAX} characters.`)
    }
  }

  // ── 6. The path must be THIS submission's workbook key ──
  //
  // Shape and ownership together. A well-formed key naming another draft is the
  // IDOR case and is refused here as well as by the storage policies.
  if (!isWorkbookPathFor(workbookPath, submissionId)) {
    return fail(400, 'BAD_WORKBOOK_PATH', 'The uploaded file could not be located for this draft.')
  }

  // ── 7. TAKE THE SUBMISSION ──
  //
  // Everything after this point — download, parse, upload, replace, clean — is
  // one processor's work on one draft. Without the lease those steps can
  // interleave between two attempts, and the reference re-check before a delete
  // is itself two statements, so it narrows the race rather than closing it.
  //
  // The token is generated here, stays on the server, is never logged and is
  // never returned. It is what lets the replacement and the release prove they
  // are this run and not a late arrival from an abandoned one.
  const processingToken = crypto.randomUUID()
  const lease = await service.rpc('begin_order_submission_processing', {
    p_submission_id: submissionId,
    p_actor_id: user.id,
    p_token: processingToken,
  })
  if (lease.error) {
    if (isProcessingBusy(lease.error)) {
      return fail(409, 'PROCESSING_BUSY', 'This draft is already being processed. Please try again shortly.')
    }
    return fail(500, 'LEASE_FAILED', 'This draft could not be prepared for saving. Please try again.')
  }

  try {
    return await processUnderLease({
      service, submissionId, workbookPath, actorId: user.id, processingToken,
      afterSubmission,
      changeReason: afterSubmission ? changeReason : null,
      submissionStatus: String(submission.status),
      priorWorkbookPath: typeof submission.source_workbook_path === 'string'
        ? submission.source_workbook_path
        : null,
    })
  } finally {
    // ── RELEASE, ALWAYS, AND ONLY WITH THE TOKEN THAT HOLDS IT ──
    //
    // In `finally` so a thrown error still frees the draft, and after the body
    // so cleanup has already finished under the lease. The function returns a
    // result instead of raising, so a release problem can never replace the
    // real error with itself.
    await service.rpc('finish_order_submission_processing', {
      p_submission_id: submissionId,
      p_token: processingToken,
    })
  }
}

/**
 * Everything that happens while this request owns the submission.
 *
 * EXPORTED for one other caller: /api/orders/pi-revisions/approve, which
 * applies a REVISED PI to an approved Order (20261116000000). It runs the very
 * same download, parse, image upload and cleanup — there is one parser path in
 * this product — and differs only at step 17, where `revisionVersionId` sends
 * the payload through approve_order_pi_revision() so the parse, the version
 * decision and the previous version's supersession land in one transaction.
 */
export async function processUnderLease(ctx: {
  service: ServiceClient
  submissionId: string
  workbookPath: string
  actorId: string
  processingToken: string
  afterSubmission: boolean
  changeReason: string | null
  submissionStatus: string
  priorWorkbookPath: string | null
  /** The pending order_pi_versions row this parse approves, if any. */
  revisionVersionId?: string | null
}): Promise<NextResponse> {
  const { service, submissionId, workbookPath, actorId, processingToken,
          afterSubmission, changeReason } = ctx

  // ── 8. Download it privately ──
  const download = await service.storage.from('order-files').download(workbookPath)
  if (download.error || !download.data) {
    return fail(404, 'WORKBOOK_NOT_STORED', 'The uploaded PI could not be found. Please upload it again.')
  }

  const bytes = new Uint8Array(await download.data.arrayBuffer())

  // ── 9. Size and type, re-checked against the bytes we actually hold ──
  if (bytes.byteLength === 0) {
    return fail(400, 'WORKBOOK_EMPTY', 'The uploaded PI is empty. Please upload it again.')
  }
  if (bytes.byteLength > PI_MAX_WORKBOOK_BYTES) {
    return fail(413, 'WORKBOOK_TOO_LARGE', 'The uploaded PI is larger than 10 MB.')
  }
  if (download.data.type && download.data.type !== XLSX_MIME) {
    return fail(400, 'WORKBOOK_NOT_XLSX', 'The uploaded file is not an .xlsx workbook.')
  }

  // ── 10. Provenance ──
  const workbookSha256 = sha256Hex(bytes)

  // ── 11. THE TRUSTED PARSE ──
  let parsed
  try {
    parsed = await parseBoePiWorkbook(bytes)
  } catch {
    // The thrown value is not read: it can quote cell contents.
    return fail(422, 'PARSE_FAILED', 'The PI could not be read on the server. Please check the file and try again.')
  }

  // ── 12. A failed parse replaces nothing ──
  //
  // The workbook is deliberately LEFT IN STORAGE. The employee can retry, or
  // upload a corrected file over a fresh attempt; deleting their upload because
  // the server could not read it would lose the only copy they had here.
  if (!parsed.ok) {
    return fail(422, 'PARSE_FAILED', 'The PI could not be read on the server.', {
      codes: parsed.errors.map(e => e.code),
    })
  }

  // ── 13. Blocking issues are refused SERVER-SIDE, whatever the browser said ──
  if (parsed.blockingIssues.length > 0) {
    return fail(422, 'BLOCKING_ISSUES', 'The PI has issues that must be fixed before it can be saved.', {
      // Codes, rows and cells only. The parser's messages quote product names.
      issues: parsed.blockingIssues.map(i => ({ code: i.code, row: i.row, cell: i.cell ?? null })),
    })
  }

  // ── 14. Deterministic ids, so image keys are known before the rows exist ──
  const plan = buildSubmissionPlan({
    submissionId,
    workbook: parsed.data,
    warnings: parsed.warnings,
    blockingIssues: parsed.blockingIssues,
    source: {
      workbookPath,
      // The original filename is NOT taken from the request body. A PI is named
      // after its client, and a body-supplied name is unverified text; the
      // stored name is derived from the key, which is an opaque uuid.
      workbookName: null,
      workbookSizeBytes: bytes.byteLength,
      workbookSha256,
      templateVersion: parsed.data.template.sheetName,
    },
  })

  // ── 15. NOTHING IS SKIPPED SILENTLY ──
  //
  // The server-side parse above already refuses an unstorable representative
  // image with a blocking issue and drops an unstorable customization image
  // with a warning, so this count is zero for every workbook that reaches here.
  // It is checked anyway: a plan that quietly lost a picture must never become
  // a draft that looks saved and complete. Nothing has been uploaded yet at
  // this point, so refusing costs nothing and leaves no cleanup.
  if (plan.counts.skippedImages > 0) {
    return fail(422, 'IMAGE_FORMAT_UNSUPPORTED',
      'This PI contains a product image in a format that cannot be saved. Replace it with a PNG, JPG/JPEG or WebP image and upload the PI again.')
  }

  // THE LEASE TOKEN, attached AFTER the fingerprint was computed.
  //
  // Order matters: the fingerprint exists to recognise a replay, and the token
  // is new on every attempt. Including it would make every retry look like a
  // change and defeat the replay suppression entirely. It also never reaches a
  // browser — the payload is built and consumed entirely on this server.
  plan.payload.processing_token = processingToken

  // THE REASON, alongside the token and for the same reason: `create or replace`
  // cannot change a signature, so both travel in the payload built entirely on
  // this server. Attached AFTER the fingerprint, like the token — a reason is
  // not part of what makes two uploads the same file, and including it would
  // make an otherwise identical retry look like a change.
  if (changeReason) plan.payload.change_reason = changeReason

  // The image paths this draft points at TODAY. Needed twice: to know which
  // uploads are new (so a failed attempt cleans up only its own), and to know
  // which old objects are obsolete once the replacement succeeds.
  const { data: priorImages } = await service
    .from('order_submission_item_images')
    .select('storage_path')
    .eq('submission_id', submissionId)
  const priorPaths = new Set(((priorImages ?? []) as { storage_path: string }[]).map(r => r.storage_path))

  // ── 15. Upload every image, WITHOUT EVER OVERWRITING A LIVE OBJECT ──
  //
  // upsert is false, deliberately. The keys are content-addressed, so:
  //
  //   * a key that does not exist holds bytes nobody references — creating it
  //     is safe, and this attempt records that IT created it;
  //   * a key that already exists holds, by construction, exactly these bytes.
  //     It is reused rather than rewritten, and is NOT recorded as
  //     attempt-created, so a later rollback cannot delete an object the
  //     surviving rows still point at.
  //
  // An upsert here would be the bug this correction exists to remove: it would
  // let a changed picture overwrite the object the current rows describe, and a
  // failed database step would then leave those rows pointing at bytes that are
  // not what they claim.
  const created: string[] = []

  /**
   * Undo this attempt's uploads — but only the ones nothing references.
   *
   * THE RACE THIS CLOSES. Two concurrent attempts on the same draft (a
   * double-click, two tabs) plan identical content-addressed keys. One creates
   * key K; the other gets a 409, verifies it and reuses it. If the SECOND then
   * commits its rows and the FIRST fails, a naive rollback would delete K while
   * committed rows point at it — turning a recoverable failure into a broken
   * record, which is exactly what this correction exists to prevent. It also
   * covers the quieter case where an object went missing out-of-band, this
   * attempt recreated it, and a surviving row still names it.
   *
   * A failed lookup deletes NOTHING. Leaving an unreferenced private object is
   * a housekeeping cost; deleting a referenced one is data loss.
   */
  const rollbackCreated = async () => {
    if (created.length === 0) return
    const { data, error } = await service
      .from('order_submission_item_images')
      .select('storage_path')
      .eq('submission_id', submissionId)
      .in('storage_path', created)
    if (error) return
    const referenced = new Set(((data ?? []) as { storage_path: string }[]).map(r => r.storage_path))
    await removeObjects(service, created.filter(p => !referenced.has(p)))
  }

  for (const image of plan.images) {
    const { error } = await service.storage
      .from('order-files')
      .upload(image.storagePath, image.bytes, {
        contentType: image.mimeType,
        upsert: false,
      })

    if (!error) { created.push(image.storagePath); continue }

    // The key is taken. That is the ordinary retry case — but it is verified
    // rather than assumed, because "the path looks right" is not evidence about
    // the object behind it.
    if (isAlreadyExists(error)) {
      const reusable = await verifyStoredImage(service, image)
      if (reusable) continue
      // The key is taken by something that is NOT this picture. Never
      // overwritten, never reused, and reported as its own stable code — the
      // path, the bytes and everything commercial stay out of the response.
      await rollbackCreated()
      return fail(409, 'IMAGE_INTEGRITY',
        'A stored product image could not be verified. Please try again, or upload the PI again.')
    }

    await rollbackCreated()
    return fail(502, 'IMAGE_UPLOAD_FAILED', 'The product images could not be saved. Please try again.')
  }

  // ── 17. Replace the snapshot atomically, as the service role ──
  //
  // A REVISION goes through approve_order_pi_revision(), which calls the same
  // parser inside its own transaction and then decides the version rows; the
  // draft path calls the parser directly. Either way one RPC, one transaction.
  const { data: replaced, error: rpcErr } = ctx.revisionVersionId
    ? await service.rpc('approve_order_pi_revision', {
        p_version_id: ctx.revisionVersionId,
        p_actor_id: actorId,
        p_payload: plan.payload,
      })
    : await service.rpc('replace_order_submission_parse', {
        p_submission_id: submissionId,
        p_actor_id: actorId,
        p_payload: plan.payload,
      })

  if (rpcErr) {
    // A revision refusal is a RULE, not a save failure, and it names itself:
    // the version is no longer pending, an older revision cannot replace a
    // newer one, the file is not this revision's. Those markers reach the
    // screen as fixed sentences; nothing else about the error does.
    if (ctx.revisionVersionId) {
      const marker = String((rpcErr as { message?: unknown })?.message ?? '')
        .match(/ORDER_PI_REVISION_[A-Z_]+|ORDER_SUBMISSION_REVISED_PI_[A-Z_]+/)?.[0]
      if (marker) {
        await rollbackCreated()
        return fail(409, marker, 'The revised PI was not applied.')
      }
    }
    // ── 18. Remove only what THIS attempt created ──
    //
    // Everything else is untouched: an object that already existed was reused,
    // not rewritten, so the surviving rows still describe exactly the bytes
    // they always did. The workbook itself is never touched on any path.
    await rollbackCreated()
    return fail(500, 'SAVE_FAILED', 'The draft could not be saved. Please try again.')
  }

  // ── 19. Obsolete objects, and ONLY now ──
  //
  // The rows that referenced them are gone, so these keys are orphans. Anything
  // still referenced is content-addressed and therefore still in currentPaths,
  // so it is never selected here. Cleanup runs strictly AFTER the replacement
  // committed, and a failure in it is not reported as a save failure: the draft
  // is saved and correct, and a leftover object inside a private bucket is a
  // housekeeping matter, not a reason to alarm an employee.
  const currentPaths = new Set(plan.images.map(i => i.storagePath))
  const obsoleteImages = [...priorPaths].filter(p => !currentPaths.has(p))

  // The superseded original, when the employee replaced the workbook. The
  // CURRENT original is never in this list — it is the path just recorded —
  // and only a key inside THIS submission's own original/ folder qualifies, so
  // a corrupt or foreign stored value cannot direct a delete anywhere else.
  //
  // AND NOT AT ALL FOR AN AMENDMENT. Once a PI has been submitted, its workbook
  // is the file other people made decisions against: what finance verified,
  // what management approved, what the confirmed documents were generated from.
  // Deleting it because an admin corrected a rate would destroy the record of
  // what was approved, and no amount of Activity text substitutes for the file
  // itself. A draft re-upload still tidies up after itself, because nobody has
  // yet relied on the file it is replacing.
  const priorWorkbook = ctx.priorWorkbookPath
  const obsoleteWorkbook =
    !afterSubmission
    && priorWorkbook
    && priorWorkbook !== workbookPath
    && isWorkbookPathFor(priorWorkbook, submissionId)
      ? [priorWorkbook]
      : []

  await removeObjects(service, [...obsoleteImages, ...obsoleteWorkbook])

  // ── 20. Counts and consequences, never content ──
  //
  // An amendment reports WHAT IT COST, because the person who confirmed it is
  // entitled to know: whether a finance verification was cleared and how many
  // ready document versions stopped being current. Counts and booleans only —
  // no name, no figure, no path.
  // A revision approval returns the version decision with the parse nested
  // under `parse`; the counts below are read from whichever shape came back.
  const outer = (replaced ?? {}) as Record<string, unknown>
  const result = (ctx.revisionVersionId && outer.parse && typeof outer.parse === 'object'
    ? outer.parse
    : outer) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  // The version decision, identifiers only, on the revision path alone.
  const revision = ctx.revisionVersionId
    ? {
        versionId: ctx.revisionVersionId,
        versionNumber: typeof outer.version_number === 'number' ? outer.version_number : null,
        versionStatus: typeof outer.status === 'string' ? outer.status : null,
      }
    : {}
  return NextResponse.json({
    ...revision,
    submissionId,
    // The real status, not an assumption. This route is no longer only a draft
    // path, and a caller that read 'draft' for an approved PI would be lied to.
    status: ctx.submissionStatus,
    itemCount: plan.counts.items,
    representativeImageCount: plan.counts.representativeImages,
    customizationImageCount: plan.counts.customizationImages,
    // Codes only. A parser message can quote a product name or a cell value.
    warningCodes: [...new Set(parsed.warnings.map(w => w.code))],
    savedItemCount: typeof result.item_count === 'number' ? result.item_count : plan.counts.items,
    // Stated explicitly so no caller can read a saved draft as a placed order.
    orderNumberAssigned: false,
    // ── What replacing this PI actually did ──
    afterSubmission: result.after_submission === true,
    financeVerificationCleared: result.finance_verification_cleared === true,
    supersededDocuments: num(result.superseded_documents),
    unchanged: result.unchanged === true,
  })
}

/**
 * Undo this attempt's uploads — but only the ones nothing references.
 *
 * THE RACE THIS CLOSES. Two concurrent attempts on the same draft (a
 * double-click, two tabs) plan identical content-addressed keys. One creates
 * key K; the other gets a 409, verifies it and reuses it. If the SECOND then
 * commits its database rows and the FIRST fails, a naive rollback would delete
 * K while committed rows point at it — turning a recoverable failure into a
 * broken record, which is precisely what this whole correction exists to
 * prevent.
 *
 * So the rollback asks the database what is currently referenced and skips
 * those keys. It also covers the quieter case where an object was missing
 * out-of-band, this attempt recreated it, and a surviving row still names it.
 *
 * A failed lookup deletes NOTHING. Leaving an unreferenced private object is a
 * housekeeping cost; deleting a referenced one is data loss.
 */
/**
 * Did this upload fail because the key is already taken?
 *
 * Supabase reports it as a 409 with a "Duplicate"/"already exists" message.
 * Both are checked because the shape has changed across versions, and reading
 * this wrong in the permissive direction would mean treating a real failure as
 * a reusable object.
 */
function isAlreadyExists(error: unknown): boolean {
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown; error?: unknown }
  const status = String(e?.statusCode ?? e?.status ?? '')
  if (status === '409') return true
  const text = `${String(e?.message ?? '')} ${String(e?.error ?? '')}`.toLowerCase()
  return text.includes('already exists') || text.includes('duplicate')
}

/**
 * Is the object already at this content-addressed key genuinely reusable?
 *
 * THE BYTES ARE DOWNLOADED AND RE-HASHED. Storage's recorded size and content
 * type are not evidence about content: both are what the uploader DECLARED, not
 * anything derived from the object. Two different pictures of the same length,
 * both uploaded as image/png, are indistinguishable by metadata — and a
 * truncated or substituted object can carry a perfectly plausible one. Reusing
 * on that basis would point a commercial record at bytes nobody checked, which
 * is exactly the guarantee content-addressing is supposed to provide.
 *
 * So the object is fetched through the service-role client and its digest must
 * equal BOTH the hash of the freshly parsed picture and the hash written into
 * the key, with the format sniffed from the magic bytes and agreeing with the
 * type and extension. Anything else is a refusal — never an overwrite.
 */
async function verifyStoredImage(
  service: { storage: { from: (b: string) => { download: (p: string) => Promise<{ data: Blob | null; error: unknown }> } } },
  image: PlannedImage,
): Promise<boolean> {
  try {
    const { data, error } = await service.storage.from('order-files').download(image.storagePath)
    if (error || !data) return false
    if (data.size > MAX_IMAGE_OBJECT_BYTES) return false

    const stored = new Uint8Array(await data.arrayBuffer())
    const verdict = verifyStoredImageBytes({
      bytes: stored,
      expectedSha256: image.sha256,
      expectedMimeType: image.mimeType,
      expectedLength: image.bytes.byteLength,
      storagePath: image.storagePath,
      sniff: sniffImageFormat,
    })
    return verdict.ok
  } catch {
    return false
  }
}

/** Just the storage surface this helper needs, so it does not have to name the
 *  supabase-js client's generic parameters. */
type ObjectRemover = {
  storage: { from: (bucket: string) => { remove: (paths: string[]) => Promise<unknown> } }
}

/** Best-effort removal. Never throws: it runs on failure paths where the real
 *  error is the one that must reach the caller. */
async function removeObjects(
  service: ObjectRemover,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return
  try {
    await service.storage.from('order-files').remove([...paths])
  } catch {
    // Deliberately silent. A leftover object inside a private bucket is not
    // worth converting a recoverable error into an unrecoverable one.
  }
}
