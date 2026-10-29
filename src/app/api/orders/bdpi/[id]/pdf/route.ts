import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/orders/submissionPayload'
import { paymentPlanPdfResponse } from '@/lib/orders/paymentPlanPdfResponse'

// GET /api/orders/bdpi/{id}/pdf — the saved Payment plan of an OLD order (BDPI)
// as a PDF. Read as the caller through bdpi_payment_plan_read; nothing stored.

export const runtime = 'nodejs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'A valid BDPI is required.' }, { status: 400 })
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'UNAUTHORIZED', message: 'Please sign in again.' }, { status: 401 })

  return paymentPlanPdfResponse(await authClient.rpc('bdpi_payment_plan_read', { p_bdpi_id: id }))
}
