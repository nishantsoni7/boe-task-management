import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid, isWorkbookPathFor } from '@/lib/orders/submissionPayload'
import { processUnderLease } from '@/app/api/orders/import/process-draft/route'

// Approving a REVISED PI on a Confirmed Order (20261119000000).
//
// WHY A ROUTE. The revised workbook has to be parsed on the server — the same
// rule every PI save follows: a browser can ask for stored bytes to be read, it
// cannot state what they say. This route owns nothing of its own: it checks the
// actor, finds the pending version, takes the processing lease on the PI, and
// hands the version id to the ONE parser pipeline (process-draft's
// processUnderLease), which downloads, parses, uploads the pictures and calls
// approve_order_pi_revision() — one RPC, one transaction, in which the parse is
// applied, the previous version is superseded and this one is approved.
//
// ACTIVE ADMIN ONLY, re-derived here before a byte is downloaded and again by
// the RPC under a row lock. The body carries ONE id.

export const runtime = 'nodejs'

type ApproveRequest = { versionId?: unknown }

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

function isProcessingBusy(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown }
  if (String(e?.code ?? '') === '55P03') return true
  return String(e?.message ?? '').includes('ORDER_SUBMISSION_PROCESSING_BUSY')
}

export async function POST(req: NextRequest) {
  // ── 1. Authenticate from the session, never from the body ──
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: ApproveRequest
  try {
    body = (await req.json()) as ApproveRequest
  } catch {
    return fail(400, 'BAD_REQUEST', 'A version id is required.')
  }
  const versionId = typeof body.versionId === 'string' ? body.versionId : ''
  if (!isUuid(versionId)) return fail(400, 'BAD_REQUEST', 'A valid version id is required.')

  const admin = adminClient()
  if (!admin.ok) {
    return fail(500, 'SERVER_NOT_CONFIGURED',
      'Approving a revised PI is not configured on this deployment. This is a server setting, not something you can fix — please report it.')
  }
  const service = admin.client

  // ── 2. The actor is real, active, not soft-deleted, and an admin ──
  const { data: me, error: meErr } = await service
    .from('users').select('id, role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (meErr) return fail(500, 'AUTH_CHECK_FAILED', 'Could not verify your account.')
  if (!me || me.is_active !== true || me.is_deleted === true) {
    return fail(403, 'ACCOUNT_INACTIVE', 'This account cannot approve a revised PI.')
  }
  if (me.role !== 'admin') {
    return fail(403, 'FORBIDDEN', 'Only an administrator can approve a revised PI.')
  }

  // ── 3. The version is pending, and names a PI this pipeline can work on ──
  const { data: version, error: verErr } = await service
    .from('order_pi_versions')
    .select('id, order_id, submission_id, version_number, status, workbook_path, revision_reason')
    .eq('id', versionId)
    .maybeSingle()
  if (verErr) return fail(500, 'LOOKUP_FAILED', 'Could not load this revision.')
  if (!version) return fail(404, 'NOT_FOUND', 'This revision no longer exists.')
  if (version.status !== 'pending') {
    return fail(409, 'ORDER_PI_REVISION_NOT_PENDING', 'This revision has already been decided.')
  }

  const submissionId = String(version.submission_id)
  const workbookPath = typeof version.workbook_path === 'string' ? version.workbook_path : ''
  if (!isWorkbookPathFor(workbookPath, submissionId)) {
    return fail(409, 'BAD_WORKBOOK_PATH', 'The revised PI could not be located for this Order.')
  }

  const { data: submission, error: subErr } = await service
    .from('order_submissions')
    .select('id, status, order_id, source_workbook_path')
    .eq('id', submissionId)
    .maybeSingle()
  if (subErr) return fail(500, 'LOOKUP_FAILED', 'Could not load this PI.')
  if (!submission || submission.status !== 'approved' || submission.order_id !== version.order_id) {
    return fail(409, 'ORDER_PI_REVISION_INVALID', 'The PI behind this Order is not in an approvable state.')
  }

  // The reason is mandatory on the version row (a CHECK enforces it), and it is
  // what the parser records as the amendment reason.
  const reason = typeof version.revision_reason === 'string' ? version.revision_reason.trim() : ''
  if (reason === '') return fail(409, 'ORDER_PI_REVISION_REASON_REQUIRED', 'This revision carries no reason.')

  // ── 4. TAKE THE SUBMISSION, exactly as a save does ──
  const processingToken = crypto.randomUUID()
  const lease = await service.rpc('begin_order_submission_processing', {
    p_submission_id: submissionId,
    p_actor_id: user.id,
    p_token: processingToken,
  })
  if (lease.error) {
    if (isProcessingBusy(lease.error)) {
      return fail(409, 'PROCESSING_BUSY', 'This PI is already being processed. Please try again shortly.')
    }
    return fail(500, 'LEASE_FAILED', 'This PI could not be prepared. Please try again.')
  }

  try {
    return await processUnderLease({
      service, submissionId, workbookPath, actorId: user.id, processingToken,
      afterSubmission: true,
      changeReason: reason.slice(0, 500),
      submissionStatus: String(submission.status),
      priorWorkbookPath: typeof submission.source_workbook_path === 'string'
        ? submission.source_workbook_path
        : null,
      revisionVersionId: versionId,
    })
  } finally {
    await service.rpc('finish_order_submission_processing', {
      p_submission_id: submissionId,
      p_token: processingToken,
    })
  }
}
