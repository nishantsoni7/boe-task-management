/**
 * Order Request attachment SIZE policy.
 *
 * THE RULE THESE TESTS PIN DOWN: nothing above 10 MB is ever STORED. A user may
 * select a larger file, but it must then be reduced below the limit by a safe
 * format-specific processor, or refused. The original oversized bytes must never
 * reach Storage — that is the invariant almost every test here exists to defend.
 *
 * The Supabase project-wide 50 MB ceiling is infrastructure headroom and must
 * never appear as the accepted product size; a test below asserts no message
 * offers it.
 *
 * No DOM is needed. Every case either returns before any canvas work (in-limit,
 * or a non-image) or exercises the guard that makes compression fail closed when
 * canvas is unavailable — which is the situation under `node --test`, and is
 * asserted rather than skipped.
 *
 * Run:
 *   npx tsx --test src/lib/orderRequestAttachmentsSize.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { File as NodeFile } from 'node:buffer'
import {
  prepareAttachment,
  willCompressImage,
  formatBytes,
  ORDER_REQ_ATTACHMENT_MAX_BYTES,
  IMAGE_COMPRESS_TARGET_BYTES,
} from './orderRequestAttachments'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS_MIME  = 'application/vnd.ms-excel'
const PDF_MIME  = 'application/pdf'
const MB = 1024 * 1024

// A File of a given logical size without allocating that many bytes: only .size
// is read by the code paths under test, so a 40 MB case is instant.
function fileOfSize(name: string, type: string, size: number): File {
  const f = new NodeFile(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size, configurable: true })
  return f as unknown as File
}

describe('the limits themselves', () => {
  test('the frontend ceiling is exactly 10 * 1024 * 1024', () => {
    assert.equal(ORDER_REQ_ATTACHMENT_MAX_BYTES, 10 * MB)
    assert.equal(ORDER_REQ_ATTACHMENT_MAX_BYTES, 10485760)
  })

  test('the compression target leaves real overhead below the ceiling', () => {
    assert.equal(IMAGE_COMPRESS_TARGET_BYTES, 8 * MB)
    assert.ok(IMAGE_COMPRESS_TARGET_BYTES < ORDER_REQ_ATTACHMENT_MAX_BYTES)
  })

  test('the ceiling formats as "10 MB" for user-facing messages', () => {
    assert.equal(formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES), '10 MB')
  })
})

describe('the 10 MB boundary is exact', () => {
  test('a file of EXACTLY 10 MB is accepted, unchanged', async () => {
    const f = fileOfSize('pi.xlsx', XLSX_MIME, 10 * MB)
    const r = await prepareAttachment(f, 'main_pi')
    assert.equal(r.ok, true, 'exactly at the limit must be allowed')
    assert.equal(r.ok && r.compressed, false)
    assert.equal(r.ok && r.file, f)
  })

  test('10 MB plus ONE byte is not accepted as-is', async () => {
    const r = await prepareAttachment(fileOfSize('pi.xlsx', XLSX_MIME, 10 * MB + 1), 'main_pi')
    assert.equal(r.ok, false, 'one byte over must not pass through')
  })

  test('10 MB plus one byte on an IMAGE enters processing rather than passing through', () => {
    assert.equal(willCompressImage(fileOfSize('p.jpg', 'image/jpeg', 10 * MB + 1), 'reference'), true)
    assert.equal(willCompressImage(fileOfSize('p.jpg', 'image/jpeg', 10 * MB), 'reference'), false)
  })
})

describe('an oversized original never reaches storage', () => {
  // The single most important property in this file: for every accepted result,
  // the file handed back is within the limit — so what gets uploaded is too.
  const oversized: [string, string][] = [
    ['big.xlsx', XLSX_MIME],
    ['big.xls',  XLS_MIME],
    ['big.pdf',  PDF_MIME],
    ['big.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['big.csv',  'text/csv'],
    ['big.jpg',  'image/jpeg'],
    ['big.png',  'image/png'],
  ]

  for (const [name, type] of oversized) {
    test(`${name} at 25 MB is either reduced or refused — never passed through`, async () => {
      const category = name.endsWith('.xlsx') || name.endsWith('.xls') ? 'main_pi' : 'reference'
      const f = fileOfSize(name, type, 25 * MB)
      const r = await prepareAttachment(f, category)
      if (r.ok) {
        assert.ok(r.finalSize <= ORDER_REQ_ATTACHMENT_MAX_BYTES,
          `${name} was accepted at ${r.finalSize} bytes, over the limit`)
        assert.notEqual(r.file, f, `${name} was accepted as the ORIGINAL oversized file`)
      } else {
        assert.ok(r.error.length > 0)
      }
    })
  }
})

describe('Excel Main PI', () => {
  test('an in-limit .xlsx is stored byte-for-byte (same File object)', async () => {
    const f = fileOfSize('quote sheet.xlsx', XLSX_MIME, 4 * MB)
    const r = await prepareAttachment(f, 'main_pi')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.file, f, 'identity — nothing rebuilt the workbook')
    assert.equal(r.ok && r.contentType, XLSX_MIME)
    assert.equal(r.ok && r.compressed, false)
  })

  test('an in-limit .xls is stored unchanged', async () => {
    const f = fileOfSize('pi.xls', XLS_MIME, 6 * MB)
    const r = await prepareAttachment(f, 'main_pi')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.file, f)
  })

  test('an oversized workbook that cannot be optimised is REFUSED, not uploaded unchanged', async () => {
    // fileOfSize fakes only .size, so the bytes are not a real ZIP: the media
    // optimiser is genuinely entered and genuinely fails. The point of the test
    // is that a failed optimisation refuses rather than falling back to the
    // original oversized bytes.
    const f = fileOfSize('huge.xlsx', XLSX_MIME, 18 * MB)
    const r = await prepareAttachment(f, 'main_pi')
    assert.equal(r.ok, false, 'an oversized workbook must never be accepted unoptimised')
  })

  test('the .xlsx refusal names the 10 MB limit and does not claim IMAGE compression', async () => {
    const r = await prepareAttachment(fileOfSize('huge.xlsx', XLSX_MIME, 18 * MB), 'main_pi')
    const msg = !r.ok ? r.error : ''
    assert.match(msg, /10 MB/)
    assert.match(msg, /could not be safely reduced/i, 'an attempt was made — say so')
    assert.doesNotMatch(msg, /compressed automatically/i, 'that phrasing belongs to images')
    assert.doesNotMatch(msg, /50 MB/)
  })

  test('an oversized legacy .xls is refused with a format-specific message and no optimiser', async () => {
    const r = await prepareAttachment(fileOfSize('legacy.xls', XLS_MIME, 18 * MB), 'main_pi')
    assert.equal(r.ok, false)
    const msg = !r.ok ? r.error : ''
    assert.match(msg, /legacy Excel/i)
    assert.match(msg, /\.xlsx/, 'point at the format that does have a safe path')
    assert.match(msg, /10 MB/)
    assert.doesNotMatch(msg, /50 MB/)
  })

  test('an invalid Main PI type is still rejected regardless of size', async () => {
    assert.equal((await prepareAttachment(fileOfSize('pi.pdf', PDF_MIME, 1 * MB), 'main_pi')).ok, false)
  })
})

describe('images', () => {
  test('an image below the limit is not recompressed', async () => {
    const f = fileOfSize('photo.jpg', 'image/jpeg', 4 * MB)
    assert.equal(willCompressImage(f, 'reference'), false)
    const r = await prepareAttachment(f, 'reference')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.compressed, false)
    assert.equal(r.ok && r.file, f, 'an in-limit image must pass through untouched')
  })

  test('an oversized image is routed to compression', () => {
    for (const [n, t] of [['b.jpg', 'image/jpeg'], ['b.png', 'image/png'], ['b.webp', 'image/webp']] as const) {
      assert.equal(willCompressImage(fileOfSize(n, t, 14 * MB), 'reference'), true, n)
    }
  })

  test('a large NON-image is never routed to image compression', () => {
    assert.equal(willCompressImage(fileOfSize('b.xlsx', XLSX_MIME, 30 * MB), 'main_pi'), false)
    assert.equal(willCompressImage(fileOfSize('b.pdf', PDF_MIME, 30 * MB), 'reference'), false)
  })

  test('an image that cannot be reduced below the limit is REJECTED, not uploaded', async () => {
    // No canvas under node:test, so compressImageToTarget returns null. The file
    // must be refused rather than silently passed through at its original size.
    const r = await prepareAttachment(fileOfSize('huge.jpg', 'image/jpeg', 20 * MB), 'reference')
    assert.equal(r.ok, false, 'an unprocessable oversized image must not be accepted')
    assert.match(!r.ok ? r.error : '', /could not be brought under 10 MB/i)
  })

  test('the image failure message is honest that compression WAS attempted', async () => {
    const r = await prepareAttachment(fileOfSize('huge.jpg', 'image/jpeg', 20 * MB), 'reference')
    assert.match(!r.ok ? r.error : '', /compressed automatically/i)
  })
})

describe('non-image references over the limit', () => {
  for (const [name, type] of [
    ['drawing.pdf', PDF_MIME],
    ['specs.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['data.csv',  'text/csv'],
  ] as const) {
    test(`${name} at 12 MB is refused with the real limit named`, async () => {
      const r = await prepareAttachment(fileOfSize(name, type, 12 * MB), 'reference')
      assert.equal(r.ok, false)
      assert.match(!r.ok ? r.error : '', /10 MB/)
    })
  }

  test('in-limit non-images are stored unchanged', async () => {
    const f = fileOfSize('drawing.pdf', PDF_MIME, 9 * MB)
    const r = await prepareAttachment(f, 'reference')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.file, f)
    assert.equal(r.ok && r.compressed, false)
  })
})

describe('no message may advertise the infrastructure ceiling', () => {
  test('no refusal mentions 50 MB', async () => {
    const cases: Promise<unknown>[] = [
      prepareAttachment(fileOfSize('a.xlsx', XLSX_MIME, 60 * MB), 'main_pi'),
      prepareAttachment(fileOfSize('a.pdf',  PDF_MIME,  60 * MB), 'reference'),
      prepareAttachment(fileOfSize('a.jpg',  'image/jpeg', 60 * MB), 'reference'),
      prepareAttachment(fileOfSize('a.csv',  'text/csv', 60 * MB), 'reference'),
    ]
    for (const p of cases) {
      const r = await p as { ok: boolean; error?: string }
      assert.equal(r.ok, false)
      assert.doesNotMatch(r.error ?? '', /50 MB|52428800/,
        'the project-wide ceiling must never be offered as the allowed size')
    }
  })
})

describe('empty files', () => {
  test('a zero-byte file is refused before anything else', async () => {
    const r = await prepareAttachment(fileOfSize('empty.xlsx', XLSX_MIME, 0), 'main_pi')
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /empty/i)
  })
})

describe('formatBytes', () => {
  test('whole numbers carry no trailing .0', () => {
    assert.equal(formatBytes(10 * MB), '10 MB')
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1536), '1.5 KB')
  })
})
