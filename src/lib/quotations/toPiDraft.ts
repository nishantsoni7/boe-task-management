// Confirm → PI draft: the saved quotation goes through the SAME Upload PI path as every PI (src/app/orders/import),
// as the person pressing Confirm, so Orders' own checks decide what is saved:
//   create_order_submission → the workbook into order-files → POST /api/orders/import/process-draft → quotation_link_pi.
// A failure before the server has saved the PI discards the empty draft (as the upload page does); after it, the
// PI draft is real and is kept.

import type { SupabaseClient } from '@supabase/supabase-js'
import { describeSaveFailure, discardUnsavedDraft, WORKBOOK_UPLOAD_MIME, workbookObjectPath } from '@/lib/orders/saveDraftFlow'
import { classifyError, type Quotation } from './api'
import { ORIGINALS_BUCKET } from './pictureStore'
import { toJpeg } from '@/lib/inventory/images'
import { buildPiWorkbook, extraPathsOf, fitExtras, piLines } from './piWorkbook'

type Supabase = SupabaseClient
export type PiStage = 'pictures' | 'creating' | 'uploading' | 'verifying' | 'linking'
export const PI_STAGE_LABEL: Record<PiStage, string> = {
  pictures: 'Collecting the pictures…', creating: 'Starting the PI draft…', uploading: 'Storing the PI…',
  verifying: 'Orders is checking the PI…', linking: 'Linking it to this quotation…',
}

export type PiDraftResult = { submissionId: string; draftReference: string | null; linkError: string | null; extrasLeftOut: number }

/** Extra pictures (swatch, drawing, reference) go on the PI at this size: enough to see a fabric or read a drawing. */
const EXTRA_EDGE_PX = 800

/**
 * Every picture the PI needs, as bytes, clean, from the private originals bucket. Main pictures always (a line without one is
 * skipped; the PI then refuses it as before). Each line's other pictures are made smaller and added while the PI stays
 * under its upload limit; a missing or unreadable extra is simply left out, never a reason to fail the PI.
 */
export async function loadPictures(s: Supabase, q: Pick<Quotation, 'lines'>): Promise<{ pictures: Map<string, Uint8Array>; extrasLeftOut: number }> {
  const lines = piLines(q.lines)
  const paths = [...new Set(lines.map(l => l.image_path).filter((p): p is string => !!p))]
  const out = new Map<string, Uint8Array>()
  await Promise.all(paths.map(async p => {
    // The PI is a factory document: it gets the CLEAN original, not the logo-marked client copy (18 Nov 2026).
    const { data: blob } = await s.storage.from(ORIGINALS_BUCKET).download(p)
    if (!blob) throw new Error('A product picture could not be loaded. Check your connection and try again.')
    out.set(p, new Uint8Array(await blob.arrayBuffer()))
  }))
  const extraPaths = [...new Set(lines.flatMap(l => extraPathsOf(l)))].filter(p => !out.has(p))
  const extras: { path: string; data: Uint8Array }[] = []
  const loaded = await Promise.all(extraPaths.map(async path => {
    try {
      const { data: blob } = await s.storage.from(ORIGINALS_BUCKET).download(path)
      return blob ? new Uint8Array(await (await toJpeg(blob, 0.82, EXTRA_EDGE_PX)).arrayBuffer()) : null
    } catch { return null }
  }))
  loaded.forEach((data, i) => { if (data) extras.push({ path: extraPaths[i], data }) })
  const mainBytes = [...out.values()].reduce((n, b) => n + b.byteLength, 0)
  const { keep, leftOut } = fitExtras(mainBytes, extras.map(e => ({ path: e.path, bytes: e.data.byteLength })))
  for (const e of extras) if (keep.has(e.path)) out.set(e.path, e.data)
  return { pictures: out, extrasLeftOut: leftOut + (extraPaths.length - extras.length) }
}

/** The PI workbook, and how many extra pictures had to be left out of it (to say so). */
export async function piWorkbookFor(s: Supabase, q: Quotation): Promise<{ bytes: Uint8Array; extrasLeftOut: number }> {
  const h = q.header
  const { pictures, extrasLeftOut } = await loadPictures(s, q)
  const bytes = await buildPiWorkbook({
    quoteNo: q.quote_no, clientName: h.client_name, projectName: h.project_name, contactPhone: h.contact_phone,
    supplyState: h.supply_state, createdByName: q.owner_name, transportNote: h.transport_note,
    money: h, dimensionUnit: h.dimension_unit, areas: q.areas, lines: q.lines, pictures,
  })
  return { bytes, extrasLeftOut }
}

/** What to tell the person when some of the client's extra pictures did not go on the PI. */
export const extrasLeftOutText = (n: number) =>
  `${n} of the client's extra picture${n === 1 ? ' was' : 's were'} left off the PI, to keep it under the 10 MB upload limit (or could not be loaded). They stay on the quotation.`

export async function makePiDraft(s: Supabase, q: Quotation, onStage: (stage: PiStage) => void): Promise<PiDraftResult> {
  onStage('pictures')
  const { bytes, extrasLeftOut } = await piWorkbookFor(s, q)

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
  if (linked.error) return { submissionId, draftReference: null, linkError: classifyError(linked.error).message, extrasLeftOut }
  return { submissionId, draftReference: (linked.data as { draft_reference: string | null }).draft_reference, linkError: null, extrasLeftOut }
}
