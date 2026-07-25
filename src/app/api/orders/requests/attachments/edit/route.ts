import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { REQUEST_ID_RE, ORDER_REQ_ATTACHMENT_BUCKET } from '@/lib/orderRequestAttachmentsServer'
import {
  ORDER_REQ_ATTACHMENT_MAX_BYTES,
  attachmentEditErrorMessage,
  buildAttachmentPath,
  resolveUploadType,
  formatBytes,
} from '@/lib/orderRequestAttachments'

// Authenticated server-side orchestration for editing the attachments of a
// SUBMITTED (finalized) Order Request: replace the Main PI, add reference files,
// remove reference files.
//
// Why a route and not a direct client upload
// ------------------------------------------
// 20260711 made a finalized request's attachments immutable through the client
// API on purpose: the storage INSERT/DELETE policies and the metadata INSERT
// policy are all gated on finalized_at IS NULL, and there is no metadata DELETE
// or UPDATE policy at all. Those policies are NOT widened by this feature — a
// browser still cannot write or delete a submitted request's objects. The
// privileged Storage work happens here instead, behind a server-side
// authorization check, exactly as the delete route already does.
//
// The safe order (Storage and Postgres cannot share a transaction):
//
//   1. authenticate the caller;
//   2. load the request FROM THE DATABASE and confirm it is finalized,
//      unconverted and in an editable status;
//   3. confirm the caller is an admin OR the CURRENT ASSIGNEE (the same rule
//      edit_order_request enforces) — never trust the client's own controls;
//   4. re-validate every uploaded file server-side: size ceiling and the
//      category's extension/MIME allow-list, using the same pure helpers the
//      browser used. The browser's compression result is accepted, its verdict
//      is not;
//   5. confirm every removal id is a REFERENCE row belonging to this request;
//   6. upload the new objects to NEW paths with the service role. Nothing has
//      been destroyed at this point;
//   7. call edit_order_request_attachments() with the CALLER'S OWN session, so
//      the SECURITY DEFINER function re-checks authorization independently and
//      swaps the metadata + writes the audit entries transactionally;
//   8. only after that commits, remove the superseded objects.
//
// Failure semantics:
//   * step 6 fails  → nothing was recorded; the objects uploaded so far are
//                     removed; the request is untouched.
//   * step 7 fails  → the metadata transaction rolled back in full, so the
//                     ORIGINAL rows and their files are intact. Every object
//                     uploaded in step 6 is removed as an orphan. The old Main PI
//                     was never deleted — it is only ever deleted in step 8.
//   * step 8 fails  → the database is already correct and consistent; the
//                     superseded objects are merely orphaned. Reported as a
//                     warning, never as a failed save, because retrying the save
//                     would not fix it and the record is right.

export const runtime = 'nodejs'

type NewFileMeta = {
  file_name: string
  storage_path: string
  mime_type: string
  original_size_bytes: number
  uploaded_size_bytes: number
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }

  const requestId = String(form.get('requestId') ?? '')
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    return NextResponse.json({ error: 'A valid requestId is required.' }, { status: 400 })
  }

  const mainPiFile = form.get('mainPi')
  const refFiles   = form.getAll('references')
  let removeIds: string[] = []
  try {
    const raw = form.get('removeIds')
    removeIds = raw ? (JSON.parse(String(raw)) as string[]) : []
    if (!Array.isArray(removeIds) || removeIds.some(id => typeof id !== 'string' || !REQUEST_ID_RE.test(id))) {
      return NextResponse.json({ error: 'Malformed removal list.' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'Malformed removal list.' }, { status: 400 })
  }

  const hasMainPi = mainPiFile instanceof File && mainPiFile.size > 0
  if (!hasMainPi && refFiles.length === 0 && removeIds.length === 0) {
    return NextResponse.json({ error: 'No attachment changes were supplied.' }, { status: 400 })
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // ── 2 + 3. Authoritative state + authorization ───────────────────────────────
  const { data: reqRow, error: reqErr } = await service
    .from('order_requests')
    .select('id, status, assigned_to, converted_order_id, finalized_at')
    .eq('id', requestId)
    .maybeSingle()
  if (reqErr)  return NextResponse.json({ error: 'Could not load the Order Request.' }, { status: 500 })
  if (!reqRow) return NextResponse.json({ error: 'This Order Request no longer exists.' }, { status: 404 })

  const { data: me, error: roleErr } = await service
    .from('users').select('role').eq('id', user.id).maybeSingle()
  if (roleErr) return NextResponse.json({ error: 'Authorization check failed.' }, { status: 500 })
  const isAdmin = me?.role === 'admin'

  // The same rule edit_order_request enforces: admin, or the CURRENT ASSIGNEE.
  // created_by / requested_by grant nothing on their own. The RPC checks this
  // again under a row lock — this is defence in depth, not the only gate.
  if (!isAdmin && reqRow.assigned_to !== user.id) {
    return NextResponse.json(
      { error: 'You do not have permission to change the attachments on this Order Request.' },
      { status: 403 },
    )
  }
  if (reqRow.converted_order_id || reqRow.status === 'converted') {
    return NextResponse.json(
      { error: 'This Order Request has been converted and its attachments can no longer be changed.' },
      { status: 409 },
    )
  }
  if (!['submitted', 'needs_clarification', 'rejected'].includes(reqRow.status)) {
    return NextResponse.json(
      { error: 'This Order Request is not in an editable state.' },
      { status: 409 },
    )
  }
  if (!reqRow.finalized_at) {
    return NextResponse.json(
      { error: 'This Order Request has not been submitted yet.' },
      { status: 409 },
    )
  }

  // ── 5. Removal ids must be REFERENCE rows on THIS request ────────────────────
  if (removeIds.length > 0) {
    const { data: rows, error: remErr } = await service
      .from('order_request_attachments')
      .select('id, attachment_type, order_request_id')
      .in('id', removeIds)
    if (remErr) return NextResponse.json({ error: 'Could not check the selected files.' }, { status: 500 })
    const found = (rows ?? []) as { id: string; attachment_type: string; order_request_id: string }[]
    if (found.length !== removeIds.length
        || found.some(r => r.order_request_id !== requestId)) {
      return NextResponse.json(
        { error: 'One of the selected files no longer belongs to this Order Request.' },
        { status: 409 },
      )
    }
    if (found.some(r => r.attachment_type !== 'reference')) {
      return NextResponse.json(
        { error: 'The Main PI can only be replaced, never removed on its own.' },
        { status: 400 },
      )
    }
  }

  // ── 4. Independent server-side file validation ───────────────────────────────
  // The browser already validated and (where needed) compressed. It is not
  // trusted: size and the category allow-list are re-checked here with the same
  // pure helpers, and the canonical MIME comes from resolveUploadType — never
  // from the browser-reported type.
  type Pending = { file: File; category: 'main_pi' | 'reference'; contentType: string }
  const pending: Pending[] = []

  const validate = (f: File, category: 'main_pi' | 'reference'): string | null => {
    if (f.size === 0) return `“${f.name}” is empty.`
    if (f.size > ORDER_REQ_ATTACHMENT_MAX_BYTES) {
      return `“${f.name}” is larger than the ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} limit.`
    }
    const contentType = resolveUploadType(f, category)
    if (!contentType) {
      return category === 'main_pi'
        ? 'The Main PI must be an Excel file (.xlsx or .xls).'
        : `“${f.name}” is not an accepted reference file type.`
    }
    pending.push({ file: f, category, contentType })
    return null
  }

  if (hasMainPi) {
    const err = validate(mainPiFile as File, 'main_pi')
    if (err) return NextResponse.json({ error: err }, { status: 400 })
  }
  for (const f of refFiles) {
    if (!(f instanceof File) || f.size === 0) continue
    const err = validate(f, 'reference')
    if (err) return NextResponse.json({ error: err }, { status: 400 })
  }

  // ── 6. Upload to NEW paths. Nothing is destroyed yet ─────────────────────────
  const uploaded: string[] = []
  const cleanupUploads = async () => {
    if (uploaded.length === 0) return
    await service.storage.from(ORDER_REQ_ATTACHMENT_BUCKET).remove(uploaded).catch(() => {})
  }

  let mainPiMeta: NewFileMeta | null = null
  const refMeta: NewFileMeta[] = []

  for (const item of pending) {
    const path = buildAttachmentPath(requestId, item.category, item.file.name)
    const { error: upErr } = await service.storage
      .from(ORDER_REQ_ATTACHMENT_BUCKET)
      .upload(path, item.file, { upsert: false, contentType: item.contentType })
    if (upErr) {
      await cleanupUploads()
      const msg = (upErr.message ?? '').toLowerCase()
      const tooBig = msg.includes('exceeded the maximum allowed size')
        || msg.includes('payload too large') || msg.includes('entity too large')
      return NextResponse.json({
        error: tooBig
          ? `“${item.file.name}” was rejected by storage for being too large.`
          : `Could not upload “${item.file.name}”. Nothing was changed — please try again.`,
      }, { status: 502 })
    }
    uploaded.push(path)

    const meta: NewFileMeta = {
      file_name:           item.file.name,
      storage_path:        path,
      mime_type:           item.contentType,
      original_size_bytes: item.file.size,
      uploaded_size_bytes: item.file.size,
    }
    if (item.category === 'main_pi') mainPiMeta = meta
    else refMeta.push(meta)
  }

  // ── 7. Metadata swap, under the CALLER'S session ─────────────────────────────
  // Deliberately not the service-role client: the SECURITY DEFINER function
  // reads auth.uid() for both its authorization check and the audit actor, so
  // running it as the caller is what makes the database the real gate and the
  // activity trail attributable.
  const { data: rpcData, error: rpcErr } = await authClient.rpc('edit_order_request_attachments', {
    p_order_request_id:      requestId,
    p_main_pi:               mainPiMeta,
    p_add_references:        refMeta,
    p_remove_attachment_ids: removeIds,
  })

  if (rpcErr) {
    // The transaction rolled back in full: original metadata and original files
    // are intact, and the old Main PI was never touched. Remove the orphans.
    await cleanupUploads()
    console.error('[order-request:attachments-edit] rpc failed', {
      code: rpcErr.code ?? null, message: rpcErr.message ?? null, requestId,
    })
    // One shared, unit-tested mapping (src/lib/orderRequestAttachments.ts), so
    // the sentence the reader gets is decided in one place and can be asserted
    // without a database. The HTTP status follows the CLASS of failure rather
    // than being 409 for everything: a missing migration is not a conflict, and
    // a permission refusal should not read as one either.
    const m    = (rpcErr.message ?? '')
    const code = rpcErr.code ?? ''
    const status =
      (code === 'PGRST202' || code === 'PGRST203' || m.toLowerCase().includes('schema cache')) ? 503 :
      (code === '42501' || m.includes('permission') || m.includes('Authentication required'))   ? 403 :
      m.includes('ORDER_REQUEST_NOT_FOUND')                                                    ? 404 :
      (m.includes('MAIN_PI_INVALID') || m.includes('ATTACHMENT_INVALID')
        || m.includes('MAIN_PI_NOT_EXCEL') || m.includes('NO_ATTACHMENT_CHANGES'))              ? 400 :
      409
    return NextResponse.json({ error: attachmentEditErrorMessage(rpcErr) }, { status })
  }

  const result = (rpcData ?? {}) as {
    main_pi_replaced?: boolean
    references_added?: number
    references_removed?: number
    superseded_paths?: string[]
  }

  // ── 8. The record is now correct. Clear the superseded objects ───────────────
  // A failure here cannot corrupt anything — it only leaves unreferenced bytes —
  // so it is surfaced as a warning rather than turning a committed save into a
  // reported failure.
  let orphanWarning = false
  const superseded = (result.superseded_paths ?? []).filter(p => typeof p === 'string' && p.length > 0)
  if (superseded.length > 0) {
    const { error: rmErr } = await service.storage
      .from(ORDER_REQ_ATTACHMENT_BUCKET).remove(superseded)
    if (rmErr) {
      orphanWarning = true
      console.error('[order-request:attachments-edit] superseded objects not removed', {
        requestId, count: superseded.length, message: rmErr.message ?? null,
      })
    }
  }

  return NextResponse.json({
    success:            true,
    main_pi_replaced:   !!result.main_pi_replaced,
    references_added:   result.references_added ?? 0,
    references_removed: result.references_removed ?? 0,
    orphan_warning:     orphanWarning,
  })
}
