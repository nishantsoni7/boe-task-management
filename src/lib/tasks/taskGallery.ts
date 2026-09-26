// Task Detail attachment gallery — the pure half.
//
// Everything here is free of React and of Supabase so the ordering, naming and
// ZIP rules can be tested directly. The component (TaskAttachmentGallery) does
// the signing and fetching through the caller's own session, exactly as the
// single-file preview always has — see attachmentStorage.ts. No storage URL is
// ever built here; entries carry OBJECT PATHS only.

import { getExt, getFileTypeLabel, IMAGE_EXTS } from '@/lib/attachment-utils'
import { resolveAttachmentPath, type AttachmentLocation } from '@/lib/tasks/attachmentStorage'

export type GalleryEntry = {
  /** Stable React key: the row id, or `legacy` for tasks.attachment_url. */
  key:      string
  /** Object key in the task-attachments bucket. */
  path:     string
  /** What the user sees and what the download is named. */
  fileName: string
  /** The recorded type label, or one derived from the name. */
  typeLabel: string
  isImage:  boolean
}

type TaskLevelRow = AttachmentLocation & {
  id: string
  file_name?: string | null
  file_type?: string | null
}

/** Last path segment, for the legacy single attachment that has no file_name. */
export function baseName(path: string): string {
  const last = path.split('/').pop() ?? path
  try { return decodeURIComponent(last) } catch { return last }
}

/** An image by the same rule the preview modal uses: the name first, then the path. */
export function isImageName(nameOrPath: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(getExt(nameOrPath))
}

/**
 * The task's own attachments, in display order.
 *
 * Order is unchanged from the list this replaces: the legacy single
 * attachment first (only when no task_attachments row already points at the
 * same object), then task_attachments rows in the order the query returned
 * them. Rows whose object cannot be located are skipped, as before — the old
 * list rendered them as a button that did nothing.
 */
export function buildGalleryEntries(
  legacy: AttachmentLocation | null | undefined,
  rows: readonly TaskLevelRow[],
): GalleryEntry[] {
  const out: GalleryEntry[] = []
  const legacyPath = resolveAttachmentPath(legacy)
  if (legacyPath && !rows.some(r => resolveAttachmentPath(r) === legacyPath)) {
    const name = baseName(legacyPath)
    out.push({
      key: 'legacy', path: legacyPath, fileName: name,
      typeLabel: getFileTypeLabel(legacyPath), isImage: isImageName(legacyPath),
    })
  }
  for (const r of rows) {
    const path = resolveAttachmentPath(r)
    if (!path) continue
    const name = r.file_name?.trim() || baseName(path)
    // The display name decides the type, falling back to the path — the same
    // precedence AttachmentPreviewModal uses, so a file never shows as an
    // image here and as a document there.
    const image = name.includes('.') ? isImageName(name) : isImageName(path)
    out.push({
      key: r.id, path, fileName: name,
      typeLabel: r.file_type ?? getFileTypeLabel(name),
      isImage: image,
    })
  }
  return out
}

/** "3 images", "1 image · 2 files", "2 files". */
export function galleryCountLabel(entries: readonly GalleryEntry[]): string {
  const images = entries.filter(e => e.isImage).length
  const files  = entries.length - images
  const parts: string[] = []
  if (images > 0) parts.push(`${images} ${images === 1 ? 'image' : 'images'}`)
  if (files > 0)  parts.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  return parts.join(' · ')
}

// ── ZIP naming ──────────────────────────────────────────────────────────────

// Characters Windows refuses in a filename, plus control characters. The
// separators matter most: a name containing "/" would create a folder inside
// the archive, and "../" would try to climb out of it on extraction.
const UNSAFE = /[\u0000-\u001f<>:"/\\|?*]/g

/** A single safe filename component. Never empty, never a dot-only name. */
export function safeFileName(name: string, fallback = 'image'): string {
  let s = name.replace(UNSAFE, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/, '')          // Windows drops trailing dots/spaces
  if (!s || /^\.+$/.test(s)) s = fallback
  if (s.length > 150) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : ''
    s = s.slice(0, 150 - ext.length) + ext
  }
  return s
}

/**
 * One archive name per input, in input order, with collisions resolved as
 * "photo.jpg", "photo (2).jpg", "photo (3).jpg". Comparison is
 * case-insensitive because Windows and macOS extract "IMG.JPG" and "img.jpg"
 * over one another.
 */
export function uniqueZipNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map(raw => {
    const safe = safeFileName(raw)
    const dot  = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext  = dot > 0 ? safe.slice(dot) : ''
    let candidate = safe
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/** "Fix the gate - images.zip": the task title, bounded and made safe. */
export function zipFileNameForTask(title: string | null | undefined): string {
  const t = safeFileName((title ?? '').slice(0, 60), 'Task')
  return `${t} - images.zip`
}

/**
 * Build the archive. Images are already compressed formats, so they are
 * STORED (level 0): deflating a JPEG costs time and saves nothing.
 * fflate is imported lazily, the same idiom as the Orders workbook code, so it
 * stays out of the Task Detail bundle until someone actually downloads.
 */
export async function buildZip(files: readonly { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { zipSync } = await import('fflate')
  const input: Record<string, [Uint8Array, { level: 0 }]> = {}
  for (const f of files) input[f.name] = [f.bytes, { level: 0 }]
  return zipSync(input)
}

/** Next/previous index, wrapping at both ends. */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return ((current + delta) % count + count) % count
}

/** Whether URLs signed at `signedAt` (epoch ms) are too old to hand to a viewer. */
export function signatureIsStale(signedAt: number, maxAgeMs: number, now: number = Date.now()): boolean {
  return now - signedAt > maxAgeMs
}
