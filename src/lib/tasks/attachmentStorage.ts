import type { SupabaseClient } from '@supabase/supabase-js'

// Task attachments: one place that knows how to reach the bytes.
//
// `task-attachments` is being taken private (20260906000000 then
// 20260907000000). Every read must therefore go through a short-lived signed
// URL, and every write must record the OBJECT PATH rather than a permanent
// public URL.
//
// Nothing here needs the service role. Signing is done with the caller's own
// session, so Postgres decides whether they may have the object — see
// task_attachments_storage_select in 20260906000000, which requires Task
// Management module entry AND creator/assignee/delegator on the parent task.
// Knowing somebody else's path is worth nothing.

export const TASK_ATTACHMENTS_BUCKET = 'task-attachments'

/** Short enough that a leaked link expires before it is useful, long enough to
 *  open a document and read it. */
export const SIGNED_URL_TTL_SECONDS = 300

const PUBLIC_URL_MARKER = `/storage/v1/object/public/${TASK_ATTACHMENTS_BUCKET}/`

/**
 * What goes into the legacy `url` / `attachment_url` columns for NEW rows.
 *
 * Those columns are still NOT NULL, so something must be written — but it must
 * not be a public URL, or the product would keep minting permanently-readable
 * links for exactly the bucket being closed. This is a canonical reference
 * instead: it names the object without being fetchable by anyone, it resolves
 * through resolveAttachmentPath, and it is obviously not a URL to anyone
 * reading the table.
 *
 * REMOVAL POINT: once `url` and `attachment_url` are dropped (a migration after
 * 20260907000000 has been verified), delete this and stop writing those columns.
 */
export const CANONICAL_REF_PREFIX = `storage://${TASK_ATTACHMENTS_BUCKET}/`

export function canonicalAttachmentRef(path: string): string {
  return `${CANONICAL_REF_PREFIX}${path}`
}

/**
 * The object path inside a legacy public URL.
 *
 * TEMPORARY COMPATIBILITY. It exists so the frontend can deploy BEFORE
 * 20260906000000 backfills `storage_path`: during that window a row has only
 * `url`, and this recovers the path from it. It is pure string handling with no
 * fallback to fetching the public URL, so it becomes harmless — it simply stops
 * finding anything new to parse — the moment the bucket is private.
 *
 * REMOVAL POINT: once 20260907000000 is applied and every row has been verified
 * to carry a path, delete this function and the `?? storagePathFromUrl(...)`
 * branch in resolveAttachmentPath. Nothing else calls it.
 */
export function storagePathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null

  // Canonical reference written by this build. Not a URL, not fetchable.
  if (url.startsWith(CANONICAL_REF_PREFIX)) {
    const path = url.slice(CANONICAL_REF_PREFIX.length)
    return path.length > 0 ? path : null
  }

  const at = url.indexOf(PUBLIC_URL_MARKER)
  if (at === -1) return null
  const path = url.slice(at + PUBLIC_URL_MARKER.length).split('?')[0]
  return path.length > 0 ? path : null
}

/** A row from any of the three surfaces that can carry an attachment. */
export type AttachmentLocation = {
  storage_path?: string | null
  attachment_storage_path?: string | null
  url?: string | null
  attachment_url?: string | null
}

/**
 * Where the bytes are. Prefers the stored path and falls back to parsing a
 * legacy URL — see the removal note on storagePathFromUrl.
 */
export function resolveAttachmentPath(row: AttachmentLocation | null | undefined): string | null {
  if (!row) return null
  const stored = row.storage_path ?? row.attachment_storage_path
  if (stored) return stored
  return storagePathFromUrl(row.url ?? row.attachment_url)
}

/** The object path for a newly uploaded task-level attachment. */
export function buildTaskAttachmentPath(
  taskId: string,
  fileName: string,
  rand: () => string = () => Math.random().toString(36).slice(2),
  now: () => number = Date.now,
): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? fileName.slice(dot + 1) : 'bin'
  return `tasks/${taskId}/${now()}_${rand()}.${ext}`
}

// ── Signing ─────────────────────────────────────────────────────────────────

/**
 * A signed URL for one object, or null when the caller is not allowed to have
 * it. A refusal is NOT an error worth surfacing as a crash: an unauthorized
 * viewer should see a missing attachment, not a stack trace.
 */
export async function signAttachmentUrl(
  supabase: SupabaseClient,
  path: string | null | undefined,
  expiresIn: number = SIGNED_URL_TTL_SECONDS,
): Promise<string | null> {
  if (!path) return null
  const { data, error } = await supabase
    .storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .createSignedUrl(path, expiresIn)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/**
 * Signed URLs for many objects in one round trip, keyed by path.
 *
 * Paths the caller may not read come back absent from the map rather than
 * failing the batch, so one inaccessible attachment cannot blank a whole list.
 */
export async function signAttachmentUrls(
  supabase: SupabaseClient,
  paths: readonly (string | null | undefined)[],
  expiresIn: number = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const wanted = [...new Set(paths.filter((p): p is string => !!p))]
  const out = new Map<string, string>()
  if (wanted.length === 0) return out

  const { data, error } = await supabase
    .storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .createSignedUrls(wanted, expiresIn)
  if (error || !data) return out

  for (const row of data) {
    // supabase-js returns { path, signedUrl, error } per entry.
    if (row?.path && row.signedUrl && !row.error) out.set(row.path, row.signedUrl)
  }
  return out
}

// ── Writing ─────────────────────────────────────────────────────────────────

export type UploadedAttachment = { path: string }

/**
 * Upload one file and return its PATH. Deliberately returns no URL: a caller
 * that cannot get a permanent URL from here cannot accidentally persist one.
 */
export async function uploadTaskAttachment(
  supabase: SupabaseClient,
  path: string,
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const { error } = await supabase
    .storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .upload(path, file, { upsert: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, path }
}

/** Delete by stored path. Best-effort: a failure leaves an unreferenced object. */
export async function removeTaskAttachment(
  supabase: SupabaseClient,
  path: string | null | undefined,
): Promise<void> {
  if (!path) return
  const { error } = await supabase
    .storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .remove([path])
  if (error) console.error('[attachment] delete failed:', error.message)
}
