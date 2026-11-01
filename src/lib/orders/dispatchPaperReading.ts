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

/** The model's answer, made safe: wrong types are dropped, and goods must be lines of this Order. */
export function parsePaperReading(raw: unknown, knownLines: ReadonlySet<string>): PaperReading {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const goods = new Map<string, number>()
  for (const g of Array.isArray(o.goods) ? o.goods : []) {
    const line = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
    const seq = typeof line.item_sequence === 'string' ? line.item_sequence.trim() : ''
    const quantity = line.quantity
    if (!knownLines.has(seq) || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) continue
    goods.set(seq, Math.round(((goods.get(seq) ?? 0) + quantity) * 100) / 100)
  }
  const packages = o.packages
  return {
    kind: DISPATCH_PAPER_KINDS.find(k => k === o.paper_type) ?? 'other',
    invoiceNumber: text(o.invoice_number, 60),
    invoiceDate: isoDate(o.invoice_date),
    invoiceTaxable: amount(o.taxable_value),
    invoiceGst: amount(o.gst_amount),
    invoiceTotal: amount(o.invoice_total),
    ewayBillNumber: text(o.eway_bill_number, 40),
    ewayGeneratedOn: isoDate(o.eway_generated_on),
    ewayValidUntil: isoDate(o.eway_valid_until),
    vehicleNumber: text(o.vehicle_number, 40).toUpperCase(),
    transporter: text(o.transporter, 160),
    lrNumber: text(o.lr_number, 60),
    packages: typeof packages === 'number' && Number.isInteger(packages) && packages >= 0 ? String(packages) : '',
    deliverTo: text(o.deliver_to, 200),
    goods: [...goods].map(([itemSequence, quantity]) => ({ itemSequence, quantity })),
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
