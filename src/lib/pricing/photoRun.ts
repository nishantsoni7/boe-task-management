// Reading the product photos (Price Brain v2, phase 3B; fixed 24 Nov 2026 after the first live run stopped at 50 of 373).
// What went wrong then: the card asked as fast as it could and hit the route's 30-a-minute limit; the limit counted refused
// calls too, so it stayed shut; a failure every photo shared (the reading service refusing) was skipped photo by photo until
// the card stalled; and the card said "too large, or not a picture" whatever the reason. Pure: used by the route and the card.

/** The route's limit per person (per server instance). */
export const PHOTOS_PER_MINUTE = 30
/** The card starts a call of five at most every 10 s: 30 photos a minute, the route's limit. */
export const PACE_MS = 10_000
/** How long the card waits when the route still says "too many", and how many times in a row before it gives up. */
export const BUSY_WAIT_MS = 30_000
export const BUSY_TRIES = 4

/** A per-person limit that counts only the photos it lets through: a refused call adds nothing, so a minute's wait clears it. */
export function photoRateLimiter(perMinute = PHOTOS_PER_MINUTE) {
  // shortcut: per-instance memory, so the limit is per server instance, not global; move to the database if abused.
  const hits = new Map<string, number[]>()
  return (userId: string, n: number, now = Date.now()): boolean => {
    const recent = (hits.get(userId) ?? []).filter(t => now - t < 60_000)
    const refused = recent.length + n > perMinute
    hits.set(userId, refused ? recent : [...recent, ...Array<number>(n).fill(now)])
    return refused
  }
}

/** The image type from the file's own first bytes (a file named .png may hold a JPEG); null when it is none of the three. */
export function sniffMedia(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

type Result = { key: string; ok: boolean; error?: string }
/**
 * What one batch means for the run. The photos that failed are skipped; when EVERY photo of the batch failed for the same
 * reason, it is the service or the account, not the photos, so the run stops and says why instead of skipping on.
 */
export function batchOutcome(results: readonly Result[]): { skip: string[]; stop: string | null; reason: string | null } {
  const failed = results.filter(r => !r.ok)
  const reason = failed[0]?.error ?? null
  const shared = results.length > 0 && failed.length === results.length && failed.every(f => f.error === reason)
  return { skip: failed.map(f => f.key), stop: shared ? reason : null, reason }
}
