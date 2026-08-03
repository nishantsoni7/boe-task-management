/**
 * Asia/Kolkata business-date helpers.
 *
 * Everything the Performance module calls a "day" is an Indian business day,
 * not a UTC day. `new Date().toISOString().slice(0, 10)` returns the UTC date,
 * which between 00:00 and 05:30 IST is *yesterday* — so work logged at 1am IST
 * was being scored against the previous day, and "today" flipped over at
 * 5:30am instead of midnight.
 *
 * IST is a fixed UTC+05:30 offset with no daylight saving, so plain offset
 * arithmetic is exact — no Intl / timezone database needed.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const DAY_MS        = 24 * 60 * 60 * 1000

/** The IST calendar date (YYYY-MM-DD) an instant falls on. */
export function istDateOf(instant: Date | string | number): string {
  const ms = instant instanceof Date ? instant.getTime()
           : typeof instant === 'number' ? instant
           : Date.parse(instant)
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** Today's IST business date. */
export function istToday(now: Date = new Date()): string {
  return istDateOf(now)
}

/** UTC instant of 00:00:00.000 IST on the given business date. */
export function istDayStartUtc(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS).toISOString()
}

/** UTC instant of 23:59:59.999 IST on the given business date. */
export function istDayEndUtc(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS + DAY_MS - 1).toISOString()
}

/**
 * Minutes past IST midnight for an instant (0–1439).
 *
 * Used by System Adoption to ask "was this open within the start window?".
 * Reading `getHours()` on a server in any other timezone would answer a different
 * question, and reading it in the browser would answer the *device's* question.
 */
export function istMinutesOfDay(instant: Date | string | number): number {
  const ms = instant instanceof Date ? instant.getTime()
           : typeof instant === 'number' ? instant
           : Date.parse(instant)
  const shifted = new Date(ms + IST_OFFSET_MS)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** `minutes` past midnight as a 24-hour clock label, e.g. 605 → "10:05". */
export function formatMinutesOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = Math.round(minutes) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * The UTC instant of an IST wall-clock time on a business date.
 *
 * The inverse of `istMinutesOfDay` + `formatMinutesOfDay`, and the same
 * conversion the fingerprint import performs on machine times — an attendance
 * correction typed as "10:07" must land on exactly the instant an imported
 * 10:07 punch would. Returns null for anything that is not a valid HH:MM.
 */
export function istClockToUtc(date: string, clock: string): string | null {
  const parts = clock.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!parts) return null
  const hours   = Number(parts[1])
  const minutes = Number(parts[2])
  if (hours > 23 || minutes > 59) return null

  const dayStart = Date.parse(`${date}T00:00:00.000Z`)
  if (isNaN(dayStart)) return null
  return new Date(dayStart - IST_OFFSET_MS + (hours * 60 + minutes) * 60_000).toISOString()
}

/** An instant as an IST 24-hour clock label, e.g. "10:07". */
export function istClockOf(instant: Date | string | number): string {
  return formatMinutesOfDay(istMinutesOfDay(instant))
}

/** Shift a business date by whole days. Negative goes back. */
export function istAddDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Inclusive list of business dates, oldest first. */
export function istDateRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = istAddDays(d, 1)) out.push(d)
  return out
}

/** The last `count` business dates ending at `end`, oldest first. */
export function istLastNDays(count: number, end: string = istToday()): string[] {
  return istDateRange(istAddDays(end, -(count - 1)), end)
}

/**
 * Monday of the week containing `date`. BOE weeks run Monday–Saturday with
 * Sunday as the weekly off, so Monday is the natural week start.
 */
export function istWeekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()   // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1
  return istAddDays(date, -backToMonday)
}

/** First business date of the month containing `date`. */
export function istMonthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** Last business date of the month containing `date`. */
export function istMonthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number)
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/** First business date of the month `offset` months before the one holding `date`. */
export function istMonthStartOffset(date: string, offset: number): string {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 - offset, 1)).toISOString().slice(0, 10)
}
