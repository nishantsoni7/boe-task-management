// Raw capture for the Minop Developer Dashboard's Transaction Data callback.
//
//   POST /api/integrations/minop/webhook/<MINOP_WEBHOOK_PATH_TOKEN>
//
// The dashboard takes a URL and nothing else: the live device (2026-08-11)
// sent only expect, content-length, host and content-type — no Authorization
// header, no custom header, no AuthToken in the body. So the secret is the last
// path segment, and that is the only thing this route authenticates.
//
// This is deliberately narrower than the header-authenticated webhook beside
// it. The machine calling it is a TEST device, not an official attendance
// source, so this route stores the exact request in minop_webhook_deliveries
// and stops. It never runs attendance processing — not even when
// MINOP_ATTENDANCE_PROCESSING_ENABLED is true — and it does not read trans[],
// map an employee, or touch attendance_records or payroll. The only write it can
// make is the one insert its caller hands it.
//
// Nothing here logs the request URL: it contains the token.

import { NextResponse } from 'next/server'
import {
  MINOP_MAX_WEBHOOK_BYTES,
  authenticateMinopPathToken,
  captureMinopWebhookBody,
  type MinopWebhookCapture,
} from './webhook'

export type MinopRawDeliveryRow = MinopWebhookCapture & {
  auth_method: 'url-path-token'
  service_tag_id: string | null
  content_type: string | null
  user_agent: string | null
}

export type MinopPathTokenDeps = {
  configuredToken: string | undefined
  /** Insert one row into public.minop_webhook_deliveries. */
  insertDelivery: (row: MinopRawDeliveryRow) => Promise<{ ok: boolean }>
}

/** After the token is proven, failures answer in Minop's own vocabulary. */
function refuse(status: number): NextResponse {
  return NextResponse.json({ status: 0 }, { status })
}

export async function handleMinopPathTokenWebhook(
  req: Request,
  providedToken: string | undefined,
  deps: MinopPathTokenDeps,
): Promise<Response> {
  // The token before anything else: a caller without it cannot make this route
  // read a body, reveal a size limit, or reach the database. A wrong token and
  // an unconfigured endpoint look identical — a 404 with no body.
  const auth = authenticateMinopPathToken(providedToken, deps.configuredToken)
  if (!auth.ok) {
    if (auth.reason === 'missing_token_config') {
      console.error('[minop/webhook/path-token] MINOP_WEBHOOK_PATH_TOKEN is missing or shorter than required')
    }
    return new Response(null, { status: 404 })
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MINOP_MAX_WEBHOOK_BYTES) {
    return refuse(413)
  }

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return refuse(400)
  }

  let capture: MinopWebhookCapture
  try {
    capture = captureMinopWebhookBody(rawBody)
  } catch (error) {
    return refuse(error instanceof RangeError ? 413 : 400)
  }

  const stored = await deps.insertDelivery({
    ...capture,
    auth_method: auth.method,
    service_tag_id: new URL(req.url).searchParams.get('stgid')?.trim() || null,
    content_type: req.headers.get('content-type'),
    user_agent: req.headers.get('user-agent'),
  })

  // Not stored means not acknowledged, so Minop may resend it.
  if (!stored.ok) return refuse(500)

  // Invalid JSON is preserved but not acknowledged as accepted, exactly as the
  // header-authenticated route treats it.
  if (capture.processing_status !== 'received') return refuse(400)

  return NextResponse.json({ status: 1 })
}
