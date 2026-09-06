import { createHash, timingSafeEqual } from 'node:crypto'

export const MINOP_MAX_WEBHOOK_BYTES = 256 * 1024

export type MinopAuthMethod = 'bearer' | 'x-minop-webhook-secret'

export type MinopWebhookCapture = {
  raw_body: string
  payload: unknown | null
  body_sha256: string
  auth_method: MinopAuthMethod
  processing_status: 'received' | 'quarantined_invalid_json'
  error_text: string | null
}

export type MinopAuthResult =
  | { ok: true; method: MinopAuthMethod }
  | { ok: false; reason: 'missing_secret' | 'unauthorized' }

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  // timingSafeEqual requires equal-length buffers. Hashing both candidates first
  // keeps the comparison constant-length without leaking the configured secret's
  // length through an early equality branch.
  const leftHash = createHash('sha256').update(leftBuffer).digest()
  const rightHash = createHash('sha256').update(rightBuffer).digest()
  return timingSafeEqual(leftHash, rightHash)
}

export function authenticateMinopWebhook(
  headers: Headers,
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

  return { ok: false, reason: 'unauthorized' }
}

export function captureMinopWebhookBody(
  rawBody: string,
  authMethod: MinopAuthMethod,
): MinopWebhookCapture {
  const byteLength = Buffer.byteLength(rawBody, 'utf8')
  if (byteLength > MINOP_MAX_WEBHOOK_BYTES) {
    throw new RangeError(`Minop webhook body exceeds ${MINOP_MAX_WEBHOOK_BYTES} bytes`)
  }

  const bodySha256 = createHash('sha256').update(rawBody, 'utf8').digest('hex')

  try {
    const payload: unknown = JSON.parse(rawBody)
    if (payload === null || (typeof payload !== 'object' && !Array.isArray(payload))) {
      return {
        raw_body: rawBody,
        payload: null,
        body_sha256: bodySha256,
        auth_method: authMethod,
        processing_status: 'quarantined_invalid_json',
        error_text: 'Webhook JSON must be an object or array',
      }
    }

    return {
      raw_body: rawBody,
      payload,
      body_sha256: bodySha256,
      auth_method: authMethod,
      processing_status: 'received',
      error_text: null,
    }
  } catch {
    return {
      raw_body: rawBody,
      payload: null,
      body_sha256: bodySha256,
      auth_method: authMethod,
      processing_status: 'quarantined_invalid_json',
      error_text: 'Webhook body is not valid JSON',
    }
  }
}
