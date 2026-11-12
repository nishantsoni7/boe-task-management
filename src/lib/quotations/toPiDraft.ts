// Confirm → PI draft: the saved quotation goes through the SAME Upload PI path as every PI (src/app/orders/import),
// as the person pressing Confirm, so Orders' own checks decide what is saved:
//   create_order_submission → the workbook into order-files → POST /api/orders/import/process-draft → quotation_link_pi.
// A failure before the server has saved the PI discards the empty draft (as the upload page does); after it, the
// PI draft is real and is kept.

import type { SupabaseClient } from '@supabase/supabase-js'
import { describeSaveFailure, discardUnsavedDraft, WORKBOOK_UPLOAD_MIME, workbookObjectPath } from '@/lib/orders/saveDraftFlow'
import { classifyError, pictureUrl, type Quotation } from './api'
import { buildPiWorkbook, piLines } from './piWorkbook'

type Supabase = SupabaseClient
export type PiStage = 'pictures' | 'creating' | 'uploading' | 'verifying' | 'linking'
export const PI_STAGE_LABEL: Record<PiStage, string> = {
  pictures: 'Collecting the pictures…', creating: 'Starting the PI draft…', uploading: 'Storing the PI…',
  verifying: 'Orders is checking the PI…', linking: 'Linking it to this quotation…',
}

export type PiDraftResult = { submissionId: string; draftReference: string | null; linkError: string | null }

/** Every picture the PI needs, as bytes, from the public quotation bucket. Lines without one are skipped. */
export async function loadPictures(s: Supabase, q: Pick<Quotation, 'lines'>): Promise<Map<string, Uint8Array>> {
  const paths = [...new Set(piLines(q.lines).map(l => l.image_path).filter((p): p is string => !!p))]
  const out = new Map<string, Uint8Array>()
  await Promise.all(paths.map(async p => {
    const res = await fetch(pictureUrl(s, p))
    if (!res.ok) throw new Error('A product picture could not be loaded. Check your connection and try again.')
    out.set(p, new Uint8Array(await res.arrayBuffer()))
  }))
  return out
}

export async function piWorkbookFor(s: Supabase, q: Quotation): Promise<Uint8Array> {
  const h = q.header
  return buildPiWorkbook({
    quoteNo: q.quote_no, clientName: h.client_name, projectName: h.project_name, contactPhone: h.contact_phone,
    supplyState: h.supply_state, createdByName: q.owner_name, transportNote: h.transport_note,
    money: h, areas: q.areas, lines: q.lines, pictures: await loadPictures(s, q),
  })
}

export async function makePiDraft(s: Supabase, q: Quotation, onStage: (stage: PiStage) => void): Promise<PiDraftResult> {
  onStage('pictures')
  const bytes = await piWorkbookFor(s, q)

  onStage('creating')
  const created = await s.rpc('create_order_submission', { p_client_name: null, p_idempotency_key: crypto.randomUUID() })
  if (created.error) {
    throw new Error(created.error.code === '42501'
      ? 'Making a PI needs Order Management → Create. Ask an administrator for it.'
      : describeSaveFailure('CREATE_FAILED').message)
  }
  const submissionId = (created.data as { id: string }).id
  const discard = (paths: (string | null)[]) => discardUnsavedDraft(submissionId, paths, {
    readSavedWorkbookPath: async id => {
      const { data, error } = await s.from('order_submissions').select('source_workbook_path').eq('id', id).maybeSingle()
      return error ? undefined : ((data as { source_workbook_path?: string | null } | null)?.source_workbook_path ?? null)
    },
    removeWorkbook: async path => !(await s.storage.from('order-files').remove([path])).error,
    discard: async id => {
      const { data, error } = await s.rpc('discard_unsaved_order_submission', { p_submission_id: id })
      if (error) return 'failed'
      const outcome = data as { discarded?: boolean; reason?: string } | null
      return outcome?.discarded ? 'discarded' : outcome?.reason === 'absent' ? 'absent' : 'kept'
    },
  })

  onStage('uploading')
  const path = workbookObjectPath(submissionId, crypto.randomUUID())
  const up = await s.storage.from('order-files').upload(path, new Blob([bytes as BlobPart], { type: WORKBOOK_UPLOAD_MIME }), { contentType: WORKBOOK_UPLOAD_MIME })
  if (up.error) { await discard([path]); throw new Error(describeSaveFailure('UPLOAD_FAILED').message) }

  onStage('verifying')
  let res: Response
  try {
    res = await fetch('/api/orders/import/process-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId, sourceWorkbookPath: path }),
    })
  } catch {
    // No answer: the server may still save it, so nothing is discarded.
    throw new Error('No answer from the server. Look in Orders → PI Drafts before trying again, so you do not make it twice.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: unknown }
    // A coded answer is a decision (nothing saved): discard. An uncoded one (a timeout) may still finish: keep.
    if (typeof body.error === 'string') await discard([])
    throw new Error(describeSaveFailure(typeof body.error === 'string' ? body.error : null).message)
  }

  onStage('linking')
  const linked = await s.rpc('quotation_link_pi', { p_id: q.id, p_submission_id: submissionId })
  if (linked.error) return { submissionId, draftReference: null, linkError: classifyError(linked.error).message }
  return { submissionId, draftReference: (linked.data as { draft_reference: string | null }).draft_reference, linkError: null }
}
