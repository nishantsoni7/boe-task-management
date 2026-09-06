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
 * Stage 1 intentionally stops here: authenticate the Minop callback, preserve
 * the exact vendor request and acknowledge it in the format Minop documents.
 * It does not map employees, interpret punch direction, calculate attendance,
 * or write attendance_records/payroll.
 */
export async function POST(req: NextRequest) {
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
    capture = captureMinopWebhookBody(rawBody)
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    return NextResponse.json({ error: 'Could not capture webhook' }, { status: 400 })
  }

  // Published Minop real-time callbacks carry AuthToken inside RealTime.
  // Bearer/x-minop-webhook-secret remain accepted for BOE's simulator and for
  // vendor configurations that authenticate at the HTTP-header layer.
  const auth = authenticateMinopWebhook(
    req.headers,
    capture.payload,
    process.env.MINOP_WEBHOOK_SECRET,
  )
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      console.error('[minop/webhook] MINOP_WEBHOOK_SECRET is not configured')
      return NextResponse.json({ error: 'Webhook unavailable' }, { status: 503 })
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  const serviceTagId = new URL(req.url).searchParams.get('stgid')?.trim() || null

  const { data, error } = await svc
    .from('minop_webhook_deliveries')
    .insert({
      ...capture,
      auth_method: auth.method,
      service_tag_id: serviceTagId,
      content_type: req.headers.get('content-type'),
      user_agent: req.headers.get('user-agent'),
    })
    .select('id, processing_status')
    .single()

  if (error || !data) {
    console.error('[minop/webhook] delivery insert failed:', error?.message ?? 'unknown error')
    // Do not return Minop's success acknowledgement. Their documented retry
    // behaviour then gives BOE another chance to persist the event.
    return NextResponse.json({ error: 'Could not store webhook' }, { status: 500 })
  }

  if (data.processing_status !== 'received') {
    // Authenticated malformed data is preserved, but not acknowledged as
    // successfully accepted so the sender may retry instead of silently losing it.
    return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 })
  }

  // Minop's callback protocol requires this exact success shape. If status "1"
  // is not returned, Minop documents that it will retry the request.
  return NextResponse.json({ status: '1' })
}
