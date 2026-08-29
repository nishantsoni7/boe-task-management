/**
 * Repository check: the invariants of the studio route that no other test can see.
 *
 * Why a source check
 * ------------------
 * Executing this route needs a live Supabase (it resolves a bearer token
 * server-side) and a paid image key, so the same approach the showroom lookup
 * route uses applies here: assert the invariants against the source. See
 * src/app/api/showroom/admin/products/lookupRoute.test.ts for the precedent.
 *
 * What is guarded, and why each one would otherwise pass unnoticed:
 *
 *   * TWO provider calls per photograph, in order, and exactly two. The cut-out
 *     exists to learn the product's real size, because padding cannot be
 *     computed without it; the studio call is the picture. A third call site, or
 *     a loop, would multiply what one press costs and no finished image would
 *     show it;
 *   * the size is decided locally, between the two calls. If that arithmetic
 *     moved into the prompt, the framing would go back to being a request the
 *     model is free to ignore — which it did, twice;
 *   * the caller is authenticated BEFORE the upload is read, so an anonymous
 *     POST cannot make BOE pay for anything;
 *   * the API key is read from the environment and never placed in a response;
 *   * nothing is persisted: no storage bucket, no insert, no file written;
 *   * the size limit is enforced against the bytes that ARRIVED, not against the
 *     size the multipart part claims;
 *   * the node runtime is declared, without which sharp cannot load at all.
 *
 * Run:
 *   npx tsx --test src/app/api/image-editor/studio/route.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(process.cwd(), 'src/app/api/image-editor/studio/route.ts'), 'utf8')

/** The handler's CODE, with comments stripped — so an assertion about what the
 *  route does cannot be tripped by a sentence explaining what it does not. */
function postCode(): string {
  return postHandler().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** The body of `export async function POST`. */
function postHandler(): string {
  const start = SOURCE.indexOf('export async function POST')
  assert.ok(start > -1, 'POST handler must exist')
  return SOURCE.slice(start)
}

/** Every argument list for a given call, read with balanced parentheses so one
 *  call cannot swallow the next. A line-based regex gets this wrong: a
 *  single-line `console.warn(...)` runs on to the close of the call after it. */
function argumentLists(source: string, marker: string): string[] {
  const out: string[] = []
  let at = source.indexOf(marker)
  while (at > -1) {
    let depth = 1
    let i = at + marker.length
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    }
    out.push(source.slice(at + marker.length, i - 1))
    at = source.indexOf(marker, i)
  }
  return out
}

const jsonResponses = (): string[] => argumentLists(SOURCE, 'NextResponse.json(')

/** Everything the handler logs, one entry per call. */
function logLines(): string[] {
  const body = postHandler()
  return ['console.error(', 'console.warn(', 'console.info(']
    .flatMap(marker => argumentLists(body, marker))
}

describe('authorization', () => {
  test('the token is checked, and against the users table as well as auth', () => {
    const body = postHandler()
    assert.ok(body.includes('authorization'), 'the bearer token must be read')
    assert.ok(body.includes('svc.auth.getUser(token)'), 'the token must be resolved server-side')
    assert.ok(body.includes("from('users')"), 'the caller must be a BOE user, not just a valid token')
    assert.ok(body.includes('status: 401'), 'an unauthenticated caller must get a 401')
  })

  test('nothing is read from the request before the caller is known', () => {
    const body = postHandler()
    const authResolved = body.indexOf('svc.auth.getUser(token)')
    const formRead     = body.indexOf('req.formData()')
    const firstCall    = body.indexOf('removeBackground(')

    assert.ok(authResolved > -1 && formRead > -1 && firstCall > -1)
    assert.ok(authResolved < formRead, 'the upload must not be read before the caller is authenticated')
    assert.ok(authResolved < firstCall, 'no provider call before the caller is authenticated')
  })

  test('the rate limit is applied before the provider call', () => {
    const body = postHandler()
    const limit = body.indexOf('rateLimited(user.id)')
    assert.ok(limit > -1 && limit < body.indexOf('removeBackground('))
    assert.ok(body.includes('status: 429'))
  })
})

describe('the pipeline', () => {
  test('exactly ONE provider call, and one call site', () => {
    const body = postCode()
    assert.equal(body.split('removeBackground(').length - 1, 1, 'one cut-out call site')
    // The generative stage is gone. A press costs one request, not two.
    assert.ok(!body.includes('generateStudioShot('))
  })

  test('nothing loops or batches around the provider call', () => {
    const body = postCode()
    const before = body.slice(0, body.indexOf('removeBackground('))
    const lastLoop = Math.max(before.lastIndexOf('for ('), before.lastIndexOf('while ('), before.lastIndexOf('.map('))
    assert.ok(lastLoop < before.lastIndexOf('await'), 'the call looks like it sits inside a loop')
  })

  test('everything after the call is local — no network, no model', () => {
    const body = postCode()
    const after = body.slice(body.indexOf('removeBackground(') + 'removeBackground('.length)

    assert.ok(after.includes('composeStudioScene('), 'the picture is built here')
    assert.ok(!/fetch\(|https?:\/\//.test(after), 'nothing else is requested over the network')
  })

  test('the furniture layer is the cut-out, and the model never repaints it', () => {
    // The rule the whole architecture rests on. A generative stage here would
    // reintroduce the failure it was removed for: a fan of thin spindles under
    // a seat came back as a dark mass with the openings filled.
    for (const banned of [
      'product-shot', 'productShot', 'ProductShot', 'generateStudioShot',
      'scene_description', 'ref_image_url', 'padding_values', 'placement_type',
      'studioReference', 'studio-reference', 'seedvr', 'upscal',
    ]) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()),
        `the route must not reference ${banned}`)
    }
  })

  test('the size is decided locally, before the composition', () => {
    const body = postCode()
    const plan = body.indexOf('planPadding(')
    assert.ok(plan > body.indexOf('measureCutout('), 'the plan needs the measured product')
    assert.ok(plan < body.indexOf('composeStudioScene('), 'the plan must precede the composition')
  })

  test('the quality gate runs, and the enlargement is reported', () => {
    const body = postCode()
    assert.ok(body.includes('checkEnlargement('))
    assert.ok(body.indexOf('checkEnlargement(') < body.indexOf('composeStudioScene('))
    assert.ok(body.includes('enlargement'), 'the ratio must reach the log')
  })

  test('the browser cannot influence what the request costs', () => {
    const body = postCode()
    const reads = body.match(/form\.get\(([^)]*)\)/g) ?? []
    assert.deepEqual(reads, ["form.get('image')"])
  })

  test('no earlier provider, and none of its plumbing, remains anywhere', () => {
    for (const banned of [
      'photoroom', 'PHOTOROOM_API_KEY', 'sdk.photoroom.com',
      'gemini', 'openai', '@fal-ai/client', 'composeStudioImage', 'productTone',
    ]) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()),
        `the route must not reference ${banned}`)
    }
  })

  test('the finished image is the locally composed master', () => {
    const body = postCode()
    assert.ok(body.includes('scene.png'))
    assert.ok(body.includes("mimeType: 'image/png'"))
  })
})

describe('retrying, and what it would cost', () => {
  test('every deterministic refusal is marked noRetry', () => {
    // A press costs two requests now. A product too small in the frame is the
    // same size next time, and an unusable cut-out is unusable again.
    const body = postCode()
    for (const marker of ['measured.error', 'verdict.message', 'shaped.error', 'scene.error']) {
      const at = body.indexOf(marker)
      assert.ok(at > -1, `${marker} must be answered`)
      const answer = body.slice(at, at + 200)
      assert.ok(answer.includes('noRetry: true'), `${marker} must not invite a retry`)
    }
  })

  test('provider failures defer to the adapters about what may be retried', () => {
    const body = postCode()
    assert.ok(body.includes('NO_RETRY_FAILURES.has(cutout.reason)'))
  })

})

describe('the API key', () => {
  test('is read from the environment and never returned to the browser', () => {
    assert.ok(SOURCE.includes('process.env.FAL_KEY'), 'the key comes from the environment')

    const responses = jsonResponses()
    assert.ok(responses.length > 5, 'the handler answers in several places')
    for (const body of responses) {
      assert.ok(!body.includes('apiKey'), `no response may carry the API key: ${body}`)
    }
    assert.ok(!SOURCE.includes('NEXT_PUBLIC_FAL'), 'the key must never be a public env var')
  })

  test('one key is read once and passed to the one adapter', () => {
    const body = postCode()
    assert.equal(body.split('process.env.FAL_KEY').length - 1, 1)
    assert.equal(body.split('apiKey,').length - 1, 1)
  })

  test('a missing key is reported honestly rather than faked', () => {
    const body = postHandler()
    assert.ok(body.includes('configured: false'), 'the page is told the service is not set up')
    assert.ok(!/placeholder|demo|sample|stock/i.test(body.replace(/\/\/.*$/gm, '')))
  })
})

describe('nothing is stored', () => {
  test('no storage bucket, no table write, no file on disk', () => {
    assert.ok(!SOURCE.includes('.storage'), 'no Supabase Storage')
    assert.ok(!SOURCE.includes('.insert('), 'no row is written')
    assert.ok(!SOURCE.includes('.upsert('), 'no row is written')
    assert.ok(!SOURCE.includes('writeFile'), 'no file is written to disk')
    assert.ok(!SOURCE.includes("from 'node:fs'"), 'the filesystem is not touched')
  })
})

describe('validation', () => {
  test('the shared validator runs server-side, not only in the browser', () => {
    assert.ok(SOURCE.includes("from '@/lib/imageEditor/validation'"))
    assert.ok(postHandler().includes('validateSourceImage('))
  })

  test('the size ceiling is enforced against the bytes that arrived', () => {
    assert.match(postHandler(), /bytes\.byteLength > MAX_SOURCE_IMAGE_BYTES/)
  })

  test('an empty upload is refused', () => {
    assert.match(postHandler(), /bytes\.byteLength === 0/)
  })
})

describe('runtime', () => {
  test('the node runtime and a duration ceiling are declared', () => {
    assert.match(SOURCE, /export const runtime = 'nodejs'/)
    assert.match(SOURCE, /export const maxDuration = \d+/)
  })

  const constant = (name: string, source = SOURCE) =>
    Number(new RegExp(`${name} = ([\\d_]+)`).exec(source)![1].replace(/_/g, ''))

  test('every part of the request is accounted for, and the total fits', () => {
    // One provider call now, and background removal sends sync_mode: true, so
    // the cut-out arrives inline and NO hosted-result download is reserved.
    const ceiling = Number(/export const maxDuration = (\d+)/.exec(SOURCE)![1]) * 1000
    const budget = constant('ROUTE_BUDGET_MS')
    const local = constant('LOCAL_WORK_MS')
    const cutout = constant('CUTOUT_TIMEOUT_MS')

    assert.ok(local + cutout <= budget,
      `${(local + cutout) / 1000}s accounted against a ${budget / 1000}s budget`)
    assert.ok(budget < ceiling, 'the budget must leave headroom under the ceiling')
    assert.ok(ceiling - budget >= 3_000, 'less than 3s of headroom under maxDuration')
  })

  test('no Product Shot budget and no hosted-download reserve remain', () => {
    assert.ok(!SOURCE.includes('STUDIO_TIMEOUT_MS'), 'the Product Shot budget is gone')
    assert.ok(!SOURCE.includes('RESULT_FETCH'), 'no download budget is reserved here')
  })

  test('the cut-out keeps the time its inline body needs', () => {
    assert.ok(constant('CUTOUT_TIMEOUT_MS') >= 25_000)
  })

  test('a deadline is anchored once and passed to the adapter', () => {
    const body = postCode()
    assert.match(body, /const deadlineAt = Date\.now\(\) \+ ROUTE_BUDGET_MS - LOCAL_WORK_MS/)
    assert.equal(body.split('deadlineAt,').length - 1, 1)
    assert.ok(body.indexOf('const deadlineAt') < body.indexOf('req.formData()'))
  })

  test('provider errors are logged, not forwarded to the browser', () => {
    const body = postHandler()
    assert.ok(body.includes('console.error'), 'provider detail goes to the server log')
    assert.ok(body.includes('error: cutout.message'))
  })

  test('what is logged is a category, a status and an id — never an image', () => {
    const logs = logLines()
    assert.ok(logs.length >= 3, 'both failures and the success are logged')
    for (const line of logs) {
      for (const leak of ['dataUrl', 'base64', 'prepared.bytes', '.png', 'scene_description']) {
        assert.ok(!line.includes(leak), `a log line must not carry ${leak}: ${line}`)
      }
    }
  })

  test('the request id is logged, so a press can be reconciled with the dashboard', () => {
    const body = postHandler()
    assert.ok(body.includes('cutout.requestId'))
  })
})
