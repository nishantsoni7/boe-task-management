// Pricing > Training, step 2: a quotation line is TOLD which submitted training case it is, by a person picking its
// photo (word matching found 0 of 87 real seating lines, so nothing is matched automatically). Pure helpers: the
// cases come from pricing_training_library (20270726000000). A taught price is only ever shown; it never fills itself.

import { productType } from '@/lib/pricing/features'

export type TaughtCase = {
  id: string; case_no: number; name: string; variant: string | null; image_path: string | null
  total: number
  /** The wood picked on the structure row, and how much of the total is that wood (both may be missing). */
  wood: string | null; wood_amount: number | null
  /** The total in every other wood that has a rate, worked out in the database: lower-case wood name -> price. */
  in_wood: Record<string, number>
  /** Only sent to people who may open Pricing: the elements of the price. */
  lines?: { element: string; kind: string; amount: number; material: string | null }[]
}
export type LineWords = { name: string; material?: string | null; spec?: string | null; finish?: string | null }
export type Library = { cases: TaughtCase[]; woods: string[] }

// Words that say nothing about WHICH product it is.
const STOP = new Set(['with', 'and', 'the', 'for', 'from', 'wooden', 'wood', 'solid', 'finish', 'colour', 'color', 'size', 'type', 'made', 'legs', 'leg', 'caps', 'cap'])
// Two spellings of one thing count as one word.
const SAME: Record<string, string> = { armchair: 'arm', upholstery: 'upholstered', cushion: 'upholstered', cushioned: 'upholstered', padded: 'upholstered', rattan: 'cane', wicker: 'cane', weave: 'woven', weaving: 'woven', chairs: 'chair' }

/** The words that describe a product, without the woods (a wood changes the price, not which product it is). */
export function productWords(text: string, woods: readonly string[] = []): Set<string> {
  const skip = new Set(woods.map(w => w.trim().toLowerCase()))
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/arm\s+chair/g, 'armchair').split(/[^a-z]+/)) {
    if (raw.length < 3 || STOP.has(raw) || skip.has(raw)) continue
    const w = SAME[raw] ?? raw
    if (w === 'arm') { out.add('arm'); out.add('chair') } else out.add(w)
  }
  return out
}

/** How alike two products are, 0 to 1: shared words against all words (Dice). Different product types never match. */
export function likeness(line: LineWords, c: Pick<TaughtCase, 'name' | 'variant'>, woods: readonly string[] = []): number {
  const lineText = [line.name, line.material, line.spec, line.finish].filter(Boolean).join(' ')
  const caseText = [c.name, c.variant].filter(Boolean).join(' ')
  const ta = productType(line.name), tb = productType(caseText)
  if (ta && tb && ta !== tb) return 0
  const a = productWords(lineText, woods), b = productWords(caseText, woods)
  if (a.size === 0 || b.size === 0) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return (2 * both) / (a.size + b.size)
}

/** The wood a line names, as it is spelled in the wood list; null when it names none (or two). */
export function lineWood(line: LineWords, woods: readonly string[]): string | null {
  const text = ` ${[line.material, line.name, line.spec].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z]+/g, ' ')} `
  const found = woods.filter(w => w.trim().length >= 2 && text.includes(` ${w.trim().toLowerCase()} `))
  return found.length === 1 ? found[0] : null
}

/** The submitted cases, the most alike first (only an order for the picker: every case stays pickable). */
export function byLikeness(cases: readonly TaughtCase[], line: LineWords, woods: readonly string[]): TaughtCase[] {
  return cases.map(c => ({ c, s: likeness(line, c, woods) })).sort((x, y) => y.s - x.s || y.c.case_no - x.c.case_no).map(x => x.c)
}

// The pick is kept as a tag in the line internal note: already saved with the line and never shown to a client.
const TAG = /\s*\[Taught case #(\d+)\]/
/** The case number picked for a line, read from its internal note. */
export function pickedCaseNo(note: string | null | undefined): number | null {
  const m = TAG.exec(note ?? '')
  return m ? Number(m[1]) : null
}
/** The note with the pick set (or removed, with null). Whatever else is written in the note stays. */
export function withPick(note: string | null | undefined, caseNo: number | null): string {
  const rest = (note ?? '').replace(TAG, '').trim()
  return caseNo === null ? rest : [rest, `[Taught case #${caseNo}]`].filter(Boolean).join(' ')
}

/** The price of a picked case for a line: in the wood the line names when that can be worked out, else as taught. */
export function taughtPrice(c: TaughtCase, line: LineWords, woods: readonly string[]): { price: number; wood: string | null; swapped: boolean; noRate: string | null } {
  const wood = lineWood(line, woods)
  const other = wood && c.wood && wood.toLowerCase() !== c.wood.trim().toLowerCase()
  const inWood = other ? c.in_wood[wood.trim().toLowerCase()] : undefined
  return inWood !== undefined
    ? { price: Number(inWood), wood, swapped: true, noRate: null }
    : { price: Number(c.total), wood: c.wood, swapped: false, noRate: other ? wood : null }
}
