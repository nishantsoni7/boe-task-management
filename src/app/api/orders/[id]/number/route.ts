import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'
import {
  ORDER_NUMBER_CHANGE_HTTP,
  classifyOrderNumberChangeError,
  describeOrderNumberChangeFailure,
  normalizeNewOrderNumber,
  type OrderNumberChangeCode,
} from '@/lib/orders/orderNumberChange'
import { readCancelledOrderLock } from '@/lib/orders/cancelledOrderLock'
import { SUBMISSION_ID_RE } from '@/lib/orders/submissionFilesServer'

// GIVING A CONFIRMED ORDER A DIFFERENT NUMBER — ADMINISTRATORS ONLY.
//
// THE DATABASE DECIDES. change_confirmed_order_number() (20270502000000) runs
// as the signed-in user, so auth.uid() is the administrator; it checks the
// role, the number, that no Order has it and no PI Draft reserved it, and that
// it is below the cycle's next number. This route refuses View As, malformed
// input and a cancelled Order before asking: a cancelled Order keeps its number.

export const runtime = 'nodejs'

type ChangeResult = {
  previous_number?: unknown
  display_number?: unknown
  next_number?: unknown
  old_number_is_next?: unknown
}

const fail = (code: OrderNumberChangeCode) =>
  NextResponse.json(
    { ok: false, code, message: describeOrderNumberChangeFailure(code).message },
    { status: ORDER_NUMBER_CHANGE_HTTP[code] },
  )

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

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

  const body = await req.json().catch(() => null) as { number?: unknown } | null
  const typed = typeof body?.number === 'string' ? body.number : ''
  if (normalizeNewOrderNumber(typed) === null) return fail('INVALID')

  const lock = await readCancelledOrderLock(authClient, orderId)
  if (lock === 'cancelled') return fail('CANCELLED')
  if (lock === 'unknown') return fail('FAILED')

  const { data, error } = await authClient.rpc('change_confirmed_order_number', {
    p_order_id: orderId,
    p_new_number: typed.trim(),
  })
  if (error) return fail(classifyOrderNumberChangeError(error.message))

  const result = (data ?? {}) as ChangeResult
  return NextResponse.json({
    ok: true,
    orderId,
    previousNumber: str(result.previous_number),
    displayNumber: str(result.display_number),
    nextNumber: str(result.next_number),
    oldNumberIsNext: result.old_number_is_next === true,
  })
}
