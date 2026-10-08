import { istDateOf } from '@/lib/istDate'
import type { Exhibition } from './constants'

// Display helpers. Everything is Asia/Kolkata, whatever the viewer's device says.

const IST = 'Asia/Kolkata'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parts(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
}

/** '2026-10-09' → '9 Oct' */
export function shortDate(date: string): string {
  const { m, d } = parts(date)
  return `${d} ${MONTHS[m - 1]}`
}

/** '2026-10-09' → 'Fri, 9 Oct 2026' */
export function longDate(date: string): string {
  const { y, m, d, weekday } = parts(date)
  return `${WEEKDAYS[weekday]}, ${d} ${MONTHS[m - 1]} ${y}`
}

/** An instant → '9 Oct, 3:45 pm' in IST. */
export function istDateTime(iso: string): string {
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))
  return `${shortDate(istDateOf(iso))}, ${time.toLowerCase()}`
}

export function exhibitionDates(e: Pick<Exhibition, 'starts_on' | 'ends_on'>): string {
  const a = parts(e.starts_on)
  const b = parts(e.ends_on)
  if (e.starts_on === e.ends_on) return longDate(e.starts_on)
  return a.m === b.m && a.y === b.y
    ? `${a.d}–${b.d} ${MONTHS[b.m - 1]} ${b.y}`
    : `${shortDate(e.starts_on)} – ${shortDate(e.ends_on)} ${b.y}`
}

/**
 * The exhibition the form opens on: the one running today, else the next one
 * to start, else the most recent one that ended.
 */
export function pickDefaultExhibition<T extends Pick<Exhibition, 'starts_on' | 'ends_on'>>(
  list: readonly T[], today: string,
): T | null {
  if (list.length === 0) return null
  const running = list.find(e => e.starts_on <= today && today <= e.ends_on)
  if (running) return running
  const upcoming = list.filter(e => e.starts_on > today).sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0]
  if (upcoming) return upcoming
  return [...list].sort((a, b) => b.ends_on.localeCompare(a.ends_on))[0]
}
