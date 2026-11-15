// Pricing > Training: the pure part of a training case (no network, no React).
// A case is a product photo plus the elements of its price, each typed by a person in their own way:
// a quantity and a rate when they know them, or just an amount when they do not.

export const KINDS = ['material', 'labour', 'overhead', 'margin', 'other'] as const
export type Kind = (typeof KINDS)[number]
export const KIND_LABEL: Record<Kind, string> = { material: 'Material', labour: 'Labour', overhead: 'Overhead', margin: 'Margin', other: 'Other' }

/** A row as it is typed: numbers stay text so a half-typed value is not lost. */
export type Line = { element: string; kind: Kind; material: string; quantity: string; unit: string; rate: string; amount: string; reasoning: string; from_ai: boolean }
export type CaseForm = { name: string; variant: string; width_in: string; depth_in: string; height_in: string; sold_price: string; notes: string; image_path: string | null; ai_reading: Reading | null }

export type ReadMaterial = { part: string; material: string; note: string; confidence: number }
export type Reading = { category: string; variant: string; confidence: number; materials: ReadMaterial[]; cannot_see: string }

export const emptyLine = (): Line => ({ element: '', kind: 'material', material: '', quantity: '', unit: '', rate: '', amount: '', reasoning: '', from_ai: false })
export const emptyForm = (): CaseForm => ({ name: '', variant: '', width_in: '', depth_in: '', height_in: '', sold_price: '', notes: '', image_path: null, ai_reading: null })

/** A typed number, or null when the box is empty or not a number ("1,800" and " 0.9 " are numbers). */
export function num(text: string | number | null | undefined): number | null {
  const t = String(text ?? '').replace(/[,\s₹]/g, '')
  if (t === '' || !/^\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}
const round2 = (n: number) => Math.round(n * 100) / 100

/** Quantity × rate when both are typed; otherwise the amount typed directly. */
export function lineAmount(l: Pick<Line, 'quantity' | 'rate' | 'amount'>): number {
  const q = num(l.quantity), r = num(l.rate)
  if (q !== null && r !== null) return round2(q * r)
  return num(l.amount) ?? 0
}
export const usesQuantity = (l: Pick<Line, 'quantity' | 'rate'>) => num(l.quantity) !== null && num(l.rate) !== null

export function totals(lines: readonly Line[]): { total: number; byKind: Record<Kind, number> } {
  const byKind: Record<Kind, number> = { material: 0, labour: 0, overhead: 0, margin: 0, other: 0 }
  for (const l of lines) byKind[l.kind] = round2(byKind[l.kind] + lineAmount(l))
  return { total: round2(KINDS.reduce((s, k) => s + byKind[k], 0)), byKind }
}

/** What stops a case from being saved or sent, in the words shown to the person. Empty = fine. */
export function problems(form: CaseForm, lines: readonly Line[], forSend: boolean): string[] {
  const out: string[] = []
  if (!form.name.trim()) out.push('Give the product a name.')
  for (const [key, label] of [['width_in', 'Width'], ['depth_in', 'Depth'], ['height_in', 'Height'], ['sold_price', 'The price on the PI']] as const) {
    if (form[key].trim() && num(form[key]) === null) out.push(`${label} must be a number.`)
  }
  lines.forEach((l, i) => {
    const n = i + 1
    if (!l.element.trim()) out.push(`Element ${n} needs a name.`)
    for (const [key, label] of [['quantity', 'quantity'], ['rate', 'rate'], ['amount', 'amount']] as const) {
      if (l[key].trim() && num(l[key]) === null) out.push(`Element ${n}: the ${label} must be a number.`)
    }
    if (forSend && l.element.trim() && lineAmount(l) <= 0) out.push(`Element ${n} (${l.element.trim()}) has no amount.`)
  })
  if (forSend && lines.length === 0) out.push('Add at least one element of the price.')
  return out
}

/** The document pricing_training_save takes. Empty boxes go as null; the amount is always the worked-out one. */
export function saveDoc(form: CaseForm, lines: readonly Line[]) {
  const n = (t: string) => num(t)
  return {
    name: form.name.trim(), variant: form.variant.trim() || null,
    width_in: n(form.width_in), depth_in: n(form.depth_in), height_in: n(form.height_in), sold_price: n(form.sold_price),
    notes: form.notes.trim() || null, image_path: form.image_path, ai_reading: form.ai_reading,
    lines: lines.map(l => ({
      element: l.element.trim(), kind: l.kind, material: l.material.trim() || null,
      quantity: n(l.quantity), unit: l.unit.trim() || null, rate: n(l.rate), amount: lineAmount(l),
      reasoning: l.reasoning.trim() || null, from_ai: l.from_ai,
    })),
  }
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0)

/** Keep only the shape we asked the reader for; anything else in its answer is dropped. Null = nothing usable. */
export function parseReading(input: unknown): Reading | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const materials = (Array.isArray(o.materials) ? o.materials : []).slice(0, 12).flatMap((m): ReadMaterial[] => {
    if (!m || typeof m !== 'object') return []
    const r = m as Record<string, unknown>
    const part = text(r.part, 60)
    return part ? [{ part, material: text(r.material, 120), note: text(r.note, 240), confidence: pct(r.confidence) }] : []
  })
  const category = text(o.category, 80)
  if (!category && materials.length === 0) return null
  return { category, variant: text(o.variant, 120), confidence: pct(o.confidence), materials, cannot_see: text(o.cannot_see, 300) }
}

/** The reader's materials as starting rows: named and marked as read from the photo, with no amounts. */
export function readingToLines(r: Reading): Line[] {
  return r.materials.map(m => ({ ...emptyLine(), element: m.part, material: m.material, reasoning: m.note, from_ai: true }))
}

/** A saved row (numbers) back into a typed row (text). */
export function toLine(l: { element: string; kind: string; material: string | null; quantity: number | null; unit: string | null; rate: number | null; amount: number; reasoning: string | null; from_ai: boolean }): Line {
  const s = (v: number | null) => (v === null || v === undefined ? '' : String(Number(v)))
  const both = l.quantity !== null && l.rate !== null
  return { element: l.element, kind: (KINDS as readonly string[]).includes(l.kind) ? (l.kind as Kind) : 'other', material: l.material ?? '', quantity: s(l.quantity), unit: l.unit ?? '', rate: s(l.rate), amount: both ? '' : s(l.amount), reasoning: l.reasoning ?? '', from_ai: l.from_ai }
}
