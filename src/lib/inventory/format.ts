import { formatINR } from '@/lib/currency'
import { istToday } from '@/lib/istDate'
import type { InventoryItem } from './constants'

/** Whole rupees stay whole; paise always show two digits (₹18,750.50, never ₹18,750.5). */
export function formatPrice(n: number): string {
  const v = Number(n)
  if (Number.isInteger(v)) return formatINR(v)
  return '₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
}

/** Whole days from `today` to `date` (both YYYY-MM-DD): positive = in the future. */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

export type ReadyState =
  | { kind: 'ready' }
  | { kind: 'soon'; days: number }       // a date is set and still ahead (or today)
  | { kind: 'overdue'; days: number }    // the date has passed and the piece is not marked ready
  | { kind: 'unknown' }                  // not ready, no date given

export function readyState(item: Pick<InventoryItem, 'stage' | 'expected_ready_on'>, today: string = istToday()): ReadyState {
  if (item.stage === 'ready') return { kind: 'ready' }
  if (!item.expected_ready_on) return { kind: 'unknown' }
  const d = daysBetween(today, item.expected_ready_on)
  return d >= 0 ? { kind: 'soon', days: d } : { kind: 'overdue', days: -d }
}

const plural = (n: number, one: string, other: string) => (n === 1 ? one : other)

/** The sentence a salesperson can read out to a customer. */
export function readyText(item: Pick<InventoryItem, 'stage' | 'expected_ready_on'>, today?: string): string {
  const s = readyState(item, today)
  switch (s.kind) {
    case 'ready': return 'Ready to ship'
    case 'soon':
      if (s.days === 0) return 'Ready today'
      if (s.days === 1) return 'Ready by tomorrow'
      return `Ready in about ${s.days} days`
    case 'overdue': return `Was due ${s.days} ${plural(s.days, 'day', 'days')} ago, check with the factory`
    case 'unknown': return 'Ready date not set yet'
  }
}

/** Short form for a card. */
export function readyShort(item: Pick<InventoryItem, 'stage' | 'expected_ready_on'>, today?: string): string {
  const s = readyState(item, today)
  switch (s.kind) {
    case 'ready': return 'Ready now'
    case 'soon': return s.days === 0 ? 'Ready today' : s.days === 1 ? 'Ready tomorrow' : `Ready in ~${s.days} days`
    case 'overdue': return `${s.days} ${plural(s.days, 'day', 'days')} overdue`
    case 'unknown': return 'Date not set'
  }
}

export type StockState = 'in_stock' | 'low' | 'out'

/** Low = at most 3 units free AND a fifth or less of what was stocked. */
export function stockState(item: Pick<InventoryItem, 'qty_available' | 'qty_total'>): StockState {
  if (item.qty_available <= 0) return 'out'
  if (item.qty_available <= 3 && item.qty_available * 5 <= item.qty_total) return 'low'
  return 'in_stock'
}

export const stockText = (item: Pick<InventoryItem, 'qty_available' | 'qty_total'>) =>
  item.qty_available <= 0 ? 'Sold out' : `${item.qty_available} available`

export const sortedImages = (item: Pick<InventoryItem, 'inventory_images'>) =>
  [...item.inventory_images].sort((a, b) => a.position - b.position)

/** First picture in order, or null. */
export const thumbPath = (item: Pick<InventoryItem, 'inventory_images'>): string | null =>
  sortedImages(item)[0]?.path ?? null

/** "12 Oct, 3:40 pm" in IST. */
export function shortDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  }).format(new Date(iso))
}

/** "+919876543210" becomes "+91 98765 43210". Other numbers are shown as stored. */
export function formatPhone(e164: string | null): string {
  if (!e164) return ''
  const m = /^\+91([6-9]\d{4})(\d{5})$/.exec(e164)
  return m ? `+91 ${m[1]} ${m[2]}` : e164
}
