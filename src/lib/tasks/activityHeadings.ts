// WHAT AN ACTIVITY ENTRY SAYS HAPPENED, WHEN FILES CAME WITH IT.
//
// The activity feed writes one `note_added` row for every "Send Update", and
// that row is the SAME row whether the person typed a sentence, attached a
// file, or did both. Reading the action alone therefore produced "Nishant
// commented" for an entry that carries no comment at all — only a PDF. The
// heading described the storage shape, not the event.
//
// So the phrase is derived from what the row actually holds:
//
//   note only              commented
//   files only             attached a document / attached 2 images / attached 3 files
//   note AND files         commented and attached a document
//
// ── WHY "document" AND "image" ARE THE ONLY TWO WORDS ───────────────────────
//
// A reader scanning a feed wants to know whether to expect something to LOOK at
// or something to READ. PDF/Word/Excel/CSV/archive all answer the same way, so
// splitting them further buys nothing and multiplies the sentences a translator
// or a test has to cover. Anything that is not recognisably an image is a
// document; a MIXED set falls back to the neutral "files", because calling two
// photos and a spreadsheet "3 documents" would be wrong about the photos.
//
// ── WHAT COUNTS AS AN ATTACHMENT ────────────────────────────────────────────
//
// Both shapes the feed carries: the modern `task_attachments` rows, and the one
// LEGACY `attachment_url` column an older build wrote a single file into. The
// caller passes whatever it has; empty entries are ignored rather than counted,
// so a row with an empty string in the legacy column never claims a file.

/** One attached file, as little of it as the phrasing needs. */
export type ActivityAttachmentInfo = {
  /** `task_attachments.file_type` — already one of the getFileTypeLabel words. */
  fileType?: string | null
  /** File name or storage path; used only when `fileType` says nothing. */
  name?: string | null
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'bmp', 'svg']

/**
 * Is this file something to look at rather than read?
 *
 * `fileType` is trusted first because it is the stored classification. The name
 * is only consulted when the type is missing or unrecognised — historical rows
 * have a null `file_type`, and the legacy single-attachment column has no type
 * column at all.
 */
function isImage(file: ActivityAttachmentInfo): boolean {
  const type = typeof file.fileType === 'string' ? file.fileType.trim().toLowerCase() : ''
  if (type) {
    if (type === 'image' || type.startsWith('image/')) return true
    // A known non-image label is an answer; anything else falls through to the
    // name rather than being taken as "not an image" on no evidence.
    if (['pdf', 'word', 'excel', 'csv', 'archive', 'file'].includes(type)) return false
  }
  const name = typeof file.name === 'string' ? file.name : ''
  const bare = name.split(/[?#]/)[0]
  const dot = bare.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.includes(bare.slice(dot + 1).toLowerCase())
}

/** "a document", "2 images", "3 files" — never a count of zero. */
export function attachmentPhrase(files: readonly ActivityAttachmentInfo[]): string | null {
  if (files.length === 0) return null
  const images = files.filter(isImage).length
  const documents = files.length - images

  if (images > 0 && documents > 0) return `${files.length} files`
  if (images > 0) return images === 1 ? 'an image' : `${images} images`
  return documents === 1 ? 'a document' : `${documents} documents`
}

/**
 * The heading phrase that follows the actor's name for a `note_added` entry.
 *
 * Returns null when there is neither text nor a file — the caller keeps its own
 * wording for that case rather than this module inventing one, because an empty
 * row means different things in the task feed and the quotation feed.
 */
export function commentHeadingRest(
  note: string | null | undefined,
  files: readonly ActivityAttachmentInfo[] = [],
): string | null {
  const hasNote = typeof note === 'string' && note.trim().length > 0
  const phrase = attachmentPhrase(files)

  if (phrase && hasNote) return `commented and attached ${phrase}`
  if (phrase)            return `attached ${phrase}`
  if (hasNote)           return 'commented'
  return null
}
