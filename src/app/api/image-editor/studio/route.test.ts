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
 *   * ONE provider call per photograph, and it is background removal. Two paid
 *     Product Shot results proved a generative model will not hold a
 *     composition — it invented a circular backdrop, then shrank the chair to a
 *     fifth of the frame — so the model now segments and nothing else. A second
 *     call site here would double what a press costs;
 *   * everything after that call is local. If sharp work drifted back to the
 *     provider, the framing would stop being arithmetic and start being a
 *     request somebody hopes is honoured;
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
  test('exactly one provider call per photograph', () => {
    const body = postCode()
    assert.ok(body.includes('removeBackground('), 'the provider is called')

    // One call site. Two would double what a single press costs, and nothing in
    // a finished image would show it.
    assert.equal(body.split('removeBackground(').length - 1, 1)
  })

  test('the one call is background removal — nothing generative', () => {
    // The whole architecture rests on this. A generative endpoint here would
    // bring back the failure it was built to end: a model that composes what it
    // likes rather than what BOE approved.
    assert.ok(SOURCE.includes("from '@/lib/imageEditor/briaBackgroundRemove'"))

    for (const banned of ['product-shot', 'productShot', 'ProductShot', 'generateProductShot']) {
      assert.ok(!SOURCE.includes(banned), `the route must not reference ${banned}`)
    }
  })

  test('no prompt, scene description or other generative instruction is sent', () => {
    const body = postCode()
    for (const field of ['prompt', 'scene', 'description', 'negative', 'seed']) {
      assert.ok(!body.toLowerCase().includes(field),
        `${field} has no place in a background-removal request`)
    }
  })

  test('everything after the provider is local — no second request', () => {
    const body = postCode()
    const call = body.indexOf('removeBackground(')

    const after = body.slice(call + 'removeBackground('.length)
    assert.ok(after.includes('composeStudioImage('), 'the composition happens here, not at the provider')
    assert.ok(!/fetch\(|https?:\/\//.test(after), 'nothing else is requested over the network')
  })

  test('no earlier provider, and none of its plumbing, remains anywhere', () => {
    for (const banned of [
      'photoroom', 'PHOTOROOM_API_KEY', 'sdk.photoroom.com',
      'gemini', 'openai', '@fal-ai/client',
    ]) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()),
        `the route must not reference ${banned}`)
    }
  })

  test('the browser cannot influence what the request costs', () => {
    const body = postCode()
    // Two things are read out of the request: the image, and the NAME of an
    // output shape. No model id, result count, placement or dimension is taken
    // from the form.
    const reads = body.match(/form\.get\(([^)]*)\)/g) ?? []
    assert.deepEqual(reads.sort(), ["form.get('image')", "form.get('preset')"].sort())

    // Dimensions are not on this list because the route legitimately LOGS the
    // ones it measured. What matters is the assertion above: only the image and
    // a preset name are read from the form, so there is nothing to set them from.
    for (const field of ['num_results', 'placement_type', 'shot_size', 'model']) {
      assert.ok(!body.includes(field), `${field} must not be settable here`)
    }
  })

  test('the output shape is resolved through the table, never passed through', () => {
    const body = postCode()
    // The value from the form goes straight into resolveOutputPreset, which
    // answers with one of three table entries or with Square. Nothing the
    // browser sends can become dimensions.
    assert.match(body, /resolveOutputPreset\(form\.get\('preset'\)\)/)
    assert.ok(body.includes('composeStudioImage(cutout.png, preset.key)'),
      'the composition receives the resolved key, not the form value')
  })

  test('the finished image is the locally composed one', () => {
    const body = postCode()
    // PNG because that is what the local composition produces — nothing is
    // passed through from the provider except the cut-out it fed.
    assert.ok(body.includes('composed.png'))
    assert.ok(body.includes("mimeType: 'image/png'"))
  })

  test('no composition refusal invites a retry that would cost another request', () => {
    // A product too small in the frame is the same size on the next press, and
    // an opaque cut-out is opaque again. Both answers are 422, and BOTH have to
    // carry noRetry — the local half of the pipeline is deterministic, so a
    // retry here buys a second charge and the identical sentence.
    const body = postCode()
    // Just the failure branch: from the `!composed.ok` test to the success
    // answer that follows it, so the finished image is not read as a refusal.
    const from = body.indexOf('if (!composed.ok)')
    const to = body.indexOf('configured: true', from)
    assert.ok(from > -1 && to > from, 'the composition failure branch must exist')

    const answers = body.slice(from, to).match(/NextResponse\.json\(\s*\{[\s\S]*?\}/g) ?? []

    assert.ok(answers.length >= 2, `expected both composition refusals, saw ${answers.length}`)
    for (const answer of answers) {
      assert.ok(answer.includes('noRetry: true'), `a composition refusal without noRetry: ${answer}`)
    }
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
    assert.ok(body.includes('error: cutout.message'), 'the browser gets the adapter’s own sentence')
  })

  test('what is logged is a category, a status and an id — never an image', () => {
    const body = postHandler()
    assert.ok(body.includes('cutout.requestId'), 'the request id is what makes a failure chaseable')
    for (const leak of ['dataUrl', 'base64', 'bytes)', 'prepared.bytes']) {
      const logs = body.match(/console\.(error|warn|info)\([\s\S]*?\n *\)/g) ?? []
      for (const line of logs) {
        assert.ok(!line.includes(leak), `a log line must not carry ${leak}: ${line}`)
      }
    }
  })
})
