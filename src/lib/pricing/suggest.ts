// The suggested price (Pricing module, phase 7A, owner approved 2026-11-12). It learns from what BOE has already
// recorded, with nothing typed in, and changes by itself as new prices and outcomes arrive:
//   order  the price on an APPROVED PI (the strongest evidence: a client agreed and paid an advance)
//   won    the price on a quotation that was CONFIRMED
//   lost   the price on a quotation that was LOST (a ceiling the client would not pay)
//   quote  a price that was quoted and is still open (weakest)
// The points come from the database (pricing_points_for / pricing_price_book, 20270619000000); this file decides.

export type PointKind = 'order' | 'won' | 'lost' | 'quote'
export type PricePoint = { p: number; at: string; k: PointKind; q: number | null }
export type Confidence = 'high' | 'medium' | 'low'
export type Suggestion = { price: number; low: number; high: number; confidence: Confidence; basis: string; used: number }

const DAY = 86_400_000
const RECENT_DAYS = 548 // 18 months: older orders are history, not the price today

/** Rounded the way a price list reads: to ₹10 under ₹10,000, to ₹100 above. */
export function roundPrice(p: number): number {
  return p >= 10_000 ? Math.round(p / 100) * 100 : Math.round(p / 10) * 10
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Newest first; each newer point counts one step more than the next older one. */
function recencyWeighted(points: PricePoint[]): number {
  const n = points.length
  let sum = 0, weight = 0
  points.forEach((pt, i) => { const w = n - i; sum += pt.p * w; weight += w })
  return sum / weight
}

const lower = (c: Confidence): Confidence => (c === 'high' ? 'medium' : 'low')

export function suggestPrice(points: readonly PricePoint[], now: Date = new Date()): Suggestion | null {
  const valid = points.filter(pt => Number.isFinite(pt.p) && pt.p > 0)
    .map(pt => ({ ...pt, t: Date.parse(pt.at) || 0 }))
    .sort((a, b) => b.t - a.t)
  const recent = (k: PointKind) => valid.filter(pt => pt.k === k && now.getTime() - pt.t <= RECENT_DAYS * DAY)
  const orders = recent('order').slice(0, 6)
  const won = recent('won').slice(0, 6)
  const lost = recent('lost')

  let used: PricePoint[]
  let base: number
  let basis: string
  let confidence: Confidence
  if (orders.length > 0) {
    // Approved orders lead; confirmed quotations add evidence at half the weight of the same position.
    used = orders
    const wo = recencyWeighted(orders)
    base = won.length ? (wo * 2 + recencyWeighted(won)) / 3 : wo
    basis = `${orders.length} approved PI${orders.length === 1 ? '' : 's'}${won.length ? ` and ${won.length} won quotation${won.length === 1 ? '' : 's'}` : ''} in the last 18 months`
    const spread = (Math.max(...orders.map(o => o.p)) - Math.min(...orders.map(o => o.p))) / median(orders.map(o => o.p))
    confidence = orders.length >= 3 && spread <= 0.2 ? 'high' : 'medium'
  } else if (won.length > 0) {
    used = won
    base = recencyWeighted(won)
    basis = `${won.length} won quotation${won.length === 1 ? '' : 's'} (no approved PI yet)`
    confidence = won.length >= 2 ? 'medium' : 'low'
  } else {
    const quotes = valid.filter(pt => pt.k === 'quote' || pt.k === 'order' || pt.k === 'won').slice(0, 6)
    if (quotes.length === 0) return null
    used = quotes
    base = median(quotes.map(q => q.p))
    basis = `${quotes.length} earlier price${quotes.length === 1 ? '' : 's'}, none recently ordered or won`
    confidence = 'low'
  }

  // Lost at or below this price more than once: the market may not bear it.
  const lostBelow = lost.filter(l => l.p <= base).length
  if (lostBelow >= 2) {
    confidence = lower(confidence)
    basis += `; lost ${lostBelow} times at or below this price`
  }

  const prices = used.map(u => u.p)
  return {
    price: roundPrice(base),
    low: roundPrice(Math.min(...prices)),
    high: roundPrice(Math.max(...prices)),
    confidence, basis, used: used.length,
  }
}
