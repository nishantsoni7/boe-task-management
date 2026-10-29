import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { parseBoePiWorkbook } from '@/lib/pi/masterSheetParser'
import { PI_MAX_WORKBOOK_BYTES } from '@/lib/pi/workbookReader'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import {
  bdpiFromWorkbook,
  bdpiPicturePath,
  bdpiWorkbookPath,
  describeBdpiError,
} from '@/lib/orders/bdpiImport'

// ── UPLOAD AN OLD ORDER'S PI AS A BDPI (20270502000000) ──────────────────────
//
// POST /api/orders/bdpi/import   multipart: file (.xlsx), old_order_no?, client_name?
//
// 1. The workbook is read HERE, with the same parser the PI upload uses.
// 2. create_bdpi() is called AS THE PERSON: the database checks the Orders
//    entry gate and edit_payment_plan, and every figure it is given.
// 3. Only after that does the service role store the workbook and the pictures
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

  let form: FormData
  try { form = await req.formData() } catch { return fail(400, 'BAD_REQUEST', 'Choose the PI file to upload.') }
  const file = form.get('file')
  if (!(file instanceof File)) return fail(400, 'NO_FILE', 'Choose the PI file to upload.')
  if (file.size === 0) return fail(400, 'WORKBOOK_EMPTY', 'The file is empty.')
  if (file.size > PI_MAX_WORKBOOK_BYTES) return fail(413, 'WORKBOOK_TOO_LARGE', 'The file is larger than 10 MB.')
  if (!/\.xlsx$/i.test(file.name)) return fail(400, 'WORKBOOK_NOT_XLSX', 'Upload the PI as an .xlsx workbook.')

  const bytes = new Uint8Array(await file.arrayBuffer())
  let parsed
  try {
    parsed = await parseBoePiWorkbook(bytes)
  } catch {
    return fail(400, 'WORKBOOK_UNREADABLE', 'This file could not be read as a BOE PI.')
  }
  const built = bdpiFromWorkbook(parsed, {
    oldOrderNo: String(form.get('old_order_no') ?? ''),
    clientName: String(form.get('client_name') ?? ''),
    workbookName: file.name,
  })
  if (!built.ok) return fail(400, 'PI_NOT_ACCEPTED', built.reason)

  const created = await authClient.rpc('create_bdpi', { p_payload: built.payload })
  if (created.error || !created.data) {
    const forbidden = created.error?.code === '42501'
    return fail(forbidden ? 403 : 400, 'BDPI_REFUSED', describeBdpiError(created.error?.message ?? ''))
  }
  const { id, bdpi_no: bdpiNo } = created.data as { id: string; bdpi_no: string }

  const notes = [...built.notes]
  const admin = adminClient()
  if (!admin.ok) {
    notes.push('The pictures and the workbook could not be stored on this deployment.')
    return NextResponse.json({ id, bdpiNo, notes })
  }
  const storage = admin.client.storage.from(ORDER_FILES_BUCKET)

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
    p_bdpi_id: id, p_workbook_path: workbookPath, p_workbook_name: file.name, p_images: images,
  })
  if (attached.error) notes.push('The pictures were stored but could not be linked to the lines.')

  return NextResponse.json({ id, bdpiNo, notes })
}
