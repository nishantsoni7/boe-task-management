// ── The Fabric & Finish cost sheet of a PI ────────────────────────────────────
//
// ONE PURE MODULE decides every figure the sheet shows, on the PI Draft page,
// on the Confirmed Order and in Edit PI, so they cannot disagree. The database
// (20270431000000) stores only the inputs per product line: what the workbook
// sheet said and what a person typed. Totals are never stored.
//
// THE RULES (owner, 2026-10-29)
//   per line   metres   = metres per piece × quantity
//              fabric ₹ = metres × ₹ per metre
//              packing ₹= ₹ per piece × quantity
//   quantity   always the PI line in force, so a revised quantity moves the
//              totals by itself
//   totals     the workbook's own arithmetic: ROUND(SUM, -1) — to the nearest
//              ₹10 — and "as applicable" when the sum is zero (nothing quoted
//              yet; charged on dispatch)
//   typed wins a value typed in the app beats the workbook's; the sheet's
//              value stays visible underneath
//   finish     a product with no fabric or finish choice recorded reads
//              "No Fabric and Finish approval done"; PENDING counts as none
//
// Money here is in rupees with paise (numbers), the way the PI stores it; the
// only rounding is the workbook's own, on the two totals.

export const FABRIC_FINISH_TITLE = 'Fabric & Finish cost'
export const FABRIC_FINISH_OPEN_LABEL = 'Open cost sheet'
export const AS_APPLICABLE_TEXT = 'As applicable'
export const NO_FINISH_TEXT = 'No Fabric and Finish approval done'
export const SHEET_SOURCE_LABEL = 'Sheet'
export const TYPED_SOURCE_LABEL = 'Typed'

export type FinishEntry = {
  heading: string
  value: string
  /** A reference picture of the fabric or finish, in the order-files bucket. */
  imagePath: string | null
  /** The picture's bytes, named in its key; required by the save function with a picture. */
  imageSha256?: string | null
}

export type LineValues = {
  fabricMetresPerPiece: number | null
  fabricPricePerMetre: number | null
  packingCostPerPiece: number | null
  packingType: string | null
  finish: readonly FinishEntry[]
}

export type FabricFinishLine = {
  /** The PI line's identity: its item number, or its row id when it has none. */
  itemSequence: string
  itemId: string | null
  productName: string | null
  productCode: string | null
  quantity: number
  sortOrder: number
  /** What the workbook sheet said; null when the sheet had no row for this line. */
  sheet: LineValues | null
  /** What a person typed; null when nothing was typed. */
  typed: LineValues | null
  typedByName: string | null
  typedAt: string | null
}

export type PiCostFigure = {
  amount: number | null
  meaning: string | null
  text: string | null
}

export type FabricFinishData = {
  submissionId: string
  status: string | null
  orderId: string | null
  orderStatus: string | null
  displayNumber: string | null
  clientName: string | null
  workbookName: string | null
  /** When the sheet was last read from a workbook (any line), or null. */
  sheetReadAt: string | null
  canEdit: boolean
  piFabricCost: PiCostFigure
  piPackingCost: PiCostFigure
  lines: readonly FabricFinishLine[]
}

// ── Parsing the read function's JSON ──────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

function parseFinish(raw: unknown): FinishEntry[] {
  if (!Array.isArray(raw)) return []
  const out: FinishEntry[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const heading = str(o.heading)
    const value = typeof o.value === 'string' ? o.value.trim() : ''
    const imagePath = str(o.image_path)
    if (!heading || (value === '' && !imagePath)) continue
    out.push({ heading, value, imagePath, imageSha256: str(o.image_sha256) })
  }
  return out
}

function parseValues(raw: unknown): LineValues | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return {
    fabricMetresPerPiece: num(o.fabric_metres_per_piece),
    fabricPricePerMetre: num(o.fabric_price_per_metre),
    packingCostPerPiece: num(o.packing_cost_per_piece),
    packingType: str(o.packing_type),
    finish: parseFinish(o.finish),
  }
}

const figure = (o: Record<string, unknown>, key: string): PiCostFigure => ({
  amount: num(o[key]),
  meaning: str(o[`${key}_meaning`]),
  text: str(o[`${key}_text`]),
})

/** The read function's JSON as the sheet uses it. Null when it found no PI. */
export function parseFabricFinishData(raw: unknown): FabricFinishData | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.found !== true) return null
  const sub = (o.submission ?? {}) as Record<string, unknown>
  const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : []
  const rawLines = Array.isArray(o.lines) ? (o.lines as Record<string, unknown>[]) : []
  const byKey = new Map(rawLines.map(l => [String(l.item_sequence ?? ''), l]))
  const lines: FabricFinishLine[] = items.map((it, index) => {
    const key = String(it.item_sequence ?? '')
    const l = byKey.get(key)
    return {
      itemSequence: key,
      itemId: str(it.item_id),
      productName: str(it.product_name),
      productCode: str(it.source_product_code),
      quantity: num(it.quantity) ?? 0,
      sortOrder: num(it.sort_order) ?? index,
      sheet: l ? parseValues(l.sheet) : null,
      typed: l ? parseValues(l.typed) : null,
      typedByName: l ? str(l.typed_by_name) : null,
      typedAt: l ? str(l.typed_at) : null,
    }
  })
  return {
    submissionId: String(sub.id ?? ''),
    status: str(sub.status),
    orderId: str(sub.order_id),
    orderStatus: str(sub.order_status),
    displayNumber: str(sub.display_number),
    clientName: str(sub.client_name),
    workbookName: str(sub.source_workbook_name),
    sheetReadAt: str(sub.sheet_read_at),
    canEdit: o.can_edit === true,
    piFabricCost: figure(sub, 'fabric_cost'),
    piPackingCost: figure(sub, 'packing_cost'),
    lines,
  }
}

// ── What counts, per line ─────────────────────────────────────────────────────

export type ValueSource = 'typed' | 'sheet' | 'none'

export type EffectiveField<T> = { value: T; source: ValueSource }

/** The value that counts: typed when typed, else the sheet's, else nothing. */
export function effective<K extends keyof Omit<LineValues, 'finish'>>(line: FabricFinishLine, key: K): EffectiveField<LineValues[K] | null> {
  const t = line.typed?.[key]
  if (t !== null && t !== undefined) return { value: t, source: 'typed' }
  const s = line.sheet?.[key]
  if (s !== null && s !== undefined) return { value: s, source: 'sheet' }
  return { value: null, source: 'none' }
}

/** Finish choices that count: typed entries win over the sheet's by heading, in the sheet's order then the new ones. */
export function effectiveFinish(line: FabricFinishLine): { entry: FinishEntry; source: 'typed' | 'sheet' }[] {
  const typed = line.typed?.finish ?? []
  const sheet = line.sheet?.finish ?? []
  const key = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase()
  const out: { entry: FinishEntry; source: 'typed' | 'sheet' }[] = []
  const seen = new Set<string>()
  for (const s of sheet) {
    const t = typed.find(x => key(x.heading) === key(s.heading))
    out.push(t ? { entry: t, source: 'typed' } : { entry: s, source: 'sheet' })
    seen.add(key(s.heading))
  }
  for (const t of typed) if (!seen.has(key(t.heading))) out.push({ entry: t, source: 'typed' })
  return out
}

/** A finish choice is DONE unless it is blank or the sheet's placeholder "PENDING". */
export const finishIsDone = (value: string): boolean => value.trim() !== '' && !/^pending$/i.test(value.trim())

export type LineFigures = {
  metres: number | null
  fabricAmount: number | null
  packingAmount: number | null
  /** Nothing is known for this line, from the sheet or typed. */
  blank: boolean
  /** No fabric or finish choice is recorded (or every one still says PENDING). */
  finishMissing: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function lineFigures(line: FabricFinishLine): LineFigures {
  const metresPerPiece = effective(line, 'fabricMetresPerPiece').value
  const price = effective(line, 'fabricPricePerMetre').value
  const packing = effective(line, 'packingCostPerPiece').value
  const metres = metresPerPiece === null ? null : round2(metresPerPiece * line.quantity)
  // No metres means no fabric money, whatever the price says; metres without a
  // price is a cost not yet known.
  const fabricAmount = metres === null ? null : metres === 0 ? 0 : price === null ? null : round2(metres * price)
  const packingAmount = packing === null ? null : round2(packing * line.quantity)
  const finish = effectiveFinish(line)
  return {
    metres,
    fabricAmount,
    packingAmount,
    blank: metresPerPiece === null && price === null && packing === null && finish.length === 0,
    finishMissing: !finish.some(f => finishIsDone(f.entry.value) || f.entry.imagePath !== null),
  }
}

// ── Totals, the workbook's way ────────────────────────────────────────────────

/** Excel's ROUND(x, -1): to the nearest ten, halves away from zero. */
export const roundToTen = (n: number): number => Math.sign(n) * Math.round(Math.abs(n) / 10) * 10

export type SheetTotal = {
  /** The plain sum of the lines that carry a figure. */
  sum: number
  /** The sum as the workbook prints it: to the nearest ₹10, or null for "as applicable". */
  rounded: number | null
  /** Lines that carry a figure. */
  counted: number
  /** Lines whose figure is still unknown (metres given, price missing). */
  unknown: number
}

const total = (amounts: readonly (number | null)[], unknown: number): SheetTotal => {
  const given = amounts.filter((a): a is number => a !== null)
  const sum = round2(given.reduce((a, b) => a + b, 0))
  const rounded = roundToTen(sum)
  return { sum, rounded: rounded === 0 ? null : rounded, counted: given.length, unknown }
}

export type FabricFinishTotals = {
  fabric: SheetTotal
  packing: SheetTotal
  metres: number
  linesFilled: number
  lines: number
}

export function sheetTotals(lines: readonly FabricFinishLine[]): FabricFinishTotals {
  const figs = lines.map(lineFigures)
  return {
    fabric: total(figs.map(f => f.fabricAmount), figs.filter(f => f.metres !== null && f.metres > 0 && f.fabricAmount === null).length),
    packing: total(figs.map(f => f.packingAmount), 0),
    metres: round2(figs.reduce((a, f) => a + (f.metres ?? 0), 0)),
    linesFilled: figs.filter(f => !f.blank).length,
    lines: lines.length,
  }
}

// ── Against the PI's own figures ──────────────────────────────────────────────

export type Comparison = {
  /** What the PI's line says, as money: a quoted amount, or 0 for "not applicable", "as applicable" or "included". */
  piAmount: number | null
  /** What the PI's line says, in words, where it is not an amount. */
  piWords: string | null
  sheetAmount: number | null
  state: 'matches' | 'differs' | 'unknown'
  /** sheet − PI, when both are known. */
  difference: number | null
}

/**
 * Does the sheet agree with the PI's Fabric cost / Packing cost line? The PI
 * stores an amount and its meaning (20260909000000): a numeric figure, "not
 * applicable" (a dash: nothing quoted), "included" (inside another figure) or
 * free text ("as per actual"). "Nothing quoted" on both sides is a match.
 */
export function compareWithPi(pi: PiCostFigure, sheet: SheetTotal): Comparison {
  const meaning = pi.meaning ?? 'numeric'
  const piAmount = meaning === 'numeric' ? (pi.amount ?? null) : 0
  const piWords = meaning === 'numeric' ? null
    : meaning === 'included' ? 'Included'
    : meaning === 'text' ? (pi.text ?? AS_APPLICABLE_TEXT)
    : 'Not applicable'
  const sheetAmount = sheet.rounded ?? 0
  if (sheet.unknown > 0 || piAmount === null) {
    return { piAmount, piWords, sheetAmount: sheet.rounded, state: 'unknown', difference: null }
  }
  const difference = round2(sheetAmount - piAmount)
  return { piAmount, piWords, sheetAmount: sheet.rounded, state: difference === 0 ? 'matches' : 'differs', difference }
}

/** "₹12,190" or "As applicable". */
export function totalText(sheet: SheetTotal, format: (n: number) => string): string {
  return sheet.rounded === null ? AS_APPLICABLE_TEXT : format(sheet.rounded)
}

// ── For Edit PI ───────────────────────────────────────────────────────────────

/**
 * The two PI lines as the sheet would set them, given the quantities an edit
 * proposes (keyed by item number). Null = the sheet has nothing for that cost
 * (no line carries a figure), so the PI keeps whatever it states.
 */
export function sheetCostsForEdit(
  lines: readonly FabricFinishLine[],
  quantities: ReadonlyMap<string, number>,
): { fabric: number | null; packing: number | null; hasSheet: boolean } {
  const live = lines
    .filter(l => quantities.has(l.itemSequence))
    .map(l => ({ ...l, quantity: quantities.get(l.itemSequence) as number }))
  const hasSheet = live.some(l => !lineFigures(l).blank)
  if (!hasSheet) return { fabric: null, packing: null, hasSheet: false }
  const t = sheetTotals(live)
  return {
    fabric: t.fabric.counted === 0 && t.fabric.unknown === 0 ? null : (t.fabric.rounded ?? 0),
    packing: t.packing.counted === 0 ? null : (t.packing.rounded ?? 0),
    hasSheet: true,
  }
}

// ── Typed input ───────────────────────────────────────────────────────────────

/** A typed figure: blank → null (nothing typed), a bad number → NaN. */
export function parseTypedFigure(text: string): number | null {
  const t = text.trim().replace(/,/g, '')
  if (t === '') return null
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return Number.NaN
  return Number(t)
}

/** The payload save_typed takes for one line. Nulls clear a typed value. */
export function typedPayload(input: {
  fabricMetresPerPiece: string
  fabricPricePerMetre: string
  packingCostPerPiece: string
  packingType: string
  finish: readonly FinishEntry[]
}): { ok: true; values: Record<string, unknown> } | { ok: false; problem: string } {
  const metres = parseTypedFigure(input.fabricMetresPerPiece)
  const price = parseTypedFigure(input.fabricPricePerMetre)
  const packing = parseTypedFigure(input.packingCostPerPiece)
  if ([metres, price, packing].some(n => n !== null && Number.isNaN(n))) {
    return { ok: false, problem: 'Figures must be numbers of at least 0, with at most three decimals for metres and two for rupees.' }
  }
  if ((price !== null && price !== Math.round(price * 100) / 100) || (packing !== null && packing !== Math.round(packing * 100) / 100)) {
    return { ok: false, problem: 'Rupee figures take at most two decimals.' }
  }
  const type = input.packingType.trim()
  if (type.length > 200) return { ok: false, problem: 'Packing type may be at most 200 characters.' }
  const finish = input.finish
    .map(f => ({ heading: f.heading.trim(), value: f.value.trim(), image_path: f.imagePath, image_sha256: f.imagePath ? (f.imageSha256 ?? null) : null }))
    .filter(f => f.heading !== '' && (f.value !== '' || f.image_path))
  if (finish.some(f => f.heading.length > 120 || f.value.length > 500)) {
    return { ok: false, problem: 'A finish heading may be at most 120 characters and its value 500.' }
  }
  if (finish.length > 12) return { ok: false, problem: 'At most 12 finish choices per product.' }
  return {
    ok: true,
    values: {
      fabric_metres_per_piece: metres,
      fabric_price_per_metre: price,
      packing_cost_per_piece: packing,
      packing_type: type === '' ? null : type,
      finish,
    },
  }
}

/** The headings the finish sheet usually carries, offered when a product has none yet. */
export const DEFAULT_FINISH_HEADINGS = ['Fabric Approval', 'Wood Finish Approval', 'Metal Finish', 'Marble/Rope Approval'] as const
