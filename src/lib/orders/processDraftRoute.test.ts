/**
 * The trusted server pass, and the client flow that calls it.
 *
 * WHY SOURCE-SHAPE ASSERTIONS. This route is the boundary where a browser stops
 * being trusted, and every guarantee it makes is a guarantee about ABSENCE or
 * about ORDER:
 *
 *   * the browser's parse result is not an input — there is no field for it;
 *   * the service-role key never leaves the server;
 *   * nothing is persisted before the server has parsed the file itself and
 *     found no blocking issue;
 *   * images are uploaded before the database write and cleaned up if it fails,
 *     while the employee's workbook is never deleted;
 *   * no order number, no approval, no payment.
 *
 * A behavioural test cannot reach these without a live Supabase project and a
 * real bucket, which this phase may not touch. So they are asserted against the
 * route's own source, the way uiEnforcement.test.ts asserts screen behaviour.
 * The pure logic underneath — paths, ids, payload shape, the save-flow state
 * machine — is unit-tested separately and for real.
 *
 * Reads repository files only. No database, no network, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/orders/processDraftRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/**
 * Source with its comments removed.
 *
 * The route DOCUMENTS why it never trusts the browser and never deletes the
 * workbook; a check searching raw text would match the prose that promises the
 * very thing it verifies.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const read = (p: string) => stripComments(readFileSync(join(ROOT, p), 'utf8'))
const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ROUTE = 'src/app/api/orders/import/process-draft/route.ts'
const PAGE = 'src/app/orders/import/page.tsx'
const FLOW = 'src/lib/orders/saveDraftFlow.ts'
const PAYLOAD = 'src/lib/orders/submissionPayload.ts'
const MIGRATION = 'supabase/migrations/20260909000000_order_submission_item_images.sql'

const route = read(ROUTE)

// ══ 1. The route exists where the client calls it ════════════════════════════

describe('the endpoint', () => {
  test('is a POST route at /api/orders/import/process-draft', () => {
    assert.ok(existsSync(join(ROOT, ROUTE)))
    assert.ok(route.includes('export async function POST'))
  })

  test('runs on Node, because it hashes and parses a workbook', () => {
    assert.ok(route.includes("export const runtime = 'nodejs'"))
  })

  test('the client calls exactly this path', () => {
    assert.ok(read(PAGE).includes("'/api/orders/import/process-draft'"))
  })
})

// ══ 2. The browser's parse is not an input ═══════════════════════════════════

describe('nothing parsed in the browser is trusted', () => {
  test('the request body carries only an id and a path', () => {
    assert.ok(route.includes('submissionId?: unknown'))
    assert.ok(route.includes('sourceWorkbookPath?: unknown'))
    // No field could carry a price, a product or a parse result.
    for (const forbidden of ['products', 'commercial', 'grandTotal', 'parseResult', 'items:', 'preview']) {
      assert.ok(!route.includes(`body.${forbidden}`), `the body must not carry ${forbidden}`)
    }
  })

  test('the workbook bytes are not posted either', () => {
    assert.ok(!route.includes('formData'), 'a 10 MiB multipart body would be refused by the platform')
    assert.ok(!route.includes('base64'))
    assert.ok(route.includes("service.storage.from('order-files').download"))
  })

  test('the server runs the parser itself', () => {
    assert.ok(route.includes('parseBoePiWorkbook(bytes)'))
    assert.ok(route.includes("from '@/lib/pi/masterSheetParser'"))
  })

  test('the payload comes from the server parse, through the pure builder', () => {
    assert.ok(route.includes('buildSubmissionPlan({'))
    assert.ok(route.includes('workbook: parsed.data'))
    assert.ok(route.includes('warnings: parsed.warnings'))
  })

  test('the client sends no parse result', () => {
    const page = read(PAGE)
    const bodyStart = page.indexOf('JSON.stringify({')
    const body = page.slice(bodyStart, bodyStart + 220)
    assert.ok(body.includes('submissionId'))
    assert.ok(body.includes('sourceWorkbookPath'))
    assert.ok(!body.includes('preview'), 'the preview must not be sent')
    assert.ok(!body.includes('products'))
  })
})

// ══ 3. Authorization ═════════════════════════════════════════════════════════

describe('the actor is resolved from the session and re-derived from the database', () => {
  test('an unauthenticated caller is refused', () => {
    assert.ok(route.includes('const { data: { user } } = await authClient.auth.getUser()'))
    assert.ok(route.includes("if (!user) return fail(401, 'UNAUTHORIZED'"))
  })

  test('the user id is never taken from the request body', () => {
    assert.ok(!route.includes('body.userId'))
    assert.ok(!route.includes('body.actorId'))
    assert.ok(route.includes('p_actor_id: user.id'), 'the actor is the session user')
  })

  test('an inactive or soft-deleted account is refused', () => {
    assert.ok(route.includes('me.is_active !== true || me.is_deleted === true'))
    assert.ok(route.includes("fail(403, 'ACCOUNT_INACTIVE'"))
  })

  test('orders.create is required, resolved by the permission engine', () => {
    assert.ok(route.includes("p_module_key: 'orders'"))
    assert.ok(route.includes("p_action_key: 'create'"))
    assert.ok(route.includes("fail(403, 'FORBIDDEN'"))
  })

  test('a failed authorization read denies rather than admits', () => {
    assert.ok(route.includes("if (meErr) return fail(500, 'AUTH_CHECK_FAILED'"))
    assert.ok(route.includes("if (permErr) return fail(500, 'AUTH_CHECK_FAILED'"))
  })

  test('the draft must be owned by this actor and still editable', () => {
    assert.ok(route.includes('submission.created_by === user.id || submission.submitted_by === user.id'))
    assert.ok(route.includes("fail(403, 'NOT_OWNED'"))
    assert.ok(route.includes("['draft', 'needs_changes'].includes(submission.status)"))
    assert.ok(route.includes("fail(409, 'NOT_EDITABLE'"))
  })

  test('the database re-checks all of it under a lock', () => {
    // assert_order_submission_editor, called by the RPC, is the real boundary.
    assert.ok(route.includes("service.rpc('replace_order_submission_parse'"))
  })
})

// ══ 4. The path is hostile input ═════════════════════════════════════════════

describe('the workbook path', () => {
  test('is validated for shape AND for ownership', () => {
    assert.ok(route.includes('isWorkbookPathFor(workbookPath, submissionId)'))
    assert.ok(route.includes("fail(400, 'BAD_WORKBOOK_PATH'"))
  })

  test('the submission id itself must be a uuid before anything else happens', () => {
    assert.ok(route.includes('if (!isUuid(submissionId))'))
  })

  test('the object must actually exist, and is read privately', () => {
    assert.ok(route.includes("fail(404, 'WORKBOOK_NOT_STORED'"))
    assert.ok(route.includes("service.storage.from('order-files').download(workbookPath)"))
  })

  test('size and type are re-checked against the bytes actually held', () => {
    assert.ok(route.includes('bytes.byteLength > PI_MAX_WORKBOOK_BYTES'))
    assert.ok(route.includes("fail(413, 'WORKBOOK_TOO_LARGE'"))
    assert.ok(route.includes("fail(400, 'WORKBOOK_NOT_XLSX'"))
    assert.ok(route.includes("fail(400, 'WORKBOOK_EMPTY'"))
  })

  test('the workbook is hashed for provenance', () => {
    assert.ok(route.includes('sha256Hex(bytes)'))
  })
})

// ══ 5. Nothing is persisted from a bad parse ═════════════════════════════════

describe('persistence is refused before it starts', () => {
  test('a thrown parser error persists nothing and is not read', () => {
    assert.ok(route.includes('} catch {'))
    assert.ok(route.includes("fail(422, 'PARSE_FAILED'"))
  })

  test('a failed parse persists nothing', () => {
    const failedAt = route.indexOf('if (!parsed.ok)')
    const rpcAt = route.indexOf("service.rpc('replace_order_submission_parse'")
    assert.ok(failedAt > -1 && rpcAt > failedAt, 'the refusal must precede the write')
  })

  test('blocking issues are refused SERVER-SIDE, whatever the browser decided', () => {
    assert.ok(route.includes('if (parsed.blockingIssues.length > 0)'))
    assert.ok(route.includes("fail(422, 'BLOCKING_ISSUES'"))
    const blockingAt = route.indexOf('parsed.blockingIssues.length > 0')
    const planAt = route.indexOf('buildSubmissionPlan({')
    assert.ok(blockingAt < planAt, 'nothing is planned or uploaded for a blocked PI')
  })

  test('a failed parse LEAVES the workbook in storage so it can be retried', () => {
    const parseFailAt = route.indexOf("fail(422, 'PARSE_FAILED'")
    const before = route.slice(0, parseFailAt)
    assert.ok(!before.includes('.remove('), 'the employee’s upload is never deleted on a parse failure')
  })
})

// ══ 6. Storage writes and their cleanup ══════════════════════════════════════

describe('a live image object is never overwritten', () => {
  test('uploads are NOT upserts', () => {
    assert.ok(route.includes('upsert: false'),
      'an upsert would rewrite the object the current rows still describe')
    assert.ok(!route.includes('upsert: true'))
    assert.ok(route.includes('contentType: image.mimeType'))
  })

  test('an existing key is reused only after its BYTES are re-hashed', () => {
    assert.ok(route.includes('isAlreadyExists(error)'))
    assert.ok(route.includes('await verifyStoredImage(service, image)'))
    // The object is downloaded and verified, not judged by its metadata.
    assert.ok(route.includes("service.storage.from('order-files').download(image.storagePath)"))
    assert.ok(route.includes('verifyStoredImageBytes({'))
    assert.ok(route.includes('expectedSha256: image.sha256'))
    assert.ok(route.includes('sniff: sniffImageFormat'))
    assert.ok(!route.includes('metadata?.mimetype'), 'declared metadata is not evidence about content')
  })

  test('an unverifiable object is a stable integrity error, never an overwrite', () => {
    assert.ok(route.includes("fail(409, 'IMAGE_INTEGRITY'"))
    const block = route.slice(route.indexOf('if (isAlreadyExists(error))'))
    assert.ok(!block.slice(0, 600).includes('upsert: true'))
  })

  test('the integrity error exposes no path, bytes or commercial data', () => {
    const at = route.indexOf("fail(409, 'IMAGE_INTEGRITY'")
    const call = route.slice(at, route.indexOf(')', route.indexOf("'", at + 40)) + 200)
    assert.ok(!call.includes('storagePath'))
    assert.ok(!call.includes('sha256'))
    assert.ok(!call.includes('image.'))
  })

  test('an unverifiable existing object fails the attempt rather than being trusted', () => {
    const uploadBlock = route.slice(route.indexOf('for (const image of plan.images)'))
    assert.ok(uploadBlock.includes('if (reusable) continue'))
    assert.ok(uploadBlock.includes("fail(502, 'IMAGE_UPLOAD_FAILED'"))
  })

  test('only objects this attempt CREATED are recorded for rollback', () => {
    assert.ok(route.includes('const created: string[] = []'))
    assert.ok(route.includes('created.push(image.storagePath)'))
    // A reused object is not pushed — `continue` skips the push entirely.
    assert.ok(!/if \(reusable\) \{[\s\S]{0,80}created\.push/.test(route))
  })

  test('the key is content-addressed, which is what makes rollback safe', () => {
    assert.ok(read(PAYLOAD).includes('${input.position}-${input.sha256}.${ext}'))
  })
})

describe('cleanup ordering', () => {
  test('an upload failure removes only what this attempt created', () => {
    const failAt = route.indexOf("fail(502, 'IMAGE_UPLOAD_FAILED'")
    const block = route.slice(failAt - 200, failAt)
    assert.ok(block.includes('await rollbackCreated()'))
  })

  test('a database failure removes only what this attempt created', () => {
    const rpcErrAt = route.indexOf('if (rpcErr)')
    // The block itself, not what follows it.
    const block = route.slice(rpcErrAt, route.indexOf("fail(500, 'SAVE_FAILED'", rpcErrAt))
    assert.ok(block.includes('await rollbackCreated()'))
    assert.ok(!block.includes('priorPaths'), 'nothing that survived is touched')
    assert.ok(!block.includes('workbookPath'), 'and the workbook is never removed')
  })

  test('rollback never deletes an object a committed row references', () => {
    // Closes the concurrent-attempt race: one request creates a key, another
    // reuses and commits it, the first fails. Deleting blindly would break the
    // record that survived.
    assert.ok(route.includes("from('order_submission_item_images')"))
    assert.ok(route.includes(".in('storage_path', created)"))
    assert.ok(route.includes('created.filter(p => !referenced.has(p))'))
  })

  test('a failed reference lookup deletes nothing at all', () => {
    const rollbackAt = route.indexOf('const rollbackCreated = async () =>')
    const block = route.slice(rollbackAt, route.indexOf('for (const image of plan.images)', rollbackAt))
    assert.ok(block.includes('if (error) return'),
      'an unreferenced leftover is cheaper than deleting a referenced object')
  })

  test('obsolete objects are removed only AFTER the replacement committed', () => {
    const rpcAt = route.indexOf("service.rpc('replace_order_submission_parse'")
    const obsoleteAt = route.indexOf('const obsoleteImages')
    const removeAt = route.lastIndexOf('await removeObjects(')
    assert.ok(obsoleteAt > rpcAt, 'an orphan is only an orphan once the new snapshot exists')
    assert.ok(removeAt > rpcAt)
  })

  test('a failed obsolete cleanup does not roll anything back or fail the save', () => {
    const removeAt = route.lastIndexOf('await removeObjects(')
    const after = route.slice(removeAt)
    assert.ok(!after.includes('fail('), 'the draft is saved; cleanup cannot un-save it')
    assert.ok(after.includes('return NextResponse.json({'))
  })

  test('cleanup is best-effort and cannot mask the primary error', () => {
    assert.ok(route.includes('async function removeObjects'))
    assert.ok(/removeObjects[\s\S]*?try \{[\s\S]*?\} catch \{/.test(route))
  })

  test('prior image paths are read from the database, never from the request', () => {
    assert.ok(route.includes("from('order_submission_item_images')"))
    assert.ok(route.includes("select('storage_path')"))
    assert.ok(route.includes(".eq('submission_id', submissionId)"))
  })

  test('cleanup is scoped to this submission, so it cannot reach another draft', () => {
    // Both lists are derived from THIS submission: its own image rows, and its
    // own previous workbook re-validated against its own id.
    assert.ok(route.includes('isWorkbookPathFor(priorWorkbook, submissionId)'))
    assert.ok(route.includes('[...priorPaths].filter(p => !currentPaths.has(p))'))
  })
})

describe('the original workbook', () => {
  test('is never deleted while it is the current one', () => {
    assert.ok(route.includes('priorWorkbook !== workbookPath'),
      'the path just recorded is excluded by construction')
  })

  test('the superseded one is removed only after a successful replacement', () => {
    const rpcAt = route.indexOf("service.rpc('replace_order_submission_parse'")
    const obsoleteAt = route.indexOf('const obsoleteWorkbook')
    assert.ok(obsoleteAt > rpcAt)
  })

  test('a foreign or malformed stored path cannot direct a delete', () => {
    assert.ok(route.includes('&& isWorkbookPathFor(priorWorkbook, submissionId)'))
  })

  test('the previous path is read from the database row', () => {
    assert.ok(route.includes('source_workbook_path'))
    assert.ok(route.includes('submission.source_workbook_path'))
  })

  test('a parse or blocking failure deletes no workbook at all', () => {
    const parseFailAt = route.indexOf("fail(422, 'PARSE_FAILED'")
    assert.ok(!route.slice(0, parseFailAt).includes('removeObjects'))
  })
})

// ══ 7. Idempotency ═══════════════════════════════════════════════════════════

describe('a retry converges instead of duplicating', () => {
  test('item ids are deterministic, so image keys repeat exactly', () => {
    assert.ok(read(PAYLOAD).includes('export function deterministicItemId'))
    assert.ok(read(PAYLOAD).includes('order-submission-item:${submissionId}:${sourceRow}'))
  })

  test('the client reuses its draft and its uploaded key across retries', () => {
    const page = read(PAGE)
    assert.ok(page.includes('draftRef'))
    assert.ok(page.includes('if (!draftRef.current)'), 'no second submission is created')
    assert.ok(page.includes('if (!draft.workbookPath)'), 'no second copy of the workbook is uploaded')
  })

  test('the upload path is recorded ONLY after the upload succeeded', () => {
    const page = read(PAGE)
    const uploadAt = page.indexOf('.upload(path, workbookFileRef.current')
    const recordAt = page.indexOf('draft.workbookPath = path')
    const failAt = page.indexOf("describeSaveFailure('UPLOAD_FAILED')")
    assert.ok(recordAt > uploadAt, 'recorded after the call')
    assert.ok(failAt < recordAt, 'and only on the success branch')
  })

  test('Change PI reuses the editable draft rather than creating a second one', () => {
    const page = read(PAGE)
    assert.ok(page.includes('draftRef.current.workbookPath = null'),
      'only the key is cleared; the submission id survives')
    assert.ok(!page.includes('draftRef.current = null'),
      'a changed file must not discard the draft')
  })

  test('a replay is recognised by a payload fingerprint', () => {
    assert.ok(read(PAYLOAD).includes('payload.fingerprint = sha256Hex('))
    assert.ok(read(MIGRATION).includes('parse_fingerprint'))
  })

  test('an identical replay writes no false audit entry', () => {
    const sql = read(MIGRATION)
    assert.ok(sql.includes('if not v_unchanged then'))
    assert.ok(sql.includes("'parse_replaced'"))
    assert.ok(sql.includes("'unchanged', v_unchanged"))
  })

  test('the fingerprint is read under the same row lock as the status', () => {
    assert.ok(read(MIGRATION).includes('select s.status, s.parse_fingerprint, s.processing_token'))
  })

  test('the route creates no submission of its own', () => {
    assert.ok(!route.includes('create_order_submission'))
    assert.ok(!route.includes("from('order_submissions').insert"))
  })

  test('the route never advances the status', () => {
    assert.ok(!route.includes('submit_order_submission'))
    assert.ok(!route.includes("status: 'submitted'"))
    assert.ok(route.includes("status: 'draft'"), 'the response says draft, and only draft')
  })
})

// ══ 7a. The processing lease ═════════════════════════════════════════════════

describe('the route holds a lease for the whole run', () => {
  test('the lease is acquired after authorization and before any byte is read', () => {
    const authAt = route.indexOf("fail(403, 'FORBIDDEN'")
    const leaseAt = route.indexOf("service.rpc('begin_order_submission_processing'")
    const downloadAt = route.indexOf("download(workbookPath)")
    assert.ok(leaseAt > authAt, 'an unauthorized caller never takes a lease')
    assert.ok(downloadAt > leaseAt, 'and nothing is read before the lease is held')
  })

  test('the token is generated on the server and never sent to the browser', () => {
    assert.ok(route.includes('const processingToken = crypto.randomUUID()'))
    const returnAt = route.lastIndexOf('return NextResponse.json({')
    const body = route.slice(returnAt)
    assert.ok(!body.includes('processingToken'), 'the token is never returned')
    assert.ok(!body.includes('token'))
  })

  test('the token is never logged', () => {
    for (const sink of ['console.log', 'console.error', 'console.warn', 'console.info']) {
      assert.ok(!route.includes(sink))
    }
  })

  test('a busy submission is a retryable 409, not a failure', () => {
    assert.ok(route.includes('isProcessingBusy(lease.error)'))
    assert.ok(route.includes("fail(409, 'PROCESSING_BUSY'"))
    assert.ok(route.includes("String(e?.code ?? '') === '55P03'"))
    assert.ok(route.includes('ORDER_SUBMISSION_PROCESSING_BUSY'))
  })

  test('the whole run happens inside try/finally', () => {
    const leaseAt = route.indexOf("service.rpc('begin_order_submission_processing'")
    const tryAt = route.indexOf('try {', leaseAt)
    const finallyAt = route.indexOf('} finally {', tryAt)
    assert.ok(tryAt > leaseAt && finallyAt > tryAt)
  })

  test('the lease is released in finally, with the token that holds it', () => {
    const finallyAt = route.indexOf('} finally {')
    const block = route.slice(finallyAt, finallyAt + 400)
    assert.ok(block.includes("finish_order_submission_processing"))
    assert.ok(block.includes('p_token: processingToken'))
  })

  test('the replacement presents the same token', () => {
    assert.ok(route.includes('plan.payload.processing_token = processingToken'))
  })

  test('the token is attached AFTER the fingerprint, so a retry still looks like one', () => {
    const fingerprintAt = read(PAYLOAD).indexOf('payload.fingerprint = sha256Hex(')
    assert.ok(fingerprintAt > -1)
    assert.ok(!read(PAYLOAD).includes('processing_token'),
      'the plan builder knows nothing about the lease, so the fingerprint cannot include it')
  })

  test('cleanup and rollback both run inside the leased body', () => {
    // processUnderLease is called from within the try; everything it does
    // therefore happens before the finally that releases the lease.
    const bodyAt = route.indexOf('async function processUnderLease')
    const body = route.slice(bodyAt)
    assert.ok(body.includes('await removeObjects('), 'obsolete cleanup is inside the leased body')
    assert.ok(body.includes('await rollbackCreated()'), 'so is rollback')

    const tryAt = route.indexOf('try {', route.indexOf('begin_order_submission_processing'))
    const callAt = route.indexOf('return await processUnderLease({')
    const finallyAt = route.indexOf('} finally {')
    assert.ok(callAt > tryAt && callAt < finallyAt, 'and the body is called inside the try')
  })

  test('the reference re-check remains as a second guard', () => {
    assert.ok(route.includes(".in('storage_path', created)"))
    assert.ok(route.includes('created.filter(p => !referenced.has(p))'))
  })

  test('a lease failure that is not "busy" is reported separately', () => {
    assert.ok(route.includes("fail(500, 'LEASE_FAILED'"))
  })

  test('the client is told a busy draft is retryable, and keeps its attempt state', () => {
    const flow = read(FLOW)
    assert.ok(flow.includes('This draft is already being processed. Please try again shortly.'))
    assert.ok(/PROCESSING_BUSY:\s+\{ message: '[^']+', retryable: true \}/.test(flow))
    // Not a document rejection: nothing about the PI is wrong.
    assert.ok(!/PROCESSING_BUSY[^\n]*document: true/.test(flow))
  })
})

// ══ 8. Scope: no numbering, approval or payment ══════════════════════════════

describe('the phase boundary holds', () => {
  test('no order number is allocated or returned', () => {
    for (const forbidden of ['display_number', 'allocate_confirmed_order_number', 'order_number']) {
      assert.ok(!route.includes(forbidden), `${forbidden} is not this phase`)
    }
    assert.ok(route.includes('orderNumberAssigned: false'))
  })

  test('no order row is created', () => {
    assert.ok(!route.includes("from('orders')"))
  })

  test('no approval or rejection happens', () => {
    for (const forbidden of ['approve', 'reject', 'approved_by', 'rejected_by']) {
      assert.ok(!route.includes(forbidden), `${forbidden} is not this phase`)
    }
  })

  test('no payment is touched', () => {
    assert.ok(!route.includes('finance_payment'))
    assert.ok(!route.includes('advance'))
  })
})

// ══ 9. Privacy ═══════════════════════════════════════════════════════════════

describe('nothing sensitive is logged or returned', () => {
  test('the route logs nothing at all', () => {
    for (const sink of ['console.log', 'console.error', 'console.warn', 'console.info']) {
      assert.ok(!route.includes(sink), `${sink} must not appear — a PI carries client and price data`)
    }
  })

  test('the response carries counts and codes, never content', () => {
    const returnAt = route.lastIndexOf('return NextResponse.json({')
    const body = route.slice(returnAt, route.indexOf('})', returnAt))
    for (const forbidden of ['client', 'grandTotal', 'productName', 'address', 'gst', 'phone', 'price']) {
      assert.ok(!body.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} must not be returned`)
    }
    assert.ok(body.includes('itemCount'))
    assert.ok(body.includes('representativeImageCount'))
    assert.ok(body.includes('customizationImageCount'))
    assert.ok(body.includes('warningCodes'))
  })

  test('blocking issues are returned as codes, rows and cells — not messages', () => {
    assert.ok(route.includes('issues: parsed.blockingIssues.map(i => ({ code: i.code, row: i.row, cell: i.cell ?? null }))'))
    assert.ok(!route.includes('i.message'), 'a parser message quotes product names')
  })

  test('warning codes are deduplicated and carry no message', () => {
    assert.ok(route.includes('[...new Set(parsed.warnings.map(w => w.code))]'))
  })

  test('the stored filename is not taken from the request body', () => {
    assert.ok(route.includes('workbookName: null'))
    assert.ok(!route.includes('body.fileName'))
    assert.ok(!route.includes('body.originalName'))
  })

  test('the object key carries an opaque uuid, not a client-named file', () => {
    assert.ok(read(FLOW).includes('workbookObjectPath'))
    assert.ok(read(FLOW).includes('/original/${objectId}.xlsx'))
    assert.ok(!read(FLOW).includes('file.name'))
  })
})

// ══ 10. The service role never reaches the browser ═══════════════════════════

describe('service-role isolation', () => {
  test('the route is the only place the key is read', () => {
    assert.ok(route.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'))
  })

  test('no client file references the service key or the privileged RPC', () => {
    const clientFiles = [PAGE, FLOW, 'src/lib/pi/previewView.ts', 'src/app/orders/page.tsx']
    for (const file of clientFiles) {
      const text = raw(file)
      assert.ok(!text.includes('SERVICE_ROLE'), `${file} must not mention the service key`)
      assert.ok(!text.includes('replace_order_submission_parse'),
        `${file} must not call the service-role-only RPC`)
    }
  })

  test('no "use client" module reads the service key anywhere in the app', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(rel); continue }
        if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
        const text = readFileSync(join(ROOT, rel), 'utf8')
        if (/^['"]use client['"]/m.test(text) && text.includes('SERVICE_ROLE')) offenders.push(rel)
      }
    }
    walk('src')
    assert.deepEqual(offenders, [], 'a client component must never read the service-role key')
  })

  test('the privileged RPC is called only from server code', () => {
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(rel); continue }
        if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
        const text = readFileSync(join(ROOT, rel), 'utf8')
        if (text.includes("rpc('replace_order_submission_parse'")) callers.push(rel)
      }
    }
    walk('src')
    assert.deepEqual(callers, [ROUTE], 'exactly one caller, and it is the server route')
  })

  test('the payload builder is server-only and says so by importing node crypto', () => {
    assert.ok(read(PAYLOAD).includes("from 'node:crypto'"))
    assert.ok(!raw(PAYLOAD).includes("'use client'"))
  })
})

// ══ 11. Nothing is skipped silently ══════════════════════════════════════════

describe('unsupported image formats are refused, not skipped', () => {
  test('the route refuses a plan that lost any image', () => {
    assert.ok(route.includes('plan.counts.skippedImages > 0'))
    assert.ok(route.includes("fail(422, 'IMAGE_FORMAT_UNSUPPORTED'"))
  })

  test('the refusal happens BEFORE anything is uploaded', () => {
    const guardAt = route.indexOf('plan.counts.skippedImages > 0')
    const uploadAt = route.indexOf('for (const image of plan.images)')
    const leaseAt = route.indexOf("service.rpc('begin_order_submission_processing'")
    assert.ok(guardAt > -1 && guardAt < uploadAt, 'no object is written for a refused plan')
    assert.ok(guardAt > leaseAt, 'and it happens under the lease, like the rest')
  })

  test('the response no longer carries an unhandled skipped count', () => {
    assert.ok(!route.includes('skippedImageCount'),
      'a field the client never displayed is exactly how the gap stayed invisible')
  })

  test('the parser is the first line of defence, server-side', () => {
    const parser = read('src/lib/pi/masterSheetParser.ts')
    assert.ok(parser.includes("code: 'PRODUCT_IMAGE_UNSUPPORTED_FORMAT'"))
    assert.ok(parser.includes("code: 'CUSTOMIZATION_IMAGE_UNSUPPORTED_FORMAT'"))
    assert.ok(parser.includes('isStorableImageFormat'))
  })

  test('the accepted set has ONE definition', () => {
    const rule = read('src/lib/pi/imageFormats.ts')
    assert.ok(rule.includes("PI_STORABLE_IMAGE_FORMATS = ['png', 'jpeg', 'webp']"))
    // Everything reads it from there rather than restating it.
    assert.ok(read('src/lib/orders/submissionPayload.ts').includes("from '../pi/imageFormats'"))
    assert.ok(read('src/lib/pi/previewView.ts').includes("from './imageFormats'"))
    assert.ok(read('src/lib/pi/masterSheetParser.ts').includes("from './imageFormats'"))
  })

  test('the client maps the refusal to a visible message', () => {
    assert.ok(read(FLOW).includes('IMAGE_FORMAT_UNSUPPORTED'))
  })
})
