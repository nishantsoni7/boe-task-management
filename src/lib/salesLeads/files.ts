import { formatBytes, sanitizeFileName } from '@/lib/orderRequestAttachments'

// Files on a lead's update (owner, 2026-11-15; migration 20270722000000). One rule, in two places: the bucket
// sales-lead-files refuses anything above 10 MB or outside this list, and this file says so first, in words, before a byte
// leaves the browser. Keep the two in step (the migration's self-check counts fourteen types).

export const LEAD_FILES_BUCKET = 'sales-lead-files'
export const LEAD_FILE_MAX_BYTES = 10 * 1024 * 1024
export const LEAD_FILES_MAX = 10

/** What the bucket accepts, by the file's extension. A browser's own type is not trusted: Windows reports a CSV as Excel. */
const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain',
}
export const LEAD_FILE_TYPES: readonly string[] = [...new Set(Object.values(TYPE_BY_EXT))]
export const LEAD_FILE_ACCEPT = Object.keys(TYPE_BY_EXT).map(e => `.${e}`).join(',')
export const LEAD_FILE_TYPES_LABEL = 'photos, PDF, Word, Excel, PowerPoint, CSV or text'

/** The extension of a file name in lower case, without the dot ('' when it has none). */
export const extOf = (name: string): string => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * The type the file will be stored as, or null when it is not one of the accepted kinds. A pasted screenshot arrives named
 * "image.png" with a type; a file with no usable extension is accepted only when the browser names one of our own types.
 */
export function leadFileType(file: { name: string; type: string }): string | null {
  const byExt = TYPE_BY_EXT[extOf(file.name)]
  if (byExt) return byExt
  return LEAD_FILE_TYPES.includes(file.type) ? file.type : null
}

export type FileKind = 'image' | 'pdf' | 'sheet' | 'doc' | 'slides' | 'text'
export function fileKind(type: string): FileKind {
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.includes('sheet') || type === 'application/vnd.ms-excel' || type === 'text/csv') return 'sheet'
  if (type.includes('presentation') || type === 'application/vnd.ms-powerpoint') return 'slides'
  if (type.includes('word') || type === 'application/msword') return 'doc'
  return 'text'
}

/** A browser can draw these; a HEIC photo it cannot, so it is shown as a file. */
export const canPreview = (type: string): boolean => type === 'image/jpeg' || type === 'image/png' || type === 'image/webp'

/** A repeated paste or drop is a new File object with the same name, size and time. */
export const fileKey = (f: Pick<File, 'name' | 'size' | 'lastModified'>): string => `${f.name}|${f.size}|${f.lastModified}`

export type Refusal = { name: string; why: string }

/**
 * Sorts what a person picked, dropped or pasted into what can be queued and what cannot, with the reason in words. `have` is
 * how many files are already queued and `keys` their identities, so the ten-file limit and repeats count what is there.
 */
export function sortIncoming(incoming: readonly File[], have: number, keys: ReadonlySet<string>): { take: File[]; refused: Refusal[] } {
  const take: File[] = []
  const refused: Refusal[] = []
  const seen = new Set(keys)
  for (const f of incoming) {
    const name = f.name || 'A file'
    if (!leadFileType(f)) { refused.push({ name, why: `is not a kind we keep (${LEAD_FILE_TYPES_LABEL})` }); continue }
    if (f.size <= 0) { refused.push({ name, why: 'is empty' }); continue }
    // The size is checked again after a photo is made smaller; this is the quick look at what the person chose.
    if (f.size > LEAD_FILE_MAX_BYTES && leadFileType(f) !== 'image/jpeg' && leadFileType(f) !== 'image/webp') {
      refused.push({ name, why: `is over ${formatBytes(LEAD_FILE_MAX_BYTES)}` }); continue
    }
    const key = fileKey(f)
    if (seen.has(key)) continue
    if (have + take.length >= LEAD_FILES_MAX) { refused.push({ name, why: `would be more than ${LEAD_FILES_MAX} files on one update` }); continue }
    seen.add(key)
    take.push(f)
  }
  return { take, refused }
}

/** One line for the refusals: "notes.zip is not a kind we keep (...); big.pdf is over 10 MB". */
export const refusalLine = (refused: readonly Refusal[]): string =>
  refused.length === 0 ? '' : `Not added: ${refused.map(r => `${r.name} ${r.why}`).join('; ')}.`

/** "<lead id>/<random>-<clean name>": the first folder is the lead, which is what the bucket's policies read. */
export function leadFilePath(leadId: string, fileName: string, token: string): string {
  return `${leadId}/${token}-${sanitizeFileName(fileName)}`
}

/** What an update says when it is only files. */
export const noteForFiles = (n: number): string => (n === 1 ? 'Shared 1 file.' : `Shared ${n} files.`)

/**
 * What a failed upload says, in words (never the storage message itself). A refusal by the bucket's rules says why; a dropped
 * connection says to try again.
 */
export function uploadErrorWords(err: { message?: string | null; statusCode?: string | number | null } | null | undefined): string {
  const m = (err?.message ?? '').toLowerCase()
  if (/row-level security|unauthorized|403|not allowed|permission/.test(m) || String(err?.statusCode ?? '') === '403') return 'You cannot add files to this lead.'
  if (/exceeded the maximum|too large|payload|413/.test(m) || String(err?.statusCode ?? '') === '413') return `This is over ${formatBytes(LEAD_FILE_MAX_BYTES)}.`
  if (/mime|not supported|invalid.*type/.test(m)) return `This is not a kind we keep (${LEAD_FILE_TYPES_LABEL}).`
  if (/duplicate|already exists/.test(m)) return 'This file is already there. Remove it and add it again.'
  if (/failed to fetch|network|load failed|timeout|aborted/.test(m)) return 'The upload did not finish. Check the connection and retry.'
  return 'The upload did not finish. Retry.'
}

export { formatBytes }
