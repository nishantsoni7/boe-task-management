import { istAddDays } from '@/lib/istDate'

// How the Lead Master writes dates and history. Every date is India time: the database stamps the received day in
// India, and the screens never read it as UTC.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parts(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null
}

/** "12 Oct 2026". */
export function dayLabel(date: string): string {
  const p = parts(date)
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : date
}

/** "Mon 2 Nov 2026". */
export function dayLabelLong(date: string): string {
  const p = parts(date)
  if (!p) return date
  return `${WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${p.d} ${MONTHS[p.m - 1]} ${p.y}`
}

/** "Mon 16 Nov": the short day a follow-up is written with. */
export function dayShort(date: string): string {
  const p = parts(date)
  if (!p) return date
  return `${WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${p.d} ${MONTHS[p.m - 1]}`
}

/** The list's "Received" column: Today, Yesterday, then "12 Oct" (and the year once it is not this one). */
export function receivedLabel(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === istAddDays(today, -1)) return 'Yesterday'
  const p = parts(date)
  const t = parts(today)
  if (!p) return date
  return t && p.y === t.y ? `${p.d} ${MONTHS[p.m - 1]}` : dayLabel(date)
}

const WHEN = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
})

/** "2 Nov 2026, 11:20 am" for a moment in a lead's history. */
export function whenLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : WHEN.format(d).replace(/\b(am|pm)\b/i, m => m.toLowerCase())
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The India day ("2026-11-13") a moment in a lead's history fell on. */
export function istDayOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : IST_DAY.format(d)
}

/** "10:45 am", India time: the time beside an entry, under its day heading. */
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : IST_TIME.format(d).replace(/\b(am|pm)\b/i, m => m.toLowerCase())
}

/** The heading over one day of a lead's activity: Today, Yesterday, "Thursday, 12 November" (with the year once it is not this one). */
export function dayHeading(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === istAddDays(today, -1)) return 'Yesterday'
  const p = parts(day)
  if (!p) return day
  const name = `${LONG_DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]}, ${p.d} ${LONG_MONTHS[p.m - 1]}`
  return p.y === parts(today)?.y ? name : `${name} ${p.y}`
}

const FIELD_WORDS: Record<string, string> = {
  phone: 'the number', source: 'the source', name: 'the name', email: 'the email', location: 'the location', requirement: 'the requirement',
  quantity: 'the quantity', timeline: 'the timeline', segment: 'the segment', client_type: 'the client type',
  temperature: 'Hot, Warm or Cold', expected_value_paise: 'the expected value',
}

/** "phone, name" → "the number and the name". */
export function editedFields(detail: string | null): string {
  const words = (detail ?? '').split(',').map(w => w.trim()).filter(Boolean).map(w => FIELD_WORDS[w] ?? w)
  if (words.length === 0) return 'the details'
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('')
}

export const leadNumber = (n: number) => `#${n}`

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`
