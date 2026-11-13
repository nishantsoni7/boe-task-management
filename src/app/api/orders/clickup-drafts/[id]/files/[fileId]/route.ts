import { NextRequest, NextResponse } from 'next/server'

import { isUuid } from '@/lib/orders/submissionPayload'
import { CLICKUP_DRAFT_BUCKET, draftFilePath, isFileId, type DraftFile } from '@/lib/orders/clickupDrafts'
import { fail, isMissing, NOT_SET_UP, requireDraftsAdmin } from '../../../guard'

// GET /api/orders/clickup-drafts/{id}/files/{fileId} → 302 to a two-minute
// signed link that saves the file under its ORIGINAL name. A plain link on the
// page is enough: the browser follows the redirect with the person's session.
// Administrator only (guard.ts).

export const runtime = 'nodejs'

const LINK_SECONDS = 120

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params
  if (!isUuid(id) || !isFileId(fileId)) return fail(400, 'BAD_REQUEST', 'This file link is not valid.')
  const gate = await requireDraftsAdmin()
  if (!gate.ok) return gate.response

  const { data, error } = await gate.service.from('clickup_draft_orders').select('clickup_id, files').eq('id', id).maybeSingle()
  if (error) {
    if (isMissing(error)) return NOT_SET_UP()
    console.error('[clickup-drafts] file lookup failed', { code: error.code })
    return fail(500, 'DB_ERROR', 'The file could not be found. Please try again.')
  }
  const file = ((data?.files ?? []) as DraftFile[]).find(f => f.id === fileId)
  if (!data || !file) return fail(404, 'NOT_FOUND', 'This file does not exist.')

  const signed = await gate.service.storage.from(CLICKUP_DRAFT_BUCKET)
    .createSignedUrl(draftFilePath(data.clickup_id as string, file.id), LINK_SECONDS, { download: file.name })
  if (signed.error || !signed.data) return fail(404, 'FILE_NOT_STORED', 'This file was not stored. Import the backup folder again.')
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { 'Cache-Control': 'private, no-store' } })
}
