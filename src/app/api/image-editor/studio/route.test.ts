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
    const providerCall = body.indexOf('removeBackground(')

    assert.ok(authResolved > -1 && formRead > -1 && providerCall > -1)
    assert.ok(authResolved < formRead, 'the upload must not be read before the caller is authenticated')
    assert.ok(authResolved < providerCall, 'the provider must not be called before the caller is authenticated')
  })

  test('the rate limit is applied before the provider is called', () => {
    const body = postHandler()
    assert.ok(body.indexOf('rateLimited(user.id)') < body.indexOf('removeBackground('))
    assert.ok(body.includes('status: 429'))
  })
})

describe('the pipeline', () => {
  test('the provider only cuts out; the studio image is composed locally', () => {
    const body = postHandler()
    const cutout  = body.indexOf('removeBackground(')
    const compose = body.indexOf('composeStudioImage(')

    assert.ok(cutout > -1 && compose > -1, 'both steps must be present')
    assert.ok(cutout < compose, 'the cut-out comes first, the composition second')

    // The composition must not go back out to a provider for the background.
    const after = body.slice(compose)
    assert.ok(!after.includes('fetch('), 'nothing leaves this server after the cut-out')
  })

  test('no generative image provider is referenced anywhere in the route', () => {
    for (const banned of ['gemini', 'openai', 'generateStudioImage', 'instant-background', '/v2/edit']) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()),
        `the route must not reference ${banned}`)
    }
  })

  test('a quality refusal is passed through as its own answer, not a generic failure', () => {
    const body = postHandler()
    // The page needs to tell "come back with a closer photograph" apart from
    // "the service broke": the first is not worth a retry.
    assert.ok(body.includes('composed.quality'), 'the refusal must be recognised')
    assert.match(body, /quality: true/)
    assert.match(body, /status: 422/)
    // Its measurements are logged, and the browser gets only the sentence.
    assert.ok(body.includes('composed.quality.detail'), 'the measurements go to the log')
    assert.ok(body.includes('composed.quality.message'), 'the employee gets the message')
  })

  test('what the pipeline measured is logged for every successful image', () => {
    const body = postHandler()
    for (const field of ['enlargement', 'detail', 'tone', 'contact columns']) {
      assert.ok(body.includes(field), `the log line should carry ${field}`)
    }
    // Sizes and ratios only — never image data.
    assert.ok(!/console\.(info|warn|error)\([^)]*base64/.test(body))
  })

  test('the finished image is returned as a PNG data URL', () => {
    const body = postHandler()
    assert.match(body, /data:image\/png;base64/)
    assert.ok(body.includes("mimeType: 'image/png'"))
  })
})

describe('the API key', () => {
  test('is read from the environment and never returned to the browser', () => {
    assert.ok(SOURCE.includes('process.env.PHOTOROOM_API_KEY'), 'the key comes from the environment')

    // Every response body in the file, checked for the variable holding the key.
    const responses = jsonResponses()
    assert.ok(responses.length > 5, 'the handler answers in several places')
    for (const body of responses) {
      assert.ok(!body.includes('apiKey'), `no response may carry the API key: ${body}`)
    }
    assert.ok(!SOURCE.includes('NEXT_PUBLIC_PHOTOROOM'), 'the key must never be a public env var')
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
    assert.match(body, /NextResponse\.json\(\{ error: cutout\.message \}/)
    assert.ok(!/NextResponse\.json\(\{[^}]*cutout\.detail/.test(body), 'detail must not reach the browser')
  })
})
