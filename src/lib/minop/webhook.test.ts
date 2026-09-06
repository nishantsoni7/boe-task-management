import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  MINOP_MAX_WEBHOOK_BYTES,
  authenticateMinopWebhook,
  captureMinopWebhookBody,
  minopPayloadAuthToken,
} from './webhook'

const publishedRealtimePayload = {
  RealTime: {
    AuthToken: 'boe-minop-secret',
    OperationID: 'INT_ID',
    PunchLog: {
      FaceMask: false,
      InputType: 'Face',
      LogTime: '2026-01-08T11:09:09Z',
      Temperature: 36.5,
      Type: 'CheckIn',
      UserId: 'EMP_001',
    },
    Time: '2026-01-08T11:09:10Z',
  },
}

test('Minop webhook authentication fails closed when no server secret exists', () => {
  const headers = new Headers({ authorization: 'Bearer anything' })
  assert.deepEqual(authenticateMinopWebhook(headers, null, undefined), {
    ok: false,
    reason: 'missing_secret',
  })
})

test('Minop webhook accepts the published RealTime.AuthToken location', () => {
  assert.equal(minopPayloadAuthToken(publishedRealtimePayload), 'boe-minop-secret')
  assert.deepEqual(
    authenticateMinopWebhook(new Headers(), publishedRealtimePayload, 'boe-minop-secret'),
    { ok: true, method: 'payload-auth-token' },
  )
})

test('Minop webhook also accepts documented top-level AuthToken', () => {
  const payload = { AuthToken: 'boe-minop-secret', OperationID: '123' }
  assert.equal(minopPayloadAuthToken(payload), 'boe-minop-secret')
  assert.deepEqual(
    authenticateMinopWebhook(new Headers(), payload, 'boe-minop-secret'),
    { ok: true, method: 'payload-auth-token' },
  )
})

test('Minop webhook accepts BOE simulator header authentication', () => {
  const bearer = new Headers({ authorization: 'Bearer boe-minop-secret' })
  assert.deepEqual(authenticateMinopWebhook(bearer, null, 'boe-minop-secret'), {
    ok: true,
    method: 'bearer',
  })

  const header = new Headers({ 'x-minop-webhook-secret': 'boe-minop-secret' })
  assert.deepEqual(authenticateMinopWebhook(header, null, 'boe-minop-secret'), {
    ok: true,
    method: 'x-minop-webhook-secret',
  })
})

test('Minop webhook rejects a wrong or missing request secret', () => {
  assert.deepEqual(
    authenticateMinopWebhook(new Headers(), publishedRealtimePayload, 'wrong'),
    { ok: false, reason: 'unauthorized' },
  )
  assert.deepEqual(
    authenticateMinopWebhook(new Headers(), {}, 'right'),
    { ok: false, reason: 'unauthorized' },
  )
})

test('capture preserves the exact published-style JSON body and parses a separate copy', () => {
  const raw = JSON.stringify(publishedRealtimePayload, null, 2) + '\n'
  const capture = captureMinopWebhookBody(raw)

  assert.equal(capture.raw_body, raw)
  assert.deepEqual(capture.payload, publishedRealtimePayload)
  assert.equal(capture.processing_status, 'received')
  assert.equal(capture.error_text, null)
  assert.match(capture.body_sha256, /^[0-9a-f]{64}$/)
})

test('body hash is stable for the exact delivery bytes but is not treated as uniqueness', () => {
  const first = captureMinopWebhookBody('{"a":1}')
  const retry = captureMinopWebhookBody('{"a":1}')
  const reformatted = captureMinopWebhookBody('{ "a": 1 }')

  assert.equal(first.body_sha256, retry.body_sha256)
  assert.notEqual(first.body_sha256, reformatted.body_sha256)
})

test('malformed JSON is quarantined without losing its original body', () => {
  const raw = '{"broken":'
  const capture = captureMinopWebhookBody(raw)

  assert.equal(capture.raw_body, raw)
  assert.equal(capture.payload, null)
  assert.equal(capture.processing_status, 'quarantined_invalid_json')
  assert.equal(capture.error_text, 'Webhook body is not valid JSON')
})

test('JSON primitives are quarantined because a webhook event must have structure', () => {
  const capture = captureMinopWebhookBody('"hello"')
  assert.equal(capture.processing_status, 'quarantined_invalid_json')
  assert.equal(capture.payload, null)
  assert.equal(capture.error_text, 'Webhook JSON must be an object or array')
})

test('oversized webhook bodies are refused before storage', () => {
  const oversized = 'x'.repeat(MINOP_MAX_WEBHOOK_BYTES + 1)
  assert.throws(
    () => captureMinopWebhookBody(oversized),
    error => error instanceof RangeError,
  )
})

test('Stage 1 route matches Minop acknowledgement but cannot write final attendance or payroll', () => {
  const source = readFileSync(
    'src/app/api/integrations/minop/webhook/route.ts',
    'utf8',
  )

  assert.match(source, /process\.env\.MINOP_WEBHOOK_SECRET/)
  assert.match(source, /searchParams\.get\('stgid'\)/)
  assert.match(source, /NextResponse\.json\(\{ status: '1' \}\)/)
  assert.match(source, /\.from\('minop_webhook_deliveries'\)/)
  assert.doesNotMatch(source, /\.from\('attendance_records'\)/)
  assert.doesNotMatch(source, /\.from\('payroll_/)
})

test('Minop migration keeps raw device data inaccessible to browser roles', () => {
  const source = readFileSync(
    'supabase/migrations/20261113000000_create_minop_webhook_deliveries.sql',
    'utf8',
  )

  assert.match(source, /service_tag_id\s+text/)
  assert.match(source, /payload-auth-token/)
  assert.match(source, /ENABLE ROW LEVEL SECURITY/)
  assert.match(source, /REVOKE ALL ON public\.minop_webhook_deliveries FROM anon, authenticated/)
  assert.match(source, /GRANT ALL ON public\.minop_webhook_deliveries TO service_role/)
  assert.doesNotMatch(source, /CREATE POLICY/)
  assert.doesNotMatch(source, /UNIQUE\s*\(body_sha256\)/i)
})
