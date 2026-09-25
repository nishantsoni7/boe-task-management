// ── A PI's product-image key, and nothing that only looks like one ────────────
//
// Every product picture lives at ONE canonical key in the private order-files
// bucket:
//
//   submissions/{submission}/images/{item}/{role}/{position}-{sha256}.{ext}
//
// the shape order_submission_item_images_path_shape rebuilds from a stored
// row. A key that arrives any other way — in an edit proposal, in a version's
// captured content — is checked against that shape before it is stored and
// again before any privileged (service-role) download. A prefix test is not
// enough: "submissions/{id}/images/../../../other/file" starts with the right
// folder, and the storage client joins it into a URL whose parser resolves
// the "..", reading any object in any bucket. The whole key must match, so no
// dot segment, encoded character, backslash, doubled or trailing separator, or
// other folder can pass. SQL twin: order_pi_image_key_is_canonical().

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const KEY = new RegExp(
  `^submissions/(${UUID})/images/(${UUID})/(representative|customization)/(0|[1-9][0-9]{0,3})-([0-9a-f]{64})\\.(png|jpg|jpeg|webp)$`,
)

export type PiImageKeyParts = {
  submissionId: string
  itemId: string
  role: 'representative' | 'customization'
  position: number
  sha256: string
}

/** The parts of a canonical key, or null for anything else. */
export function parsePiImageKey(path: unknown): PiImageKeyParts | null {
  if (typeof path !== 'string') return null
  const m = KEY.exec(path)
  if (!m) return null
  return { submissionId: m[1], itemId: m[2], role: m[3] as PiImageKeyParts['role'], position: Number(m[4]), sha256: m[5] }
}

/**
 * True only for a canonical key inside THIS PI's image folder — and, when
 * given, for exactly this line, role, slot and content hash.
 */
export function isCanonicalPiImageKey(
  path: unknown,
  expect: { submissionId: string; itemId?: string | null; role?: string | null; position?: number | null; sha256?: string | null },
): boolean {
  const k = parsePiImageKey(path)
  if (!k || k.submissionId !== expect.submissionId.toLowerCase()) return false
  if (expect.itemId != null && k.itemId !== expect.itemId.toLowerCase()) return false
  if (expect.role != null && k.role !== expect.role) return false
  if (expect.position != null && k.position !== expect.position) return false
  if (expect.sha256 != null && k.sha256 !== expect.sha256.toLowerCase()) return false
  return true
}

/**
 * Every picture a built Edit PI proposal names: each image row is this PI's
 * key for its own line, role, slot and bytes, and each line's picture is this
 * PI's key for that line. What propose_order_pi_edit_revision() re-checks.
 */
export function proposalImagesAreCanonical(payload: Record<string, unknown>, submissionId: string): boolean {
  const images = Array.isArray(payload.item_images) ? payload.item_images as Record<string, unknown>[] : []
  const items = Array.isArray(payload.items) ? payload.items as Record<string, unknown>[] : []
  return images.every(m => isCanonicalPiImageKey(m?.storage_path, {
    submissionId, itemId: String(m?.item_id ?? ''), role: String(m?.role ?? ''),
    position: Number(m?.position), sha256: String(m?.sha256 ?? ''),
  })) && items.every(i => i?.image_storage_path == null
    || isCanonicalPiImageKey(i.image_storage_path, { submissionId, itemId: String(i.id ?? '') }))
}
