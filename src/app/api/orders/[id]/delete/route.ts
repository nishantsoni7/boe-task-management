import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'
import {
  ORDER_DELETION_HTTP,
  classifyOrderDeletionError,
  describeOrderDeletionFailure,
  type OrderDeletionCode,
} from '@/lib/orders/orderDeletion'
import { readCancelledOrderLock } from '@/lib/orders/cancelledOrderLock'
import {
  SUBMISSION_ID_RE,
  removeAllObjectsForOrder,
  removeAllObjectsForPiDocuments,
  removeAllObjectsForSubmission,
} from '@/lib/orders/submissionFilesServer'

// PERMANENTLY DELETING A CONFIRMED ORDER — ADMINISTRATORS ONLY.
//
// THE ORDER OF THINGS, AND WHY IT IS THE REVERSE OF A PI DELETE
// -------------------------------------------------------------
// A PI is reserved, then its files are swept, then its row is erased, because a
// PI's files are part of what the PI is and losing them first leaves a PI that
// looks healthy with no workbook. An Order has no reservation, and everything it
// owns is erased in ONE database transaction by delete_confirmed_order(). The
// files go AFTER it commits. If the sweep then fails, what is left is
// unreachable objects in a bucket, which a retry of the sweep removes; the other
// order would leave a live Order whose documents had disappeared.
//
// THE DATABASE DECIDES. The RPC runs as the signed-in user, so auth.uid() is the
// administrator; it checks the role, the typed confirmation, and that no payment
// allocation, intent or payment request names the Order or its PI. This route
// never reads or writes Finance and never receives a key, a path or a prefix
// from the browser: the prefixes are built here from uuids the database returned.
//
// A CANCELLED ORDER IS NOT DELETED (owner, 2026-10-31). Deleting it would free
// its number for another Order, and the RPC has no status check, so this route
// refuses it before asking.

export const runtime = 'nodejs'

type DeleteResult = {
  deleted?: boolean
  display_number?: string
  submission_ids?: unknown
  storage_paths?: unknown
}

const fail = (code: OrderDeletionCode) =>
  NextResponse.json(
    { ok: false, code, message: describeOrderDeletionFailure(code).message },
    { status: ORDER_DELETION_HTTP[code] },
  )

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail('UNAUTHORIZED')

  // An administrator looking at the system through somebody else's eyes performs
  // no action. See src/lib/viewAs.ts.
  if (isPreviewRequest(req.headers)) {
    return NextResponse.json({ error: PREVIEW_WRITE_REFUSED }, { status: 403 })
  }

  const { id: orderId } = await params
  if (!SUBMISSION_ID_RE.test(orderId)) return fail('BAD_REQUEST')

  const body = await req.json().catch(() => null) as { confirm?: unknown } | null
  const confirm = typeof body?.confirm === 'string' ? body.confirm : ''
  if (confirm.trim() === '') return fail('CONFIRMATION')

  const lock = await readCancelledOrderLock(authClient, orderId)
  if (lock === 'cancelled') return fail('CANCELLED')
  if (lock === 'unknown') return fail('FAILED')

  // Proven BEFORE the Order is touched: without the service role the sweep that
  // follows could not run, and a deletion that cannot be finished is not started.
  const admin = adminClient()
  if (!admin.ok) return fail('NOT_CONFIGURED')
  const service = admin.client

  const { data, error } = await authClient.rpc('delete_confirmed_order', {
    p_order_id: orderId,
    p_confirm: confirm,
  })
  if (error) return fail(classifyOrderDeletionError(error.message))

  const result = (data ?? {}) as DeleteResult
  const submissionIds = Array.isArray(result.submission_ids)
    ? result.submission_ids.filter((id): id is string => typeof id === 'string' && SUBMISSION_ID_RE.test(id))
    : []
  const recorded = Array.isArray(result.storage_paths)
    ? result.storage_paths.filter((path): path is string => typeof path === 'string')
    : []

  // THE ORDER IS ALREADY GONE. Nothing below may turn that into a failure.
  let leftBehind = 0
  try {
    const sweeps = [
      await removeAllObjectsForOrder(service, orderId, recorded),
      ...(await Promise.all(submissionIds.flatMap(id => [
        removeAllObjectsForSubmission(service, id, recorded),
        removeAllObjectsForPiDocuments(service, id, recorded),
      ]))),
    ]
    leftBehind = sweeps.reduce((sum, sweep) => sum + sweep.failed.length, 0)
  } catch {
    leftBehind = -1
  }

  return NextResponse.json({
    ok: true,
    orderId,
    displayNumber: result.display_number ?? null,
    // -1: the sweep itself could not run. Positive: that many objects survived.
    storageLeftBehind: leftBehind,
  })
}
