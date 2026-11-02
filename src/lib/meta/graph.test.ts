/**
 * The Graph client: GET only, the token in a header and never in a URL, the next page by cursor, and the two ways
 * Meta refuses (a token that is no good, and anything else) told apart.
 *
 * Run: npx tsx --test src/lib/meta/graph.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { META_GRAPH_VERSION, MetaApiError, MetaTokenRejected, metaGet, metaGetAll } from './graph'

const TOKEN = 'EAAB-secret-token-123'

type Call = { url: string; init: RequestInit }
function fakeFetch(answers: { status?: number; body: unknown }[]): { doFetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }) as typeof fetch
  return { doFetch, calls }
}

describe('a read', () => {
  test('is a GET with the token in the Authorization header and not in the URL', async () => {
    const { doFetch, calls } = fakeFetch([{ body: { data: [] } }])
    await metaGet('act_1111111/campaigns', { fields: 'id,name', limit: '200' }, TOKEN, doFetch)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.method, 'GET')
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`)
    assert.ok(calls[0].url.startsWith(`https://graph.facebook.com/${META_GRAPH_VERSION}/act_1111111/campaigns?`))
    assert.ok(calls[0].url.includes('fields=id%2Cname') && calls[0].url.includes('limit=200'))
    assert.ok(!calls[0].url.includes(TOKEN) && !/access_token/.test(calls[0].url))
  })

  test('a token Meta refuses is told apart: by status 401, and by its own code 190', async () => {
    await assert.rejects(metaGet('me', {}, TOKEN, fakeFetch([{ status: 401, body: {} }]).doFetch), MetaTokenRejected)
    await assert.rejects(
      metaGet('me', {}, TOKEN, fakeFetch([{ status: 400, body: { error: { code: 190, message: 'Error validating access token' } } }]).doFetch),
      MetaTokenRejected,
    )
  })

  test('any other refusal is an API error that never repeats the token', async () => {
    const { doFetch } = fakeFetch([{ status: 500, body: { error: { code: 1, message: `trouble with ${TOKEN} today` } } }])
    await assert.rejects(metaGet('me', {}, TOKEN, doFetch), (error: unknown) => {
      assert.ok(error instanceof MetaApiError)
      assert.ok(!error.message.includes(TOKEN))
      assert.match(error.message, /Meta answered 500: trouble with \[token\] today/)
      return true
    })
  })

  test('an answer that is not JSON is an API error, not a crash', async () => {
    await assert.rejects(metaGet('me', {}, TOKEN, fakeFetch([{ body: '<html>' }]).doFetch), MetaApiError)
  })
})

describe('a list', () => {
  test('is read page by page with the after cursor, never by the next link that carries the token', async () => {
    const { doFetch, calls } = fakeFetch([
      { body: { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'CUR1' }, next: `https://graph.facebook.com/next?access_token=${TOKEN}` } } },
      { body: { data: [{ id: '3' }], paging: { cursors: { after: 'CUR2' } } } },
    ])
    const rows = await metaGetAll('act_1111111/adsets', { fields: 'id' }, TOKEN, doFetch)
    assert.deepEqual(rows.map(r => r.id), ['1', '2', '3'])
    assert.equal(calls.length, 2)
    assert.ok(calls[1].url.includes('after=CUR1'))
    assert.ok(calls.every(c => !c.url.includes('access_token') && !c.url.includes(TOKEN)))
  })

  test('stops when there is no next page, and reads an empty list', async () => {
    const { doFetch, calls } = fakeFetch([{ body: { data: [] } }])
    assert.deepEqual(await metaGetAll('act_1111111/adsets', {}, TOKEN, doFetch), [])
    assert.equal(calls.length, 1)
  })

  test('gives up on a list that never ends', async () => {
    const { doFetch } = fakeFetch([{ body: { data: [{ id: '1' }], paging: { cursors: { after: 'AGAIN' }, next: 'x' } } }])
    await assert.rejects(metaGetAll('act_1111111/adsets', {}, TOKEN, doFetch), /more pages/)
  })
})

describe('read only', () => {
  test('graph.ts makes GET requests and no other method appears in it', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/meta/graph.ts'), 'utf8')
    assert.equal((source.match(/method:/g) ?? []).length, 1)
    assert.match(source, /method: 'GET'/)
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(!source.includes(`'${verb}'`), verb)
  })

  test('nothing else under src/lib/meta or the sync route calls fetch directly', () => {
    for (const file of ['src/lib/meta/sync.ts', 'src/lib/meta/store.ts', 'src/lib/meta/parse.ts', 'src/app/api/integrations/meta/sync/route.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      assert.ok(!/\bfetch\(/.test(source.replace(/doFetch|fetchImpl/g, '')), `${file} must go through graph.ts`)
    }
  })
})
