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
  /** The elements a line may leave out or another case may borrow (20270727000000): never structure, overhead or margin. */
  parts?: Part[]
}
export type Part = { element: string; kind: string; amount: number }
/** What a line says it is: a case, less the elements it leaves out, plus elements taught on other cases. */
export type LinePick = { caseNo: number; without: string[]; with: { caseNo: number; element: string }[]; /** Why the price quoted differs from the taught one, once somebody has said. */ why?: string | null }
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
// With differences it reads: [Taught case #12; without Back weaving; with #4 Brass caps]
// shortcut: a tag in a note, found by text search; move to its own column when the watcher needs to query picks.
const TAG = /\s*\[Taught case #(\d+)((?:;[^\]]*)?)\]/
/** An element name as it is written in the tag: without the characters the tag itself uses. */
const plain = (s: string) => s.replace(/[\[\];]/g, ' ').replace(/\s+/g, ' ').trim()
export const sameElement = (a: string, b: string) => plain(a).toLowerCase() === plain(b).toLowerCase()

/** What a line says it is, read from its internal note. */
export function readPick(note: string | null | undefined): LinePick | null {
  const m = TAG.exec(note ?? '')
  if (!m) return null
  const pick: LinePick = { caseNo: Number(m[1]), without: [], with: [] }
  for (const bit of m[2].split(';').map(b => b.trim())) {
    const add = /^with #(\d+) (.+)$/.exec(bit)
    if (add) pick.with.push({ caseNo: Number(add[1]), element: add[2] })
    else if (bit.startsWith('without ')) pick.without.push(bit.slice(8).trim())
    else if (bit.startsWith('why ')) pick.why = bit.slice(4).trim()
  }
  return pick
}
/** The note with the pick set (or removed, with null). Whatever else is written in the note stays. */
export function writePick(note: string | null | undefined, pick: LinePick | null): string {
  const rest = (note ?? '').replace(TAG, '').trim()
  if (!pick) return rest
  const bits = [`Taught case #${pick.caseNo}`, ...pick.without.map(e => `without ${plain(e)}`), ...pick.with.map(w => `with #${w.caseNo} ${plain(w.element)}`), ...(pick.why ? [`why ${plain(pick.why)}`] : [])]
  return [rest, `[${bits.join('; ')}]`].filter(Boolean).join(' ')
}
/** The case number picked for a line. */
export const pickedCaseNo = (note: string | null | undefined): number | null => readPick(note)?.caseNo ?? null
/** The note with a case picked as it was taught (any differences start again), or with the pick removed. */
export const withPick = (note: string | null | undefined, caseNo: number | null): string => writePick(note, caseNo === null ? null : { caseNo, without: [], with: [] })

/** The elements other submitted cases teach that this case does not have: what a line may add. */
export function borrowable(c: TaughtCase, cases: readonly TaughtCase[]): { from: TaughtCase; part: Part }[] {
  return cases.filter(o => o.id !== c.id).flatMap(o => (o.parts ?? []).filter(p => !(c.parts ?? []).some(x => sameElement(x.element, p.element))).map(part => ({ from: o, part })))
}

/** What the differences of a pick come to. `lost` names what the tag asks for that is no longer taught (it changes nothing). */
export function adjustment(c: TaughtCase, pick: LinePick, cases: readonly TaughtCase[]): { delta: number; without: Part[]; with: { from: TaughtCase; part: Part }[]; lost: string[] } {
  const out = { delta: 0, without: [] as Part[], with: [] as { from: TaughtCase; part: Part }[], lost: [] as string[] }
  for (const name of pick.without) {
    const part = (c.parts ?? []).find(p => sameElement(p.element, name) && !out.without.includes(p))
    if (part) { out.without.push(part); out.delta -= Number(part.amount) } else out.lost.push(name)
  }
  for (const w of pick.with) {
    const from = cases.find(o => o.case_no === w.caseNo && o.id !== c.id)
    const part = from?.parts?.find(p => sameElement(p.element, w.element))
    if (from && part) { out.with.push({ from, part }); out.delta += Number(part.amount) } else out.lost.push(`#${w.caseNo} ${w.element}`)
  }
  return out
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

// ── The watcher (20270729000000): a quoted price against the taught one ──
/** The reasons offered when a quoted price differs. Written into the tag as they read here. */
export const REASONS = ['Quantity discount', 'Client relationship', 'Size is different', 'Material or finish is different', 'The taught price is wrong', 'Other'] as const
/** A quoted price is asked about when it is more than this far from the taught one (owner default, 16 Nov 2026: 5%). */
export const ASK_ABOVE = 0.05

/** The whole taught price of a pick for a line: the case in the line's wood, with what the line leaves out or adds. */
export function pickPrice(c: TaughtCase, pick: LinePick, line: LineWords, lib: Library): number {
  return taughtPrice(c, line, lib.woods).price + adjustment(c, pick, lib.cases).delta
}
/** How far a quoted price is from the taught one, or null when it is close enough (or there is nothing to compare). */
export function difference(quoted: number | null | undefined, taught: number): { amount: number; percent: number; below: boolean } | null {
  if (!quoted || quoted <= 0 || taught <= 0) return null
  const gap = quoted - taught
  if (Math.abs(gap) <= taught * ASK_ABOVE) return null
  return { amount: Math.abs(gap), percent: Math.round((Math.abs(gap) / taught) * 100), below: gap < 0 }
}

/** A priced quotation line that picked a taught product, as pricing_taught_quotes sends it. */
export type TaughtQuote = LineWords & { quotation_id: string; quote_no: string | null; status: string; updated_at: string; owner_name: string | null; unit_price: number; internal_note: string | null }
export type QuotedSummary = { lines: number; close: number; lower: number; higher: number; reasons: Record<string, number>; unexplained: (TaughtQuote & { taught: number })[] }

/** For every taught case, how the lines that picked it were really priced. Lines whose case is no longer submitted are left out. */
export function quotedAgainst(lib: Library, quotes: readonly TaughtQuote[]): Map<number, QuotedSummary> {
  const out = new Map<number, QuotedSummary>()
  for (const q of quotes) {
    const pick = readPick(q.internal_note)
    const c = pick && lib.cases.find(x => x.case_no === pick.caseNo)
    if (!pick || !c) continue
    const s = out.get(c.case_no) ?? { lines: 0, close: 0, lower: 0, higher: 0, reasons: {}, unexplained: [] }
    out.set(c.case_no, s)
    const taught = pickPrice(c, pick, q, lib)
    const d = difference(Number(q.unit_price), taught)
    s.lines++
    if (!d) { s.close++; continue }
    if (d.below) s.lower++; else s.higher++
    if (pick.why) s.reasons[pick.why] = (s.reasons[pick.why] ?? 0) + 1
    else s.unexplained.push({ ...q, taught })
  }
  return out
}
