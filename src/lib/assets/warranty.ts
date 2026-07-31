// Asset warranty status — derived, never stored.
//
// The database keeps warranty_start_date / warranty_expiry_date and nothing
// else. A stored "warranty_status" column would be a second copy of a fact
// that changes by itself every midnight, and would be wrong on any row nobody
// happened to touch that day. So the status is computed from the dates every
// time it is displayed, and there is exactly one function that does it.
//
// The four states, and what each actually means:
//   'active'        — an expiry date is recorded and it has not passed
//   'expiring_soon' — active, and within EXPIRING_SOON_DAYS of the expiry
//   'expired'       — an expiry date is recorded and it has passed
//   'not_available' — no expiry date recorded. NOT the same as expired: it
//                     means nobody wrote the warranty down, which is the state
//                     almost every pre-existing asset is in.

export type WarrantyStatus = 'active' | 'expiring_soon' | 'expired' | 'not_available'

/** How far ahead "Expiring Soon" starts. One month of notice, per the brief. */
export const EXPIRING_SOON_DAYS = 30

export const WARRANTY_STATUS_LABEL: Record<WarrantyStatus, string> = {
  active:        'Active',
  expiring_soon: 'Expiring Soon',
  expired:       'Expired',
  not_available: 'Not Available',
}

export const WARRANTY_STATUS_OPTIONS: readonly WarrantyStatus[] = [
  'active', 'expiring_soon', 'expired', 'not_available',
]

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Midnight-UTC epoch for a `YYYY-MM-DD` string or a Date, or null if it is not
 * a usable date.
 *
 * Comparison is done in whole days at UTC on BOTH sides, so "expires today" is
 * never flipped by the reader's timezone. A warranty is a calendar fact, not a
 * timestamp: it does not expire at 05:30 because the browser is in IST.
 */
function toUtcDay(value: string | Date | null | undefined): number | null {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return null
  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
}

/**
 * Whole days from `now` until `expiry`. Negative once the date has passed,
 * 0 on the expiry date itself. Null when either side is unusable.
 */
export function daysUntilWarrantyExpiry(
  expiryDate: string | Date | null | undefined,
  now: string | Date = new Date(),
): number | null {
  const expiry = toUtcDay(expiryDate)
  const today  = toUtcDay(now)
  if (expiry === null || today === null) return null
  return Math.round((expiry - today) / MS_PER_DAY)
}

/**
 * The warranty state of one asset.
 *
 * `thresholdDays` is a parameter rather than a constant read inside, so the
 * rule can be asserted at its boundaries without moving the calendar.
 */
export function warrantyStatus(
  expiryDate: string | Date | null | undefined,
  now: string | Date = new Date(),
  thresholdDays: number = EXPIRING_SOON_DAYS,
): WarrantyStatus {
  const days = daysUntilWarrantyExpiry(expiryDate, now)
  // No expiry recorded — or one that cannot be read as a date. Both mean the
  // same thing to a reader: there is no warranty information here.
  if (days === null) return 'not_available'
  if (days < 0) return 'expired'
  if (days <= thresholdDays) return 'expiring_soon'
  return 'active'
}

/**
 * The sentence shown beside the badge. States the date and the distance to it,
 * and says nothing at all when there is no date — never "expires never".
 */
export function warrantyDetailLine(
  expiryDate: string | Date | null | undefined,
  now: string | Date = new Date(),
  thresholdDays: number = EXPIRING_SOON_DAYS,
): string | null {
  const days = daysUntilWarrantyExpiry(expiryDate, now)
  if (days === null) return null
  if (days < 0) {
    const ago = Math.abs(days)
    return `Expired ${ago} day${ago === 1 ? '' : 's'} ago`
  }
  if (days === 0) return 'Expires today'
  if (days <= thresholdDays) return `Expires in ${days} day${days === 1 ? '' : 's'}`
  return `Expires in ${days} days`
}

/** Assets whose warranty is inside the notice window and not yet expired. */
export function isWarrantyExpiringSoon(
  expiryDate: string | Date | null | undefined,
  now: string | Date = new Date(),
  thresholdDays: number = EXPIRING_SOON_DAYS,
): boolean {
  return warrantyStatus(expiryDate, now, thresholdDays) === 'expiring_soon'
}

/**
 * Whether a warranty date pair is coherent. Mirrors the
 * assets_warranty_dates_ordered constraint, so the form refuses what the
 * database would refuse — with a sentence instead of a constraint name.
 */
export function validateWarrantyDates(
  startDate: string | null | undefined,
  expiryDate: string | null | undefined,
): string | null {
  const start = toUtcDay(startDate)
  const end   = toUtcDay(expiryDate)
  if (startDate && start === null) return 'Warranty start date is not a valid date.'
  if (expiryDate && end === null) return 'Warranty expiry date is not a valid date.'
  if (start !== null && end !== null && end < start) {
    return 'Warranty expiry cannot be earlier than the warranty start date.'
  }
  return null
}
