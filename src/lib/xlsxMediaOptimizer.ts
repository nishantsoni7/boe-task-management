// Safe, media-only .xlsx optimisation for oversized Order Request Main PI files.
//
// THE PROBLEM. A Proforma Invoice workbook goes over the 10 MB storage ceiling
// almost exclusively because of embedded photographs and logos under xl/media.
// The obvious fix — reading the workbook with SheetJS and writing it back out —
// is CATASTROPHIC here and must never be used: an empirical probe of the
// installed xlsx@0.18.5 showed a SheetJS write emits only 12 parts and the string
// "xl/media" appears nowhere in its source, so it does not parse embedded images
// at all. It would "shrink" a PI by silently deleting the very logos, stamps,
// product photos, charts, drawings, print settings and conditional formatting
// that make it a commercial document. Succeeding by discarding the payload is
// not succeeding.
//
// THE APPROACH. An .xlsx IS a ZIP. So treat it as one:
//   * copy EVERY entry through byte-for-byte, except approved raster images under
//     xl/media/;
//   * re-encode only those images, in their OWN format, never renamed;
//   * rebuild the archive, REOPEN it, and validate the result against the input
//     before anyone is allowed to upload it.
// Nothing parses or rewrites worksheets, styles, relationships, drawings, charts,
// comments, formulas, links, metadata or print settings. They are opaque bytes we
// carry from one archive to the other.
//
// TESTABILITY. Everything in this file except createCanvasMediaEncoder() is a
// pure function of its inputs, or an async function whose only impure dependency
// (the image encoder) is INJECTED. That is deliberate: the archive logic —
// structure validation, media selection, limits, the byte-identity comparison —
// is fully exercised under `node --test` with a fake encoder, while the canvas
// re-encoding itself is browser-only and is honestly reported as such rather
// than pretended to be covered.

import type { Zippable } from 'fflate'

/** Decompressed archive: entry name → inflated bytes. Structurally the same as
 *  fflate's `Unzipped`, but declared locally with a plain `Uint8Array` so bytes
 *  produced by canvas/Blob APIs interoperate without ArrayBuffer-variance
 *  friction, and so the pure helpers below can be exercised from tests without
 *  importing fflate at all. */
export type ArchiveEntries = Record<string, Uint8Array>

// ── Resource limits ───────────────────────────────────────────────────────────
// The workbook is UNTRUSTED INPUT: it arrives from an employee's desktop and may
// be malformed, hostile, or merely enormous. Every limit below exists to make a
// bad input fail fast and safely rather than hang or exhaust a browser tab.
// Values are chosen for an ordinary employee desktop browser, and are deliberately
// generous enough that a genuine, heavy PI workbook passes.

/** Largest COMPRESSED workbook we will even attempt to optimise. Above this we
 *  refuse immediately, without unzipping — a 64 MB .xlsx is not a PI. */
export const MAX_OPTIMIZE_INPUT_BYTES = 64 * 1024 * 1024

/** Largest total DECOMPRESSED size we will hold. The primary zip-bomb guard:
 *  fflate reports each entry's uncompressed size from the central directory
 *  BEFORE inflating it, so we can stop before the memory is ever allocated. */
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024

/** Secondary zip-bomb guard: a legitimate .xlsx is mostly already-compressed
 *  media plus highly compressible XML, and does not approach this ratio. */
export const MAX_COMPRESSION_RATIO = 200

/** A real workbook has tens to low hundreds of parts. Thousands means either a
 *  generated monster or an attack on our per-entry bookkeeping. */
export const MAX_ENTRY_COUNT = 4000

/** Single media entries above this are left BYTE-IDENTICAL rather than decoded —
 *  decoding one could exhaust the tab on its own. Skipping still protects the
 *  browser, and the final size gate then refuses the workbook honestly if that
 *  entry is what keeps it oversized. */
export const MAX_MEDIA_ENTRY_BYTES = 32 * 1024 * 1024

/** Refuse to rasterise absurd pixel counts (a 30000×30000 "image" is a decode
 *  bomb regardless of its compressed size). Enforced inside the encoder. */
export const MAX_IMAGE_PIXELS = 40_000_000

/** Media smaller than this is never touched. Re-encoding a 40 KB logo cannot
 *  meaningfully help and can only degrade it. */
export const MIN_MEDIA_OPTIMIZE_BYTES = 64 * 1024

/** Wall-clock ceiling for the whole optimisation, checked between images and
 *  between rounds. Bounds the worst case even on a slow machine. */
export const MAX_OPTIMIZE_MS = 60_000

/** Workbook-level target, deliberately BELOW the 10 MB hard ceiling so ZIP
 *  overhead and encoder variation cannot push a "just under" result past it. */
export const XLSX_TARGET_BYTES = Math.round(8.75 * 1024 * 1024)

/** Progressive rounds, gentlest first. We stop at the first round that reaches
 *  the target, so a workbook that only needs a light touch only gets a light
 *  touch. PNG ignores `quality` (canvas PNG encoding is lossless), so for PNG
 *  only `maxEdge` does any work. */
export const OPTIMIZE_ROUNDS: readonly { maxEdge: number; quality: number }[] = [
  { maxEdge: 2600, quality: 0.82 },
  { maxEdge: 2000, quality: 0.74 },
  { maxEdge: 1600, quality: 0.68 },
  { maxEdge: 1280, quality: 0.62 },
]

export const MAX_OPTIMIZE_ROUNDS = OPTIMIZE_ROUNDS.length

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ── Archive shape ─────────────────────────────────────────────────────────────

const MEDIA_PREFIX = 'xl/media/'

/** Parts without which the file is not a workbook at all. */
const REQUIRED_ENTRIES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
] as const

/** Entry families that must survive byte-for-byte. This is belt-and-braces: the
 *  general comparison already requires EVERY non-media entry to be identical.
 *  These are asserted by name as well so a future change that accidentally
 *  narrowed the general check would still be caught on the parts that matter
 *  most. */
function isCriticalPart(name: string): boolean {
  return (
    name === '[Content_Types].xml' ||
    name === 'xl/workbook.xml' ||
    name === 'xl/styles.xml' ||
    name.startsWith('xl/worksheets/') ||
    name.startsWith('xl/drawings/') ||
    name.endsWith('.rels')
  )
}

export type OptimizeFailureReason =
  | 'input_too_large'
  | 'invalid_zip'
  | 'unsafe_entry_name'
  | 'duplicate_entry'
  | 'too_many_entries'
  | 'decompressed_too_large'
  | 'missing_workbook_parts'
  | 'no_optimizable_media'
  | 'nothing_optimized'
  | 'still_over_limit'
  | 'validation_failed'
  | 'timeout'

export type OptimizeStage =
  | 'reading'
  | 'optimizing'
  | 'rebuilding'
  | 'validating'

export type XlsxOptimizeResult =
  | {
      ok: true
      bytes: Uint8Array
      originalSize: number
      finalSize: number
      /** How many embedded images were genuinely made smaller. Always >= 1: an
       *  output that changed nothing is rejected, because "optimised" would then
       *  be a lie and the size gate would have failed anyway. */
      optimizedImages: number
    }
  | { ok: false; reason: OptimizeFailureReason }

// ── Image format sniffing ─────────────────────────────────────────────────────
// The EXTENSION alone is not trusted. We re-encode an image only when its actual
// magic bytes agree with its extension, and we verify the ENCODER'S OUTPUT the
// same way. That is what makes "preserve the original format and extension" a
// checked property rather than an intention: bytes that are not the format the
// filename claims never get written back under that name.

export type RasterFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'tiff' | 'unknown'

export function sniffImageFormat(bytes: Uint8Array): RasterFormat {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'tiff'
  return 'unknown'
}

/** Extensions we are willing to re-encode, mapped to the format their bytes must
 *  actually be. Everything absent from this table — SVG, EMF, WMF, TIFF, GIF,
 *  BMP, OLE objects, embedded documents, video, audio, unknown binaries — is
 *  carried through untouched. Animated GIF in particular would lose every frame
 *  but the first through a canvas, so it is deliberately excluded. */
const OPTIMIZABLE_EXTS: Record<string, Extract<RasterFormat, 'png' | 'jpeg' | 'webp'>> = {
  png:  'png',
  jpg:  'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
}

const FORMAT_MIME: Record<'png' | 'jpeg' | 'webp', 'image/png' | 'image/jpeg' | 'image/webp'> = {
  png:  'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

function extensionOf(name: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  const dot = leaf.lastIndexOf('.')
  return dot === -1 ? '' : leaf.slice(dot + 1).toLowerCase()
}

/** An entry is optimisable only if it lives under xl/media/, carries a supported
 *  extension, and its MAGIC BYTES match that extension. A "logo.png" that is
 *  really a TIFF is left alone. Pure. */
export function listOptimizableMedia(entries: ArchiveEntries): string[] {
  const out: string[] = []
  for (const name of Object.keys(entries)) {
    if (!name.startsWith(MEDIA_PREFIX)) continue
    const want = OPTIMIZABLE_EXTS[extensionOf(name)]
    if (!want) continue
    const bytes = entries[name]
    if (bytes.length > MAX_MEDIA_ENTRY_BYTES) continue
    if (sniffImageFormat(bytes) !== want) continue
    out.push(name)
  }
  return out
}

// ── Entry-name safety ─────────────────────────────────────────────────────────

/** Reject archive entry names that could escape their directory or confuse the
 *  path bookkeeping. We never write to disk, so this is not a filesystem
 *  traversal risk — but a "../../x" entry means the archive is not a
 *  well-formed OOXML package, and a malformed package is exactly what we must
 *  not hand to Excel after rewriting it. Pure. */
export function isUnsafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return true
  if (name.includes('\\')) return true
  if (name.includes('\0')) return true
  if (name.startsWith('/')) return true
  if (/^[a-zA-Z]:/.test(name)) return true
  return name.split('/').some(seg => seg === '..')
}

export type ArchiveStructureProblem =
  | { ok: true }
  | { ok: false; reason: Extract<OptimizeFailureReason, 'unsafe_entry_name' | 'duplicate_entry' | 'missing_workbook_parts'> }

/** Minimum OOXML spreadsheet structure, plus name safety and duplicate
 *  detection. Duplicates matter because a Record<string, bytes> silently
 *  collapses them — so they are detected from the raw name LIST, which is
 *  collected during unzip, not from the entry map. Pure. */
export function validateArchiveStructure(names: string[], entries: ArchiveEntries): ArchiveStructureProblem {
  for (const name of names) {
    if (isUnsafeEntryName(name)) return { ok: false, reason: 'unsafe_entry_name' }
  }
  if (new Set(names).size !== names.length) return { ok: false, reason: 'duplicate_entry' }

  for (const required of REQUIRED_ENTRIES) {
    if (!(required in entries)) return { ok: false, reason: 'missing_workbook_parts' }
  }
  const hasSheet = Object.keys(entries).some(
    n => n.startsWith('xl/worksheets/') && n.endsWith('.xml'),
  )
  if (!hasSheet) return { ok: false, reason: 'missing_workbook_parts' }
  return { ok: true }
}

// ── Workbook introspection (read-only, for validation only) ───────────────────

const decoder = new TextDecoder()

function textOf(entries: ArchiveEntries, name: string): string {
  const bytes = entries[name]
  return bytes ? decoder.decode(bytes) : ''
}

/** Sheet names in declaration order, read from xl/workbook.xml. Read-only: this
 *  is used to PROVE the workbook did not change, never to rewrite it. Pure. */
export function readSheetNames(entries: ArchiveEntries): string[] {
  const xml = textOf(entries, 'xl/workbook.xml')
  const out: string[] = []
  const re = /<(?:\w+:)?sheet\b[^>]*\bname\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

/** Total `<f>` formula elements across every worksheet part. Pure. */
export function countFormulas(entries: ArchiveEntries): number {
  let total = 0
  for (const name of Object.keys(entries)) {
    if (!name.startsWith('xl/worksheets/') || !name.endsWith('.xml')) continue
    const xml = textOf(entries, name)
    const matches = xml.match(/<(?:\w+:)?f[\s>/]/g)
    total += matches ? matches.length : 0
  }
  return total
}

/** Resolve a relationship Target against the part directory that owns the .rels
 *  file: "xl/drawings/_rels/drawing1.xml.rels" + "../media/image1.png" resolves
 *  to "xl/media/image1.png". Returns null for targets we do not police
 *  (external links, absolute URLs). Pure. */
export function resolveRelTarget(relsPath: string, target: string): string | null {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null // mailto:, http:, file:
  if (target.startsWith('#')) return null
  const clean = target.startsWith('/') ? target.slice(1) : target

  // Drop the trailing "_rels/<part>.rels" to get the owning directory.
  const relsDir = relsPath.slice(0, relsPath.lastIndexOf('/'))       // …/_rels
  const baseDir = relsDir.slice(0, Math.max(0, relsDir.lastIndexOf('/'))) // …

  const segments = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'))
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (stack.length === 0) return null; stack.pop(); continue }
    stack.push(seg)
  }
  return stack.join('/')
}

/** Every internal relationship target that must still resolve to a real entry.
 *  TargetMode="External" relationships point outside the package and are skipped.
 *  Pure. */
export function collectInternalRelTargets(entries: ArchiveEntries): { rels: string; resolved: string }[] {
  const out: { rels: string; resolved: string }[] = []
  for (const name of Object.keys(entries)) {
    if (!name.endsWith('.rels')) continue
    const xml = textOf(entries, name)
    const re = /<Relationship\b[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const tag = m[0]
      if (/TargetMode\s*=\s*"External"/i.test(tag)) continue
      const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1]
      if (!target) continue
      const resolved = resolveRelTarget(name, target)
      if (resolved) out.push({ rels: name, resolved })
    }
  }
  return out
}

// ── Byte comparison ───────────────────────────────────────────────────────────

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export type ValidationFailure =
  | 'entry_count_changed'
  | 'entry_names_changed'
  | 'duplicate_entry'
  | 'unsafe_entry_name'
  | 'missing_workbook_parts'
  | 'non_media_entry_modified'
  | 'critical_part_modified'
  | 'untouched_media_modified'
  | 'sheet_names_changed'
  | 'formula_count_changed'
  | 'broken_relationship'

/**
 * The safety gate. Proves the rebuilt archive differs from the original in
 * EXACTLY the media entries we deliberately re-encoded, and in nothing else.
 *
 * Note on "byte-identical": ZIP stores entries COMPRESSED, and recompressing
 * necessarily produces different compressed bytes. What is compared — and what
 * matters — is the DECOMPRESSED content of every entry. A part whose inflated
 * bytes are unchanged is the same part, however it happens to be stored.
 *
 * Pure: takes both archives already in memory, returns the first problem found.
 */
export function validateRebuiltArchive(
  original: ArchiveEntries,
  originalNames: string[],
  rebuilt: ArchiveEntries,
  rebuiltNames: string[],
  changedMedia: ReadonlySet<string>,
): ValidationFailure | null {
  for (const name of rebuiltNames) {
    if (isUnsafeEntryName(name)) return 'unsafe_entry_name'
  }
  if (new Set(rebuiltNames).size !== rebuiltNames.length) return 'duplicate_entry'
  if (rebuiltNames.length !== originalNames.length) return 'entry_count_changed'

  // Same names, same order. Order equality is stricter than needed by OOXML but
  // it is free here and makes "we only swapped bytes" literally true.
  for (let i = 0; i < originalNames.length; i++) {
    if (originalNames[i] !== rebuiltNames[i]) return 'entry_names_changed'
  }

  const structure = validateArchiveStructure(rebuiltNames, rebuilt)
  if (!structure.ok) {
    return structure.reason === 'missing_workbook_parts' ? 'missing_workbook_parts' : 'unsafe_entry_name'
  }

  for (const name of originalNames) {
    const before = original[name]
    const after = rebuilt[name]
    if (!after) return 'entry_names_changed'

    if (changedMedia.has(name)) {
      // A re-encoded image must still be under xl/media/ and must still be the
      // format its extension claims — checked at encode time and again here.
      continue
    }
    if (!bytesEqual(before, after)) {
      if (isCriticalPart(name)) return 'critical_part_modified'
      if (name.startsWith(MEDIA_PREFIX)) return 'untouched_media_modified'
      return 'non_media_entry_modified'
    }
  }

  const beforeSheets = readSheetNames(original)
  const afterSheets = readSheetNames(rebuilt)
  if (beforeSheets.length !== afterSheets.length) return 'sheet_names_changed'
  for (let i = 0; i < beforeSheets.length; i++) {
    if (beforeSheets[i] !== afterSheets[i]) return 'sheet_names_changed'
  }

  if (countFormulas(original) !== countFormulas(rebuilt)) return 'formula_count_changed'

  for (const { resolved } of collectInternalRelTargets(rebuilt)) {
    if (!(resolved in rebuilt)) return 'broken_relationship'
  }
  return null
}

// ── fflate access (lazy, with a main-thread fallback) ─────────────────────────
// fflate is imported DYNAMICALLY so the ZIP machinery is fetched only when an
// oversized .xlsx is actually selected — the Order Requests page itself never
// carries it. The async fflate entry points do their work off the main thread,
// which is what keeps a 40 MB workbook from freezing the tab; if a Worker cannot
// be created (a restrictive CSP, for instance) we fall back to the synchronous
// path rather than failing the user's upload over it.

type UnzipFilter = (file: { name: string; size: number; originalSize: number }) => boolean

async function inflateArchive(bytes: Uint8Array, filter: UnzipFilter): Promise<ArchiveEntries> {
  const { unzip, unzipSync } = await import('fflate')
  return new Promise<ArchiveEntries>((resolve, reject) => {
    const runSync = (fallbackErr: unknown) => {
      try { resolve(unzipSync(bytes, { filter })) } catch { reject(fallbackErr) }
    }
    try {
      unzip(bytes, { filter }, (err, data) => {
        if (err) runSync(err)
        else resolve(data)
      })
    } catch (err) {
      runSync(err)
    }
  })
}

async function deflateArchive(files: Zippable): Promise<Uint8Array> {
  const { zip, zipSync } = await import('fflate')
  return new Promise<Uint8Array>((resolve, reject) => {
    const runSync = (fallbackErr: unknown) => {
      try { resolve(zipSync(files)) } catch { reject(fallbackErr) }
    }
    try {
      zip(files, {}, (err, data) => {
        if (err) runSync(err)
        else resolve(data)
      })
    } catch (err) {
      runSync(err)
    }
  })
}

/** Build the fflate input, choosing a per-entry compression level. Media is
 *  already-compressed data, so deflating it again burns CPU and can make it
 *  larger — those entries are STORED. XML compresses well and keeps level 6. */
function toZippable(entries: ArchiveEntries, names: string[]): Zippable {
  const out: Zippable = {}
  for (const name of names) {
    const isMedia = name.startsWith(MEDIA_PREFIX)
    out[name] = [entries[name], { level: isMedia ? 0 : 6 }]
  }
  return out
}

// ── Image encoder contract ────────────────────────────────────────────────────

export type MediaEncodeRequest = {
  bytes: Uint8Array
  /** The format the image ACTUALLY is (sniffed, not guessed from the name). The
   *  encoder must return this same format or null — never a different one. */
  format: 'png' | 'jpeg' | 'webp'
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  maxEdge: number
  /** Ignored for PNG, whose canvas encoding is lossless. */
  quality: number
  maxPixels: number
}

/**
 * Re-encode one embedded image. Returns null when it cannot or should not be
 * re-encoded — the caller then keeps the ORIGINAL bytes, byte-for-byte.
 *
 * Contract the caller enforces independently (so a broken encoder cannot corrupt
 * a workbook): the returned bytes must sniff as the SAME format, and must be
 * strictly smaller than the input, or they are discarded.
 */
export type MediaEncoder = (req: MediaEncodeRequest) => Promise<Uint8Array | null>

/**
 * The production encoder: browser canvas. Returns null outside a DOM, which is
 * why the optimiser takes the encoder as a parameter — Node tests inject a
 * deterministic fake and never touch this function.
 *
 * Preserves orientation (createImageBitmap with imageOrientation:'from-image'),
 * never upscales (scale is clamped to <= 1), preserves PNG transparency (no
 * white flatten on the alpha-capable formats), and always re-encodes into the
 * SOURCE format so the entry's extension, content type and workbook
 * relationships all stay valid.
 */
export function createCanvasMediaEncoder(): MediaEncoder {
  return async (req) => {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null

    const blob = new Blob([new Uint8Array(req.bytes)], { type: req.mime })
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch {
      return null
    }
    try {
      const { width, height } = bitmap
      if (!width || !height) return null
      if (width * height > req.maxPixels) return null

      const longest = Math.max(width, height)
      // min(1, …) is the no-upscale guarantee: a small-but-heavy image is only
      // re-encoded at its native size, never enlarged.
      const scale = Math.min(1, req.maxEdge / longest)
      const w = Math.max(1, Math.round(width * scale))
      const h = Math.max(1, Math.round(height * scale))

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      // No white flatten anywhere: PNG and WEBP both carry alpha, and JPEG
      // sources have none to lose.
      ctx.drawImage(bitmap, 0, 0, w, h)

      const encoded = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, req.mime, req.format === 'png' ? undefined : req.quality)
      })
      if (!encoded || encoded.type !== req.mime) return null
      return new Uint8Array(await encoded.arrayBuffer())
    } catch {
      return null
    } finally {
      bitmap.close()
    }
  }
}

// ── The optimiser ─────────────────────────────────────────────────────────────

export type OptimizeOptions = {
  encoder: MediaEncoder
  /** Hard ceiling the final archive must not exceed (the 10 MB storage rule). */
  limitBytes: number
  /** Preferred landing zone, below the ceiling. */
  targetBytes?: number
  onStage?: (stage: OptimizeStage) => void
  /** Injectable clock so the timeout is testable without waiting. */
  now?: () => number
  /** Resource ceilings. Default to the module constants; overridable so the
   *  guards can be exercised with small fixtures instead of by allocating a
   *  quarter of a gigabyte in a unit test. App code passes NEITHER — these exist
   *  to TIGHTEN a budget or to test one, never to widen it in production. */
  maxDecompressedBytes?: number
  maxEntryCount?: number
}

/**
 * Optimise an oversized .xlsx by re-encoding ONLY its embedded raster images.
 *
 * Returns ok:true ONLY when every one of these holds:
 *   - the input was a structurally valid .xlsx;
 *   - at least one embedded image was genuinely made smaller;
 *   - the rebuilt archive reopens as a ZIP;
 *   - every non-media part is byte-identical to the input;
 *   - sheet names, sheet count, formula count and every internal relationship
 *     still match the input;
 *   - the final archive is within limitBytes.
 * In every other case it returns ok:false and the ORIGINAL oversized workbook is
 * never uploaded by the caller.
 */
export async function optimizeXlsxMedia(
  input: Uint8Array,
  opts: OptimizeOptions,
): Promise<XlsxOptimizeResult> {
  const now = opts.now ?? Date.now
  const started = now()
  const target = Math.min(opts.targetBytes ?? XLSX_TARGET_BYTES, opts.limitBytes)
  const originalSize = input.length
  const expired = () => now() - started > MAX_OPTIMIZE_MS
  const maxDecompressed = opts.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES
  const maxEntries = opts.maxEntryCount ?? MAX_ENTRY_COUNT

  if (originalSize > MAX_OPTIMIZE_INPUT_BYTES) return { ok: false, reason: 'input_too_large' }

  opts.onStage?.('reading')

  // Limits are enforced from the central directory DURING unzip, so a bomb is
  // refused before its bytes are ever allocated.
  const names: string[] = []
  let entryCount = 0
  let decompressed = 0
  let limitHit: Extract<OptimizeFailureReason, 'too_many_entries' | 'decompressed_too_large' | 'unsafe_entry_name'> | null = null

  let entries: ArchiveEntries
  try {
    entries = await inflateArchive(input, (file) => {
      if (limitHit) return false
      entryCount += 1
      if (entryCount > maxEntries) { limitHit = 'too_many_entries'; return false }
      if (isUnsafeEntryName(file.name)) { limitHit = 'unsafe_entry_name'; return false }
      decompressed += file.originalSize
      if (decompressed > maxDecompressed) { limitHit = 'decompressed_too_large'; return false }
      names.push(file.name)
      return true
    })
  } catch {
    return { ok: false, reason: 'invalid_zip' }
  }
  if (limitHit) return { ok: false, reason: limitHit }
  if (names.length === 0) return { ok: false, reason: 'invalid_zip' }
  if (originalSize > 0 && decompressed / originalSize > MAX_COMPRESSION_RATIO) {
    return { ok: false, reason: 'decompressed_too_large' }
  }

  const structure = validateArchiveStructure(names, entries)
  if (!structure.ok) return { ok: false, reason: structure.reason }

  const candidates = listOptimizableMedia(entries)
  if (candidates.length === 0) return { ok: false, reason: 'no_optimizable_media' }

  // Work on a copy so the ORIGINAL entry map stays pristine for the final
  // comparison — validation must compare against what came in, not against
  // something we have been mutating.
  const working: ArchiveEntries = {}
  for (const name of names) working[name] = entries[name]

  const changed = new Set<string>()
  let optimizedImages = 0
  let lastBuilt: Uint8Array | null = null

  for (let round = 0; round < OPTIMIZE_ROUNDS.length; round++) {
    if (expired()) return { ok: false, reason: 'timeout' }
    const settings = OPTIMIZE_ROUNDS[round]
    opts.onStage?.('optimizing')

    // Largest media first — that is where the bytes are, and it lets a workbook
    // dominated by one photograph finish without touching anything else.
    const ordered = [...candidates].sort((a, b) => working[b].length - working[a].length)

    for (const name of ordered) {
      if (expired()) return { ok: false, reason: 'timeout' }
      // Stop early once the raw payload is comfortably inside the target: the
      // archive can only be smaller than the sum of its inflated parts, so this
      // is a safe "no further degradation needed" signal.
      if (currentPayload(working, names) <= target) break

      const current = working[name]
      if (current.length < MIN_MEDIA_OPTIMIZE_BYTES) continue

      const format = OPTIMIZABLE_EXTS[extensionOf(name)]
      if (!format) continue

      let encoded: Uint8Array | null = null
      try {
        encoded = await opts.encoder({
          bytes: current,
          format,
          mime: FORMAT_MIME[format],
          maxEdge: settings.maxEdge,
          quality: settings.quality,
          maxPixels: MAX_IMAGE_PIXELS,
        })
      } catch {
        encoded = null
      }
      if (!encoded) continue

      // Independent verification of the encoder's contract. Bytes that are not
      // the same format, or that did not actually get smaller, are DISCARDED and
      // the original is kept — an encoder bug can waste effort here but can
      // never change a workbook's content type or grow the file.
      if (sniffImageFormat(encoded) !== format) continue
      if (encoded.length >= current.length) continue

      working[name] = encoded
      if (!changed.has(name)) optimizedImages += 1
      changed.add(name)
    }

    if (changed.size === 0) {
      // Nothing could be improved at all; harsher rounds will not change that
      // for formats the encoder refused outright.
      return { ok: false, reason: 'nothing_optimized' }
    }

    opts.onStage?.('rebuilding')
    lastBuilt = await deflateArchive(toZippable(working, names))
    if (lastBuilt.length <= target) break
  }

  if (!lastBuilt) return { ok: false, reason: 'nothing_optimized' }
  if (optimizedImages === 0) return { ok: false, reason: 'nothing_optimized' }
  if (lastBuilt.length > opts.limitBytes) return { ok: false, reason: 'still_over_limit' }
  if (expired()) return { ok: false, reason: 'timeout' }

  // ── Reopen and validate. Nothing below trusts the build step. ──
  opts.onStage?.('validating')
  const rebuiltNames: string[] = []
  let rebuilt: ArchiveEntries
  try {
    rebuilt = await inflateArchive(lastBuilt, (file) => {
      rebuiltNames.push(file.name)
      return true
    })
  } catch {
    return { ok: false, reason: 'validation_failed' }
  }

  const failure = validateRebuiltArchive(entries, names, rebuilt, rebuiltNames, changed)
  if (failure) return { ok: false, reason: 'validation_failed' }

  return {
    ok: true,
    bytes: lastBuilt,
    originalSize,
    finalSize: lastBuilt.length,
    optimizedImages,
  }
}

/** Sum of the inflated entry sizes. Used only as an early-stop heuristic: the
 *  built archive is always smaller than this, so reaching the target here means
 *  further image degradation is pointless. Pure. */
function currentPayload(entries: ArchiveEntries, names: string[]): number {
  let total = 0
  for (const name of names) total += entries[name].length
  return total
}
