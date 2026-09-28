// ── EDIT PI (20270115000000) ──────────────────────────────────────────────────
//
// One door for the whole-PI editor. The browser sends WHAT was changed; this
// route re-reads the PI in force, re-applies the change, prices it
// (src/lib/orders/piEdit.ts) and hands the result to the database, which
// re-checks who may do it.
//
//   mode 'propose'  the PI is approved and in force on an Order. Nothing
//                   current changes: a PENDING version is recorded
//                   (propose_order_pi_edit_revision); an Admin's approval puts
//                   it in force and amends the Order (20270116000000).
//   mode 'apply'    the PI has not become an Order (draft, returned, or — for
//                   an admin, with a reason — under review). The edit is
//                   written through the same parse writer a workbook upload
//                   uses, under the processing lease, and its terms with it.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid, sha256Hex } from '@/lib/orders/submissionPayload'
import {
  buildEditProposal,
  diffPi,
  editChangesSomething,
  isDatesOnlyEdit,
  normalizePi,
  normalizeProposal,
  priceEdit,
  retiredSequenceProblems,
  validateEdit,
  type PiEditState,
} from '@/lib/orders/piEdit'
import { describePiEditFailure, loadPiContent } from '@/lib/orders/piEditServer'
import { isCanonicalPiImageKey, proposalImagesAreCanonical } from '@/lib/orders/piImageKey'

export const runtime = 'nodejs'

const PHOTO_NOT_THIS_PI = 'A product photo does not belong to this PI.'

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, message, ...extra }, { status })

type Body = { mode?: unknown; submissionId?: unknown; edit?: unknown; reason?: unknown }

function looksLikeEdit(v: unknown): v is PiEditState {
  const e = v as PiEditState
  return !!e && typeof e === 'object' && !!e.header && !!e.terms && !!e.commercial && Array.isArray(e.items)
    && e.items.length <= 200
}

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: Body
  try { body = (await req.json()) as Body } catch { return fail(400, 'BAD_REQUEST', 'The edit could not be read.') }
  const mode = body.mode === 'propose' || body.mode === 'apply' ? body.mode : null
  const submissionId = typeof body.submissionId === 'string' ? body.submissionId : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!mode || !isUuid(submissionId) || !looksLikeEdit(body.edit)) {
    return fail(400, 'BAD_REQUEST', 'The edit could not be read.')
  }
  const edit = body.edit

  const problems = validateEdit(edit)
  if (problems.length > 0) return fail(400, 'EDIT_INVALID', problems[0].message, { problems })

  const admin = adminClient()
  if (!admin.ok) {
    return fail(500, 'SERVER_NOT_CONFIGURED', 'Editing a PI is not configured on this deployment. Please report it.')
  }
  const service = admin.client

  const loaded = await loadPiContent(service, submissionId)
  if (!loaded.ok) return fail(loaded.status, loaded.code, loaded.message)
  const { content, row } = loaded

  // Photos may only name this PI's own canonical image keys — the whole key,
  // not a prefix (src/lib/orders/piImageKey.ts), for the picture's own bytes.
  for (const item of edit.items) {
    const photo = item.photo
    if (photo?.kind === 'new' && !isCanonicalPiImageKey(photo.storage_path, {
      submissionId, role: 'representative', position: 0,
      sha256: typeof photo.sha256 === 'string' ? photo.sha256 : '',
    })) {
      return fail(400, 'EDIT_INVALID', PHOTO_NOT_THIS_PI)
    }
  }

  const priced = priceEdit(content, edit)
  const orderId = typeof row.order_id === 'string' ? row.order_id : null

  if (mode === 'propose') {
    if (!orderId || row.status !== 'approved') {
      return fail(409, 'NOT_APPROVED', 'This PI is not in force on an Order; edit it directly instead.')
    }
    // Asked as the person, of the database: the same rule the drafts table uses.
    const may = await authClient.rpc('can_propose_order_pi_edit', { p_order_id: orderId })
    if (may.error || may.data !== true) {
      return fail(403, 'FORBIDDEN', 'Only the person who owns this PI, or an administrator, may revise it.')
    }
    const { data: current } = await service.from('order_pi_versions')
      .select('id').eq('order_id', orderId).eq('status', 'approved').maybeSingle()
    // Every item number this Order has ever used (20270116000000): an added
    // line never takes a removed product's number.
    const everUsed = await service.rpc('order_item_sequences_ever_used', { p_order_id: orderId })
    if (everUsed.error) return fail(500, 'LOOKUP_FAILED', 'This PI could not be read. Please try again.')
    const retiredSequences = (everUsed.data ?? []) as string[]
    const retired = retiredSequenceProblems(edit, content, retiredSequences)
    if (retired.length > 0) return fail(400, 'SEQUENCE_RETIRED', retired[0].message)
    const proposal = buildEditProposal({
      current: content, state: edit, priced, retiredSequences,
      baseVersionId: (current as { id?: string } | null)?.id ?? null,
      newId: () => crypto.randomUUID(),
      fingerprint: json => sha256Hex(new TextEncoder().encode(json)),
    })
    const diff = diffPi(normalizePi(content), normalizeProposal(proposal))
    if (!editChangesSomething(diff)) return fail(400, 'NO_CHANGES', 'Nothing has been changed yet.')

    // ONLY THE TWO DATES CHANGED (20270122000000). No client document prints
    // them, so this is not a new PI version: amend them in place, AS THE
    // PERSON, through the schedule editor — which re-derives the authority
    // (an active admin, with a reason), moves the Order's dates, records both
    // histories, and supersedes nothing. A new version would have reset
    // production alignment and asked Operations to accept the PI again.
    if (isDatesOnlyEdit(diff)) {
      const header = (proposal.payload as { header?: Record<string, unknown> }).header ?? {}
      const fields: Record<string, string | null> = {}
      for (const f of diff.fields) {
        const v = header[f.key]
        fields[f.key] = typeof v === 'string' && v.trim() !== '' ? v : null
      }
      const { error } = await authClient.rpc('update_order_submission_schedule_terms', {
        p_submission_id: submissionId, p_fields: fields, p_expected_version: null, p_reason: reason || null,
      })
      if (error) {
        const m = error.message ?? ''
        if (/ORDER_SUBMISSION_NOT_EDITABLE/.test(m)) {
          return fail(403, 'DATES_ADMIN_ONLY',
            'Only an administrator can change the dates of a confirmed Order. No new PI version is needed — ask an administrator to change them.')
        }
        if (/ORDER_SUBMISSION_REASON_REQUIRED/.test(m)) return fail(400, 'REASON_REQUIRED', 'Say why the dates are changing.')
        if (/ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION/.test(m)) {
          return fail(400, 'DUE_BEFORE_CONFIRMATION', 'The due date cannot be before the order confirmation date.')
        }
        const f = describePiEditFailure(error)
        return fail(f.status, f.code, f.message)
      }
      return NextResponse.json({ ok: true, mode, dates_amended: true, change_summary: proposal.change_summary })
    }

    // Every picture the version will name: this PI's key, for that very line.
    if (!proposalImagesAreCanonical(proposal.payload, submissionId)) {
      return fail(400, 'EDIT_INVALID', PHOTO_NOT_THIS_PI)
    }

    const { data, error } = await service.rpc('propose_order_pi_edit_revision', {
      p_order_id: orderId, p_actor_id: user.id, p_proposal: proposal, p_reason: reason,
    })
    if (error) {
      const f = describePiEditFailure(error)
      return fail(f.status, f.code, f.message)
    }
    return NextResponse.json({ ok: true, mode, ...(data as object), change_summary: proposal.change_summary })
  }

  // ── mode 'apply': a PI that is not yet an Order ──
  if (orderId || row.status === 'approved' || row.status === 'rejected') {
    return fail(409, 'REQUIRES_REVISION', 'This PI is approved and in force. Propose a new version instead.')
  }
  const proposal = buildEditProposal({
    current: content, state: edit, priced, baseVersionId: null,
    newId: () => crypto.randomUUID(),
    fingerprint: json => sha256Hex(new TextEncoder().encode(json)),
  })
  const diff = diffPi(normalizePi(content), normalizeProposal(proposal))
  if (!editChangesSomething(diff)) return fail(400, 'NO_CHANGES', 'Nothing has been changed yet.')

  const token = crypto.randomUUID()
  const lease = await service.rpc('begin_order_submission_processing', {
    p_submission_id: submissionId, p_actor_id: user.id, p_token: token,
  })
  if (lease.error) {
    const f = describePiEditFailure(lease.error)
    return fail(f.status, f.code, f.message)
  }
  try {
    // The parse writer re-derives who the actor is and whether they may edit
    // this PI at this stage (the owner in draft or returned; an active admin
    // with a reason once it is under review) — the rule every workbook
    // replacement already obeys.
    const { error } = await service.rpc('replace_order_submission_parse', {
      p_submission_id: submissionId,
      p_actor_id: user.id,
      p_payload: { ...proposal.payload, processing_token: token, change_reason: reason || null },
    })
    if (error) {
      const f = describePiEditFailure(error)
      return fail(f.status, f.code, f.message)
    }
    // The terms the parse writer does not own: same lease, same editor check,
    // through the database (the table itself is never written directly).
    const { error: termsErr } = await service.rpc('apply_order_submission_pi_edit_terms', {
      p_submission_id: submissionId,
      p_actor_id: user.id,
      p_terms: proposal.terms,
      p_processing_token: token,
      p_reason: reason || null,
    })
    if (termsErr) {
      return fail(500, 'TERMS_NOT_SAVED',
        'The products and details were saved, but the terms could not be. Open Edit PI again and save the terms.')
    }
  } finally {
    await service.rpc('finish_order_submission_processing', { p_submission_id: submissionId, p_token: token })
  }
  return NextResponse.json({ ok: true, mode, change_summary: proposal.change_summary })
}
