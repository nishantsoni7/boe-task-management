import { istAddDays, istMonthEnd, istMonthStart, istMonthStartOffset } from '@/lib/istDate'
import type { Period } from './constants'
import { dayLabel } from './format'

// The days a Lead Master list is cut to. Every day is an India date written YYYY-MM-DD, as `<input type="date">` writes
// it; '' means that side is open. The database does the same sums (20270606000000), these are what the screen asks for
// and says.

export type DayRange = { from: string; to: string }
export const NO_DAYS: DayRange = { from: '', to: '' }

/** What the list asks the database for: one of the periods it has always known, or chosen days. */
export type LeadWhen = DayRange & { period: Period }

/**
 * Chosen days win over a card. Yesterday is sent as the day itself (not as the word) so a database that does not know
 * the word yet refuses the call instead of quietly answering "all time". A search looks through every day.
 */
export function leadWhen(period: Period, days: DayRange, today: string, searching: boolean): LeadWhen {
  if (searching) return { period: 'all', ...NO_DAYS }
  if (days.from || days.to) return { period: 'all', ...orderDays(days) }
  if (period === 'yesterday') {
    const yesterday = istAddDays(today, -1)
    return { period, from: yesterday, to: yesterday }
  }
  return { period, ...NO_DAYS }
}

/** A pair typed the wrong way round is the range between the two. */
export function orderDays({ from, to }: DayRange): DayRange {
  return from && to && from > to ? { from: to, to: from } : { from, to }
}

export const hasDays = (d: DayRange) => d.from !== '' || d.to !== ''

export type MonthKey = 'this' | 'last'

/** This month runs to today; last month is the whole of it. */
export function monthDays(which: MonthKey, today: string): DayRange {
  if (which === 'this') return { from: istMonthStart(today), to: today }
  const start = istMonthStartOffset(today, 1)
  return { from: start, to: istMonthEnd(start) }
}

/** 'this' / 'last' when the days are exactly that month, else null. */
export function monthOf(d: DayRange, today: string): MonthKey | null {
  for (const key of ['this', 'last'] as const) {
    const m = monthDays(key, today)
    if (m.from === d.from && m.to === d.to) return key
  }
  return null
}

const short = (date: string) => dayLabel(date).replace(/ \d{4}$/, '')
const sameYear = (a: string, b: string) => a.slice(0, 4) === b.slice(0, 4)

/** The words on the dates button: "Custom dates" until something is chosen, then what was chosen. */
export function rangeLabel(d: DayRange, today: string): string {
  if (!hasDays(d)) return 'Custom dates'
  const month = monthOf(d, today)
  if (month) return month === 'this' ? 'This month' : 'Last month'
  if (d.from && d.to) {
    if (d.from === d.to) return dayLabel(d.from)
    return `${sameYear(d.from, d.to) ? short(d.from) : dayLabel(d.from)} – ${dayLabel(d.to)}`
  }
  return d.from ? `From ${dayLabel(d.from)}` : `Until ${dayLabel(d.to)}`
}

/** Finishes "...received ___": "yesterday", "between 1 Nov and 5 Nov 2026". */
export function whenWords(when: LeadWhen): string {
  const { period, from, to } = when
  if (from || to) {
    if (from && to) {
      if (from === to) return period === 'yesterday' ? 'yesterday' : `on ${dayLabel(from)}`
      return `between ${sameYear(from, to) ? short(from) : dayLabel(from)} and ${dayLabel(to)}`
    }
    return from ? `from ${dayLabel(from)}` : `up to ${dayLabel(to)}`
  }
  return { today: 'today', yesterday: 'yesterday', week: 'in the last 7 days', month: 'in the last 30 days', all: 'so far' }[period]
}
