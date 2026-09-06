import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  MINOP_MAX_WEBHOOK_BYTES,
  authenticateMinopWebhook,
  captureMinopWebhookBody,
} from '@/lib/minop/webhook'

export const runtime = 'nodejs'

/**
 * Raw Minop transport boundary.
 *
 * Stage 1 intentionally stops here: this endpoint authenticates and preserves
 * the vendor request, but it does not interpret employee ids, punch direction,
 * timestamps, attendance dates, or payroll state. In particular it makes no
 * write to attendance_records. A real Minop payload contract is required before
 * any of those fields can be mapped safely.
 */
export async function POST(req: NextRequest) {
  const auth = authenticateMinopWebhook(req.headers, process.env.MINOP_WEBHOOK_SECRET)
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      console.error('[minop/webhook] MINOP_WEBHOOK_SECRET is not configured')
      return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 })
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MINOP_MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return NextResponse.json({ error: 'Could not read request body' }, { status: 400 })
  }

  let capture
  try {
    capture = captureMinopWebhookBody(rawBody, auth.method)
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    return NextResponse.json({ error: 'Could not capture webhook' }, { status: 400 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[minop/webhook] Supabase service configuration is missing')
    return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 })
  }

  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await svc
    .from('minop_webhook_deliveries')
    .insert({
      ...capture,
      content_type: req.headers.get('content-type'),
      user_agent: req.headers.get('user-agent'),
    })
    .select('id, received_at, processing_status')
    .single()

  if (error || !data) {
    console.error('[minop/webhook] delivery insert failed:', error?.message ?? 'unknown error')
    return NextResponse.json({ error: 'Could not store webhook' }, { status: 500 })
  }

  // 202 means BOE accepted the transport delivery. It does NOT mean attendance
  // was changed; Stage 1 has no attendance processor by design.
  return NextResponse.json({
    accepted: true,
    delivery_id: data.id,
    received_at: data.received_at,
    status: data.processing_status,
  }, { status: 202 })
}
