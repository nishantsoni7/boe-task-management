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
 *   * the caller is authenticated BEFORE the upload is read, so an anonymous
 *     POST cannot make BOE pay for a provider call;
 *   * the API key is read from the environment and never placed in a response —
 *     a route that echoed its own config would leak the key to every employee;
 *   * nothing is persisted: no storage bucket, no insert, no file written. The
 *     prototype's promise is that neither image outlives the request;
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

/** Every `NextResponse.json(...)` argument list in the file, read with balanced
 *  parentheses so one call cannot swallow the next. */
function jsonResponses(): string[] {
  const out: string[] = []
  const marker = 'NextResponse.json('
  let at = SOURCE.indexOf(marker)
  while (at > -1) {
    let depth = 1
    let i = at + marker.length
    while (i < SOURCE.length && depth > 0) {
      if (SOURCE[i] === '(') depth++
      else if (SOURCE[i] === ')') depth--
      i++
    }
    out.push(SOURCE.slice(at + marker.length, i - 1))
    at = SOURCE.indexOf(marker, i)
  }
  return out
}

describe('authorization', () => {
  test('the token is checked, and against the users table as well as auth', () => {
    const body = postHandler()
    assert.ok(body.includes('authorization'), 'the bearer token must be read')
    assert.ok(body.includes('svc.auth.getUser(token)'), 'the token must be resolved server-side')
    assert.ok(body.includes("from('users')"), 'the caller must be a BOE user, not just a valid token')
    assert.ok(body.includes("status: 401"), 'an unauthenticated caller must get a 401')
  })

  test('nothing is read from the request before the caller is known', () => {
    const body = postHandler()
    const authResolved = body.indexOf('svc.auth.getUser(token)')
    const formRead     = body.indexOf('req.formData()')
    const providerCall = body.indexOf('generateProductShot(')

    assert.ok(authResolved > -1 && formRead > -1 && providerCall > -1)
    assert.ok(authResolved < formRead, 'the upload must not be read before the caller is authenticated')
    assert.ok(authResolved < providerCall, 'the provider must not be called before the caller is authenticated')
  })

  test('the rate limit is applied before the provider is called', () => {
    const body = postHandler()
    assert.ok(body.indexOf('rateLimited(user.id)') < body.indexOf('generateProductShot('))
    assert.ok(body.includes('status: 429'))
  })
})

describe('the pipeline', () => {
  test('one provider call, and nothing after it', () => {
    const body = postHandler()
    const call = body.indexOf('generateProductShot(')
    assert.ok(call > -1, 'the provider is called')

    // Exactly one call site, so one request per press cannot become two.
    assert.equal(body.split('generateProductShot(').length - 1, 1)

    // Nothing composes, resizes or re-encodes the result afterwards: what the
    // model returned is what the employee downloads.
    const after = body.slice(call)
    assert.ok(!after.includes('sharp('), 'the result is not re-processed')
    assert.ok(!/resize|composite|extend\(/.test(after), 'the result is not resized or recomposed')
  })

  test('no PhotoRoom call, and none of its composition, remains anywhere', () => {
    for (const banned of [
      'photoroom', 'PHOTOROOM_API_KEY', 'removeBackground', 'sdk.photoroom.com',
      'composeStudioImage', 'productMetrics', 'enhanceProduct', 'defringe',
      'gemini', 'openai',
    ]) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()),
        `the route must not reference ${banned}`)
    }
  })

  test('the browser cannot influence what the request costs', () => {
    const body = postCode()
    // The only thing read out of the request is the image itself. No model id,
    // count, placement or size is taken from the form.
    const reads = body.match(/form\.get\(([^)]*)\)/g) ?? []
    assert.deepEqual(reads, ["form.get('image')"])

    for (const field of ['num_results', 'placement_type', 'shot_size', 'model']) {
      assert.ok(!body.includes(field), `${field} must not be settable here`)
    }
  })

  test('the finished image is returned at the provider’s own type', () => {
    const body = postHandler()
    assert.ok(body.includes('result.image.dataUrl'))
    assert.ok(body.includes('result.image.contentType'))
    // Not hard-coded to PNG, and not converted: whatever came back is passed on.
    assert.ok(!body.includes("mimeType: 'image/png'"))
  })
})

describe('the API key', () => {
  test('is read from the environment and never returned to the browser', () => {
    assert.ok(SOURCE.includes('process.env.FAL_KEY'), 'the key comes from the environment')

    // Every response body in the file, checked for the variable holding the key.
    const responses = jsonResponses()
    assert.ok(responses.length > 5, 'the handler answers in several places')
    for (const body of responses) {
      assert.ok(!body.includes('apiKey'), `no response may carry the API key: ${body}`)
    }
    assert.ok(!SOURCE.includes('NEXT_PUBLIC_FAL'), 'the key must never be a public env var')
  })

  test('a missing key is reported honestly rather than faked', () => {
    const body = postHandler()
    assert.ok(body.includes('configured: false'), 'the page is told the service is not set up')
    // No placeholder, no sample, no bundled demo image anywhere in the route.
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
    const body = postHandler()
    // `file.size` is a claim in the multipart headers. The check that counts is
    // against the buffer, after it is read.
    assert.match(body, /bytes\.byteLength > MAX_SOURCE_IMAGE_BYTES/)
  })

  test('an empty upload is refused', () => {
    assert.match(postHandler(), /bytes\.byteLength === 0/)
  })
})

describe('runtime', () => {
  test('the node runtime and a duration ceiling are declared', () => {
    // sharp is a native module: on the edge runtime this route cannot run at all.
    assert.match(SOURCE, /export const runtime = 'nodejs'/)
    assert.match(SOURCE, /export const maxDuration = \d+/)
  })

  test('provider errors are logged, not forwarded to the browser', () => {
    const body = postHandler()
    assert.ok(body.includes('console.error'), 'provider detail goes to the server log')
    // The employee-facing body carries the adapter's own message only.
    assert.ok(body.includes('error: result.message'), 'the browser gets the adapter’s own sentence')
  })
})
