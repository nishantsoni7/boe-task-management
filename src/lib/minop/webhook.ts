import { createHash, timingSafeEqual } from 'node:crypto'

export const MINOP_MAX_WEBHOOK_BYTES = 256 * 1024

export type MinopAuthMethod = 'bearer' | 'x-minop-webhook-secret' | 'payload-auth-token'

export type MinopWebhookCapture = {
  raw_body: string
  payload: unknown | null
  body_sha256: string
  processing_status: 'received' | 'quarantined_invalid_json'
  error_text: string | null
}

export type MinopAuthResult =
  | { ok: true; method: MinopAuthMethod }
  | { ok: false; reason: 'missing_secret' | 'unauthorized' }

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Minop's published real-time callback puts AuthToken inside `RealTime`.
 * Other documented operations put it at the top level, so Stage 1 accepts both
 * without interpreting any attendance fields.
 */
export function minopPayloadAuthToken(payload: unknown): string | null {
  const root = record(payload)
  if (!root) return null

  const direct = root.AuthToken
  if (typeof direct === 'string' && direct.trim()) return direct.trim()

  const realTime = record(root.RealTime)
  const nested = realTime?.AuthToken
  return typeof nested === 'string' && nested.trim() ? nested.trim() : null
}

export function authenticateMinopWebhook(
  headers: Headers,
  payload: unknown,
  configuredSecret: string | undefined,
): MinopAuthResult {
  const secret = configuredSecret?.trim()
  if (!secret) return { ok: false, reason: 'missing_secret' }

  const authorization = headers.get('authorization')?.trim() ?? ''
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i)
  if (bearerMatch) {
    return constantTimeEqual(bearerMatch[1].trim(), secret)
      ? { ok: true, method: 'bearer' }
      : { ok: false, reason: 'unauthorized' }
  }

  const headerSecret = headers.get('x-minop-webhook-secret')?.trim()
  if (headerSecret) {
    return constantTimeEqual(headerSecret, secret)
      ? { ok: true, method: 'x-minop-webhook-secret' }
      : { ok: false, reason: 'unauthorized' }
  }

  const payloadToken = minopPayloadAuthToken(payload)
  if (payloadToken) {
    return constantTimeEqual(payloadToken, secret)
      ? { ok: true, method: 'payload-auth-token' }
      : { ok: false, reason: 'unauthorized' }
  }

  return { ok: false, reason: 'unauthorized' }
}

export function captureMinopWebhookBody(rawBody: string): MinopWebhookCapture {
  const byteLength = Buffer.byteLength(rawBody, 'utf8')
  if (byteLength > MINOP_MAX_WEBHOOK_BYTES) {
    throw new RangeError(`Minop webhook body exceeds ${MINOP_MAX_WEBHOOK_BYTES} bytes`)
  }

  const bodySha256 = createHash('sha256').update(rawBody, 'utf8').digest('hex')

  try {
    const payload: unknown = JSON.parse(rawBody)
    if (payload === null || typeof payload !== 'object') {
      return {
        raw_body: rawBody,
        payload: null,
        body_sha256: bodySha256,
        processing_status: 'quarantined_invalid_json',
        error_text: 'Webhook JSON must be an object or array',
      }
    }

    return {
      raw_body: rawBody,
      payload,
      body_sha256: bodySha256,
      processing_status: 'received',
      error_text: null,
    }
  } catch {
    return {
      raw_body: rawBody,
      payload: null,
      body_sha256: bodySha256,
      processing_status: 'quarantined_invalid_json',
      error_text: 'Webhook body is not valid JSON',
    }
  }
}
