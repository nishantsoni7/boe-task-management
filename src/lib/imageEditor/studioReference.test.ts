/**
 * The approved reference, and the one rule about it: it is never substituted.
 *
 * A studio image generated without the approved reference still looks like a
 * studio image. That is exactly the danger — nobody downstream could tell it
 * apart from an approved one, so it would enter the catalogue unnoticed. A
 * visible failure is the safe behaviour, and these tests are what keep it.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/studioReference.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadStudioReference, resetReferenceCache, referenceSource,
  REFERENCE_PATH, REFERENCE_MIME, MAX_REFERENCE_BYTES,
  REFERENCE_BUCKET, REFERENCE_OBJECT,
} from './studioReference'

const realEnv = { ...process.env }
const realFetch = globalThis.fetch

afterEach(() => {
  resetReferenceCache()
  process.env = { ...realEnv }
  globalThis.fetch = realFetch
})

/** A repository root, optionally carrying a reference file. */
function root(contents?: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'boe-ref-'))
  if (contents) {
    mkdirSync(join(dir, 'assets', 'image-editor'), { recursive: true })
    writeFileSync(join(dir, REFERENCE_PATH), contents)
  }
  return dir
}

describe('where it lives', () => {
  test('it is outside public/, so it is not served to a browser', () => {
    // Nothing in a browser needs it: the only reader is this server, on its way
    // to fal. Under public/ it would be fetchable by anyone who guessed the path.
    assert.ok(!REFERENCE_PATH.startsWith('public'), REFERENCE_PATH)
    assert.ok(REFERENCE_PATH.includes('assets'), REFERENCE_PATH)
  })

  test('the path is fixed, not derived from anything a caller sends', () => {
    assert.equal(REFERENCE_PATH.includes('..'), false)
    assert.equal(REFERENCE_MIME, 'image/png')
  })
})

describe('loading it', () => {
  test('an installed reference comes back as a data URI', async () => {
    const result = await loadStudioReference(root(Buffer.from('REFERENCE-BYTES')))

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.dataUrl, /^data:image\/png;base64,/)
    assert.equal(Buffer.from(result.dataUrl.split(',')[1], 'base64').toString(), 'REFERENCE-BYTES')
  })

  test('it travels as data, so no public URL for it is ever created', async () => {
    const result = await loadStudioReference(root(Buffer.from('REFERENCE-BYTES')))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(!result.dataUrl.startsWith('http'))
    assert.ok(!result.dataUrl.includes('fal.media'))
  })

  test('a missing file is reported, never worked around', async () => {
    const result = await loadStudioReference(root())

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'missing')
    // The detail names the path an administrator has to install, and nothing else.
    assert.ok(result.detail.includes(REFERENCE_PATH))
  })

  test('an empty file is refused rather than sent', async () => {
    const result = await loadStudioReference(root(Buffer.alloc(0)))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'unreadable')
  })

  test('a file beyond what Bria accepts is refused locally', async () => {
    const result = await loadStudioReference(root(Buffer.alloc(MAX_REFERENCE_BYTES + 1)))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'too_large')
  })

  test('nothing is invented when it is missing — there is no fallback path', async () => {
    const result = await loadStudioReference(root())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal('dataUrl' in result, false, 'a failure must not carry an image')
  })

  test('it never throws, whatever is on disk', async () => {
    for (const dir of [root(), root(Buffer.alloc(0)), '/definitely/not/a/directory']) {
      const result = await loadStudioReference(dir)
      assert.equal(typeof result.ok, 'boolean')
    }
  })
})

describe('caching', () => {
  test('the file is read once, not once per image', async () => {
    const dir = root(Buffer.from('FIRST'))
    const first = await loadStudioReference(dir)

    writeFileSync(join(dir, REFERENCE_PATH), Buffer.from('SECOND'))
    const second = await loadStudioReference(dir)

    assert.deepEqual(first, second, 'the second call must not re-read the file')
  })

  test('a failure is cached too, so a missing file does not stat on every request', async () => {
    const dir = root()
    assert.equal((await loadStudioReference(dir)).ok, false)

    mkdirSync(join(dir, 'assets', 'image-editor'), { recursive: true })
    writeFileSync(join(dir, REFERENCE_PATH), Buffer.from('INSTALLED-LATER'))

    // Still the cached failure: installing the reference means restarting the
    // server, which is how it is installed anyway.
    assert.equal((await loadStudioReference(dir)).ok, false)

    resetReferenceCache()
    assert.equal((await loadStudioReference(dir)).ok, true)
  })
})

// ═══ Where it comes from in a deployment ══════════════════════════════════════
//
// The local file is `.gitignore`d, so a Vercel build — which starts from a git
// clone — does not have it. Verified by exporting HEAD to a clean tree: only the
// README is there. Without a second source every generation in production fails
// with "reference not installed", so these tests are about the source that
// actually serves it.

/** Stand in for Supabase Storage at the HTTP level, so no client is mocked. */
function stubStorage(respond: (url: string) => Response) {
  const calls: string[] = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stub.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input)
    calls.push(url)
    return respond(url)
  }) as typeof globalThis.fetch
  return { calls }
}

const png = Buffer.from('APPROVED-REFERENCE-BYTES')
const storageOk = () => new Response(png, {
  status: 200, headers: { 'Content-Type': 'image/png' },
})

describe('the deployment source', () => {
  test('with no local file, storage serves the reference', async () => {
    // The production case. A git clone has no reference; this is what makes the
    // deployed module work at all.
    stubStorage(storageOk)
    const result = await loadStudioReference(root())
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.dataUrl, `data:${REFERENCE_MIME};base64,${png.toString('base64')}`)
  })

  test('it is fetched from the private bucket, by name', async () => {
    const { calls } = stubStorage(storageOk)
    await loadStudioReference(root())
    assert.equal(calls.length, 1)
    assert.ok(calls[0].includes(REFERENCE_BUCKET), calls[0])
    assert.ok(calls[0].includes(REFERENCE_OBJECT), calls[0])
  })

  test('a local file wins, and storage is never called', async () => {
    // A developer's checkout must not depend on a network round trip, and a
    // deployment that does ship the file must not pay for one either.
    const { calls } = stubStorage(storageOk)
    const result = await loadStudioReference(root(Buffer.from('LOCAL')))
    assert.equal(result.ok, true)
    assert.equal(calls.length, 0, 'storage must not be consulted when the file is there')
  })

  test('with neither source, it fails and names BOTH', async () => {
    // The failure an operator has to act on. Naming only one sends them to the
    // wrong place.
    stubStorage(() => new Response('nope', { status: 404 }))
    const result = await loadStudioReference(root())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.detail, /studio-reference\.png could not be read/)
    assert.match(result.detail, new RegExp(REFERENCE_BUCKET))
    assert.equal('dataUrl' in result, false, 'a failure must never carry an image')
  })

  test('unconfigured storage says so, rather than looking like a missing object', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const result = await loadStudioReference(root())
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.detail, /storage not configured/)
  })

  test('an unusable LOCAL file reports its own reason, not the storage one', async () => {
    // "empty" tells an operator what to fix; "not found in storage" would send
    // them to the wrong system entirely.
    stubStorage(() => new Response('nope', { status: 404 }))
    const empty = await loadStudioReference(root(Buffer.alloc(0)))
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.reason, 'unreadable')

    resetReferenceCache()
    const big = await loadStudioReference(root(Buffer.alloc(MAX_REFERENCE_BYTES + 1)))
    assert.equal(big.ok, false)
    if (!big.ok) assert.equal(big.reason, 'too_large')
  })

  test('a storage copy is size-checked exactly like a local one', async () => {
    stubStorage(() => new Response(Buffer.alloc(MAX_REFERENCE_BYTES + 1), { status: 200 }))
    const result = await loadStudioReference(root())
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'too_large')
  })

  test('an unreachable storage never throws', async () => {
    stubStorage(() => { throw new Error('network down') })
    const result = await loadStudioReference(root())
    assert.equal(result.ok, false)
  })

  test('no failure detail can carry a key or a signed URL', async () => {
    // Details reach the server log. A bucket path is enough to act on.
    stubStorage(() => new Response('nope', { status: 404 }))
    const result = await loadStudioReference(root())
    assert.equal(result.ok, false)
    if (result.ok) return
    for (const secret of ['stub-service-role-key', 'apikey', 'token', 'Bearer']) {
      assert.ok(!result.detail.includes(secret), result.detail)
    }
  })

  test('referenceSource names which one served it', async () => {
    stubStorage(storageOk)
    assert.equal(await referenceSource(root(Buffer.from('LOCAL'))), 'disk')
    assert.equal(await referenceSource(root()), 'storage')
    stubStorage(() => new Response('nope', { status: 404 }))
    assert.equal(await referenceSource(root()), 'none')
  })
})

describe('the cache is keyed by root', () => {
  test('two roots do not serve each other bytes', async () => {
    // The cache used to ignore its root argument: a second call with a
    // different root returned the FIRST root's reference, which is how an A/B
    // between two references silently compares one reference with itself.
    const a = root(Buffer.from('REFERENCE-A'))
    const b = root(Buffer.from('REFERENCE-B'))
    const first = await loadStudioReference(a)
    const second = await loadStudioReference(b)
    assert.equal(first.ok && second.ok, true)
    if (!first.ok || !second.ok) return
    assert.notEqual(first.dataUrl, second.dataUrl, 'the cache served the wrong root')
  })
})
