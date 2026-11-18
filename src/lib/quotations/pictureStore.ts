// Where quotation pictures live (owner, 18 Nov 2026, logo marks): the clean original in the PRIVATE bucket, the marked
// copy in the PUBLIC one, both at the same path. Shared by the upload, the mark route and the image studio.

export const ORIGINALS_BUCKET = 'quotation-originals'

const PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/

/** A reason the path cannot be marked by this caller, or null. The path is the uploader's own folder and a .jpg. */
export function storedPictureProblem(path: unknown, userId: string): string | null {
  if (typeof path !== 'string' || !PATH.test(path)) return 'That picture path is not valid.'
  if (path.split('/')[0] !== userId) return 'Only the person who uploaded a picture can mark it.'
  return null
}
