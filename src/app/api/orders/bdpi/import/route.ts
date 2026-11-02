import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { PI_MAX_WORKBOOK_BYTES } from '@/lib/pi/workbookReader'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import {
  bdpiFromWorkbook,
  bdpiPicturePath,
  bdpiUploadFolder,
  bdpiWorkbookPath,
  describeBdpiError,
  isBdpiUploadPath,
} from '@/lib/orders/bdpiImport'

// ── UPLOAD AN OLD ORDER'S PI AS A BDPI (20270503000000) ──────────────────────
//
// POST /api/orders/bdpi/import   JSON, in TWO STEPS, because a PI is up to
// 10 MiB and a serverless request body is only 4.5 MB (a 6 MiB PI came back as
// a bare 413 and the page could only say "try again", 2026-11-02):
//
//   { }                                        → { path, token }
//   { path, file_name, old_order_no?, client_name? } → { id, bdpiNo, notes }
//
// 1. The browser asks for somewhere to put the file, and is answered only if
//    the database would let this person create a BDPI. It sends the workbook
//    straight to private storage with the signed key.
// 2. The workbook is read HERE, with the same parser the PI upload uses; the
//    browser's parse is never an input. The temporary file is always removed.
// 3. create_bdpi() is called AS THE PERSON: the database checks the Orders
//    entry gate and edit_payment_plan, and every figure it is given.
// 4. Only after that does the service role store the workbook and the pictures
//    under order-files/bdpi/<id>/, and bdpi_attach_files() (as the person)
//    records their paths. A failed file step leaves the BDPI usable without
//    pictures; the answer says so.

export const runtime = 'nodejs'
export const maxDuration = 60

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: { path?: unknown; file_name?: unknown; old_order_no?: unknown; client_name?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, 'BAD_REQUEST', 'Choose the PI file to upload.') }

  // The same two questions create_bdpi asks, asked first so a person who cannot
  // create a BDPI is not handed an upload key.
  const [entry, may] = await Promise.all([
    authClient.rpc('module_entry_open', { p_module_key: 'orders' }),
    authClient.rpc('actor_has_module_permission', { p_module_key: 'orders', p_action_key: 'edit_payment_plan' }),
  ])
  if (entry.error || may.error || entry.data !== true || may.data !== true) {
    return fail(403, 'BDPI_REFUSED', describeBdpiError('PAYMENT_PLAN_FORBIDDEN'))
  }

  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Uploading a PI is not configured on this deployment.')
  const storage = admin.client.storage.from(ORDER_FILES_BUCKET)

  // ── Step one: somewhere to put the file ──
  if (body.path === undefined) {
    const signed = await storage.createSignedUploadUrl(`${bdpiUploadFolder(user.id)}${randomUUID()}.xlsx`)
    if (signed.error || !signed.data) return fail(500, 'UPLOAD_NOT_PREPARED', 'The PI could not be received. Please try again.')
    return NextResponse.json({ path: signed.data.path, token: signed.data.token })
  }

  // ── Step two: read it, and always remove it ──
  const uploadedPath = typeof body.path === 'string' ? body.path : ''
  if (!isBdpiUploadPath(user.id, uploadedPath)) return fail(400, 'BAD_PATH', 'The uploaded file could not be located.')
  const fileName = (typeof body.file_name === 'string' ? body.file_name : '').slice(0, 300) || 'PI.xlsx'
  try {
    const download = await storage.download(uploadedPath)
    if (download.error || !download.data) return fail(404, 'WORKBOOK_NOT_STORED', 'The uploaded PI could not be found. Please choose it again.')
    const bytes = new Uint8Array(await download.data.arrayBuffer())
    if (bytes.byteLength === 0) return fail(400, 'WORKBOOK_EMPTY', 'The file is empty.')
    if (bytes.byteLength > PI_MAX_WORKBOOK_BYTES) return fail(413, 'WORKBOOK_TOO_LARGE', 'The file is larger than 10 MB.')

    let parsed
    try {
      parsed = await parseBoePiWorkbook(bytes)
    } catch {
      return fail(400, 'WORKBOOK_UNREADABLE', 'This file could not be read as a BOE PI.')
    }
    const built = bdpiFromWorkbook(parsed, {
      oldOrderNo: String(body.old_order_no ?? ''),
      clientName: String(body.client_name ?? ''),
      workbookName: fileName,
    })
    if (!built.ok) return fail(400, 'PI_NOT_ACCEPTED', built.reason)

    const created = await authClient.rpc('create_bdpi', { p_payload: built.payload })
    if (created.error || !created.data) {
      const forbidden = created.error?.code === '42501'
      return fail(forbidden ? 403 : 400, 'BDPI_REFUSED', describeBdpiError(created.error?.message ?? ''))
    }
    const { id, bdpi_no: bdpiNo } = created.data as { id: string; bdpi_no: string }

    const notes = [...built.notes]
    let workbookPath: string | null = bdpiWorkbookPath(id)
    const wb = await storage.upload(workbookPath, bytes, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: true,
    })
    if (wb.error) { workbookPath = null; notes.push('The workbook itself could not be stored.') }

    const images: { item_sequence: string; path: string }[] = []
    let failedPictures = 0
    for (const pic of built.pictures) {
      const path = bdpiPicturePath(id, pic.itemSequence, pic.image)
      const up = await storage.upload(path, pic.image.bytes, { contentType: pic.image.mimeType ?? undefined, upsert: true })
      if (up.error) failedPictures += 1
      else images.push({ item_sequence: pic.itemSequence, path })
    }
    if (failedPictures > 0) notes.push(`${failedPictures} picture(s) could not be stored.`)

    const attached = await authClient.rpc('bdpi_attach_files', {
      p_bdpi_id: id, p_workbook_path: workbookPath, p_workbook_name: fileName, p_images: images,
    })
    if (attached.error) notes.push('The pictures were stored but could not be linked to the lines.')

    return NextResponse.json({ id, bdpiNo, notes })
  } finally {
    await storage.remove([uploadedPath]).catch(() => undefined)
  }
}
