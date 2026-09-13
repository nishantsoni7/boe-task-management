/**
 * The URL-path-token Minop receiver, actually executed against a fake store.
 *
 * The handler's only way to reach the database is the `insertDelivery` it is
 * handed, so recording those calls proves exactly what one request writes:
 * one raw delivery row, byte-for-byte, and nothing else. Source checks at the
 * end pin that neither the handler nor its route can reach attendance
 * processing, attendance_records or payroll.
 *
 * Run:
 *   npx tsx --test src/lib/minop/pathTokenWebhook.test.ts
 */

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { handleMinopPathTokenWebhook, type MinopRawDeliveryRow } from './pathTokenWebhook'

// Obviously synthetic, 64 characters.
const TOKEN = '0123456789abcdef'.repeat(4)

const ROUTE = 'src/app/api/integrations/minop/webhook/[token]/route.ts'
const HANDLER = 'src/lib/minop/pathTokenWebhook.ts'
const MIGRATION = 'supabase/migrations/20261210000000_minop_webhook_url_path_token_auth.sql'

function fakeStore(ok = true) {
  const rows: MinopRawDeliveryRow[] = []
  return {
    rows,
    insertDelivery: async (row: MinopRawDeliveryRow) => {
      rows.push(row)
      return { ok }
    },
  }
}

function post(body: string) {
  return new Request('https://boe.example/api/integrations/minop/webhook/redacted', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

// No default parameters: an explicit `undefined` must reach the handler as
// undefined, not silently become the correct token.
async function deliverWith(body: string, token: string | undefined, configuredToken: string | undefined) {
  const store = fakeStore()
  const res = await handleMinopPathTokenWebhook(post(body), token, { configuredToken, insertDelivery: store.insertDelivery })
  return { res, rows: store.rows, text: await res.text() }
}

const deliver = (body: string) => deliverWith(body, TOKEN, TOKEN)

// The Developer Dashboard's own example: numeric txnId, dvcId and punchId.
const numericTrans = '{"trans":[{"txnId":21,"dvcId":1,"dvcIP":"192.168.1.1","punchId":1000,"txnDateTime":"2018-05-11 18:05:36","mode":"IN"}]}'

// The shape the real device sent on 2026-08-11: every value a string, mode "8".
const stringTrans = '{ "trans": [ {\n  "txnId": "3", "dvcId": "1", "dvcIP": "127.0.0.2",\n  "punchId": "2", "txnDateTime": "2026-08-11 12:41:35", "mode": "8"\n} ] }\n'

const multipleTrans = JSON.stringify({
  trans: [
    { txnId: 21, dvcId: 1, dvcIP: '192.168.1.1', punchId: 1000, txnDateTime: '2018-05-11 18:05:36', mode: 'IN' },
    { txnId: '22', dvcId: '1', dvcIP: '192.168.1.1', punchId: '1001', txnDateTime: '2018-05-11 18:06:02', mode: 'OUT' },
    { txnId: 23, dvcId: 1, dvcIP: '192.168.1.1', punchId: 1000, txnDateTime: '2018-05-11 19:00:00', mode: '8' },
  ],
}, null, 2)

afterEach(() => {
  delete process.env.MINOP_ATTENDANCE_PROCESSING_ENABLED
})

test('the correct path token is accepted and stores exactly one raw delivery', async () => {
  const { res, rows } = await deliver(numericTrans)
  assert.equal(res.status, 200)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].auth_method, 'url-path-token')
  assert.equal(rows[0].processing_status, 'received')
  assert.equal(rows[0].error_text, null)
  assert.equal(rows[0].content_type, 'application/json')
})

test('a wrong path token is a 404 with no body and stores nothing', async () => {
  for (const wrong of [TOKEN.slice(0, -1) + 'x', TOKEN.slice(0, -1), `${TOKEN}0`, TOKEN.toUpperCase(), ` ${TOKEN}`, '', undefined]) {
    const { res, rows, text } = await deliverWith(numericTrans, wrong, TOKEN)
    assert.equal(res.status, 404, `token ${JSON.stringify(wrong)}`)
    assert.equal(text, '')
    assert.equal(rows.length, 0)
  }
})

test('a missing, blank or too-short configured token fails closed and stores nothing — even for a matching path', async () => {
  const short = 'short-token'
  for (const [provided, configured] of [[TOKEN, undefined], [TOKEN, ''], [TOKEN, '   '], [short, short]] as const) {
    const { res, rows, text } = await deliverWith(numericTrans, provided, configured)
    assert.equal(res.status, 404, `configured ${JSON.stringify(configured)}`)
    assert.equal(text, '')
    assert.equal(rows.length, 0)
  }
})

test('a valid JSON body is stored raw with a separately parsed copy and its SHA-256', async () => {
  const { rows } = await deliver(numericTrans)
  assert.equal(rows[0].raw_body, numericTrans)
  assert.deepEqual(rows[0].payload, JSON.parse(numericTrans))
  assert.equal(rows[0].body_sha256, createHash('sha256').update(numericTrans, 'utf8').digest('hex'))
})

test('a trans[] payload with numeric fields is kept numeric — nothing is normalised', async () => {
  const { res, rows } = await deliver(numericTrans)
  assert.equal(res.status, 200)
  const item = (rows[0].payload as { trans: Record<string, unknown>[] }).trans[0]
  assert.equal(item.txnId, 21)
  assert.equal(item.dvcId, 1)
  assert.equal(item.punchId, 1000)
})

test('a trans[] payload with string fields is kept as strings, including mode "8"', async () => {
  const { res, rows } = await deliver(stringTrans)
  assert.equal(res.status, 200)
  const item = (rows[0].payload as { trans: Record<string, unknown>[] }).trans[0]
  assert.equal(item.txnId, '3')
  assert.equal(item.punchId, '2')
  assert.equal(item.mode, '8')
})

test('several entries inside trans[] are one delivery row, in their original order', async () => {
  const { res, rows } = await deliver(multipleTrans)
  assert.equal(res.status, 200)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].payload, JSON.parse(multipleTrans))
})

test('the success response is exactly {"status":1}, with status a number', async () => {
  const { res, text } = await deliver(stringTrans)
  assert.equal(res.status, 200)
  assert.equal(text, '{"status":1}')
  assert.equal(typeof JSON.parse(text).status, 'number')
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/)
})

test('the raw body is stored byte-for-byte — whitespace, key order and unicode untouched', async () => {
  const body = '{\r\n  "trans" : [ { "mode":"8", "txnId":"3", "note":"Jodhpur — प्रवेश" } ]  }\n\n'
  const { rows } = await deliver(body)
  assert.equal(rows[0].raw_body, body)
})

test('invalid JSON is preserved but not acknowledged; a failed insert is never acknowledged', async () => {
  const bad = await deliver('{"trans": [')
  assert.equal(bad.res.status, 400)
  assert.equal(bad.rows.length, 1)
  assert.equal(bad.rows[0].processing_status, 'quarantined_invalid_json')
  assert.equal(bad.rows[0].raw_body, '{"trans": [')
  assert.notEqual(bad.text, '{"status":1}')

  const failing = fakeStore(false)
  const res = await handleMinopPathTokenWebhook(post(numericTrans), TOKEN, { configuredToken: TOKEN, insertDelivery: failing.insertDelivery })
  assert.equal(res.status, 500)
  assert.notEqual(await res.text(), '{"status":1}')
})

test('attendance processing is not triggered, even with MINOP_ATTENDANCE_PROCESSING_ENABLED=true', async () => {
  process.env.MINOP_ATTENDANCE_PROCESSING_ENABLED = 'true'
  const { res, rows } = await deliver(stringTrans)
  assert.equal(res.status, 200)
  // The single insert is the only side effect the handler has access to.
  assert.equal(rows.length, 1)

  for (const path of [HANDLER, ROUTE]) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /runMinopAttendanceProcessing|runProcessing|processDelivery|punchEvent|employeeMapping/, path)
    assert.doesNotMatch(source, /process\.env\.MINOP_ATTENDANCE_PROCESSING_ENABLED/, path)
  }
})

test('attendance_records and payroll are never written: the route writes one table, by insert only', () => {
  for (const path of [HANDLER, ROUTE]) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /\.from\('attendance_records'\)|\.from\('payroll_|\.rpc\(|\.update\(|\.upsert\(|\.delete\(/, path)
  }
  const route = readFileSync(ROUTE, 'utf8')
  assert.deepEqual(route.match(/\.from\('[a-z_]+'\)/g), [".from('minop_webhook_deliveries')"])
  assert.match(route, /process\.env\.MINOP_WEBHOOK_PATH_TOKEN/)
  // The route must not export anything but the handler Minop calls.
  assert.deepEqual(route.match(/^export .*$/gm), [
    "export const runtime = 'nodejs'",
    'export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {',
  ])
})

test('the migration only widens auth_method by url-path-token, keeping the three existing methods', () => {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '')
  assert.match(sql, /DROP CONSTRAINT minop_webhook_deliveries_auth_method_check;/)
  assert.doesNotMatch(sql, /IF EXISTS/i)
  assert.match(sql, /CHECK \(auth_method IN \('bearer', 'x-minop-webhook-secret', 'payload-auth-token', 'url-path-token'\)\)/)
  assert.equal(sql.match(/ALTER TABLE/g)?.length, 2)
  assert.doesNotMatch(sql, /CREATE|GRANT|REVOKE|POLICY|attendance_records|payroll_|INSERT|UPDATE|DELETE/i)
})
