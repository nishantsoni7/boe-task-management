import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createClient } from '@/lib/supabase/server'
import {
  ORDER_DOCUMENTS_GENERIC_FAILURE,
  ORDER_DOCUMENT_FAILURES,
  ORDER_DOCUMENT_UNKNOWN_FAILURE,
  orderDocumentAttemptPath,
  sanitizeOrderDocumentFailure,
} from '@/lib/orders/orderDocuments'
import {
  CONFIRMED_WORKBOOK_MAX_BYTES,
  CONFIRMED_WORKBOOK_MIME,
  buildConfirmedWorkbook,
} from '@/lib/orders/confirmedWorkbook'
import {
  WORKBOOK_COLUMNS,
  loadApprovedWorkbook,
  sha256Hex,
  type ObjectReader,
} from '@/lib/orders/confirmedExcel'
import { buildConfirmedPdfModel } from '@/lib/orders/confirmedPdf'
import { renderConfirmedPdf } from '@/lib/orders/confirmedPdfRender'
import { ORDER_FILES_BUCKET, PI_DRAFT_ITEM_COLUMNS, type PersistedItem } from '@/lib/orders/draftsView'
import { ORDER_PI_HANDOFF_COLUMNS, type OrderPiRow } from '@/lib/orders/orderPiHandoff'

// GENERATING A CONFIRMED ORDER'S DOCUMENTS.
//
// WHERE THIS SITS
// ---------------
// Approval is atomic and stays small: it allocates the Order number and moves
// the money, and nothing slow may live inside it. Document generation therefore
// happens AFTER approval, through the claim protocol in migration
// 20260925000000, and this route is the worker that protocol describes.
//
//   request   as the CALLER, so the two RLS policies decide. A SECURITY DEFINER
//             function could not ask "may this person see this Order" honestly —
//             inside one, the current user is the table owner, who bypasses row
//             security. See §5 of the migration.
//   claim     as the SERVER, atomically. The token that comes back is what
//             authorizes everything after it, and it never leaves this function.
//   generate  the workbook copy, then the PDF, then both uploads.
//   complete  only when BOTH objects exist. The database refuses `ready` any
//             other way, so this is belt and braces over a CHECK constraint.
//
// NOTHING THE CLIENT SENDS IS TRUSTED. The route takes an Order id from the URL
// and nothing else — no body at all. The PI, its workbook path, the version, the
// attempt and both destination keys are every one of them resolved server-side
// from the database. A caller cannot name a file to read, a file to write, or a
// version to publish.
//
// PRIVACY. Nothing here logs or returns a client name, an address, a price, a
// filename or a byte of a document. What is stored on a failure is a code and a
// PREWRITTEN sentence — sanitizeOrderDocumentFailure is an allow-list, so an
// error nobody anticipated contributes no text of its own and cannot leak a
// credential, a hostname or a stack frame.
//
// THE ORIGINAL WORKBOOK IS NEVER TOUCHED. It is read; the confirmed copy goes to
// a different key entirely. Every upload uses upsert:false against a key nothing
// has ever occupied, so immutability is never bent — order-files has no UPDATE
// policy and this route does not want one.

export const runtime = 'nodejs'

/**
 * How long this route may take.
 *
 * Reading a 10 MiB workbook, rewriting its ZIP, rendering a multi-page PDF with
 * embedded photographs and uploading both is seconds, not minutes — but a large
 * PI with forty images is the slow case and it must not be cut off halfway, with
 * one object uploaded and the version left claimed until its lease goes stale.
 *
 * 60 is the ceiling every Vercel plan allows, including Hobby, so this is
 * portable rather than tuned to a plan this repository cannot see. There is no
 * vercel.json; if one is ever added, this value is the one to keep in step.
 */
export const maxDuration = 60

/**
 * The privileged client — or null when this deployment has not been given the
 * service role key.
 *
 * THIS RETURNS NULL RATHER THAN THROWING, and that is the fix for a real defect
 * rather than a stylistic preference.
 *
 * It used to be `process.env.SUPABASE_SERVICE_ROLE_KEY!` — a non-null assertion
 * over a value the type system cannot actually vouch for. When the variable is
 * absent or empty, supabase-js throws `supabaseKey is required.` at the moment
 * of construction, and that construction sat OUTSIDE this route's try/catch. The
 * throw therefore escaped the handler entirely: Next returned a bare 500 whose
 * body carries no `message`, the client's `body?.message` came back undefined,
 * and the card fell back to its own generic sentence — "That could not be done
 * just now." A missing environment variable was being reported as though it
 * were a refusal, which sent everybody looking at permissions.
 *
 * A missing key is a DEPLOYMENT fault, not a user fault, and it now says so.
 * The two sibling routes in this module (test-data-cleanup, submissions/delete)
 * already guarded this way; this one is now consistent with them.
 */
function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createServiceClient(url, key)
}
type ServiceClient = NonNullable<ReturnType<typeof serviceClient>>

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The BOE mark, read from the repository's own public directory. A missing file
 *  is not a failure: the renderer falls back to the wordmark. */
async function readLogo(): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(process.cwd(), 'public', 'branding', 'boe-logo-full.png')))
  } catch {
    return null
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // THE OUTERMOST NET. Every deliberate exit below carries a code and a
  // message; this exists for the exits nobody wrote. An escaped throw becomes a
  // bare 500 whose body has no `message`, and the client then falls back to its
  // own generic sentence — which is precisely how a missing environment
  // variable came to be reported to a user as though it were a refusal.
  //
  // It says nothing about what happened. sanitizeOrderDocumentFailure is not
  // even consulted here: at this depth the failure has no established meaning,
  // and inventing one would be worse than admitting there isn't one.
  try {
    return await handle(req, { params })
  } catch {
    return fail(500, ORDER_DOCUMENT_UNKNOWN_FAILURE, ORDER_DOCUMENTS_GENERIC_FAILURE)
  }
}

async function handle(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // ── 1. Authenticate from the session, never from the body ──
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  const { id: orderId } = await params
  if (!UUID.test(orderId)) return fail(400, 'BAD_REQUEST', 'A valid Order id is required.')

  // ── 2. Ask for documents, AS THE CALLER ──
  //
  // request_order_document_generation is SECURITY INVOKER and the two write
  // policies decide. Running it through the caller's own session is therefore
  // not a convenience — it is the enforcement. Doing it with the service client
  // would bypass RLS and authorize anybody who could reach this URL.
  const { data: requested, error: requestError } = await authClient
    .rpc('request_order_document_generation', { p_order_id: orderId })

  if (requestError) {
    const message = String(requestError.message ?? '')
    if (message.includes('ORDER_DOCUMENT_FORBIDDEN')) {
      return fail(403, 'FORBIDDEN', 'Generating Order documents needs the management approval authority.')
    }
    if (message.includes('ORDER_DOCUMENT_NO_SUCH_ORDER')) {
      return fail(404, 'NOT_FOUND', 'That Order is not available to you.')
    }
    if (message.includes('ORDER_DOCUMENT_NO_SOURCE_PI')) {
      return fail(409, 'NO_SOURCE_PI', 'This Order was not created from a PI, so it has no documents to generate.')
    }
    // Anything else is refused without repeating the database's own words, which
    // can name a constraint, a column or a function.
    return fail(403, 'FORBIDDEN', 'That request was refused.')
  }

  const asked = (requested ?? {}) as { version?: number; status?: string }

  // ── 3. Claim, as the server ──
  //
  // THE CONFIGURATION IS CHECKED BEFORE THE CLIENT IS USED. A deployment
  // missing SUPABASE_SERVICE_ROLE_KEY cannot generate anything, and it must say
  // that in its own words: this is the one failure here that no retry, no
  // permission and no different Order will resolve.
  const service = serviceClient()
  if (!service) {
    return fail(503, 'SERVER_NOT_CONFIGURED',
      'Document generation is not configured on this deployment. This is a server setting, not something you can fix — please report it.')
  }

  const { data: claimed, error: claimError } = await service
    .rpc('claim_order_document_generation', { p_order_id: orderId })

  const claim = (claimed ?? {}) as {
    claimed?: boolean
    version_id?: string
    version?: number
    attempt?: number
    claim_token?: string
    excel_path?: string
    pdf_path?: string
  }

  if (claimError || !claim.claimed) {
    // Somebody else is already generating this Order, or the version was picked
    // up between the request and here. Not an error — the work is happening.
    //
    // EVERY RESPONSE FROM HERE ON CARRIES A `message`. The client falls back to
    // its own generic sentence whenever one is absent, which is exactly how a
    // configuration crash came to be reported as a refusal. A response without
    // a message is now a bug in this file.
    return NextResponse.json({
      status: 'in_progress',
      code: 'CLAIM_ACTIVE',
      version: claim.version ?? asked.version ?? null,
      message: 'These documents are already being generated. This page will show them when they are ready.',
    }, { status: 202 })
  }

  const token = String(claim.claim_token ?? '')
  const versionId = String(claim.version_id ?? '')
  const version = Number(claim.version ?? 0)
  const attempt = Number(claim.attempt ?? 0)

  // THE DESTINATION KEYS ARE THE DATABASE'S, not this route's. They are rebuilt
  // here only to compare, so a disagreement between the two implementations of
  // the path convention is a refusal rather than a file written where the policy
  // will not authorize it.
  const excelPath = String(claim.excel_path ?? '')
  const pdfPath = String(claim.pdf_path ?? '')
  const expectedExcel = orderDocumentAttemptPath(orderId, version, attempt, 'xlsx')
  const expectedPdf = orderDocumentAttemptPath(orderId, version, attempt, 'pdf')

  const release = async (code: unknown) => {
    const { code: safeCode, message } = sanitizeOrderDocumentFailure(code)
    // RELEASING MUST NOT BE ABLE TO REPLACE THE FAILURE IT IS RECORDING. If the
    // release itself throws — the network drops, the claim was taken over — the
    // caller still needs the answer about the ORIGINAL failure, and the lease
    // will fall to the TTL takeover it was designed for. Swallowing here is
    // therefore correct; swallowing anywhere else in this file would not be.
    try {
      await service.rpc('fail_order_document_generation', {
        p_version_id: versionId,
        p_claim_token: token,
        p_error_code: safeCode,
        p_error_message: message,
      })
    } catch {
      // deliberately ignored — see above
    }
    return { safeCode, message }
  }

  try {
    if (excelPath === '' || pdfPath === ''
        || excelPath !== expectedExcel || pdfPath !== expectedPdf) {
      const { safeCode, message } = await release(ORDER_DOCUMENT_UNKNOWN_FAILURE)
      return NextResponse.json({ status: 'failed', code: safeCode, message }, { status: 500 })
    }

    const outcome = await generate({
      service,
      orderId,
      version,
      excelPath,
      pdfPath,
    })

    if (!outcome.ok) {
      const { safeCode, message } = await release(outcome.code)
      return NextResponse.json({ status: 'failed', code: safeCode, message }, { status: 422 })
    }

    // ── 4. Publish — and ONLY with both files present ──
    const { data: completed, error: completeError } = await service
      .rpc('complete_order_document_generation', {
        p_version_id: versionId,
        p_claim_token: token,
        p_excel_path: excelPath,
        p_pdf_path: pdfPath,
        p_excel_sha256: outcome.excelSha,
        p_pdf_sha256: outcome.pdfSha,
        p_excel_bytes: outcome.excelBytes,
        p_pdf_bytes: outcome.pdfBytes,
      })

    if (completeError || !(completed as { completed?: boolean } | null)?.completed) {
      // The claim was taken over while this run was working, so its output is
      // stale and must not be published. Nothing is released: the live claim
      // belongs to somebody else and this run has no right to fail it.
      return NextResponse.json({
        status: 'superseded',
        code: 'CLAIM_LOST',
        version,
        message: ORDER_DOCUMENT_FAILURES.CLAIM_LOST,
      }, { status: 409 })
    }

    return NextResponse.json({ status: 'ready', version }, { status: 200 })
  } catch (err) {
    // The thrown value's own text is DISCARDED. sanitizeOrderDocumentFailure is
    // an allow-list: an unrecognised failure contributes no words of its own.
    const { safeCode, message } = await release(err)
    return NextResponse.json({ status: 'failed', code: safeCode, message }, { status: 500 })
  }
}

// ── The generation itself ─────────────────────────────────────────────────────

type GenerateOk = {
  ok: true
  excelSha: string
  pdfSha: string
  excelBytes: number
  pdfBytes: number
}
type GenerateFailed = { ok: false; code: string }

async function generate(input: {
  service: ServiceClient
  orderId: string
  version: number
  excelPath: string
  pdfPath: string
}): Promise<GenerateOk | GenerateFailed> {
  const { service, orderId } = input

  // ── The Order, and the PI it came from ──
  //
  // Read with the service client because this half runs as the system — but
  // every id used below comes from the database, never from the request.
  const { data: orderRow } = await service
    .from('orders')
    .select('id, display_number, confirm_date, source_order_submission_id')
    .eq('id', orderId)
    .maybeSingle()

  const order = orderRow as {
    display_number?: string
    confirm_date?: string | null
    source_order_submission_id?: string | null
  } | null

  if (!order?.source_order_submission_id) return { ok: false, code: 'NO_SOURCE_PI' }
  const submissionId = order.source_order_submission_id
  const orderNumber = String(order.display_number ?? '').trim()
  if (orderNumber === '') return { ok: false, code: 'NO_SOURCE_PI' }

  const [{ data: piRow }, { data: workbookRow }, { data: itemRows }, { data: imageRows }] =
    await Promise.all([
      service.from('order_submissions').select(ORDER_PI_HANDOFF_COLUMNS).eq('id', submissionId).maybeSingle(),
      service.from('order_submissions').select(WORKBOOK_COLUMNS).eq('id', submissionId).maybeSingle(),
      service.from('order_submission_items').select(PI_DRAFT_ITEM_COLUMNS)
        .eq('submission_id', submissionId).order('sort_order', { ascending: true }),
      service.from('order_submission_item_images').select('item_id, role, position, storage_path')
        .eq('submission_id', submissionId).order('position', { ascending: true }),
    ])

  const pi = piRow as unknown as OrderPiRow | null
  if (!pi) return { ok: false, code: 'PI_UNREADABLE' }

  const workbook = workbookRow as unknown as {
    id: string
    source_workbook_path: string | null
    source_workbook_size_bytes: number | string | null
    source_workbook_sha256: string | null
  } | null
  if (!workbook) return { ok: false, code: 'PI_UNREADABLE' }

  // ── The original workbook, PROVED ──
  const read: ObjectReader = async (path) => {
    const { data, error } = await service.storage.from(ORDER_FILES_BUCKET).download(path)
    if (error || !data) return null
    return new Uint8Array(await data.arrayBuffer())
  }

  const loaded = await loadApprovedWorkbook({
    submissionId: workbook.id,
    path: workbook.source_workbook_path,
    sizeBytes: workbook.source_workbook_size_bytes,
    sha256: workbook.source_workbook_sha256,
  }, read)
  if (!loaded.ok) return { ok: false, code: loaded.reason }

  // ── The confirmed workbook ──
  const rewritten = await buildConfirmedWorkbook({ bytes: loaded.bytes, orderNumber })
  if (!rewritten.ok) return { ok: false, code: rewritten.reason }
  if (rewritten.bytes.length > CONFIRMED_WORKBOOK_MAX_BYTES) return { ok: false, code: 'WORKBOOK_TOO_LARGE' }

  // ── The confirmed PDF ──
  const items = (itemRows ?? []) as unknown as PersistedItem[]

  // WHICH ROWS HAVE A PHOTOGRAPH, resolved from the stored image rows rather
  // than assumed. `representative` is the one a table cell shows.
  const images = (imageRows ?? []) as unknown as
    { item_id: string; role: string; position: number; storage_path: string }[]
  const pathByRow = new Map<number, string>()
  const rowByItem = new Map(items.map(i => [i.id, i.source_row]))
  for (const image of images) {
    if (image.role !== 'representative') continue
    const row = rowByItem.get(image.item_id)
    if (row === undefined || pathByRow.has(row)) continue
    if (typeof image.storage_path === 'string' && image.storage_path.startsWith(`submissions/${submissionId}/`)) {
      pathByRow.set(row, image.storage_path)
    }
  }

  const model = buildConfirmedPdfModel({
    orderNumber,
    submission: pi,
    items,
    imageRows: new Set(pathByRow.keys()),
  })

  let pdf: Buffer
  try {
    pdf = await renderConfirmedPdf({
      model,
      logo: await readLogo(),
      // PINNED to the Order's own confirm date, so two regenerations of one
      // version produce identical bytes and the recorded hash is an identity
      // rather than a timestamp. A record with no confirm date falls back to the
      // Unix epoch — a fixed instant, never the clock.
      metadata: {
        date: order.confirm_date ? new Date(`${order.confirm_date}T00:00:00Z`) : new Date(0),
        title: `Confirmed Order ${orderNumber}`,
      },
      loadImage: async (row) => {
        const path = pathByRow.get(row)
        if (!path) return null
        return read(path)
      },
    })
  } catch {
    return { ok: false, code: 'PDF_RENDER_FAILED' }
  }

  if (pdf.length > CONFIRMED_WORKBOOK_MAX_BYTES) return { ok: false, code: 'PDF_TOO_LARGE' }

  // ── Both objects, to keys nothing has ever occupied ──
  //
  // upsert:false, deliberately. order-files has no UPDATE policy and the service
  // role is not exempt from a bucket that has none; a colliding key is a defect
  // in the attempt counter and must be a loud failure rather than a silent
  // overwrite of an earlier attempt's output.
  const excelUpload = await service.storage.from(ORDER_FILES_BUCKET).upload(
    input.excelPath, rewritten.bytes, { contentType: CONFIRMED_WORKBOOK_MIME, upsert: false })
  if (excelUpload.error) return { ok: false, code: 'UPLOAD_FAILED' }

  const pdfUpload = await service.storage.from(ORDER_FILES_BUCKET).upload(
    input.pdfPath, pdf, { contentType: 'application/pdf', upsert: false })
  if (pdfUpload.error) return { ok: false, code: 'UPLOAD_FAILED' }

  return {
    ok: true,
    excelSha: await sha256Hex(rewritten.bytes),
    pdfSha: await sha256Hex(new Uint8Array(pdf)),
    excelBytes: rewritten.bytes.length,
    pdfBytes: pdf.length,
  }
}
