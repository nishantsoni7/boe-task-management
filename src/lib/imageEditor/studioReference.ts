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
// WHERE IT ACTUALLY COMES FROM IN PRODUCTION
// ------------------------------------------
// Two sources, tried in order, because the obvious one does not survive a
// deployment:
//
//   1. THE LOCAL FILE. Present in a developer's checkout, and shipped by
//      `outputFileTracingIncludes` in next.config.ts to any deployment whose
//      build tree contains it. It is `.gitignore`d — a licensed art-direction
//      asset BOE deliberately keeps out of the repository — so a Vercel build,
//      which starts from a git clone, DOES NOT HAVE IT. Verified by exporting
//      HEAD to a clean tree: only the README is there, and the loader returns
//      `missing`. Relying on this file alone means every generation in
//      production fails with "reference not installed".
//
//   2. SUPABASE STORAGE, private bucket. Downloaded server-side with the
//      service-role key this app already holds, so no new secret exists and no
//      publicly reachable URL for the reference is ever created. This is what
//      makes the deployed module work.
//
// Both are server-only. The bytes reach Bria inside the request body as a data
// URI and never reach a browser.
//
// If NEITHER source has it, this returns `missing` and the route answers 503
// before any billable request — a misconfigured deployment costs nothing.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

/** Where the approved reference lives, relative to the repository root. */
export const REFERENCE_PATH = join('assets', 'image-editor', 'studio-reference.png')

export const REFERENCE_MIME = 'image/png'

/** Bria accepts jpeg, jpg, png and webp for a reference image. */
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024

/**
 * The private Supabase Storage bucket holding the reference in a deployment.
 *
 * Overridable so a staging project can point elsewhere, but it has a working
 * default: an environment variable nobody sets is an environment variable
 * somebody forgets, and the failure would be a 503 on every generation.
 */
export const REFERENCE_BUCKET = process.env.IMAGE_EDITOR_REFERENCE_BUCKET || 'image-editor'

/** The object's name inside that bucket. */
export const REFERENCE_OBJECT = 'studio-reference.png'

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
const cache = new Map<string, ReferenceResult>()

/**
 * Drops the cache. For tests, which write different fixtures to the same path.
 */
export function resetReferenceCache(): void {
  cache.clear()
}

/**
 * The approved reference as a data URI, or a reason it could not be loaded.
 *
 * Never throws and never falls back. A substitute reference would produce a
 * plausible-looking studio image that is NOT the one BOE approved, and an image
 * nobody can tell apart from an approved one is worse than no image — so a
 * missing reference is an error the route reports, not something it works around.
 */
/** Read the local file, or say why not. Never throws. */
async function fromDisk(root: string): Promise<ReferenceResult> {
  let bytes: Buffer
  try {
    bytes = await readFile(join(root, REFERENCE_PATH))
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    return {
      ok: false,
      reason: missing ? 'missing' : 'unreadable',
      // A path, never the file's contents.
      detail: `${REFERENCE_PATH} could not be read (${missing ? 'not found' : 'unreadable'})`,
    }
  }
  return validate(bytes, REFERENCE_PATH)
}

/**
 * Download from the private Supabase Storage bucket. Never throws.
 *
 * The service-role key is used because the bucket is private: an anon-readable
 * bucket would give the reference a publicly reachable URL, which is the thing
 * keeping it out of `public/` was for. The key is already in this app's
 * environment for the auth lookups the route performs, so nothing new is
 * introduced and nothing extra is exposed.
 */
async function fromStorage(): Promise<ReferenceResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const where = `${REFERENCE_BUCKET}/${REFERENCE_OBJECT}`

  if (!url || !key) {
    return { ok: false, reason: 'missing', detail: `${where} could not be read (storage not configured)` }
  }

  try {
    const storage = createClient(url, key, { auth: { persistSession: false } }).storage
    const { data, error } = await storage.from(REFERENCE_BUCKET).download(REFERENCE_OBJECT)
    if (error || !data) {
      // The provider's message is not forwarded; a bucket path is enough to act
      // on and cannot leak a key or a signed URL into a log.
      return { ok: false, reason: 'missing', detail: `${where} could not be read (not found in storage)` }
    }
    return validate(Buffer.from(await data.arrayBuffer()), where)
  } catch {
    return { ok: false, reason: 'unreadable', detail: `${where} could not be read (storage unreachable)` }
  }
}

/** The same size rules whichever source the bytes came from. */
function validate(bytes: Buffer, where: string): ReferenceResult {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'unreadable', detail: `${where} is empty` }
  }
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    return { ok: false, reason: 'too_large', detail: `${where} is larger than Bria accepts` }
  }
  return {
    ok: true,
    dataUrl: `data:${REFERENCE_MIME};base64,${bytes.toString('base64')}`,
    bytes: bytes.byteLength,
  }
}

/**
 * The approved reference as a data URI, or a reason it could not be loaded.
 *
 * Local file first, then Supabase Storage. Never throws and never falls back to
 * a substitute image: a plausible studio picture that is NOT the approved one
 * produces results nobody can tell apart from approved ones, which is worse
 * than a visible failure.
 *
 * Cached per root. The cache used to ignore its `root` argument, so a second
 * call with a different root returned the first root's bytes — harmless in the
 * app, which only ever passes one, and a real trap for anything comparing two
 * references.
 */
export async function loadStudioReference(root = process.cwd()): Promise<ReferenceResult> {
  const hit = cache.get(root)
  if (hit) return hit

  const disk = await fromDisk(root)
  if (disk.ok) {
    cache.set(root, disk)
    return disk
  }

  const storage = await fromStorage()

  let result: ReferenceResult
  if (storage.ok) {
    result = storage
  } else {
    // Both failed. Name both in the detail, and lead with the DISK reason when
    // a local file was actually there: "empty" or "larger than Bria accepts"
    // tells an operator exactly what to fix, where "not found in storage" would
    // send them to the wrong place. Only when there was no local file at all is
    // the storage reason the useful one.
    const diskExisted = disk.reason !== 'missing'
    result = {
      ok: false,
      reason: diskExisted ? disk.reason : storage.reason,
      detail: `${disk.detail}; ${storage.detail}`,
    }
  }

  cache.set(root, result)
  return result
}

/** Which source served the reference, for the startup log. Never the bytes. */
export async function referenceSource(root = process.cwd()): Promise<'disk' | 'storage' | 'none'> {
  if ((await fromDisk(root)).ok) return 'disk'
  if ((await fromStorage()).ok) return 'storage'
  return 'none'
}
