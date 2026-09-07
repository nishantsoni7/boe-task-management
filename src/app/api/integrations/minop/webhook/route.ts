import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  MINOP_MAX_WEBHOOK_BYTES,
  authenticateMinopWebhook,
  captureMinopWebhookBody,
} from '@/lib/minop/webhook'
import { runMinopAttendanceProcessing } from '@/lib/minop/runProcessing'

export const runtime = 'nodejs'

/**
 * Raw Minop transport boundary, plus (Stage 2, flag-gated) turning that raw
 * delivery into attendance.
 *
 * The transport half is unchanged from Stage 1: authenticate the callback,
 * preserve the exact vendor request, and acknowledge it in the format Minop
 * documents, whatever happens next. Attendance processing runs only when
 * `MINOP_ATTENDANCE_PROCESSING_ENABLED=true`, and its outcome — including a
 * processing failure — never changes the acknowledgement Minop receives: the
 * raw delivery is already safely stored by that point, and this route's job
 * is done. A processing failure is recorded on the delivery for an admin to
 * see and retry, not returned to the device as a reason to resend the punch.
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

  // Rollout control (Phase J): raw capture is always on once this route is
  // deployed and authenticated; turning attendance WRITES on is a separate,
  // explicit step taken only after a real device payload and the employee
  // mapping have been verified. Unset or anything but the literal string
  // "true" means off, which is the required default before that evidence
  // exists.
  if (process.env.MINOP_ATTENDANCE_PROCESSING_ENABLED === 'true') {
    try {
      const { deliveryUpdate } = await runMinopAttendanceProcessing(svc, {
        id: data.id,
        payload: capture.payload,
      })
      const { error: updateErr } = await svc
        .from('minop_webhook_deliveries')
        .update(deliveryUpdate)
        .eq('id', data.id)
      if (updateErr) {
        console.error('[minop/webhook] could not record processing outcome:', updateErr.message)
      }
    } catch (processingError) {
      // A processing failure never withholds Minop's acknowledgement — the
      // raw delivery is already durably stored, which is what the documented
      // retry behaviour exists to protect. Best-effort: record the failure if
      // the same client can still reach the table; if it can't, the delivery
      // simply stays 'pending' for an admin to retry by hand.
      const message = processingError instanceof Error ? processingError.message : String(processingError)
      console.error('[minop/webhook] attendance processing failed:', message)
      await svc
        .from('minop_webhook_deliveries')
        .update({ attendance_status: 'error', attendance_error: message, attendance_processed_at: new Date().toISOString() })
        .eq('id', data.id)
        .then(({ error: markErr }) => {
          if (markErr) console.error('[minop/webhook] could not mark processing error:', markErr.message)
        })
    }
  }

  // Minop's callback protocol requires this exact success shape. If status "1"
  // is not returned, Minop documents that it will retry the request.
  return NextResponse.json({ status: '1' })
}
