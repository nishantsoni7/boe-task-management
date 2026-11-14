// THE LAUNCHER'S BADGE COUNTS IN ONE CALL (2026-11-14, page speed part 7), the server's half: the same two count
// routes, each answer exactly as its own request would have had it, one failing part never taking the others
// down. Run with: npx tsx --test src/lib/notifications/countBatch.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SAMPLE_PART, countRequestPath, loadCounts, parseCountParts } from './countBatch'

const SUBJECT = '0b9c6c0e-6a58-4f4d-8f5b-1d0f3a6a7a11'
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('which parts are asked for', () => {
  test('valid notification categories and sample, once each, in the order given; anything else is ignored', () => {
    assert.deepEqual(parseCountParts('task,finance,order,sample'), ['task', 'finance', 'order', 'sample'])
    assert.deepEqual(parseCountParts('sample, task ,task,hacker,,../x'), ['sample', 'task'])
    assert.deepEqual(parseCountParts('asset,attendance_payroll,review,inventory,sales').length, 5)
    assert.deepEqual(parseCountParts(null), [])
    assert.deepEqual(parseCountParts(''), [])
  })

  test('the path a part asks is EXACTLY the address its caller used to fetch', () => {
    assert.equal(countRequestPath('task', null), '/api/notifications?count=1&category=task')
    assert.equal(countRequestPath('order', null), '/api/notifications?count=1&category=order')
    assert.equal(countRequestPath('finance', SUBJECT), `/api/notifications?count=1&category=finance&subjectUserId=${SUBJECT}`)
    assert.equal(countRequestPath(SAMPLE_PART, null), '/api/samples/notifications?count=1')
    assert.equal(countRequestPath(SAMPLE_PART, SUBJECT), '/api/samples/notifications?count=1', 'Sample Tracking has no preview subject')
  })
})

describe('what the batch answers', () => {
  test('each part carries its own route\'s status and body, unchanged', async () => {
    const asked: string[] = []
    const r = await loadCounts(['task', 'finance', 'sample'], null, async (_part, path) => {
      asked.push(path)
      if (path.includes('finance')) return reply({ error: 'Forbidden' }, 403)
      return reply({ unreadCount: path.includes('samples') ? 1 : 5 })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { parts: {
      task: { status: 200, body: { unreadCount: 5 } },
      finance: { status: 403, body: { error: 'Forbidden' } },
      sample: { status: 200, body: { unreadCount: 1 } },
    } })
    assert.deepEqual(asked.sort(), [
      '/api/notifications?count=1&category=finance',
      '/api/notifications?count=1&category=task',
      '/api/samples/notifications?count=1',
    ])
  })

  test('the preview subject goes to the notification categories only', async () => {
    const asked: string[] = []
    await loadCounts(['task', 'sample'], SUBJECT, async (_p, path) => { asked.push(path); return reply({ unreadCount: 0 }) })
    assert.deepEqual(asked.sort(), [
      `/api/notifications?count=1&category=task&subjectUserId=${SUBJECT}`,
      '/api/samples/notifications?count=1',
    ])
  })

  test('the parts run in parallel, not one after another', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const run = loadCounts(['task', 'finance', 'order', 'sample'], null, async (part) => {
      order.push(`start ${part}`); await gate; order.push(`end ${part}`); return reply({ unreadCount: 0 })
    })
    await new Promise(r => setTimeout(r, 5))
    assert.deepEqual(order, ['start task', 'start finance', 'start order', 'start sample'], 'all four started before any ended')
    release()
    await run
  })

  test('a part that throws becomes a 500 for that part alone, with the database message kept in the log', async () => {
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const r = await loadCounts(['task', 'order'], null, async (part) => {
        if (part === 'order') throw new Error('db down: secret detail')
        return reply({ unreadCount: 2 })
      })
      assert.deepEqual(r.body.parts, {
        task: { status: 200, body: { unreadCount: 2 } },
        order: { status: 500, body: { error: 'Something went wrong. Try again.' } },
      })
      assert.equal(JSON.stringify(r).includes('secret detail'), false)
      assert.equal(logged.length, 1)
    } finally {
      console.error = original
    }
  })

  test('an answer that is not JSON keeps its status with an empty body; no parts is an empty answer', async () => {
    const r = await loadCounts(['task'], null, async () => new Response('<html>', { status: 502 }))
    assert.deepEqual(r.body.parts, { task: { status: 502, body: {} } })
    assert.deepEqual(await loadCounts([], null, async () => reply({})), { status: 200, body: { parts: {} } })
  })
})

describe('the route and the wiring', () => {
  const root = join(__dirname, '..', '..', '..')
  // Line comments first: a header comment that mentions "/api/x/*" must not open a block comment.
  const src = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

  test('the batch route runs the unchanged GET handlers of the two routes it stands in for, and only reads', () => {
    const route = src('src/app/api/notifications/counts/route.ts')
    assert.match(route, /import \{ GET as notificationCount \} from '\.\.\/route'/)
    assert.match(route, /import \{ GET as sampleCount \} from '@\/app\/api\/samples\/notifications\/route'/)
    assert.match(route, /headers: req\.headers/, 'the caller\'s own cookies travel with each part')
    assert.match(route, /export async function GET/)
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(route), false)
    for (const original of ['src/app/api/notifications/route.ts', 'src/app/api/samples/notifications/route.ts']) {
      assert.match(src(original), /export async function GET\(req: NextRequest\)/, `${original} still answers for itself`)
    }
  })

  test('the hook and the launcher ask through the batcher, with their own URLs unchanged', () => {
    const hook = src('src/hooks/queries/useUnreadNotifications.ts')
    assert.match(hook, /batchedCountGet\(\s*`\/api\/notifications\?count=1&category=\$\{category\}`/)
    assert.equal(/\bfetch\(/.test(hook), false, 'no count is fetched around the batcher')
    const launcher = src('src/app/modules/page.tsx')
    assert.match(launcher, /batchedCountGet\(url\)/)
    assert.match(launcher, /load\(mayOpenSample, '\/api\/samples\/notifications\?count=1', 'sample'\)/)
    assert.ok(existsSync(join(root, 'src/app/api/notifications/counts/route.ts')))
  })
})
