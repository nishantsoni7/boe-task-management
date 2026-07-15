// Payment-proof helpers — deliberately scoped to the Finance payment-proof
// feature only (not a general attachment framework). Shared by the Finance
// pages (upload + validation) and PaymentProofView (bucket name).

export const PROOF_BUCKET = 'payment-proofs'

// Must match the bucket's allowed_mime_types in
// supabase/migrations/20260672_create_payment_proof_attachments.sql
export const PROOF_ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
] as const

// Extension → MIME, used only when the browser leaves file.type blank.
const PROOF_EXT_TYPES: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
  pdf:  'application/pdf',
}

export const PROOF_MAX_BYTES = 10 * 1024 * 1024 // 10 MB — mirrors the bucket limit

function extOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

// The MIME type to upload the file as. Prefers the browser-reported type; when
// that is blank (some browsers report '' for less common types) it is derived
// from the extension. Returns null when neither yields an allowed type — the
// bucket's allowed_mime_types would reject the upload anyway, so validateProofFile
// rejects those files up front rather than letting the upload fail mid-submit.
export function proofContentType(file: File): string | null {
  if ((PROOF_ALLOWED_TYPES as readonly string[]).includes(file.type)) return file.type
  if (file.type) return null // reported a type, and it is not one we allow
  return PROOF_EXT_TYPES[extOf(file.name)] ?? null
}

// Validates a candidate proof file. Returns an error string to display, or null
// when the file is acceptable. Checks: empty file, size ceiling, allowed type.
// The type check mirrors the bucket's allowed_mime_types exactly, so a file that
// passes here cannot be rejected by Storage: if the browser reported a type it
// must be an allowed one (an extension can never launder a disallowed type),
// and only when the type is blank do we fall back to the extension.
export function validateProofFile(file: File): string | null {
  if (file.size === 0) return 'The selected file is empty.'
  if (file.size > PROOF_MAX_BYTES) return 'File must be under 10 MB.'
  if (!proofContentType(file)) {
    return 'Only images (JPG, PNG, WEBP, GIF) or PDF files are allowed.'
  }
  return null
}

// Builds a safe, unique object key under the payment request's folder.
// The first path segment is the payment_request_id — the storage RLS policies
// validate ownership from it. The filename itself is fully generated (no
// user-controlled path), only the extension is derived and sanitised.
export function buildProofPath(paymentRequestId: string, fileName: string): string {
  const ext = extOf(fileName).replace(/[^a-z0-9]/g, '') || 'bin'
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return `${paymentRequestId}/${unique}.${ext}`
}
