// Rate reminders (Price Brain v2, phase 4; owner decision D7, 23 Nov 2026): steel is reviewed every 30 days, wood every 90,
// and a missing rate is due at once. A rate is reviewed when it is saved, changed or not ("Still right" on the rates page
// saves it unchanged, which stamps its date). Shown to people who may teach in Pricing, on For you, until every rate is
// reviewed. Pure: the lists in, what is due out.

export const REVIEW_DAYS = { wood: 90, metal: 30 } as const
const DAY = 86_400_000

export type RateKind = keyof typeof REVIEW_DAYS
export type RateRow = { name: string; rate: number | string | null; updated_at: string }
/** A rate due for review: `days` since it was last saved, or null when it was never entered. */
export type DueRate = { kind: RateKind; name: string; days: number | null }

/** Days since the rate was last saved (whole days, never below zero). */
export const daysSince = (at: string, now: number) => Math.max(0, Math.floor((now - (Date.parse(at) || now)) / DAY))

export function isDue(kind: RateKind, r: RateRow, now: number): boolean {
  return r.rate === null || daysSince(r.updated_at, now) >= REVIEW_DAYS[kind]
}

/** Every rate due for review: missing rates first, then the oldest. */
export function dueRates(woods: readonly RateRow[], metals: readonly RateRow[], now = Date.now()): DueRate[] {
  const due = (kind: RateKind, rows: readonly RateRow[]) => rows.filter(r => isDue(kind, r, now))
    .map((r): DueRate => ({ kind, name: r.name, days: r.rate === null ? null : daysSince(r.updated_at, now) }))
  return [...due('metal', metals), ...due('wood', woods)]
    .sort((a, b) => (a.days === null ? -1 : 0) - (b.days === null ? -1 : 0) || (b.days ?? 0) - (a.days ?? 0) || a.name.localeCompare(b.name))
}

/** "MS sheet: no rate yet", "Teak: 95 days". */
export const dueText = (d: DueRate) => `${d.name}: ${d.days === null ? 'no rate yet' : `${d.days} days`}`
