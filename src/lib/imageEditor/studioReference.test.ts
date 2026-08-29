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
  loadStudioReference, resetReferenceCache, REFERENCE_PATH, REFERENCE_MIME, MAX_REFERENCE_BYTES,
} from './studioReference'

afterEach(() => resetReferenceCache())

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
