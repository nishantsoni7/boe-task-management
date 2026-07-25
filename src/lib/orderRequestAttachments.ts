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

// 10 MB = 10 × 1024 × 1024, the convention used across the codebase and by the
// bucket's file_size_limit.
export const ORDER_REQ_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

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

// Human-readable size, e.g. "8.4 MB", "612 KB", "0 B". Pure.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
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

function withJpgExtension(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}.jpg`
}

function renderToBlob(
  img: HTMLImageElement,
  scale: number,
  type: 'image/png' | 'image/jpeg',
  quality: number | undefined,
  flattenWhite: boolean,
): Promise<Blob | null> {
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  if (flattenWhite) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(img, 0, 0, w, h)
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

// Compress an oversized image to at most maxBytes with CONSERVATIVE settings, so
// drawing dimensions, finish references, labels and specifications stay legible:
//   - a generous 3000px longest-edge cap, stepping down only as needed;
//   - a high JPEG quality floor (0.72; never the aggressive 0.5 of the old code);
//   - PNGs are FIRST re-encoded losslessly as resized PNG, which PRESERVES
//     transparency and avoids flattening technical content onto white. Only if a
//     lossless PNG still cannot fit does it fall back to a white-flattened JPEG
//     (the sole case where a transparent PNG is flattened — a documented last
//     resort, not the default).
// Returns the compressed File, or null when even the smallest/lowest-quality
// attempt is still over the limit (the caller then rejects the file rather than
// upload it oversized or unreadable). Returns the ORIGINAL untouched when it is
// already within the limit or the canvas API is unavailable.
async function compressImageToLimit(file: File, maxBytes: number): Promise<File | null> {
  if (file.size <= maxBytes) return file
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (!isCompressibleImageType(file.type)) return null

  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => resolve(null)
      el.src = objectUrl
    })
    if (!img || !img.naturalWidth || !img.naturalHeight) return null

    const longest = Math.max(img.naturalWidth, img.naturalHeight)
    const MAX_EDGE = 3000
    const baseScale = Math.min(1, MAX_EDGE / longest)
    const scales = [baseScale, baseScale * 0.85, baseScale * 0.7, baseScale * 0.55, baseScale * 0.42]
    const qualities = [0.92, 0.85, 0.78, 0.72]

    // PNG first: lossless resize, transparency preserved. Try largest scales.
    if (file.type === 'image/png') {
      for (const scale of scales) {
        const blob = await renderToBlob(img, scale, 'image/png', undefined, false)
        if (blob && blob.size <= maxBytes) {
          return new File([blob], file.name, { type: 'image/png', lastModified: Date.now() })
        }
      }
      // Fall through to the JPEG path (flatten on white) only as a last resort.
    }

    // JPEG path for JPEG/WEBP, and the PNG last resort. Flatten onto white so a
    // transparent source never renders as black.
    for (const scale of scales) {
      for (const quality of qualities) {
        const blob = await renderToBlob(img, scale, 'image/jpeg', quality, true)
        if (blob && blob.size <= maxBytes) {
          return new File([blob], withJpgExtension(file.name), { type: 'image/jpeg', lastModified: Date.now() })
        }
      }
    }
    return null
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

// Outcome of preparing one selected file. `originalSize` is always the selected
// size; `finalSize`/`file` are what will be uploaded when ok.
export type PreparedAttachment =
  | { ok: true;  file: File; contentType: string; originalSize: number; finalSize: number; compressed: boolean }
  | { ok: false; error: string; originalSize: number }

// Validate + (if needed) compress one selected file for the given category.
// Pure decision logic plus canvas work; no upload, no DB write. Rules:
//   - empty file                              → error
//   - type not allowed for this category      → clear "allowed types" error
//   - within 10 MB                            → uploaded as-is, no compression
//   - image over 10 MB                        → compressed; still over ⇒ error
//   - PDF over 10 MB                          → refused (no safe browser
//                                               compression) with a PDF-specific
//                                               "upload a smaller PDF" message
//   - other non-compressible over 10 MB       → refused with a "compress/reduce
//     (DOCX/XLSX/TXT/CSV)                        externally" message — never a
//                                               fake "compressed" claim
export async function prepareAttachment(
  file: File,
  category: AttachmentCategory,
): Promise<PreparedAttachment> {
  const originalSize = file.size

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

  if (file.size <= ORDER_REQ_ATTACHMENT_MAX_BYTES) {
    return { ok: true, file, contentType, originalSize, finalSize: file.size, compressed: false }
  }

  // Over 10 MB from here.
  if (isCompressibleImageType(contentType)) {
    const compressed = await compressImageToLimit(file, ORDER_REQ_ATTACHMENT_MAX_BYTES)
    if (!compressed) {
      return {
        ok: false,
        error: 'This image is larger than 10 MB and could not be reduced below the limit without losing too much detail. Please upload a smaller image.',
        originalSize,
      }
    }
    // A PNG that stayed PNG keeps its type; otherwise it is JPEG.
    return { ok: true, file: compressed, contentType: compressed.type, originalSize, finalSize: compressed.size, compressed: true }
  }

  if (contentType === PDF_MIME) {
    return {
      ok: false,
      error: 'This PDF is larger than 10 MB and cannot be compressed here. Please upload a compressed PDF under 10 MB.',
      originalSize,
    }
  }

  return {
    ok: false,
    error: 'This file is larger than 10 MB and cannot be compressed in the browser. Please compress or reduce it externally and upload a version under 10 MB.',
    originalSize,
  }
}
