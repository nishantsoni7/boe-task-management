// Server-side pieces shared by the two Customize image routes
// (interpret-customization and regenerate-image): who may, and reading the
// line's current picture. SERVER ONLY — uses the service role for storage.

import type { SupabaseClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import { MAX_IMAGE_OBJECT_BYTES } from '@/lib/orders/submissionPayload'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'

/** The picture is sent at most this wide/tall: enough to read and edit, small to upload. */
const SEND_MAX_SIDE = 1600

/**
 * Whether this person may change the photos on this PI: the same rule as the
 * plain photo upload (../../app/api/orders/pi-edits/photo/route.ts). Asked as
 * the person, of the database.
 */
export async function mayChangePiPhotos(
  authClient: SupabaseClient,
  submissionId: string,
): Promise<'yes' | 'not_found' | 'forbidden'> {
  const { data: sub } = await authClient.from('order_submissions')
    .select('id, order_id').eq('id', submissionId).maybeSingle()
  if (!sub) return 'not_found'
  const orderId = (sub as { order_id: string | null }).order_id
  const checks = orderId
    ? [authClient.rpc('can_propose_order_pi_edit', { p_order_id: orderId })]
    : [authClient.rpc('can_edit_order_submission', { p_submission_id: submissionId }),
       authClient.rpc('can_admin_edit_order_submission', { p_submission_id: submissionId })]
  const answers = await Promise.all(checks)
  return answers.some(a => !a.error && a.data === true) ? 'yes' : 'forbidden'
}

/**
 * The line's current picture as a JPEG no larger than SEND_MAX_SIDE, or why
 * not. The caller has already checked `path` is this PI's canonical key.
 */
export async function loadSourcePicture(
  service: SupabaseClient,
  path: string,
): Promise<{ ok: true; jpeg: Buffer } | { ok: false; code: 'SOURCE_MISSING' | 'SOURCE_UNSUPPORTED' }> {
  const download = await service.storage.from('order-files').download(path)
  if (download.error || !download.data) return { ok: false, code: 'SOURCE_MISSING' }
  const bytes = new Uint8Array(await download.data.arrayBuffer())
  const format = sniffImageFormat(bytes)
  if ((format !== 'png' && format !== 'jpeg' && format !== 'webp') || bytes.length > MAX_IMAGE_OBJECT_BYTES) {
    return { ok: false, code: 'SOURCE_UNSUPPORTED' }
  }
  try {
    const jpeg = await sharp(bytes).rotate()
      .resize(SEND_MAX_SIDE, SEND_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer()
    return { ok: true, jpeg }
  } catch {
    return { ok: false, code: 'SOURCE_UNSUPPORTED' }
  }
}

export const SOURCE_MESSAGES = {
  SOURCE_MISSING: 'The product picture could not be read. Reload the page and try again.',
  SOURCE_UNSUPPORTED: 'This product picture cannot be edited. Replace it with a PNG, JPEG or WebP photo first.',
} as const

/** Per user, in memory: a spend guard on a route that costs money per press, not a security control. */
export function makeRateLimiter(maxPerMinute: number) {
  const recentCalls = new Map<string, number[]>()
  return (userId: string): boolean => {
    const now = Date.now()
    const recent = (recentCalls.get(userId) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= maxPerMinute) { recentCalls.set(userId, recent); return true }
    recent.push(now)
    recentCalls.set(userId, recent)
    return false
  }
}
