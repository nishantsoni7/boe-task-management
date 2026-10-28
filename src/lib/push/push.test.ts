import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPushPayload, pushCategoryFor, safePushPath, shouldPushNotification, PUSH_CATEGORIES,
  type PushSourceRow,
} from '@/lib/push/pushPolicy'
import { dispatchPush, type DispatchDeps, type PushDevice } from '@/lib/push/dispatch'

const row = (over: Partial<PushSourceRow> = {}): PushSourceRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  task_id: null,
  entity_id: '33333333-3333-4333-8333-333333333333',
  type: 'finance_handover_requested' as PushSourceRow['type'],
  title: 'Sharma Exports paid Rs 4,50,000',
  body: 'Order 539',
  is_digest: false,
  ...over,
})

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

test('a task row is filed by task_id, a module row by its type list', () => {
  assert.equal(pushCategoryFor({ task_id: 't1', type: 'task_acknowledged' as PushSourceRow['type'] }), 'task')
  assert.equal(pushCategoryFor({ task_id: null, type: 'finance_handover_requested' as PushSourceRow['type'] }), 'finance')
  assert.equal(pushCategoryFor({ task_id: null, type: 'inventory_booking_requested' as PushSourceRow['type'] }), 'inventory')
  assert.equal(pushCategoryFor({ task_id: null, type: 'not_a_real_type' as PushSourceRow['type'] }), null)
})

test('rows the inbox hides never push', () => {
  for (const type of ['escalation', 'overdue', 'stale_flag', 'morning_digest', 'evening_digest']) {
    assert.equal(shouldPushNotification(row({ type: type as PushSourceRow['type'], task_id: 't1' })), false, type)
  }
  assert.equal(shouldPushNotification(row({ type: 'task_assigned' as PushSourceRow['type'], task_id: 't1' })), false)
  assert.equal(shouldPushNotification(row({ is_digest: true })), false)
  assert.equal(shouldPushNotification(row({ type: 'not_a_real_type' as PushSourceRow['type'] })), false)
  assert.equal(shouldPushNotification(row()), true)
})

test('a muted category does not push, the others still do', () => {
  assert.equal(shouldPushNotification(row(), ['finance']), false)
  assert.equal(shouldPushNotification(row(), ['order', 'task']), true)
})

test('the lock-screen text is generic: no title, body, amount or name leaks', () => {
  const payload = buildPushPayload(row())
  const text = JSON.stringify(payload)
  assert.doesNotMatch(text, /Sharma|4,50,000|539/)
  assert.equal(payload.title, 'Finance update')
  assert.equal(payload.tag, 'boe-finance')
})

test('the tap opens the same record the inbox row opens, same-origin only', () => {
  const payload = buildPushPayload(row({ type: 'finance_handover_requested' as PushSourceRow['type'] }))
  assert.match(payload.url, /^\/(?!\/)/)
  assert.equal(safePushPath('//evil.example'), null)
  assert.equal(safePushPath('https://evil.example'), null)
  assert.equal(safePushPath('/\\evil'), null)
  assert.equal(safePushPath('/orders'), '/orders')
})

test('every mutable category has an inbox fallback and a label', () => {
  for (const c of PUSH_CATEGORIES) {
    const p = buildPushPayload(row({
      task_id: c === 'task' ? 't1' : null,
      entity_id: null,
      type: ({
        task: 'task_acknowledged', finance: 'finance_handover_requested', order: 'order_update_status',
        asset: 'asset_warranty_expiring', attendance_payroll: 'attendance_request_submitted',
        review: 'customer_review_submitted', inventory: 'inventory_booking_requested',
      } as const)[c] as PushSourceRow['type'],
    }))
    assert.ok(p.url.startsWith('/'), c)
    assert.ok(p.title.length > 0, c)
  }
})

// ── dispatch ─────────────────────────────────────────────────────────────────
const device = (id: string): PushDevice => ({ id, endpoint: `https://push.example/${id}`, p256dh: 'k', auth: 'a' })

function deps(over: Partial<DispatchDeps> = {}) {
  const sent: string[] = []
  const removed: string[] = []
  const d: DispatchDeps = {
    loadNotification: async () => row(),
    loadMutedCategories: async () => [],
    loadDevices: async () => [device('a'), device('b')],
    send: async (dev) => { sent.push(dev.id) },
    removeDevice: async (id) => { removed.push(id) },
    ...over,
  }
  return { d, sent, removed }
}

test('dispatch sends to every device of the recipient', async () => {
  const { d, sent } = deps()
  const r = await dispatchPush('id', d)
  assert.deepEqual(r, { outcome: 'sent', sent: 2, failed: 0, removed: 0 })
  assert.deepEqual(sent.sort(), ['a', 'b'])
})

test('dispatch skips a missing row, a muted category and a person with no device', async () => {
  assert.deepEqual(await dispatchPush('id', deps({ loadNotification: async () => null }).d),
    { outcome: 'skipped', reason: 'not_found' })
  assert.deepEqual(await dispatchPush('id', deps({ loadMutedCategories: async () => ['finance'] }).d),
    { outcome: 'skipped', reason: 'not_pushable' })
  assert.deepEqual(await dispatchPush('id', deps({ loadDevices: async () => [] }).d),
    { outcome: 'skipped', reason: 'no_devices' })
})

test('a gone device (404/410) is removed, other failures are kept, and neither stops the rest', async () => {
  const { d, sent, removed } = deps({
    loadDevices: async () => [device('gone'), device('flaky'), device('ok')],
    send: async (dev) => {
      if (dev.id === 'gone') throw Object.assign(new Error('gone'), { statusCode: 410 })
      if (dev.id === 'flaky') throw Object.assign(new Error('busy'), { statusCode: 503 })
      sent.push(dev.id)
    },
  })
  const r = await dispatchPush('id', d)
  assert.deepEqual(r, { outcome: 'sent', sent: 1, failed: 1, removed: 1 })
  assert.deepEqual(removed, ['gone'])
  assert.deepEqual(sent, ['ok'])
})

// ── source contracts ─────────────────────────────────────────────────────────
test('the service worker has no fetch handler and no cache, so it cannot serve a stale app', () => {
  const sw = read('public/sw.js')
  assert.doesNotMatch(sw, /addEventListener\(\s*['"]fetch['"]/)
  assert.doesNotMatch(sw, /\bcaches\./)
  assert.match(sw, /showNotification/)
  assert.match(sw, /notificationclick/)
})

test('the dispatch route refuses without the secret and never reads a body first', () => {
  const src = read('src/app/api/push/dispatch/route.ts')
  assert.ok(src.indexOf('secretMatches(provided, expected)') < src.indexOf('req.json()'))
  assert.match(src, /status: 503/)
  assert.match(src, /status: 401/)
})

test('the subscription and preference routes refuse a View As preview and scope to the caller', () => {
  for (const file of ['src/app/api/push/subscription/route.ts', 'src/app/api/push/preferences/route.ts']) {
    const src = read(file)
    assert.match(src, /isPreviewRequest\(req\.headers\)/, file)
    assert.match(src, /auth\.getUser\(\)/, file)
  }
  assert.match(read('src/app/api/push/subscription/route.ts'), /\.eq\('user_id', who\.user\.id\)/)
})

test('the migration is inert without Vault secrets, swallows errors and adds no enum value', () => {
  const sql = read('supabase/migrations/20270425000000_phone_push_notifications.sql')
  assert.match(sql, /push_dispatch_url/)
  assert.match(sql, /push_dispatch_secret/)
  assert.match(sql, /if v_url is null or v_secret is null then\s+return new;/)
  assert.match(sql, /exception when others then\s+return new;/)
  assert.doesNotMatch(sql, /alter type/i)
  assert.match(sql, /enable row level security/i)
})
