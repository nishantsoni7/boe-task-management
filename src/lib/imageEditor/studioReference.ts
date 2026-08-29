// The approved studio reference, and how it reaches Bria.
//
// SERVER ONLY. Read from disk, cached for the life of the process, and sent as
// a data URI inside the request body.
//
// WHY NOT THE fal.media URL
// -------------------------
// The accepted request pointed `ref_image_url` at a fal.media file. That URL is
// temporary: when it expires, every studio image silently stops matching the
// approved look, and the failure would show up as "the results changed" weeks
// later rather than as an error. The reference is BOE's approved standard, so
// it belongs in BOE's repository.
//
// WHY NOT public/
// ---------------
// `public/` is served to anyone who guesses the path. The reference is an
// internal art-direction asset, and nothing about this feature needs a browser
// to fetch it — the only reader is this server, on its way to fal. So it lives
// outside `public/` and travels as a data URI, which also means no publicly
// reachable URL is created for it anywhere.
//
// Next.js only ships files it knows the server needs; `outputFileTracingIncludes`
// in next.config.ts is what puts this one in the deployment.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the approved reference lives, relative to the repository root. */
export const REFERENCE_PATH = join('assets', 'image-editor', 'studio-reference.png')

export const REFERENCE_MIME = 'image/png'

/** Bria accepts jpeg, jpg, png and webp for a reference image. */
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024

export type ReferenceResult =
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; reason: 'missing' | 'unreadable' | 'too_large'; detail: string }

/**
 * Cached across requests.
 *
 * The file never changes at runtime — it changes when somebody commits a new
 * approved reference, which restarts the server — so re-reading and re-encoding
 * a megabyte of PNG on every image would be pure waste.
 */
let cached: ReferenceResult | null = null

/** Drops the cache. For tests, which write different fixtures to the same path. */
export function resetReferenceCache(): void {
  cached = null
}

/**
 * The approved reference as a data URI, or a reason it could not be loaded.
 *
 * Never throws and never falls back. A substitute reference would produce a
 * plausible-looking studio image that is NOT the one BOE approved, and an image
 * nobody can tell apart from an approved one is worse than no image — so a
 * missing reference is an error the route reports, not something it works around.
 */
export async function loadStudioReference(root = process.cwd()): Promise<ReferenceResult> {
  if (cached) return cached

  const path = join(root, REFERENCE_PATH)

  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    cached = {
      ok: false,
      reason: missing ? 'missing' : 'unreadable',
      // A path, never the file's contents.
      detail: `${REFERENCE_PATH} could not be read (${missing ? 'not found' : 'unreadable'})`,
    }
    return cached
  }

  if (bytes.byteLength === 0) {
    cached = { ok: false, reason: 'unreadable', detail: `${REFERENCE_PATH} is empty` }
    return cached
  }
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    cached = { ok: false, reason: 'too_large', detail: `${REFERENCE_PATH} is larger than Bria accepts` }
    return cached
  }

  cached = {
    ok: true,
    dataUrl: `data:${REFERENCE_MIME};base64,${bytes.toString('base64')}`,
    bytes: bytes.byteLength,
  }
  return cached
}
