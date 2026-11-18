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

const TOKEN = /^[0-9a-f]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A reason the picture-file request is not valid, or null: a picture path, and exactly one of a client token or a quotation id. */
export function pictureRequestProblem(path: unknown, token: unknown, id: unknown): string | null {
  if (typeof path !== 'string' || !PATH.test(path)) return 'That picture path is not valid.'
  const hasToken = typeof token === 'string' && token !== ''
  const hasId = typeof id === 'string' && id !== ''
  if (hasToken === hasId) return 'Give the client token or the quotation id, not both and not neither.'
  if (hasToken && !TOKEN.test(token as string)) return 'That link is not valid.'
  if (hasId && !UUID.test(id as string)) return 'That quotation id is not valid.'
  return null
}
