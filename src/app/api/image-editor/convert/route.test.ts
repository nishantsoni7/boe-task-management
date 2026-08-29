/**
 * Repository check: the download-format route cannot cost money and cannot be
 * reached by a stranger.
 *
 * Executing it needs a live Supabase, so the invariants are asserted against the
 * source — the same approach the studio route's tests use, and the precedent in
 * src/app/api/showroom/admin/products/lookupRoute.test.ts.
 *
 * What is guarded:
 *
 *   * it never calls fal, holds no key, and names no model — a conversion of an
 *     image BOE has already paid for must not become a second generation;
 *   * the caller is authenticated before sharp is handed an uploaded file;
 *   * the format is an allowlist rather than a string passed to an encoder;
 *   * nothing is stored.
 *
 * Run:
 *   npx tsx --test src/app/api/image-editor/convert/route.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(process.cwd(), 'src/app/api/image-editor/convert/route.ts'), 'utf8')

function postHandler(): string {
  const start = SOURCE.indexOf('export async function POST')
  assert.ok(start > -1, 'POST handler must exist')
  return SOURCE.slice(start)
}

describe('this route cannot spend money', () => {
  test('it knows nothing about the provider', () => {
    for (const banned of ['fal.run', 'FAL_KEY', 'fal-ai', 'generateProductShot', 'num_results', 'Authorization: `Key']) {
      assert.ok(!SOURCE.includes(banned), `a conversion route must not reference ${banned}`)
    }
  })

  test('the only work it does is sharp, through the shared converter', () => {
    assert.ok(SOURCE.includes("from '@/lib/imageEditor/imageFormats'"))
    assert.ok(postHandler().includes('convertImage('))
    // No outbound request of any kind.
    assert.ok(!postHandler().includes('fetch('), 'nothing leaves this server')
  })
})

describe('authorization', () => {
  test('the token is checked, and against the users table as well as auth', () => {
    const body = postHandler()
    assert.ok(body.includes('authorization'))
    assert.ok(body.includes('svc.auth.getUser(token)'))
    assert.ok(body.includes("from('users')"))
    assert.ok(body.includes('status: 401'))
  })

  test('nothing is decoded before the caller is known', () => {
    const body = postHandler()
    const authResolved = body.indexOf('svc.auth.getUser(token)')
    const formRead = body.indexOf('req.formData()')
    const convert = body.indexOf('convertImage(')

    assert.ok(authResolved > -1 && formRead > -1 && convert > -1)
    assert.ok(authResolved < formRead, 'the upload must not be read first')
    assert.ok(authResolved < convert, 'sharp must not run first')
  })

  test('it is rate limited', () => {
    assert.ok(SOURCE.includes('rateLimited'))
    assert.ok(postHandler().includes('status: 429'))
  })
})

describe('what it accepts', () => {
  test('the format is an allowlist, not a string handed to an encoder', () => {
    const body = postHandler()
    assert.ok(body.includes('isDownloadFormat(format)'))
    assert.ok(body.includes('status: 400'))
  })

  test('the upload is bounded and must not be empty', () => {
    const body = postHandler()
    assert.match(body, /bytes\.byteLength === 0/)
    assert.match(body, /bytes\.byteLength > MAX_IMAGE_BYTES/)
  })

  test('nothing is stored', () => {
    assert.ok(!SOURCE.includes('.storage'))
    assert.ok(!SOURCE.includes('.insert('))
    assert.ok(!SOURCE.includes('writeFile'))
    assert.ok(!SOURCE.includes("from 'node:fs'"))
  })

  test('the node runtime is declared, without which sharp cannot load', () => {
    assert.match(SOURCE, /export const runtime = 'nodejs'/)
  })
})
