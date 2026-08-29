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
    const firstCall    = body.indexOf('generateProductShot(')

    assert.ok(authResolved > -1 && formRead > -1 && firstCall > -1)
    assert.ok(authResolved < formRead, 'the upload must not be read before the caller is authenticated')
    assert.ok(authResolved < firstCall, 'no provider call before the caller is authenticated')
  })

  test('the rate limit is applied before the provider call', () => {
    const body = postHandler()
    const limit = body.indexOf('rateLimited(user.id)')
    assert.ok(limit > -1 && limit < body.indexOf('generateProductShot('))
    assert.ok(body.includes('status: 429'))
  })
})

describe('the pipeline', () => {
  test('exactly TWO provider calls — one each, one call site each', () => {
    const body = postCode()
    assert.equal(body.split('generateProductShot(').length - 1, 1, 'one product shot call site')
    assert.equal(body.split('upscaleImage(').length - 1, 1, 'one upscale call site')
  })

  test('no other provider call exists anywhere in the route', () => {
    const body = postCode()
    for (const banned of ['removeBackground(', 'callFal(', 'fetch(']) {
      assert.ok(!body.includes(banned), `${banned} must not appear`)
    }
  })

  test('nothing loops or batches around either call', () => {
    const body = postCode()
    for (const call of ['generateProductShot(', 'upscaleImage(']) {
      const before = body.slice(0, body.indexOf(call))
      const lastLoop = Math.max(before.lastIndexOf('for ('), before.lastIndexOf('while ('), before.lastIndexOf('.map('))
      assert.ok(lastLoop < before.lastIndexOf('await'), `${call} looks like it sits inside a loop`)
    }
  })

  test('Product Shot receives the ORIGINAL photograph, not a cut-out', () => {
    const body = postCode()
    assert.match(body, /photograph: prepared\.bytes/)
    // The cut-out path is gone entirely.
    for (const banned of ['prepareCutoutForShot', 'measureCutout', 'decontaminateEdges', 'composeStudioScene']) {
      assert.ok(!SOURCE.includes(banned), `${banned} must not be in the route`)
    }
  })

  test('the reframe happens locally, between the two calls', () => {
    const body = postCode()
    const shot = body.indexOf('generateProductShot(')
    const frame = body.indexOf('reframe(')
    const up = body.indexOf('upscaleImage(')
    assert.ok(shot < frame && frame < up, 'crop the generated square before upscaling it')
  })

  test('the gate runs after BOTH stages', () => {
    const body = postCode()
    const calls = body.split('comparePreservation(').length - 1
    assert.equal(calls, 2, 'preservation is checked after the shot and after the upscale')
    assert.ok(body.includes('PRESERVATION_REFUSAL'), 'a failed check must refuse')
  })

  test('the ground truth is measured before anything is generated', () => {
    const body = postCode()
    assert.ok(body.indexOf('measureProfile(prepared.bytes)') < body.indexOf('generateProductShot('))
  })

  test('the browser cannot influence what the request costs', () => {
    const body = postCode()
    assert.deepEqual(body.match(/form\.get\(([^)]*)\)/g) ?? [], ["form.get('image')"])
  })

  test('no prompt or scene wording lives in the route', () => {
    for (const phrase of ['scene_description', 'catalogue studio', 'warm neutral', 'rock', 'ocean']) {
      assert.ok(!SOURCE.toLowerCase().includes(phrase.toLowerCase()), `"${phrase}"`)
    }
  })

  test('what the upscaler returned is INSPECTED, never assumed', () => {
    // `upscale_factor: 1.44` on a 1000px square should give 1440, but the
    // factor's accepted range is undocumented and nothing promises the model
    // rounds as we would. So the route measures the result and normalises it.
    const body = postCode()
    assert.match(body, /normaliseSquare\(upscaled\.image, MASTER_SIDE\)/)
    assert.ok(body.indexOf('normaliseSquare(') > body.indexOf('upscaleImage('))
    // A blind resize to the master size would hide a wrongly shaped result.
    assert.ok(!body.includes(".resize(MASTER_"), 'the size must be checked, not forced')
    assert.ok(body.includes("mimeType: 'image/png'"))
  })

  test('the delivered image is the normalised one, not the raw upscale', () => {
    const body = postCode()
    assert.match(body, /const master = normalised\.image/)
    // The SUCCESS response, found by the field only it carries. Anchoring on
    // "the last return" broke the moment the pipeline gained a catch block
    // whose refusal is now the last one — the assertion was still true, it was
    // reading the wrong response.
    const at = body.indexOf('configured: true')
    assert.ok(at > -1, 'the success response must exist')
    const returned = body.slice(body.lastIndexOf('return NextResponse.json(', at))
    assert.ok(returned.includes('master.toString'), 'the response must carry the normalised bytes')
    assert.ok(!returned.includes('upscaled.image'), 'the raw upscale must never be served')
  })

  test('nothing is cropped after the upscale', () => {
    // A crop at this point could cut a foot off.
    const body = postCode()
    const after = body.slice(body.indexOf('upscaleImage('))
    assert.ok(!after.includes('.extract('), 'nothing may be cropped off after the upscale')
  })

  test('both returned and delivered dimensions are logged', () => {
    const logged = logLines().join('\n')
    assert.match(logged, /seedvr returned/)
    assert.match(logged, /delivered /)
    assert.match(logged, /normalised\.returned\.width/)
    assert.match(logged, /normalised\.delivered\.width/)
  })

  test('an inconclusive comparison is DELIVERED, and never called verified', () => {
    // BOE photographs furniture against textured concrete, so most genuine
    // uploads cannot be compared at all. Refusing them would refuse the module
    // on the strength of a check that never ran — so the image is delivered and
    // the fact that nobody verified it travels with it.
    const body = postCode()
    assert.ok(body.includes('report.inconclusive'), 'the route must read the inconclusive flag')
    const refusals = jsonResponses().filter(r => r.includes('INCONCLUSIVE_MESSAGE'))
    assert.equal(refusals.length, 0, 'an inconclusive result must not be refused')
    assert.match(body, /verification = 'manual_review_required'/)
    assert.match(body, /VERIFICATION_HEADER\]: verification/)
  })

  test('a CONFIRMED failure is refused before the second billable request', () => {
    // Paying to upscale an image already known to be wrong is money spent to
    // produce a refusal.
    const body = postCode()
    const firstRefusal = body.indexOf('PRESERVATION_REFUSAL')
    assert.ok(firstRefusal > -1 && firstRefusal < body.indexOf('upscaleImage('),
      'a confirmed structural failure must stop before the upscale')
  })

  test('the verdict is a header, never measurements in the body', () => {
    const body = postCode()
    const returned = body.slice(body.lastIndexOf('return NextResponse.json('))
    for (const leak of ['bounds', 'structure', 'summary', 'requestId', 'checks', 'plan.']) {
      assert.ok(!returned.includes(leak), `"${leak}" must not reach the browser`)
    }
  })

  test('the exact inconclusive wording is logged, verbatim', () => {
    // The agreed sentence. Logged as its own argument so nothing interpolates
    // around it and changes what an operator greps for.
    const logged = logLines()
    assert.ok(logged.some(l => /\bINCONCLUSIVE_MESSAGE\b/.test(l)),
      'the inconclusive message must be logged')
  })

  test('no earlier provider or local-composition plumbing remains', () => {
    for (const banned of ['photoroom', 'gemini', 'openai', '@fal-ai/client', 'studioScene', 'productTone']) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()), banned)
    }
  })
})

describe('retrying, and failure classification', () => {
  test('the two stages are classified separately', () => {
    const body = postCode()
    assert.ok(body.includes('product shot failed'), 'a Product Shot failure says so')
    assert.ok(body.includes('upscale failed'), 'an upscale failure says so')
    assert.ok(body.includes('isNoRetry(shot.reason)'))
    assert.ok(body.includes('NO_RETRY_FAILURES.has(upscaled.reason)'))
  })

  test('no automatic retry exists anywhere', () => {
    // `noRetry` and `NO_RETRY_FAILURES` are the response flag and the
    // classification set — they mark a failure as not worth another press.
    // What must not exist is a MECHANISM that presses again by itself.
    const body = postCode().replace(/noRetry|NO_RETRY_FAILURES|isNoRetry/g, '')
    for (const banned of ['retry', 'attempt', 'maxRetries', 'backoff']) {
      assert.ok(!body.toLowerCase().includes(banned.toLowerCase()), `${banned} in the route`)
    }
  })

  test('a missing reference is a 503 and costs nothing', () => {
    assert.ok(SOURCE.includes("case 'reference_missing'"))
    const mapping = SOURCE.slice(SOURCE.indexOf('function statusFor'), SOURCE.indexOf('// ─── Route'))
    assert.match(mapping, /reference_missing[\s\S]{0,60}503/)
  })

  test('a preservation refusal is answered, not served', () => {
    const body = postCode()
    assert.ok(body.includes('PRESERVATION_REFUSAL'))
    assert.match(body, /status: 422/)
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

  test('one key is read once and passed to both adapters', () => {
    const body = postCode()
    assert.equal(body.split('process.env.FAL_KEY').length - 1, 1)
    assert.equal(body.split('apiKey,').length - 1, 2)
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

  test('the budget is declared, and the deadline is what enforces it', () => {
    const ceiling = Number(/export const maxDuration = (\d+)/.exec(SOURCE)![1]) * 1000
    const budget = constant('ROUTE_BUDGET_MS')
    const local = constant('LOCAL_WORK_MS')
    const shot = constant('PRODUCT_SHOT_TIMEOUT_MS')
    const upscale = constant('UPSCALE_TIMEOUT_MS')

    assert.ok(budget < ceiling, 'the budget must sit under the platform ceiling')
    assert.ok(local + shot + upscale <= budget,
      `${(local + shot + upscale) / 1000}s of stages against a ${budget / 1000}s budget`)

    // Two generative calls in one request is tight, so the deadline — not the
    // sum — is the guarantee. Every timeout clamps to what is left.
    const body = postCode()
    assert.match(body, /const deadlineAt = Date\.now\(\) \+ ROUTE_BUDGET_MS - LOCAL_WORK_MS/)
    assert.equal(body.split('deadlineAt,').length - 1, 2, 'both adapters receive it')
    assert.ok(body.indexOf('const deadlineAt') < body.indexOf('req.formData()'))
  })

  test('provider errors are logged, not forwarded to the browser', () => {
    const body = postHandler()
    assert.ok(body.includes('console.error'), 'provider detail goes to the server log')
    assert.ok(body.includes('error: shot.message'))
    assert.ok(body.includes('error: upscaled.message'))
  })

  test('what is logged is a category, a status and an id — never an image', () => {
    const logs = logLines()
    assert.ok(logs.length >= 4, 'both failures, the gate and the success are logged')
    for (const line of logs) {
      for (const leak of ['dataUrl', 'base64', 'prepared.bytes', '.png', 'scene_description']) {
        assert.ok(!line.includes(leak), `a log line must not carry ${leak}: ${line}`)
      }
    }
  })

  test('both request ids are logged, so a two-call press reconciles', () => {
    const body = postHandler()
    assert.ok(body.includes('shot.requestId'))
    assert.ok(body.includes('upscaled.requestId'))
  })
})
