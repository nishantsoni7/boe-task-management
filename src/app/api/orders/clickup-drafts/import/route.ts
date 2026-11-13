import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { CLICKUP_DRAFT_BUCKET, draftFilePath, isClickupId, isFileId, parseSaveOrder } from '@/lib/orders/clickupDrafts'
import { fail, isMissing, NOT_SET_UP, requireDraftsAdmin } from '../guard'

// POST /api/orders/clickup-drafts/import — Administrator only (guard.ts).
// The browser reads the ClickUp export folder and sends it one order at a time,
// in TWO calls, because the files go straight to private storage (a serverless
// body is 4.5 MB and a file here can be 48 MB):
//
//   { step: 'sign', clickup_id, files: [{ id, size }] }
//        → { uploads: [{ id, path, token }], already }   only files not stored yet (same name and size)
//   { step: 'save', order }
//        → { id }   after every file of the order is found in storage with the size the order lists
//
// The row is written LAST, so an order never points at a missing file, and
// running the same folder again fills only what is missing and replaces the
// row of the same ClickUp task id. Paths are built here from ids; nothing the
// browser sends names a place in storage.

export const runtime = 'nodejs'
export const maxDuration = 60

/** file name → size, for what is stored under this order. null when the bucket does not exist (migration not applied). */
async function storedSizes(storage: ReturnType<SupabaseClient['storage']['from']>, clickupId: string): Promise<Map<string, number> | null> {
  const listed = await storage.list(clickupId, { limit: 1000 })
  if (listed.error) return null
  return new Map((listed.data ?? []).map(o => [o.name, Number((o.metadata as { size?: number } | null)?.size ?? -1)]))
}

export async function POST(req: NextRequest) {
  const gate = await requireDraftsAdmin()
  if (!gate.ok) return gate.response
  let body: { step?: unknown; clickup_id?: unknown; files?: unknown; order?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const storage = gate.service.storage.from(CLICKUP_DRAFT_BUCKET)

  if (body.step === 'sign') {
    if (!isClickupId(body.clickup_id)) return fail(400, 'BAD_REQUEST', 'The ClickUp task id is not valid.')
    const files = Array.isArray(body.files) ? body.files.slice(0, 200) : []
    const have = await storedSizes(storage, body.clickup_id)
    if (!have) return NOT_SET_UP()

    const uploads: { id: string; path: string; token: string }[] = []
    for (const f of files as { id?: unknown; name?: unknown; size?: unknown }[]) {
      if (!isFileId(f?.id)) return fail(400, 'BAD_REQUEST', 'A file of this order is not valid.')
      const path = draftFilePath(body.clickup_id, f.id)
      if (have.get(f.id) === Number(f.size)) continue
      const signed = await storage.createSignedUploadUrl(path, { upsert: true })
      if (signed.error || !signed.data) return fail(500, 'UPLOAD_NOT_PREPARED', 'A file could not be prepared for upload. Please try again.')
      uploads.push({ id: f.id, path: signed.data.path, token: signed.data.token })
    }
    return NextResponse.json({ uploads, already: files.length - uploads.length })
  }

  if (body.step === 'save') {
    const parsed = parseSaveOrder(body.order)
    if (!parsed.ok) return fail(400, 'BAD_ORDER', parsed.message)
    const { row } = parsed
    const have = await storedSizes(storage, row.clickup_id)
    if (!have) return NOT_SET_UP()
    const missing = row.files.filter(f => have.get(f.id) !== f.size)
    if (missing.length > 0) {
      return fail(409, 'FILES_NOT_STORED', `${missing.length} file(s) of this order are not stored yet (${missing.map(f => f.name).slice(0, 3).join(', ')}). Try again.`)
    }
    const { data, error } = await gate.service.from('clickup_draft_orders')
      .upsert({ ...row, imported_by: gate.userId, imported_at: new Date().toISOString() }, { onConflict: 'clickup_id' })
      .select('id').single()
    if (error || !data) {
      if (isMissing(error)) return NOT_SET_UP()
      console.error('[clickup-drafts] save failed', { code: error?.code })
      return fail(500, 'DB_ERROR', 'The order could not be saved. Please try again.')
    }
    return NextResponse.json({ id: data.id })
  }

  return fail(400, 'BAD_REQUEST', 'Unknown step.')
}
