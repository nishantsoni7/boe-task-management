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

  test('the rate limit is applied before either provider call', () => {
    const body = postHandler()
    const limit = body.indexOf('rateLimited(user.id)')
    assert.ok(limit > -1 && limit < body.indexOf('removeBackground('))
    assert.ok(limit < body.indexOf('generateStudioShot('))
    assert.ok(body.includes('status: 429'))
  })
})

describe('the pipeline', () => {
  test('exactly two provider calls, and exactly one call site each', () => {
    const body = postCode()
    assert.equal(body.split('removeBackground(').length - 1, 1, 'one cut-out call site')
    assert.equal(body.split('generateStudioShot(').length - 1, 1, 'one studio call site')
  })

  test('the cut-out comes first — the studio call needs its dimensions', () => {
    const body = postCode()
    assert.ok(body.indexOf('removeBackground(') < body.indexOf('generateStudioShot('))
  })

  test('nothing loops or batches around a provider call', () => {
    const body = postCode()
    // One press, two requests. A `for`/`while`/`map` wrapped around either call
    // would turn that into an unbounded bill.
    for (const call of ['removeBackground(', 'generateStudioShot(']) {
      const before = body.slice(0, body.indexOf(call))
      const lastLoop = Math.max(before.lastIndexOf('for ('), before.lastIndexOf('while ('), before.lastIndexOf('.map('))
      const lastAwait = before.lastIndexOf('await')
      assert.ok(lastLoop < lastAwait, `${call} looks like it sits inside a loop`)
    }
  })

  test('the size is decided locally, between the two calls', () => {
    // The whole point of the change. If this moved back into the prompt, the
    // framing would again be something the model may ignore.
    const body = postCode()
    const plan = body.indexOf('planPadding(')
    assert.ok(plan > body.indexOf('measureCutout('), 'the plan needs the measured product')
    assert.ok(plan < body.indexOf('generateStudioShot('), 'the plan must precede the studio call')
  })

  test('the quality gate runs before the second request is paid for', () => {
    const body = postCode()
    assert.ok(body.indexOf('checkEnlargement(') < body.indexOf('generateStudioShot('),
      'a product too small must be refused before it costs a second request')
  })

  test('the browser cannot influence what the request costs', () => {
    const body = postCode()
    // One thing is read out of the request: the image. There is no output shape
    // to choose any more, and no dimension, count or placement is taken from a form.
    const reads = body.match(/form\.get\(([^)]*)\)/g) ?? []
    assert.deepEqual(reads, ["form.get('image')"])

    for (const field of [
      'num_results', 'placement_type', 'shot_size', 'padding_values',
      'scene_description', 'ref_image_url', 'optimize_description', 'model',
    ]) {
      assert.ok(!body.includes(field), `${field} must not be settable here`)
    }
  })

  test('no prompt or scene wording lives in the route', () => {
    // It is a server-side constant in the adapter, so there is exactly one of it.
    for (const phrase of ['catalogue studio photograph', 'warm neutral', 'rock', 'ocean', 'dark theme']) {
      assert.ok(!SOURCE.toLowerCase().includes(phrase), `the route must not contain "${phrase}"`)
    }
  })

  test('no earlier provider, and none of its plumbing, remains anywhere', () => {
    for (const banned of [
      'photoroom', 'PHOTOROOM_API_KEY', 'sdk.photoroom.com',
      'gemini', 'openai', '@fal-ai/client',
      // The local scene path this replaced.
      'composeStudioImage', 'productTone', 'outputPresets',
    ]) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()),
        `the route must not reference ${banned}`)
    }
  })

  test('the finished image is whatever the studio stage returned', () => {
    const body = postCode()
    assert.ok(body.includes('studio.image'))
    // The provider's own content type, not a hard-coded one: nothing here
    // re-encodes the accepted result.
    assert.ok(body.includes('studio.contentType'))
  })
})

describe('retrying, and what it would cost', () => {
  test('every deterministic refusal is marked noRetry', () => {
    // A press costs two requests now. A product too small in the frame is the
    // same size next time, and an unusable cut-out is unusable again.
    const body = postCode()
    for (const marker of ['measured.error', 'verdict.message', 'shaped.error']) {
      const at = body.indexOf(marker)
      assert.ok(at > -1, `${marker} must be answered`)
      const answer = body.slice(at, at + 200)
      assert.ok(answer.includes('noRetry: true'), `${marker} must not invite a retry`)
    }
  })

  test('provider failures defer to the adapters about what may be retried', () => {
    const body = postCode()
    assert.ok(body.includes('NO_RETRY_FAILURES.has(cutout.reason)'))
    assert.ok(body.includes('isNoRetry(studio.reason)'))
  })

  test('a missing studio reference is a 503, not something to try again', () => {
    assert.ok(SOURCE.includes("case 'reference_missing'"), 'the reference failure must be mapped')
    const mapping = SOURCE.slice(SOURCE.indexOf('function statusFor'), SOURCE.indexOf('// ─── Route'))
    assert.match(mapping, /reference_missing[\s\S]{0,60}503/)
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

  test('one key is read once and passed to both stages', () => {
    const body = postCode()
    assert.equal(body.split('process.env.FAL_KEY').length - 1, 1)
    assert.equal(body.split('apiKey,').length - 1, 2, 'both adapters receive it')
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
    // A real run died because the budget was a sum nobody had checked: the
    // cut-out was given 18s, its body needed more, and the request came back
    // as a misclassified failure after 18026 ms.
    const ceiling = Number(/export const maxDuration = (\d+)/.exec(SOURCE)![1]) * 1000
    const budget = constant('ROUTE_BUDGET_MS')
    const local = constant('LOCAL_WORK_MS')
    const cutout = constant('CUTOUT_TIMEOUT_MS')
    const studio = constant('STUDIO_TIMEOUT_MS')

    const transport = readFileSync(join(process.cwd(), 'src/lib/imageEditor/falRequest.ts'), 'utf8')
    const download = constant('RESULT_FETCH_TIMEOUT_MS', transport)

    // Background removal sends sync_mode: true, so its cut-out arrives inline
    // and NO download is reserved for it. Only the studio stage fetches a
    // hosted result.
    const accounted = local + cutout + studio + download

    assert.ok(accounted <= budget,
      `${accounted / 1000}s accounted against a ${budget / 1000}s budget`)

    // And the providers alone must fit inside the deadline they are actually
    // given, which is the budget less the local work reserved for the end.
    assert.ok(cutout + studio + download <= budget - local,
      `providers need ${(cutout + studio + download) / 1000}s but are given ${(budget - local) / 1000}s`)
    assert.ok(budget < ceiling,
      `the budget must leave headroom under the ${ceiling / 1000}s ceiling`)
    assert.ok(ceiling - budget >= 3_000, 'less than 3s of headroom under maxDuration')
  })

  test('the cut-out gets the time its inline body needs', () => {
    // sync_mode: true means the whole cut-out comes back inside the response
    // body as base64, and streaming that is part of this budget. The observed
    // failure took 18026 ms.
    const cutout = constant('CUTOUT_TIMEOUT_MS')
    assert.ok(cutout >= 25_000, `${cutout / 1000}s is not enough for an inline cut-out`)
  })

  test('the studio stage keeps the budget it already had', () => {
    assert.equal(constant('STUDIO_TIMEOUT_MS'), 20_000)
  })

  test('a deadline is anchored once and passed to both stages', () => {
    // The sum above is the intent; this is the guarantee. Every timeout is
    // clamped to what is left, so a slow path degrades the next step instead of
    // overrunning the platform's ceiling.
    const body = postCode()
    assert.match(body, /const deadlineAt = Date\.now\(\) \+ ROUTE_BUDGET_MS - LOCAL_WORK_MS/)
    assert.equal(body.split('deadlineAt,').length - 1, 2, 'both adapters receive it')

    const anchor = body.indexOf('const deadlineAt')
    assert.ok(anchor < body.indexOf('req.formData()'),
      'the deadline must be anchored before the upload is read')
  })

  test('provider errors are logged, not forwarded to the browser', () => {
    const body = postHandler()
    assert.ok(body.includes('console.error'), 'provider detail goes to the server log')
    assert.ok(body.includes('error: cutout.message'))
    assert.ok(body.includes('error: studio.message'))
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

  test('both request ids are logged, so a two-call press can be reconciled', () => {
    const body = postHandler()
    assert.ok(body.includes('cutout.requestId'))
    assert.ok(body.includes('studio.requestId'))
  })
})
