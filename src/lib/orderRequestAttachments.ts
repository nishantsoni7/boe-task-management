// Order Request attachment helpers — scoped to the "Main PI + reference
// attachments" feature (not a general document system). Shared by the create
// form and the details view.
//
// Design mirrors the Finance payment-proof feature (src/lib/paymentProof.ts):
//   - a PRIVATE bucket, viewed only through short-lived signed URLs;
//   - the request id is ALWAYS the first path segment, because the storage RLS
//     policies validate ownership from split_part(name,'/',1);
//   - the object key is fully generated (uuid + sanitised name), never the raw
//     user filename.
//
// Everything here except compressImageToLimit()/prepareAttachment() is a pure
// function of its inputs (type classification, filename/path building, size
// formatting) so it is directly unit-testable without a DOM.

export const ORDER_REQ_ATTACHMENT_BUCKET = 'order-request-attachments'

// ── Accepted types ────────────────────────────────────────────────────────────
// Two allow-lists. The Main PI is the primary commercial document (a Proforma
// Invoice) and MUST be an Excel workbook — .xlsx or .xls ONLY. A PDF or image is
// never accepted as the Main PI; a PI PDF may be attached under references
// instead. Reference attachments accept the safe, well-defined PDF / image /
// Office / text formats the codebase already trusts (task attachments, 20260607).
// ZIP is NOT included in this phase. These MUST stay a subset of the bucket's
// allowed_mime_types in supabase/migrations/20260711000000_order_request_attachments.sql.

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
const PDF_MIME = 'application/pdf'
const DOC_MIMES = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const
const SHEET_MIMES = [
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const
const TEXT_MIMES = ['text/plain', 'text/csv'] as const
// ZIP is intentionally NOT in this phase — a container can hold anything, so it
// needs an explicit product decision rather than an automatic inclusion.

export const MAIN_PI_ALLOWED_TYPES: readonly string[] = [...SHEET_MIMES]
export const REFERENCE_ALLOWED_TYPES: readonly string[] = [
  PDF_MIME, ...IMAGE_MIMES, ...DOC_MIMES, ...SHEET_MIMES, ...TEXT_MIMES,
]

export type AttachmentCategory = 'main_pi' | 'reference'

// Allowed EXTENSIONS per category — the primary gate. Validation is
// extension-first (see resolveUpload): the extension must be one of these, which
// blocks unknown types AND double-extension tricks ("invoice.pdf.exe" → ext
// "exe" → rejected). Macro-enabled Office formats (.docm/.xlsm/.dotm/…) are
// absent by design and therefore rejected.
export const MAIN_PI_EXTS = ['xlsx', 'xls'] as const
export const REFERENCE_EXTS = [
  'pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv',
] as const

// Human labels + input `accept` strings for the two categories, so the UI and
// the validation share one source of truth.
export const MAIN_PI_ACCEPT =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,.xlsx,.xls'
// Reference attachments keep the full PDF / image / Office / text set (a PI PDF
// belongs here). Built INDEPENDENTLY of MAIN_PI_ACCEPT, which is now Excel-only —
// references must never be narrowed to Excel by a change to the Main PI list.
export const REFERENCE_ACCEPT =
  'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp' +
  ',application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document' +
  ',application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' +
  ',text/plain,text/csv' +
  ',.doc,.docx,.xls,.xlsx,.txt,.csv'

export const MAIN_PI_TYPES_LABEL = 'Excel (.xlsx or .xls)'
export const REFERENCE_TYPES_LABEL = 'PDF, image, Word, Excel, CSV or TXT'

// Extension → canonical MIME. The canonical MIME is what we UPLOAD as, so a
// spoofed or blank browser type never reaches storage — the bucket's
// allowed_mime_types then double-checks it.
const EXT_TYPES: Record<string, string> = {
  pdf:  PDF_MIME,
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt:  'text/plain',
  csv:  'text/csv',
}

// Browser types we tolerate as "consistent" for a given extension family. Some
// environments report text/plain for CSV, or octet-stream/blank for Office
// files, so we don't demand an exact ext↔type match — but a NON-blank type that
// is a recognised-yet-disallowed binary (e.g. an executable) is rejected.
const TEXT_LIKE = new Set<string>(['text/plain', 'text/csv'])

// ── Size policy ───────────────────────────────────────────────────────────────
// THE BOE PRODUCT RULE: no attachment may be STORED above 10 MB.
//
// Distinguish two things that are easy to confuse:
//   * the ORIGINAL SELECTED size — may legitimately exceed 10 MB. The user picks
//     whatever they have; the app then tries to process it.
//   * the FINAL UPLOAD size — must ALWAYS be <= 10 MB. This is what reaches
//     Supabase Storage, and it is the number this constant governs.
//
// A file over 10 MB is therefore never simply passed through: it is either
// reduced below the limit by a safe, format-specific processor, or it is
// REFUSED. The original oversized bytes must never reach Storage.
//
// This MUST equal the bucket's file_size_limit in
// supabase/migrations/20260711000000_order_request_attachments.sql (10485760) —
// one rule expressed in two places, with the bucket acting as an INDEPENDENT
// backend enforcement boundary rather than as the first line of defence.
//
// NOT to be confused with the Supabase project-wide Storage ceiling (50 MB on
// this project's plan, verified 2026-07-25). That is infrastructure headroom, not
// permission: the product limit is 10 MB and is deliberately far below it.
export const ORDER_REQ_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

// What an oversized image is compressed DOWN to. Deliberately BELOW the 10 MB
// ceiling rather than equal to it, so the stored file keeps safe overhead and a
// result that lands just under the target can never round past the limit.
export const IMAGE_COMPRESS_TARGET_BYTES = 8 * 1024 * 1024

export function extOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function allowedExtsFor(category: AttachmentCategory): readonly string[] {
  return category === 'main_pi' ? MAIN_PI_EXTS : REFERENCE_EXTS
}

function allowedMimesFor(category: AttachmentCategory): readonly string[] {
  return category === 'main_pi' ? MAIN_PI_ALLOWED_TYPES : REFERENCE_ALLOWED_TYPES
}

function typesLabelFor(category: AttachmentCategory): string {
  return category === 'main_pi' ? MAIN_PI_TYPES_LABEL : REFERENCE_TYPES_LABEL
}

// Extension-first validation. Returns the canonical MIME to upload as, or null if
// the file is not acceptable for the category. Pure and unit-testable.
//
// Rules, in order:
//   1. The (last) extension must be in the category's allow-list. This is the
//      primary gate and defeats double-extension tricks and unknown types.
//   2. If the browser reported a type, it must be CONSISTENT with the extension —
//      i.e. in the category's allowed MIME set, or a tolerated text-like type for
//      text/CSV. A non-blank type outside that set (e.g. application/x-msdownload
//      on a file named ".pdf") is a dangerous mismatch → rejected.
//   3. We always upload as the extension's CANONICAL MIME, never the raw browser
//      type, so a spoofed-but-allowed type can't smuggle through and the bucket's
//      allowed_mime_types check always sees a known-good value.
export function resolveUploadType(file: File, category: AttachmentCategory): string | null {
  const ext = extOf(file.name)
  const allowedExts = allowedExtsFor(category)
  if (!allowedExts.includes(ext)) return null

  const canonical = EXT_TYPES[ext]
  if (!canonical) return null

  const reported = file.type
  if (reported) {
    const allowedMimes = allowedMimesFor(category)
    const consistent = allowedMimes.includes(reported) || TEXT_LIKE.has(reported)
    if (!consistent) return null // dangerous ext↔type mismatch
  }
  return canonical
}

// Back-compat name kept for any external caller; delegates to resolveUploadType.
export function attachmentContentType(file: File, category: AttachmentCategory): string | null {
  return resolveUploadType(file, category)
}

const COMPRESSIBLE_IMAGE_TYPES: readonly string[] = IMAGE_MIMES

export function isCompressibleImageType(mime: string): boolean {
  return COMPRESSIBLE_IMAGE_TYPES.includes(mime)
}

// Human-readable size, e.g. "8.4 MB", "612 KB", "10 MB", "0 B". Pure.
// A whole number never keeps a pointless ".0" — these strings appear in
// user-facing limit messages, where "over the 10.0 MB limit" reads like a
// machine and "over the 10 MB limit" reads like a sentence.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  const rounded = value >= 100 || i === 0 ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded} ${units[i]}`
}

// Keep only characters safe in a storage key and a display name; collapse the
// rest to '-', trim, cap length. The extension is preserved by the caller when
// it matters. Pure.
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return (cleaned || 'file').slice(0, 80)
}

function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Object key builder. FIRST segment = order_request_id (storage RLS validates
// ownership from it); category folder separates Main PI from references; leaf =
// uuid-{safe-name} so same-named files never collide and the raw name is never
// the key. Pure apart from the random token.
export function buildAttachmentPath(
  orderRequestId: string,
  category: AttachmentCategory,
  fileName: string,
): string {
  const folder = category === 'main_pi' ? 'main-pi' : 'references'
  return `${orderRequestId}/${folder}/${randomToken()}-${sanitizeFileName(fileName)}`
}

// Swap a filename's extension so it always agrees with the MIME we actually
// encoded. A compressed file whose extension disagrees with its bytes would be
// rejected by resolveUploadType on any later re-validation, and would download
// as an unopenable file.
function withExtension(name: string, ext: 'jpg' | 'png' | 'webp'): string {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}.${ext}`
}

// Decoded source for compression. createImageBitmap with
// imageOrientation:'from-image' applies the EXIF orientation tag, so a phone
// photo taken sideways is re-encoded the way the user sees it rather than
// silently rotated — canvas drawImage of a raw <img> does NOT do this on every
// browser. The <img> path is the fallback where createImageBitmap is missing.
type DecodedImage = { source: CanvasImageSource; width: number; height: number; close: () => void }

async function decodeImage(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      if (bmp.width && bmp.height) {
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
      }
      bmp.close()
    } catch {
      // fall through to the <img> path
    }
  }
  const objectUrl = URL.createObjectURL(file)
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => resolve(null)
    el.src = objectUrl
  })
  if (!img || !img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(objectUrl)
    return null
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close: () => URL.revokeObjectURL(objectUrl),
  }
}

function renderToBlob(
  img: DecodedImage,
  scale: number,
  type: 'image/png' | 'image/jpeg' | 'image/webp',
  quality: number | undefined,
  flattenWhite: boolean,
): Promise<Blob | null> {
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  if (flattenWhite) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(img.source, 0, 0, w, h)
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

// Compress an oversized image down to targetBytes with CONSERVATIVE settings, so
// drawing dimensions, finish references, labels and specifications stay legible:
//   - a generous 3000px longest-edge cap, stepping down only as needed, and NEVER
//     upscaling (scale is clamped to <= 1, so a small-but-heavy image is only
//     re-encoded, never enlarged);
//   - a high JPEG quality floor (0.72; never the aggressive 0.5 of the old code);
//   - EXIF orientation applied at decode, so a sideways phone photo is not rotated;
//   - it STOPS at the first attempt that reaches the target rather than continuing
//     to degrade the picture — attempts run largest/highest-quality first.
//
// Transparency is preserved wherever the source has it: PNG and WEBP are first
// re-encoded in their OWN alpha-capable format (PNG losslessly, WEBP at stepped
// quality). Only if that still cannot reach the target does either fall back to a
// white-flattened JPEG — a documented last resort, not the default, and the only
// path that discards an alpha channel.
//
// Returns the compressed File, or null when even the smallest/lowest-quality
// attempt is still over the target (the caller then reports a per-file error
// rather than uploading something oversized or unreadable). Returns the ORIGINAL
// untouched when it is already within the target or the canvas API is missing.
async function compressImageToTarget(file: File, targetBytes: number): Promise<File | null> {
  if (file.size <= targetBytes) return file
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (!isCompressibleImageType(file.type)) return null

  const img = await decodeImage(file)
  if (!img) return null

  try {
    const longest = Math.max(img.width, img.height)
    const MAX_EDGE = 3000
    // min(1, …) is the no-upscale guarantee: an image already under MAX_EDGE
    // keeps its native dimensions and is only re-encoded.
    const baseScale = Math.min(1, MAX_EDGE / longest)
    const scales = [baseScale, baseScale * 0.85, baseScale * 0.7, baseScale * 0.55, baseScale * 0.42]
    const qualities = [0.92, 0.85, 0.78, 0.72]

    // PNG: lossless resize, alpha intact. Largest scale first, stop on success.
    if (file.type === 'image/png') {
      for (const scale of scales) {
        const blob = await renderToBlob(img, scale, 'image/png', undefined, false)
        if (blob && blob.size <= targetBytes) {
          return new File([blob], withExtension(file.name, 'png'), { type: 'image/png', lastModified: Date.now() })
        }
      }
    }

    // WEBP: re-encode as WEBP so an alpha channel survives. Skipped silently if
    // the browser cannot encode WEBP (toBlob then yields a non-webp/empty blob,
    // which the type guard below rejects).
    if (file.type === 'image/webp') {
      for (const scale of scales) {
        for (const quality of qualities) {
          const blob = await renderToBlob(img, scale, 'image/webp', quality, false)
          if (blob && blob.type === 'image/webp' && blob.size <= targetBytes) {
            return new File([blob], withExtension(file.name, 'webp'), { type: 'image/webp', lastModified: Date.now() })
          }
        }
      }
    }

    // JPEG path — the normal route for JPEG sources, and the last resort for a
    // PNG/WEBP that could not reach the target in its own format. Flatten onto
    // white so a transparent source never renders as black.
    for (const scale of scales) {
      for (const quality of qualities) {
        const blob = await renderToBlob(img, scale, 'image/jpeg', quality, true)
        if (blob && blob.size <= targetBytes) {
          return new File([blob], withExtension(file.name, 'jpg'), { type: 'image/jpeg', lastModified: Date.now() })
        }
      }
    }
    return null
  } finally {
    img.close()
  }
}

// ── Removing one already-selected reference attachment ────────────────────────
// The DECISION of how to remove a file is separated from the async work of doing
// it, so the rule is unit-testable without a DOM or a Supabase client.
//
// Two genuinely different cases:
//   * nothing was committed yet (the usual case — uploads only happen during
//     submit) → drop it from local state, no server work at all;
//   * the file was already uploaded by an earlier, partially failed submit →
//     the storage object AND its metadata row must both go, in that order.
export type ReferenceRemoval =
  | { kind: 'local' }
  | { kind: 'remote'; storagePath: string; attachmentId: string }
  | { kind: 'blocked'; reason: string }

export type RemovableFile = {
  category:     AttachmentCategory
  uploadedPath: string | null
  attachmentId: string | null
}

// Decide how to remove one selected file. Pure.
//   - a Main PI is never removable this way (the RPC refuses it too; this keeps
//     the client from even attempting it);
//   - a removal already in flight blocks a second one, so a double-click cannot
//     delete an object twice or race the metadata delete;
//   - a file with an uploaded path but no attachment id would leave a row we
//     cannot address, so it is blocked rather than half-removed.
export function planReferenceRemoval(
  file: RemovableFile,
  opts: { hasDraft: boolean; removalInFlight: boolean },
): ReferenceRemoval {
  if (opts.removalInFlight) {
    return { kind: 'blocked', reason: 'Another file is still being removed.' }
  }
  if (file.category !== 'reference') {
    return { kind: 'blocked', reason: 'The Main PI cannot be removed individually.' }
  }
  // Never uploaded (or the draft behind it is already gone) — purely local.
  if (!file.uploadedPath || !opts.hasDraft) return { kind: 'local' }

  if (!file.attachmentId) {
    return { kind: 'blocked', reason: 'This file cannot be removed cleanly. Please cancel and start again.' }
  }
  return { kind: 'remote', storagePath: file.uploadedPath, attachmentId: file.attachmentId }
}

// ── Stale-result guard ────────────────────────────────────────────────────────
// Preparing a file is asynchronous and can take seconds (a 40 MB workbook has to
// be unzipped, re-encoded, rebuilt and re-validated). In that window the user can
// replace the file, remove it, retry it, or close the modal. Every one of those
// starts a NEW generation, and the older in-flight result must be thrown away —
// otherwise a slow optimisation of a file the user already replaced would land on
// top of the current selection and the wrong bytes would be uploaded.
//
// The rule is a pure function so it can be tested directly, rather than being an
// inline identity comparison buried in a React callback.
export type StageApplication = 'apply' | 'discard-stale' | 'discard-aborted'

export function planStageApplication(opts: {
  /** localId currently occupying the slot the result was produced for, or null
   *  if the slot was cleared (file removed, modal reset). */
  slotId: string | null
  /** localId the in-flight result belongs to. */
  resultId: string
  /** Set when the whole staging context was torn down (modal closed/reset). */
  aborted: boolean
}): StageApplication {
  if (opts.aborted) return 'discard-aborted'
  if (opts.slotId === null || opts.slotId !== opts.resultId) return 'discard-stale'
  return 'apply'
}

// What prepareAttachment() is ABOUT to do with this file, so the UI can show the
// truth before the work starts rather than a vague "Preparing…". Shares
// prepareAttachment's own conditions, so the status shown can never disagree
// with the work actually performed.
//   'image' → an oversized picture will be re-encoded;
//   'xlsx'  → an oversized workbook will have its embedded images optimised;
//   null    → the file is passed through untouched (or will be refused).
export type PlannedProcessing = 'image' | 'xlsx' | null

export function plannedProcessing(file: File, category: AttachmentCategory): PlannedProcessing {
  const contentType = resolveUploadType(file, category)
  if (!contentType) return null
  if (file.size <= ORDER_REQ_ATTACHMENT_MAX_BYTES) return null
  if (isCompressibleImageType(contentType)) return 'image'
  if (isOptimizableWorkbook(file)) return 'xlsx'
  return null
}

// Back-compat: the boolean the UI used before workbook optimisation existed.
export function willCompressImage(file: File, category: AttachmentCategory): boolean {
  return plannedProcessing(file, category) === 'image'
}

// Only the ZIP-based .xlsx can be optimised. A legacy .xls is BIFF8 — a binary
// stream format whose images live inside OLE compound-document streams. There is
// no safe reduction path for it: it cannot be re-zipped, converting it to .xlsx
// would rewrite the whole workbook, and a SheetJS rewrite is exactly the
// content-destroying operation this feature refuses to perform. So an oversized
// .xls is refused, permanently and by design.
function isOptimizableWorkbook(file: File): boolean {
  return extOf(file.name) === 'xlsx'
}

// Stages surfaced while a file is prepared. These map 1:1 onto real work — the
// UI never shows a stage that did not happen, and there is deliberately no
// percentage anywhere (nothing in this pipeline reports fractional progress, so
// a percentage could only be invented).
export type PrepareStage =
  | 'checking'    // validating type + size
  | 'compressing' // re-encoding an oversized image
  | 'reading'     // reading an oversized workbook as a ZIP
  | 'optimizing'  // re-encoding embedded workbook images
  | 'rebuilding'  // writing the new archive
  | 'validating'  // reopening + proving the archive is unchanged apart from media

// Every stage that means "still working". The UI derives its submit-blocking set
// from exactly this list, so a stage added here can never be one the submit
// button forgets to wait for.
export const PREPARE_STAGES: readonly PrepareStage[] = [
  'checking', 'compressing', 'reading', 'optimizing', 'rebuilding', 'validating',
]

export type PrepareProgress = (stage: PrepareStage) => void

// Outcome of preparing one selected file. `originalSize` is always the selected
// size; `finalSize`/`file` are what will be uploaded when ok.
export type PreparedAttachment =
  | { ok: true;  file: File; contentType: string; originalSize: number; finalSize: number; compressed: boolean }
  | { ok: false; error: string; originalSize: number }

// Validate one selected file and, when it is over the limit, try to process it
// down. No upload, no DB write.
//
// THE INVARIANT: this function NEVER returns ok:true with finalSize above
// ORDER_REQ_ATTACHMENT_MAX_BYTES. Whatever comes back as `file` is what gets
// stored, so an oversized original can only ever leave here as a REDUCED file or
// as an error. That is the single guarantee the whole size rule rests on, and the
// final `finalSize` check below enforces it belt-and-braces, independently of how
// any individual processor behaved.
//
// Rules, in order:
//   - empty file                         → error
//   - type not allowed for this category → clear "allowed types" error
//   - within 10 MB                       → stored exactly as selected, untouched
//   - IMAGE over 10 MB                   → compressed toward ~8 MB; if the result
//                                          is still over 10 MB ⇒ REJECTED
//   - .xlsx over 10 MB                   → embedded images under xl/media are
//                                          re-encoded IN PLACE; every other ZIP
//                                          entry is carried through byte-for-byte
//                                          and the rebuilt workbook is reopened
//                                          and proven unchanged before it is
//                                          accepted. Anything short of that ⇒
//                                          REJECTED.
//   - anything else over 10 MB           → REJECTED. There is no safe automatic
//     (.xls / PDF / Word / CSV / TXT)      reducer for these formats; rewriting a
//                                          legacy workbook or an already-compressed
//                                          container without being able to validate
//                                          the result would risk silently corrupting
//                                          a commercial document, so we refuse
//                                          instead of pretending.
export async function prepareAttachment(
  file: File,
  category: AttachmentCategory,
  onStage?: PrepareProgress,
): Promise<PreparedAttachment> {
  const result = await decideAttachment(file, category, onStage)

  // THE BACKSTOP. Whatever the branches above decided, nothing leaves this
  // function marked ok while exceeding the storage limit. If a processor ever
  // regresses — returns a file bigger than it promised, or a new format branch
  // forgets its own size check — this converts a silent oversized upload into a
  // plain refusal. The bucket's file_size_limit would also reject it server-side,
  // but the user deserves the answer here, before an upload is attempted.
  if (result.ok && result.finalSize > ORDER_REQ_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: `This file could not be reduced below ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)}. Please attach a smaller file.`,
      originalSize: result.originalSize,
    }
  }
  return result
}

async function decideAttachment(
  file: File,
  category: AttachmentCategory,
  onStage?: PrepareProgress,
): Promise<PreparedAttachment> {
  const originalSize = file.size
  onStage?.('checking')

  if (file.size === 0) {
    return { ok: false, error: 'The selected file is empty.', originalSize }
  }

  const contentType = resolveUploadType(file, category)
  if (!contentType) {
    return {
      ok: false,
      error: category === 'main_pi'
        ? 'Main PI must be an Excel file in .xlsx or .xls format.'
        : `Only ${typesLabelFor(category)} files are allowed here.`,
      originalSize,
    }
  }

  // Within the limit — stored byte-for-byte. An Excel Main PI under 10 MB takes
  // this path, so a normal workbook is never re-encoded or restructured.
  if (file.size <= ORDER_REQ_ATTACHMENT_MAX_BYTES) {
    return { ok: true, file, contentType, originalSize, finalSize: file.size, compressed: false }
  }

  // ── Over the limit from here: process or refuse. Never pass through. ──

  // .xlsx — optimise the embedded images and NOTHING else. The optimiser proves
  // the rebuilt workbook is byte-identical outside xl/media before returning ok,
  // so a failure here is a genuine "cannot do this safely", never a silent
  // downgrade of the document.
  if (isOptimizableWorkbook(file)) {
    onStage?.('reading')
    let optimized: File | null = null
    try {
      const [{ optimizeXlsxMedia, createCanvasMediaEncoder }, buffer] = await Promise.all([
        import('./xlsxMediaOptimizer'),
        file.arrayBuffer(),
      ])
      const result = await optimizeXlsxMedia(new Uint8Array(buffer), {
        encoder: createCanvasMediaEncoder(),
        limitBytes: ORDER_REQ_ATTACHMENT_MAX_BYTES,
        onStage: (stage) => onStage?.(stage),
      })
      if (result.ok) {
        // Original filename and canonical .xlsx MIME are BOTH preserved: the
        // stored object is the same document, only lighter.
        optimized = new File([result.bytes as unknown as BlobPart], file.name, {
          type: contentType,
          lastModified: file.lastModified,
        })
      }
    } catch {
      optimized = null // a thrown optimiser is a refusal, never a pass-through
    }

    if (optimized && optimized.size <= ORDER_REQ_ATTACHMENT_MAX_BYTES) {
      return {
        ok: true, file: optimized, contentType,
        originalSize, finalSize: optimized.size, compressed: true,
      }
    }
    return {
      ok: false,
      error: `This Excel file is ${formatBytes(originalSize)}. It could not be safely reduced below ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} without changing its workbook structure. Please use a smaller Main PI file.`,
      originalSize,
    }
  }

  // Legacy .xls — no safe automatic reduction path exists, so say exactly that
  // and point at the format that does have one.
  if (category === 'main_pi') {
    return {
      ok: false,
      error: `This legacy Excel file is ${formatBytes(originalSize)}, larger than ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)}, and cannot be safely reduced automatically. Please upload an .xlsx file below ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)}.`,
      originalSize,
    }
  }

  // Images are the other format the app can reduce safely.
  if (isCompressibleImageType(contentType)) {
    onStage?.('compressing')
    const compressed = await compressImageToTarget(file, IMAGE_COMPRESS_TARGET_BYTES)
    if (compressed && compressed.size <= ORDER_REQ_ATTACHMENT_MAX_BYTES) {
      // The extension was rewritten to match whatever format we encoded, so the
      // stored type, the stored name and the bytes always agree.
      return {
        ok: true, file: compressed, contentType: compressed.type,
        originalSize, finalSize: compressed.size, compressed: true,
      }
    }
    // Every safe automatic path was tried and none produced a usable file.
    return {
      ok: false,
      error: `This image is ${formatBytes(originalSize)}. It was compressed automatically but could not be brought under ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} without losing too much detail. Please attach a smaller image.`,
      originalSize,
    }
  }

  // A reference attachment in a format with no safe reducer (PDF, Word, Excel,
  // CSV, TXT). The message states plainly what the app can and cannot do — it
  // does NOT claim an attempt that never happened, and it does not imply that
  // larger files would be accepted.
  return {
    ok: false,
    error: `This file is ${formatBytes(originalSize)}, over the ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} limit. This format cannot be reduced automatically in the app, so please attach a version of ${formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} or less.`,
    originalSize,
  }
}
