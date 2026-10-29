import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/orders/submissionPayload'
import { paymentPlanPdfResponse } from '@/lib/orders/paymentPlanPdfResponse'

// ── THE PAYMENT PLAN AS A PDF ────────────────────────────────────────────────
//
// GET /api/orders/{orderId}/payment-plan/pdf
//
// Draws the SAVED plan (the page asks the person to save before it offers the
// download). Everything is read as the caller through order_payment_plan_read,
// which asks the database for the Orders entry gate, view_payment_plan and the
// right to open the Order; no service role is involved. Nothing is stored.
// The drawing itself is shared with the BDPI route (paymentPlanPdfResponse).

export const runtime = 'nodejs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: orderId } = await params
  if (!isUuid(orderId)) {
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'A valid Order is required.' }, { status: 400 })
  }
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'UNAUTHORIZED', message: 'Please sign in again.' }, { status: 401 })

  return paymentPlanPdfResponse(await authClient.rpc('order_payment_plan_read', { p_order_id: orderId }))
}
