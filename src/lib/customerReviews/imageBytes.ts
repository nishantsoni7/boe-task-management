// WHAT THE FILE ACTUALLY IS, decided from its bytes.
//
// WHY THIS EXISTS
// ---------------
// Everything a browser says about an upload is a claim: `file.type` is chosen by
// the browser from the extension, and the extension is chosen by whoever named
// the file. The first cut of this module stored `mime_type` and `byte_size`
// straight from those claims, which meant a caller could record "image/png,
// 100 bytes" for three megabytes of something else. The bucket's own
// allowed_mime_types was the only real gate, and it checks the Content-Type of
// the upload request — another claim.
//
// This module reads the bytes.
//
// THE PROPERTY THAT MAKES IT WORTH HAVING: the container must account for the
// WHOLE FILE. A JPEG must end at its EOI marker, a PNG at its IEND chunk, and a
// WEBP's RIFF header must declare the exact length it was given. That is what
// rejects a polyglot — a valid image with a ZIP, a script or a second file
// appended to it — rather than merely rejecting a wrong extension.
//
// NO DEPENDENCIES, ON PURPOSE. `sharp` is in this repository and is used for
// rendering, but libvips is not reliably present in every environment here (see
// the /_next/image note in the project notes), and a validator that fails open
// or fails hard depending on a native library is not a validator. Parsing three
// well-documented container formats is fifty lines and is deterministic
// everywhere, which is what a security boundary needs.
//
// PURE. No node imports, no I/O, no clock. Every branch is unit-testable with a
// handful of bytes.

export const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number]

/**
 * Why a file was refused.
 *
 * A CLOSED SET of codes, not a message. The route turns these into sentences;
 * nothing here ever quotes the filename or a byte of the content, so a rejection
 * cannot carry the thing it rejected into a log or a response.
 */
export type ImageRejection =
  | 'empty'
  | 'too_large'
  | 'unknown_format'
  | 'truncated'
  | 'malformed'
  | 'trailing_data'
  | 'bad_dimensions'

export type ImageInspection =
  | { ok: true; mime: SupportedImageMime; width: number; height: number }
  | { ok: false; reason: ImageRejection }

const reject = (reason: ImageRejection): ImageInspection => ({ ok: false, reason })

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean => {
  if (bytes.length < at + signature.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[at + i] !== signature[i]) return false
  }
  return true
}

const ascii = (bytes: Uint8Array, at: number, length: number): string => {
  let out = ''
  for (let i = at; i < at + length && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i])
  return out
}

const readU32BE = (b: Uint8Array, at: number) =>
  ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]

const readU32LE = (b: Uint8Array, at: number) =>
  b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0)

const readU16BE = (b: Uint8Array, at: number) => (b[at] << 8) + b[at + 1]

// ── PNG ───────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/**
 * A PNG is its 8-byte signature, an IHDR chunk that must come FIRST, and an IEND
 * chunk that must come LAST. Requiring IEND to close the file is what refuses a
 * PNG with anything appended to it.
 */
function inspectPng(bytes: Uint8Array): ImageInspection {
  // signature + IHDR length + 'IHDR' + 13 bytes + CRC = 8 + 4 + 4 + 13 + 4
  if (bytes.length < 33) return reject('truncated')
  if (readU32BE(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return reject('malformed')

  const width = readU32BE(bytes, 16)
  const height = readU32BE(bytes, 20)
  if (width <= 0 || height <= 0) return reject('bad_dimensions')

  const bitDepth = bytes[24]
  const colorType = bytes[25]
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return reject('malformed')
  if (![0, 2, 3, 4, 6].includes(colorType)) return reject('malformed')

  // IEND is a zero-length chunk: 00 00 00 00 'IEND' + 4-byte CRC. The file must
  // end on it, so appended data is trailing data rather than "a valid PNG".
  const end = bytes.length - 12
  if (end < 33) return reject('truncated')
  if (readU32BE(bytes, end) !== 0 || ascii(bytes, end + 4, 4) !== 'IEND') {
    // An IEND somewhere earlier means the image closed and something was stuck
    // on after it; no IEND at all means the file never finished arriving. The
    // distinction is only for the sentence the employee reads — both refuse.
    return hasChunk(bytes, 'IEND') ? reject('trailing_data') : reject('truncated')
  }

  return { ok: true, mime: 'image/png', width, height }
}

/** Whether a four-character chunk name appears anywhere after the signature. */
function hasChunk(bytes: Uint8Array, name: string): boolean {
  for (let i = 8; i + 4 <= bytes.length; i += 1) {
    if (ascii(bytes, i, 4) === name) return true
  }
  return false
}

// ── JPEG ──────────────────────────────────────────────────────────────────────

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

/**
 * A JPEG is SOI, a run of segments, and EOI. Dimensions come from whichever
 * Start-Of-Frame marker appears; the file must END on FFD9, which is what
 * refuses the classic JPEG-with-a-ZIP-appended polyglot.
 */
function inspectJpeg(bytes: Uint8Array): ImageInspection {
  if (bytes.length < 4) return reject('truncated')

  const endsOnEoi = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9

  let width = 0
  let height = 0
  let offset = 2

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return reject('malformed')

    let marker = bytes[offset + 1]
    // Fill bytes: any number of 0xFF may precede a marker.
    let cursor = offset + 1
    while (marker === 0xff && cursor + 1 < bytes.length) {
      cursor += 1
      marker = bytes[cursor]
    }

    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset = cursor + 1
      continue
    }
    if (marker === 0xd9) break // EOI
    if (marker === 0xda) break // SOS — entropy-coded data follows; stop parsing.

    if (cursor + 3 >= bytes.length) return reject('truncated')
    const length = readU16BE(bytes, cursor + 1)
    if (length < 2) return reject('malformed')

    if (SOF_MARKERS.has(marker)) {
      if (cursor + 8 >= bytes.length) return reject('truncated')
      height = readU16BE(bytes, cursor + 4)
      width = readU16BE(bytes, cursor + 6)
    }

    offset = cursor + 1 + length
  }

  if (width <= 0 || height <= 0) {
    return endsOnEoi ? reject('bad_dimensions') : reject('truncated')
  }
  if (!endsOnEoi) return reject('trailing_data')

  return { ok: true, mime: 'image/jpeg', width, height }
}

// ── WEBP ──────────────────────────────────────────────────────────────────────

/**
 * A WEBP is a RIFF container. The size field at offset 4 declares the payload
 * length, and it must describe THIS file exactly — that single check is what
 * rejects appended data, and it is why the format is worth accepting at all.
 */
function inspectWebp(bytes: Uint8Array): ImageInspection {
  if (bytes.length < 30) return reject('truncated')
  if (ascii(bytes, 8, 4) !== 'WEBP') return reject('malformed')

  const declared = readU32LE(bytes, 4)
  const actual = bytes.length - 8
  // RIFF pads odd-length payloads to even; anything else is data the container
  // does not account for.
  if (declared !== actual && declared !== actual - 1) {
    return declared > actual ? reject('truncated') : reject('trailing_data')
  }

  const chunk = ascii(bytes, 12, 4)
  let width = 0
  let height = 0

  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte start code, then width and height as little-endian pairs
    // with 14 significant bits each.
    if (bytes.length < 30) return reject('truncated')
    width = (bytes[26] | (bytes[27] << 8)) & 0x3fff
    height = (bytes[28] | (bytes[29] << 8)) & 0x3fff
  } else if (chunk === 'VP8L') {
    if (bytes.length < 25) return reject('truncated')
    if (bytes[20] !== 0x2f) return reject('malformed')
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    width = (bits & 0x3fff) + 1
    height = ((bits >> 14) & 0x3fff) + 1
  } else if (chunk === 'VP8X') {
    if (bytes.length < 30) return reject('truncated')
    width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
  } else {
    return reject('malformed')
  }

  if (width <= 0 || height <= 0) return reject('bad_dimensions')
  return { ok: true, mime: 'image/webp', width, height }
}

// ── The one entry point ───────────────────────────────────────────────────────

/**
 * What these bytes actually are.
 *
 * `maxBytes` is checked here as well as by the caller so the function is safe to
 * use on its own; the route still checks before reading a stream into memory.
 *
 * A file whose signature matches nothing supported is `unknown_format` — the
 * same answer for a PDF, a ZIP, an executable and an HTML page, because the
 * caller has no business knowing which it was.
 */
export function inspectImageBytes(bytes: Uint8Array, maxBytes: number): ImageInspection {
  if (bytes.length === 0) return reject('empty')
  if (bytes.length > maxBytes) return reject('too_large')

  if (startsWith(bytes, PNG_SIGNATURE)) return inspectPng(bytes)
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return inspectJpeg(bytes)
  if (ascii(bytes, 0, 4) === 'RIFF') return inspectWebp(bytes)

  return reject('unknown_format')
}

/**
 * The sentence an employee sees. One per code, prewritten — an allow-list, so a
 * rejection can never contribute text of its own to a response.
 */
export const IMAGE_REJECTION_MESSAGES: Record<ImageRejection, string> = {
  empty:          'That file is empty.',
  too_large:      'Each photo must be under 5 MB.',
  unknown_format: 'Only JPG, PNG or WEBP images can be attached.',
  truncated:      'That image is incomplete — it may not have finished copying.',
  malformed:      'That image could not be read.',
  trailing_data:  'That file has extra data after the image and was not accepted.',
  bad_dimensions: 'That image could not be read.',
}
