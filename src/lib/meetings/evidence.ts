// Meetings — evidence images attached to an Order's discussion.
//
// The rules live in the database (20261203000000): a private bucket that caps
// type and size, storage policies that authorize on the Order's meeting, and an
// RPC that records nothing unless the object is really stored. This file is the
// browser half — it refuses a wrong file BEFORE an upload is attempted, builds
// the only key shape the storage policy accepts, and turns failures into one
// sentence a person mid-meeting can act on.
//
// Everything except prepareEvidenceFile() is a pure function of its inputs.

import { formatBytes, prepareAttachment } from '@/lib/orderRequestAttachments'

export const MEETING_EVIDENCE_BUCKET = 'meeting-evidence'

/**
 * The BOE stored-attachment ceiling. MUST equal the bucket's file_size_limit and
 * the table CHECK in 20261203000000.
 */
export const MEETING_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024

/** MUST equal the bucket's allowed_mime_types and the table CHECK. */
export const MEETING_EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type EvidenceMime = typeof MEETING_EVIDENCE_MIME_TYPES[number]
export type EvidenceExt = 'jpg' | 'png' | 'webp'

export const MEETING_EVIDENCE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
export const MEETING_EVIDENCE_TYPES_LABEL = 'JPG, PNG or WEBP'

/** Images staged in one save. A meeting records a screenshot, not an album. */
export const MEETING_EVIDENCE_MAX_PER_SAVE = 6

/** Signed URLs outlive a long meeting without being shareable indefinitely. */
export const MEETING_EVIDENCE_URL_TTL_SECONDS = 60 * 60

const EXT_TO_MIME: Record<string, EvidenceMime> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

const MIME_TO_EXT: Record<EvidenceMime, EvidenceExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Browser-reported aliases that mean the canonical type. */
const MIME_ALIASES: Record<string, EvidenceMime> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
}

function canonicalMime(reported: string): EvidenceMime | null {
  const type = reported.toLowerCase()
  if ((MEETING_EVIDENCE_MIME_TYPES as readonly string[]).includes(type)) return type as EvidenceMime
  return MIME_ALIASES[type] ?? null
}

/**
 * The type an image will be uploaded as, or null if it may not be attached.
 *
 * Extension-first, as the Order Request attachments are: a named file must carry
 * an allowed extension (so `ticket.png.exe` is refused), and a reported browser
 * type must agree with it. A pasted clipboard image may arrive with no usable
 * name, so a file WITHOUT an extension is judged on its reported type alone.
 * The canonical type is what gets uploaded, never the raw browser string.
 */
export function resolveEvidenceType(
  file: { name: string; type: string },
): { mime: EvidenceMime; ext: EvidenceExt } | null {
  const name = file.name.trim()
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const reported = file.type ? canonicalMime(file.type) : null

  if (ext) {
    const fromExt = EXT_TO_MIME[ext]
    if (!fromExt) return null
    if (file.type && reported !== fromExt) return null
    return { mime: fromExt, ext: MIME_TO_EXT[fromExt] }
  }

  if (!reported) return null
  return { mime: reported, ext: MIME_TO_EXT[reported] }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** The one key shape the storage INSERT policy and the RPC accept. */
export const MEETING_EVIDENCE_PATH_PATTERN = new RegExp(`^(${UUID})/${UUID}\\.(jpg|png|webp)$`)

/**
 * `{meeting_order_id}/{uuid}.{ext}`. The Order folder is what the storage
 * policies authorize on; the leaf is generated so the user's filename never
 * reaches a key and two uploads can never collide.
 */
export function buildEvidencePath(
  meetingOrderId: string,
  ext: EvidenceExt,
  uuid: string = crypto.randomUUID(),
): string {
  return `${meetingOrderId}/${uuid}.${ext}`
}

export function isEvidencePathForOrder(path: string, meetingOrderId: string): boolean {
  const match = MEETING_EVIDENCE_PATH_PATTERN.exec(path)
  return !!match && match[1] === meetingOrderId
}

/** Display name kept on the row. Never used to build a path. */
export function evidenceDisplayName(fileName: string): string {
  // Control characters and path separators dropped; everything a person would
  // type in a filename (spaces, dots, dashes, brackets) kept.
  const cleaned = Array.from(fileName)
    .filter(ch => {
      const code = ch.charCodeAt(0)
      return code >= 32 && code !== 127 && ch !== '/' && ch !== '\\'
    })
    .join('')
    .trim()
    .slice(0, 120)
  return cleaned || 'image'
}

export type PreparedEvidence =
  | { ok: true; file: File; mime: EvidenceMime; ext: EvidenceExt; compressed: boolean }
  | { ok: false; error: string }

/**
 * Validate one selected or pasted image and, only when it is over the limit,
 * compress it with the shared conservative compressor. No upload, no DB write.
 *
 * Never returns ok with a file above MEETING_EVIDENCE_MAX_BYTES; the bucket would
 * refuse it anyway, but the person deserves the answer before the upload.
 */
export async function prepareEvidenceFile(file: File): Promise<PreparedEvidence> {
  if (file.size === 0) return { ok: false, error: 'The selected image is empty.' }

  const type = resolveEvidenceType(file)
  if (!type) {
    return { ok: false, error: `Only ${MEETING_EVIDENCE_TYPES_LABEL} images can be attached.` }
  }

  if (file.size <= MEETING_EVIDENCE_MAX_BYTES) {
    return { ok: true, file, ...type, compressed: false }
  }

  const prepared = await prepareAttachment(file, 'reference')
  if (!prepared.ok) return { ok: false, error: prepared.error }

  const finalType = resolveEvidenceType(prepared.file)
  if (!finalType || prepared.file.size > MEETING_EVIDENCE_MAX_BYTES) {
    return {
      ok: false,
      error: `This image could not be reduced below ${formatBytes(MEETING_EVIDENCE_MAX_BYTES)}. Please attach a smaller image.`,
    }
  }
  return { ok: true, file: prepared.file, ...finalType, compressed: prepared.compressed }
}

/**
 * A failed Storage upload, as one sentence. Storage reports these as free text
 * (and sometimes a status code); nothing raw reaches the reader.
 */
export function evidenceUploadErrorMessage(
  err: { message?: string | null; statusCode?: string | number | null } | null | undefined,
): string {
  const message = (err?.message ?? '').toLowerCase()
  const status = String(err?.statusCode ?? '')

  if (status === '413' || message.includes('maximum allowed size') || message.includes('too large')) {
    return `This image is larger than ${formatBytes(MEETING_EVIDENCE_MAX_BYTES)}.`
  }
  if (message.includes('mime type') || message.includes('invalid_mime_type')) {
    return `Only ${MEETING_EVIDENCE_TYPES_LABEL} images can be attached.`
  }
  if (status === '403' || message.includes('row-level security') || message.includes('unauthorized')) {
    return 'You do not have permission to attach evidence to this meeting.'
  }
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('load failed')) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return 'The image could not be uploaded.'
}

/**
 * The outcome of one save, stated exactly. "Saved" is claimed only for what was
 * recorded; a failed image is named as not attached, never implied to be.
 */
export function evidenceSaveOutcome(outcome: {
  updateSaved: boolean
  attached: number
  failed: number
}): { tone: 'success' | 'error'; message: string } {
  const { updateSaved, attached, failed } = outcome
  const images = (n: number) => `${n} image${n === 1 ? '' : 's'}`

  const done: string[] = []
  if (updateSaved) done.push('Update saved')
  if (attached > 0) done.push(`${images(attached)} attached`)

  if (failed === 0) {
    return { tone: 'success', message: done.length > 0 ? done.join(' · ') : 'Nothing to save' }
  }

  const prefix = done.length > 0 ? `${done.join(' · ')}. ` : ''
  return {
    tone: 'error',
    message: `${prefix}${images(failed)} could not be attached, so nothing was recorded for ${failed === 1 ? 'it' : 'them'}. Try again.`,
  }
}
