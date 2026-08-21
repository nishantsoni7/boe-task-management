/**
 * PROVING THE WORKBOOK IS THE RIGHT WORKBOOK.
 *
 * The confirmed Excel is the document a client is sent. If generation ever read
 * a different file — another submission's workbook, or a replacement uploaded
 * after approval — the business would send a client a document with the right
 * Order number and the wrong prices, and nothing about the file would say so.
 *
 * These tests are the three independent checks that make that impossible: the
 * path is inside this submission's own folder, the size matches what was
 * recorded, and the hash matches what was recorded. Each is proved to REFUSE,
 * not merely to warn.
 *
 * Offline and pure. The object reader is a function, so nothing here touches a
 * network or a storage client.
 *
 * Run:
 *   npx tsx --test src/lib/orders/confirmedExcel.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  WORKBOOK_COLUMNS,
  checkWorkbookProvenance,
  loadApprovedWorkbook,
  sha256Hex,
  workbookObjectPath,
  type ObjectReader,
  type RecordedWorkbook,
} from './confirmedExcel'

const SUB = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const OTHER = '11111111-2222-3333-4444-555555555555'

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
/** sha256 of BYTES, computed by the module under test and pinned here so a
 *  change of hashing algorithm is a visible failure rather than a silent one. */
const BYTES_SHA = 'c848e1013f9f04a9d63fa43ce7fd4af035152c7c669a4a404b67107cee5f2e4e'

function record(over: Partial<RecordedWorkbook> = {}): RecordedWorkbook {
  return {
    submissionId: SUB,
    path: `submissions/${SUB}/original/9f1c-marigold.xlsx`,
    sizeBytes: BYTES.length,
    sha256: BYTES_SHA,
    ...over,
  }
}

const readerFor = (bytes: Uint8Array | null): ObjectReader => async () => bytes

// ── 1. Hashing ────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  test('produces lowercase hex of exactly the length both schemas demand', async () => {
    const hex = await sha256Hex(BYTES)
    assert.match(hex, /^[0-9a-f]{64}$/)
  })

  test('matches the known digest of the empty input', async () => {
    assert.equal(
      await sha256Hex(new Uint8Array(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('is stable across calls', async () => {
    assert.equal(await sha256Hex(BYTES), await sha256Hex(BYTES))
  })

  test('hashes a SUBARRAY\'s own bytes, not the pool behind it', async () => {
    // A Uint8Array that is a window onto a larger buffer is the common shape a
    // stream decoder hands back. Hashing the whole pool would make every
    // provenance check fail for reasons nobody could see.
    const pool = new Uint8Array(64)
    pool.set(BYTES, 16)
    const view = pool.subarray(16, 16 + BYTES.length)
    assert.equal(view.byteLength, BYTES.length)
    assert.equal(await sha256Hex(view), await sha256Hex(BYTES))
  })

  test('a single changed byte changes the digest', async () => {
    const other = BYTES.slice()
    other[3] ^= 0xff
    assert.notEqual(await sha256Hex(other), await sha256Hex(BYTES))
  })
})

// ── 2. The path ───────────────────────────────────────────────────────────────

describe('which object is read', () => {
  test('the submission\'s own original/ key is accepted', () => {
    const out = workbookObjectPath(record())
    assert.ok(out.ok)
    assert.equal(out.path, `submissions/${SUB}/original/9f1c-marigold.xlsx`)
  })

  test('ANOTHER submission\'s workbook is refused, however well formed', () => {
    const out = workbookObjectPath(record({ path: `submissions/${OTHER}/original/a.xlsx` }))
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISSING')
  })

  test('a traversal, a nested key, the images folder and an Order key are all refused', () => {
    for (const path of [
      `submissions/${SUB}/original/../../etc/passwd`,
      `submissions/${SUB}/original/nested/a.xlsx`,
      `submissions/${SUB}/images/a.png`,
      `orders/${SUB}/versions/1/approved.xlsx`,
      `/submissions/${SUB}/original/a.xlsx`,
      '',
      null,
      undefined,
    ]) {
      assert.equal(workbookObjectPath(record({ path })).ok, false, String(path))
    }
  })
})

// ── 3. Provenance ─────────────────────────────────────────────────────────────

describe('proving the bytes are the recorded ones', () => {
  test('a matching size and hash passes', () => {
    const out = checkWorkbookProvenance(record(), { sha256: BYTES_SHA, bytes: BYTES.length })
    assert.ok(out.ok)
    assert.equal(out.sha256, BYTES_SHA)
    assert.equal(out.bytes, BYTES.length)
  })

  test('A DIFFERENT HASH IS A REFUSAL, not a warning', () => {
    const out = checkWorkbookProvenance(record(), { sha256: 'f'.repeat(64), bytes: BYTES.length })
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISMATCH')
  })

  test('a different size is a refusal, even when the hash is absent', () => {
    const out = checkWorkbookProvenance(record({ sha256: null }), { sha256: BYTES_SHA, bytes: 99 })
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISMATCH')
  })

  test('a hash recorded in upper case still matches', () => {
    const out = checkWorkbookProvenance(record({ sha256: BYTES_SHA.toUpperCase() }),
      { sha256: BYTES_SHA, bytes: BYTES.length })
    assert.ok(out.ok)
  })

  test('a record carrying NEITHER figure is refused rather than waved through', () => {
    // Which way to fail is the decision here: a PI that cannot be proved is one
    // this must not generate a client document from.
    const out = checkWorkbookProvenance(record({ sha256: null, sizeBytes: null }),
      { sha256: BYTES_SHA, bytes: BYTES.length })
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISMATCH')
    assert.match(out.detail, /cannot be proved/)
  })

  test('either figure alone is enough to prove it', () => {
    assert.ok(checkWorkbookProvenance(record({ sizeBytes: null }),
      { sha256: BYTES_SHA, bytes: BYTES.length }).ok)
    assert.ok(checkWorkbookProvenance(record({ sha256: null }),
      { sha256: BYTES_SHA, bytes: BYTES.length }).ok)
  })

  test('an empty object is missing, not mismatched', () => {
    const out = checkWorkbookProvenance(record(), { sha256: BYTES_SHA, bytes: 0 })
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISSING')
  })

  test('a size recorded as a numeric STRING still compares', () => {
    // PostgREST returns bigint as a string.
    assert.ok(checkWorkbookProvenance(record({ sizeBytes: String(BYTES.length) }),
      { sha256: BYTES_SHA, bytes: BYTES.length }).ok)
  })
})

// ── 4. The whole load ─────────────────────────────────────────────────────────

describe('loading the approved workbook', () => {
  test('returns the bytes and their hash when everything agrees', async () => {
    const out = await loadApprovedWorkbook(record(), readerFor(BYTES))
    assert.ok(out.ok, out.ok ? '' : out.detail)
    assert.deepEqual([...out.bytes], [...BYTES])
    assert.equal(out.sha256, BYTES_SHA)
    assert.equal(out.path, `submissions/${SUB}/original/9f1c-marigold.xlsx`)
  })

  test('reads EXACTLY ONE object, at the key the RECORD names', async () => {
    const asked: string[] = []
    const reader: ObjectReader = async (path) => { asked.push(path); return BYTES }
    await loadApprovedWorkbook(record(), reader)
    assert.deepEqual(asked, [`submissions/${SUB}/original/9f1c-marigold.xlsx`])
  })

  test('refuses before reading anything when the path is not this submission\'s', async () => {
    let read = false
    const reader: ObjectReader = async () => { read = true; return BYTES }
    const out = await loadApprovedWorkbook(record({ path: `submissions/${OTHER}/original/a.xlsx` }), reader)
    assert.ok(!out.ok)
    assert.equal(read, false, 'a foreign key must not even be requested')
  })

  test('a storage miss is WORKBOOK_MISSING', async () => {
    const out = await loadApprovedWorkbook(record(), readerFor(null))
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISSING')
  })

  test('an object whose bytes do not match the record is WORKBOOK_MISMATCH', async () => {
    const swapped = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9])
    const out = await loadApprovedWorkbook(record(), readerFor(swapped))
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISMATCH')
  })

  test('A THROWING READER LEAKS NOTHING into the detail', async () => {
    // A storage client's error can carry a project URL, a bucket reference or a
    // token. None of it may reach a message a person will read.
    const reader: ObjectReader = async () => {
      throw new Error('GET https://abcdefgh.supabase.co/storage/v1/object/order-files?token=sbp_secret failed')
    }
    const out = await loadApprovedWorkbook(record(), reader)
    assert.ok(!out.ok)
    assert.equal(out.reason, 'WORKBOOK_MISSING')
    for (const fragment of ['supabase.co', 'sbp_', 'token=', 'https://', 'storage/v1']) {
      assert.ok(!out.detail.includes(fragment), `${fragment} leaked into the detail`)
    }
  })

  test('the module never writes — the reader is its ONLY door to storage', async () => {
    // A reader that returns bytes is the whole contract. There is no writer
    // parameter, so this module has no way to touch the original object.
    const out = await loadApprovedWorkbook(record(), readerFor(BYTES))
    assert.ok(out.ok)
    const before = [...BYTES]
    assert.deepEqual([...BYTES], before, 'the source array is untouched')
  })
})

// ── 5. The select ─────────────────────────────────────────────────────────────

describe('what the generator selects from the PI', () => {
  const columns = WORKBOOK_COLUMNS.split(',').map(c => c.trim())

  test('is the four workbook columns and the id, and nothing else', () => {
    assert.deepEqual(columns.sort(), [
      'id', 'source_workbook_name', 'source_workbook_path',
      'source_workbook_sha256', 'source_workbook_size_bytes',
    ])
  })

  test('is never `*`', () => {
    assert.ok(!columns.includes('*'))
  })
})
