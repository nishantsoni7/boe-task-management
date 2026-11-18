// What would stop a save, said about the product it is on (practicality review, 18 Nov 2026: "save errors do not name the
// product"). The limits are the database's own (quotation_areas / quotation_lines checks, spec 1600 since 20270714000000),
// so a save this passes is not refused for one of them and the person is not left with a raw database message.

import type { QuoteArea, QuoteLine } from './math'

export type SaveProblem = { text: string; lineKey?: string }

const MAX_PRICE = 100_000_000_000
const fmt = (n: number) => n.toLocaleString('en-IN')

/** The first problem, in page order: room types first, then products room by room as the builder shows them. */
export function saveProblem(areas: readonly QuoteArea[], lines: readonly QuoteLine[]): SaveProblem | null {
  for (const [i, a] of areas.entries()) {
    const name = a.name.trim()
    const label = name ? `Room type "${name}"` : `Room type ${i + 1}`
    if (!name) return { text: `${label} needs a name.` }
    if (name.length > 80) return { text: `${label}: the name is longer than 80 characters.` }
    if (!(a.multiplier >= 1) || a.multiplier > 100_000) return { text: `${label} needs between 1 and ${fmt(100_000)} rooms.` }
  }
  const roomName = new Map(areas.map(a => [a.key, a.name.trim()]))
  const ordered = [...areas.flatMap(a => lines.filter(l => l.area_key === a.key)), ...lines.filter(l => !l.area_key || !roomName.has(l.area_key))]
  const seen = new Map<string | null, number>()
  for (const l of ordered) {
    const room = l.area_key ? roomName.get(l.area_key) ?? '' : ''
    const n = (seen.get(l.area_key ?? null) ?? 0) + 1
    seen.set(l.area_key ?? null, n)
    const where = room ? ` in ${room}` : ''
    const label = l.name.trim() ? `"${l.name.trim()}"${where}` : `Product ${n}${where || ' (no room type)'}`
    const say = (what: string): SaveProblem => ({ text: `${label}: ${what}`, lineKey: l.key })
    if (!l.name.trim()) return say('needs a name.')
    if (l.name.trim().length > 160) return say('the name is longer than 160 characters.')
    if (l.size_text.trim().length > 80) return say('the dimensions are longer than 80 characters.')
    if (l.spec.trim().length > 1600) return say('the remarks are longer than 1,600 characters.')
    if (l.material.trim().length > 120) return say('the material is longer than 120 characters.')
    if (l.finish.trim().length > 120) return say('the finish is longer than 120 characters.')
    if (l.internal_note.trim().length > 1000) return say('the internal note is longer than 1,000 characters.')
    const qty = Number(l.qty)
    const most = l.qty_mode === 'per_unit' ? 100_000 : 1_000_000 // as saveDoc splits it into qty_per_unit / qty_fixed
    if (!(qty > 0)) return say('needs a quantity above 0.')
    if (qty > most) return say(`the quantity can be at most ${fmt(most)}.`)
    if (!(l.unit_price >= 0) || l.unit_price > MAX_PRICE) return say('the price is not a valid amount.')
  }
  return null
}
