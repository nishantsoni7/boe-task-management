// Asset documents — invoice, warranty card, supporting files.
//
// Design mirrors the Finance payment-proof and Order Request attachment
// features (src/lib/orderRequestAttachments.ts):
//   - a PRIVATE bucket, viewed only through short-lived signed URLs;
//   - the asset id is ALWAYS the first path segment, because the storage RLS
//     policies read ownership from split_part(name, '/', 1);
//   - the object key is fully generated (uuid + sanitised name), never the raw
//     user filename.
//
// Everything here is a pure function of its inputs, so the type gate, the size
// rule and the path shape are all testable without a DOM or a Supabase client.

import type { AssetDocumentType } from './types'

export const ASSET_DOCUMENT_BUCKET = 'asset-documents'

// THE BOE PRODUCT RULE: no attachment may be STORED above 10 MB. This MUST
// equal the bucket's file_size_limit in
// supabase/migrations/20260729000000_asset_transfer_service_documents.sql —
// one rule expressed in two places, with the bucket as the INDEPENDENT backend
// boundary rather than the first line of defence.
export const ASSET_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

// Extension → canonical MIME. The canonical MIME is what we UPLOAD as, so a
// spoofed or blank browser type never reaches storage; the bucket's
// allowed_mime_types then double-checks it.
const EXT_TYPES: Record<string, string> = {
  pdf:  'application/pdf',
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

/**
 * Allowed EXTENSIONS — the primary gate.
 *
 * Validation is extension-first, which blocks unknown types AND
 * double-extension tricks ("invoice.pdf.exe" → ext "exe" → rejected).
 * Macro-enabled Office formats (.docm/.xlsm/…) are absent by design and
 * therefore refused. ZIP is likewise absent: a container can hold anything.
 */
export const ASSET_DOCUMENT_EXTS: readonly string[] = [
  'pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv',
]

export const ASSET_DOCUMENT_ACCEPT =
  'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp' +
  ',application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document' +
  ',application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' +
  ',text/plain,text/csv' +
  ',.doc,.docx,.xls,.xlsx,.txt,.csv'

export const ASSET_DOCUMENT_TYPES_LABEL = 'PDF, image, Word, Excel, CSV or TXT'

// Browser types tolerated as "consistent" for a text-family extension. Some
// environments report text/plain for CSV, so an exact ext↔type match is not
// demanded — but a NON-blank type outside the allow-list (an executable on a
// file named ".pdf") is a dangerous mismatch and is refused.
const TEXT_LIKE = new Set(['text/plain', 'text/csv'])
const ALLOWED_MIMES = new Set(Object.values(EXT_TYPES))

export function extOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

/**
 * The canonical MIME to upload this file as, or null if it is not acceptable.
 *
 * Rules, in order:
 *   1. the (last) extension must be in the allow-list;
 *   2. a reported browser type must be CONSISTENT with it;
 *   3. we always upload as the extension's canonical MIME, never the raw
 *      browser type.
 */
export function resolveDocumentType(file: { name: string; type?: string }): string | null {
  const ext = extOf(file.name)
  if (!ASSET_DOCUMENT_EXTS.includes(ext)) return null

  const canonical = EXT_TYPES[ext]
  if (!canonical) return null

  const reported = file.type ?? ''
  if (reported && !ALLOWED_MIMES.has(reported) && !TEXT_LIKE.has(reported)) return null

  return canonical
}

/** Human-readable size, e.g. "8.4 MB", "612 KB", "10 MB", "0 B". Pure. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  const rounded = value >= 100 || i === 0 ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded} ${units[i]}`
}

/** Keep only characters safe in a storage key and a display name. Pure. */
export function sanitizeDocumentName(name: string): string {
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

const DOC_FOLDER: Record<AssetDocumentType, string> = {
  invoice:       'invoice',
  warranty_card: 'warranty',
  other:         'other',
}

/**
 * Object key builder.
 *
 * FIRST segment = asset id, because the storage policies validate ownership
 * from it. Then a category folder, then `uuid-{safe-name}` so same-named files
 * never collide and the raw user filename is never the key.
 */
export function buildDocumentPath(
  assetId: string,
  docType: AssetDocumentType,
  fileName: string,
): string {
  return `${assetId}/${DOC_FOLDER[docType]}/${randomToken()}-${sanitizeDocumentName(fileName)}`
}

export type DocumentValidation =
  | { ok: true; contentType: string }
  | { ok: false; error: string }

/**
 * Whether this file may be uploaded at all.
 *
 * There is no compression path here, deliberately: an asset document is an
 * invoice or a warranty card, and silently re-encoding a commercial document
 * to squeeze it under a limit is exactly the kind of "help" that corrupts a
 * record. An oversized file is refused with a sentence that says what to do.
 */
export function validateDocument(file: { name: string; type?: string; size: number }): DocumentValidation {
  if (file.size === 0) {
    return { ok: false, error: 'The selected file is empty.' }
  }

  const contentType = resolveDocumentType(file)
  if (!contentType) {
    return { ok: false, error: `Only ${ASSET_DOCUMENT_TYPES_LABEL} files can be attached to an asset.` }
  }

  if (file.size > ASSET_DOCUMENT_MAX_BYTES) {
    return {
      ok: false,
      error: `This file is ${formatFileSize(file.size)}, over the ${formatFileSize(ASSET_DOCUMENT_MAX_BYTES)} limit. Please attach a smaller file.`,
    }
  }

  return { ok: true, contentType }
}

/** Documents still on the record — a soft-removed row is history, not a file. */
export function activeDocuments<T extends { removed_at: string | null }>(rows: readonly T[]): T[] {
  return rows.filter(r => r.removed_at === null)
}

/** How long a preview/download link stays valid. Short, because it is a URL. */
export const ASSET_DOCUMENT_SIGNED_URL_SECONDS = 300
