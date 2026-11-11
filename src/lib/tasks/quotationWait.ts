// How long a quotation request has been waiting, and how loud the Dashboard
// should make that (owner, 2026-11-11: "from how long is the lead pending").
//
// Waiting = time since the request was raised (tasks.created_at) until now,
// counted in WHOLE 24-HOUR DAYS. That is exactly the floor the Dashboard already
// sorts these rows by (`daysSince` in src/app/dashboard/page.tsx), and it has to
// stay that way: counting IST calendar days instead would let one row read
// "8 days" above another that reads "9 days". quotationWait.test.ts pins the
// two to the same expression.
//
// PURE: no clock of its own. The caller passes `now` (epoch ms).

export type WaitBand = 'fresh' | 'aging' | 'late'

/** Amber from this many whole days. The owner sets these numbers; change them here only. */
export const WAIT_AGING_DAYS = 2
/** Red from this many whole days. */
export const WAIT_LATE_DAYS = 4
/** The bar under the wait is full from this many days. */
export const WAIT_BAR_FULL_DAYS = 7

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export type QuotationWait = {
  /** Whole 24-hour days waited. */
  days: number
  band: WaitBand
  /** "Under 1 hour", "5 hours", "1 day", "9 days". */
  label: string
  /** 0..1, how much of the bar to fill. */
  fill: number
}

/** null when there is no usable created time. A created time in the future (clock skew) counts as no wait. */
export function quotationWait(createdAt: string | null | undefined, now: number): QuotationWait | null {
  if (!createdAt) return null
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return null

  const ms = Math.max(0, now - created)
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor(ms / HOUR_MS)

  const label =
    days >= 1 ? `${days} ${days === 1 ? 'day' : 'days'}`
    : hours >= 1 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}`
    : 'Under 1 hour'

  const band: WaitBand = days >= WAIT_LATE_DAYS ? 'late' : days >= WAIT_AGING_DAYS ? 'aging' : 'fresh'
  const fill = Math.min(ms / DAY_MS, WAIT_BAR_FULL_DAYS) / WAIT_BAR_FULL_DAYS

  return { days, band, label, fill }
}
