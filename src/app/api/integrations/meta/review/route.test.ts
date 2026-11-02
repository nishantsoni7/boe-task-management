/**
 * GET /api/integrations/meta/review: the door. Closed without a secret, refuses a wrong one, quiet with no Claude key.
 *
 * Run: npx tsx --test src/app/api/integrations/meta/review/route.test.ts
 */
import { strict as assert } from 'node:assert'
import { afterEach, describe, test } from 'node:test'
import { GET } from './route'

const saved = { ...process.env }
const call = (secret?: string) => GET(new Request('https://x.test/api/integrations/meta/review', { headers: secret ? { authorization: `Bearer ${secret}` } : {} }))

describe('the review door', () => {
  afterEach(() => { process.env = { ...saved } })

  test('no CRON_SECRET: closed', async () => {
    delete process.env.CRON_SECRET
    assert.equal((await call('anything')).status, 503)
  })

  test('no secret or a wrong one: refused', async () => {
    process.env.CRON_SECRET = 'right'
    assert.equal((await call()).status, 401)
    assert.equal((await call('wrong')).status, 401)
  })

  test('no Claude key: quiet, nothing read', async () => {
    process.env.CRON_SECRET = 'right'
    delete process.env.ANTHROPIC_API_KEY
    const res = await call('right')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'not_configured' })
  })
})
