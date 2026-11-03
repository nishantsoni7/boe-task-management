import { DISPATCH_PAPER_KINDS, DISPATCH_PAPER_LABEL, type DispatchForm, type DispatchPaperKind } from './dispatch'

// Reading one dispatch paper (invoice, e-way bill, LR / bilty).
//
// A paper is read once, on the server, into a PaperReading. Nothing here trusts
// that reading: parsePaperReading keeps only values of the right shape, and
// applyPaperReading only ever FILLS what the person has not typed. The person
// checks the form before saving, so a misread costs a correction, not a wrong
// record.

export const DISPATCH_PAPER_MAX_BYTES = 10 * 1024 * 1024

export const DISPATCH_PAPER_TYPES: Readonly<Record<string, 'pdf' | 'jpg' | 'png' | 'webp'>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export const DISPATCH_PAPER_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp'

/** order-files/orders/{order}/dispatch/{record_key}/{uuid}.{ext}: order_dispatch_file_key_parts' own shape. */
export const dispatchPaperPath = (orderId: string, recordKey: string, fileId: string, ext: string): string =>
  `orders/${orderId}/dispatch/${recordKey}/${fileId}.${ext}`

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PAPER_PATH = new RegExp(`^orders/(${UUID})/dispatch/${UUID}/${UUID}\\.(pdf|jpg|png|webp)$`)

export function isDispatchPaperPath(path: unknown, orderId: string): path is string {
  return typeof path === 'string' && PAPER_PATH.exec(path)?.[1] === orderId
}

export type PaperReading = {
  kind: DispatchPaperKind
  invoiceNumber: string
  invoiceDate: string
  invoiceTaxable: string
  invoiceGst: string
  invoiceTotal: string
  ewayBillNumber: string
  ewayGeneratedOn: string
  ewayValidUntil: string
  vehicleNumber: string
  transporter: string
  lrNumber: string
  packages: string
  deliverTo: string
  goods: { itemSequence: string; quantity: number }[]
  /** Every BOE product code printed on the paper, "395-BE0007", whether or not it is a line of this Order. */
  printedCodes: string[]
  /** How many times the same lines were read (an invoice is printed Original, Duplicate and Triplicate); 1 when once. */
  copies: number
}

export type PaperReadingResponse =
  | { ok: true; reading: PaperReading }
  | { ok: false; code: 'auth' | 'not_configured' | 'rate_limited' | 'too_large' | 'unreadable' | 'failed'; error: string }

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** A real calendar date in YYYY-MM-DD, or nothing. */
function isoDate(v: unknown): string {
  const t = text(v, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return ''
  const d = new Date(`${t}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : ''
}

const amount = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(Math.round(v * 100) / 100) : ''

/**
 * A BOE product code however it was printed ("395-BE0007", "395 - BE 7") as the one
 * form the app uses ("395-BE0007"); null when the text holds none.
 */
export function normalizeProductCode(raw: unknown): string | null {
  const m = /(\d{1,5})\s*-\s*BE\s*0*(\d{1,5})/i.exec(typeof raw === 'string' ? raw : '')
  return m ? `${Number(m[1])}-BE${m[2].padStart(4, '0')}` : null
}

/** An e-way bill number is 12 digits: "7616 8509 0730" and "761685090730" are one number. Anything else stays as printed. */
function ewayNumber(v: unknown): string {
  const t = text(v, 40)
  const digits = t.replace(/[\s-]/g, '')
  return /^\d{12}$/.test(digits) ? digits : t
}

const sum2 = (xs: number[]): number => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100

/**
 * The model's answer, made safe: wrong types are dropped, and goods must be lines of this Order.
 * A line is matched by the BOE product code printed beside it when this Order has that code
 * (exact), else by the model's own match of its name (`knownLines`).
 */
export function parsePaperReading(
  raw: unknown,
  knownLines: ReadonlySet<string>,
  codes: ReadonlyMap<string, string> = new Map(),
): PaperReading {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const read = new Map<string, number[]>()
  const printed = new Set<string>()
  for (const g of Array.isArray(o.goods) ? o.goods : []) {
    const line = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
    const code = normalizeProductCode(line.code)
    if (code) printed.add(code)
    const named = typeof line.item_sequence === 'string' ? line.item_sequence.trim() : ''
    const seq = (code ? codes.get(code) : undefined) ?? (knownLines.has(named) ? named : undefined)
    const quantity = line.quantity
    if (!seq || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) continue
    read.set(seq, [...(read.get(seq) ?? []), quantity])
  }
  // shortcut: a file that prints the same invoice 2-3 times (Original, Duplicate, Triplicate) can
  // come back with every line read once per copy. When two or more products each repeat the same
  // number of times with identical quantities it is copies, and counted once; a product on two
  // lines of one invoice is still added up. One product repeated cannot be told from two lines,
  // so it is added, and the pending check on the form catches a quantity above the Order.
  const lists = [...read.values()]
  const repeats = lists.length >= 2 && lists[0].length > 1
    && lists.every(q => q.length === lists[0].length && q.every(x => x === q[0]))
  const copies = repeats ? lists[0].length : 1
  const goods = [...read].map(([itemSequence, q]) => ({ itemSequence, quantity: repeats ? q[0] : sum2(q) }))
  const packages = o.packages
  return {
    kind: DISPATCH_PAPER_KINDS.find(k => k === o.paper_type) ?? 'other',
    invoiceNumber: text(o.invoice_number, 60),
    invoiceDate: isoDate(o.invoice_date),
    invoiceTaxable: amount(o.taxable_value),
    invoiceGst: amount(o.gst_amount),
    invoiceTotal: amount(o.invoice_total),
    ewayBillNumber: ewayNumber(o.eway_bill_number),
    ewayGeneratedOn: isoDate(o.eway_generated_on),
    ewayValidUntil: isoDate(o.eway_valid_until),
    vehicleNumber: text(o.vehicle_number, 40).toUpperCase(),
    transporter: text(o.transporter, 160),
    lrNumber: text(o.lr_number, 60),
    packages: typeof packages === 'number' && Number.isInteger(packages) && packages >= 0 ? String(packages) : '',
    deliverTo: text(o.deliver_to, 200),
    goods,
    printedCodes: [...printed],
    copies,
  }
}

const READ_FIELDS = [
  'invoiceNumber', 'invoiceDate', 'invoiceTaxable', 'invoiceGst', 'invoiceTotal',
  'ewayBillNumber', 'ewayGeneratedOn', 'ewayValidUntil',
  'vehicleNumber', 'transporter', 'lrNumber', 'packages', 'deliverTo',
] as const

/** True when the paper yielded nothing the form can use. */
export const readingIsEmpty = (r: PaperReading): boolean =>
  r.goods.length === 0 && READ_FIELDS.every(f => r[f] === '')

/** "Read 8 details · 10 products matched · printed 3 times, counted once": what the box says under a paper that was read. */
export function readingSummary(r: PaperReading): string {
  const details = READ_FIELDS.filter(f => r[f] !== '').length
  const parts = [`Read ${details} ${details === 1 ? 'detail' : 'details'}`]
  if (r.goods.length > 0) parts.push(`${r.goods.length} ${r.goods.length === 1 ? 'product' : 'products'} matched`)
  if (r.copies > 1) parts.push(`printed ${r.copies} times, counted once`)
  return parts.join(' · ')
}

/**
 * The Order number the paper's product codes name, when it is NOT this Order ("395" on Order 536's screen);
 * null when they name this Order, or the paper prints no code. `storedNumber` is the four-digit stored number
 * ("0536"): compared as numbers, never as the zero-stripped display text.
 */
export function paperOrderMismatch(r: PaperReading, storedNumber: string | null | undefined): string | null {
  const mine = storedNumber ? Number(storedNumber) : NaN // Number(null) is 0, which is not an Order
  if (!Number.isFinite(mine) || r.printedCodes.length === 0) return null
  const named = [...new Set(r.printedCodes.map(c => Number(c.split('-')[0])))]
  return named.includes(mine) ? null : String(named[0])
}

/** The three boxes on the Record dispatch screen. Each is also a kind of paper. */
export type PaperSlot = 'invoice' | 'eway_bill' | 'lr'

/**
 * Which box a paper belongs in, given what the reader says it is. The box the person chose is only a guess:
 * a paper put in the wrong box moves to the right one (its details were filled in as what it is), and a paper
 * the reader cannot name stays where the person put it.
 */
export function placePaper(said: DispatchPaperKind, chosen: PaperSlot): { slot: PaperSlot; kind: DispatchPaperKind; moved: boolean } {
  const slot: PaperSlot = said === 'invoice' || said === 'eway_bill' ? said : said === 'lr' || said === 'packing_list' ? 'lr' : chosen
  return { slot, kind: said === 'other' ? chosen : said, moved: slot !== chosen }
}

export type InvoiceWayCheck = { state: 'match' | 'differ'; invoice: string; eway: string }

/** Does the e-way bill cover the invoice that was read? null until both papers named a document number. */
export function invoiceVsEway(readings: readonly PaperReading[]): InvoiceWayCheck | null {
  const invoice = readings.find(r => r.kind === 'invoice' && r.invoiceNumber)?.invoiceNumber
  const eway = readings.find(r => r.kind === 'eway_bill' && r.invoiceNumber)?.invoiceNumber
  if (!invoice || !eway) return null
  const key = (s: string) => s.replace(/\s+/g, '').toUpperCase()
  return { state: key(invoice) === key(eway) ? 'match' : 'differ', invoice, eway }
}

/** Which paper a field was filled from, to show under the field. */
export type ReadSources = Partial<Record<keyof DispatchForm | 'goods', string>>

/**
 * The patch that pours a reading into the form: only fields still empty are
 * filled, and each remembers which paper it came from. Paper order must not
 * matter, so the dispatch date comes from the e-way bill when one is read,
 * replacing a date that only came from the invoice.
 */
export function applyPaperReading(
  form: DispatchForm,
  quantities: Record<string, string>,
  sources: ReadSources,
  reading: PaperReading,
): { form: DispatchForm; quantities: Record<string, string>; sources: ReadSources } {
  const from = DISPATCH_PAPER_LABEL[reading.kind]
  const nextForm = { ...form }
  const nextSources = { ...sources }
  for (const field of READ_FIELDS) {
    if (reading[field] && !form[field].trim()) {
      nextForm[field] = reading[field]
      nextSources[field] = from
    }
  }
  const date = reading.ewayGeneratedOn || reading.invoiceDate
  const dateCameFromInvoice = sources.dispatchedOn === DISPATCH_PAPER_LABEL.invoice
  if (date && (!form.dispatchedOn.trim() || (dateCameFromInvoice && reading.ewayGeneratedOn))) {
    nextForm.dispatchedOn = date
    nextSources.dispatchedOn = from
  }
  const nextQuantities = { ...quantities }
  let filledGoods = false
  for (const line of reading.goods) {
    if (!(nextQuantities[line.itemSequence] ?? '').trim()) {
      nextQuantities[line.itemSequence] = String(line.quantity)
      filledGoods = true
    }
  }
  if (filledGoods) nextSources.goods = from
  return { form: nextForm, quantities: nextQuantities, sources: nextSources }
}
