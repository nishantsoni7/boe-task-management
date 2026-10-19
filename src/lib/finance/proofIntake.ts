// ── Getting a payment-proof file ready, from any way it can arrive ───────────
//
// A proof reaches a form four ways: the file picker, drag-and-drop, a pasted
// screenshot, or a phone photo. Every one of them ends here, so there is ONE
// answer to "is this acceptable, and under what name and type will it be stored?"
//
// THE BUCKET IS UNCHANGED. payment-proofs still admits only JPEG, PNG, WEBP, GIF
// and PDF (20260672). Another image format (BMP, AVIF, TIFF, …) is therefore
// converted to JPEG here, in the browser, when the browser can read it, and
// refused in plain words when it cannot. Nothing is ever uploaded under a type
// the bucket would reject, and validateProofFile stays the single gate.

import { PROOF_ALLOWED_TYPES, validateProofFile } from '@/lib/paymentProof'

export const PROOF_ACCEPT_ATTR = 'image/*,.pdf'

export const PROOF_UNREADABLE_IMAGE =
  'This image format cannot be opened by your browser. Save it as JPG or PNG, or take a screenshot of it, and try again.'

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
  'application/pdf': 'pdf',
}

/** A screenshot pasted from the clipboard arrives called "image.png" (or nothing). */
export function isGenericProofName(name: string): boolean {
  return /^(image|screenshot|untitled|blob)?(\.[a-z0-9]+)?$/i.test(name.trim())
}

function two(n: number): string { return String(n).padStart(2, '0') }

/**
 * Gives a pasted or nameless file a name a reviewer can recognise
 * ("payment-proof-2026-10-19-1432.png"). A file that already has a real name
 * keeps it. Pure: the clock is a parameter.
 */
export function nameProofFile(file: File, now: Date = new Date()): File {
  if (!isGenericProofName(file.name)) return file
  const ext = EXT_BY_TYPE[file.type] ?? (file.name.split('.').pop()?.toLowerCase() || 'png')
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`
  return new File([file], `payment-proof-${stamp}.${ext}`, { type: file.type, lastModified: file.lastModified })
}

/**
 * An image the bucket does not admit but a browser can usually decode.
 * SVG is excluded on purpose: it is a document that can carry script, and a
 * payment proof is a picture of a payment.
 */
export function isConvertibleProofImage(file: File): boolean {
  if (!file.type.startsWith('image/')) return false
  if (file.type === 'image/svg+xml') return false
  return !(PROOF_ALLOWED_TYPES as readonly string[]).includes(file.type)
}

/** Browser-only: redraws an image as a JPEG. Resolves null when it cannot be read. */
async function convertToJpeg(file: File): Promise<File | null> {
  if (typeof window === 'undefined') return null
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement | null>(resolve => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => resolve(null)
      el.src = url
    })
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // JPEG has no transparency: paint white first so it does not turn black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (!blob) return null
    const base = file.name.replace(/\.[^.]+$/, '') || 'payment-proof'
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type ProofIntake = { file: File; error: null } | { file: null; error: string }

/**
 * Names, converts and validates one incoming file. Never throws.
 * The caller shows `error` or keeps `file`.
 */
export async function prepareProofFile(incoming: File): Promise<ProofIntake> {
  let file = nameProofFile(incoming)
  if (isConvertibleProofImage(file)) {
    const converted = await convertToJpeg(file)
    if (!converted) return { file: null, error: PROOF_UNREADABLE_IMAGE }
    file = converted
  }
  const problem = validateProofFile(file)
  return problem ? { file: null, error: problem } : { file, error: null }
}

/** Files carried by a clipboard or drag payload, in order. */
export function filesFromTransfer(items: ArrayLike<DataTransferItem> | null | undefined): File[] {
  const found: File[] = []
  if (!items) return found
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'file') continue
    const f = items[i].getAsFile()
    if (f) found.push(f)
  }
  return found
}
