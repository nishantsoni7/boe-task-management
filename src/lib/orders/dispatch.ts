// Dispatch on a Confirmed Order (20270520000000): what the database returned,
// made safe, and the one place dispatched and pending are worked out. The
// screen does no arithmetic of its own. Nothing here touches money; the invoice
// figures are only what was printed on the invoice.

import { formatOrderProductCode } from './orderProductCodes'

export const DISPATCH_PAPER_KINDS = ['invoice', 'eway_bill', 'lr', 'packing_list', 'other'] as const
export type DispatchPaperKind = (typeof DISPATCH_PAPER_KINDS)[number]

export const DISPATCH_PAPER_LABEL: Record<DispatchPaperKind, string> = {
  invoice: 'Invoice',
  eway_bill: 'E-way bill',
  lr: 'LR / bilty',
  packing_list: 'Packing list',
  other: 'Other paper',
}

export type DispatchItem = {
  /** The PI line's id: what the Order page's rows hold. */
  itemId: string
  /** The raw key lots use. The page reformats this for display, so it cannot match on it. */
  itemSequence: string
  productName: string
  quantity: number
  code: string | null
}

export type DispatchFile = {
  id: string
  kind: DispatchPaperKind
  storagePath: string
  fileName: string
  mimeType: string | null
  sizeBytes: number | null
}

export type DispatchDetails = {
  recordKey: string
  vehicleNumber: string | null
  transporter: string | null
  lrNumber: string | null
  driverPhone: string | null
  packages: number | null
  deliverTo: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  invoiceTaxable: number | null
  invoiceGst: number | null
  invoiceTotal: number | null
  ewayBillNumber: string | null
  ewayGeneratedOn: string | null
  ewayValidUntil: string | null
  note: string | null
  recordedAt: string | null
}

export type DispatchLot = {
  id: string
  lotNo: number
  status: 'planned' | 'dispatched'
  plannedOn: string | null
  dispatchedOn: string | null
  lines: { itemSequence: string; quantity: number }[]
  details: DispatchDetails | null
  recordedByName: string | null
  files: DispatchFile[]
}

export type DispatchData = {
  canRecord: boolean
  orderId: string
  displayNumber: string | null
  orderStatus: string
  items: DispatchItem[]
  lots: DispatchLot[]
}

type Row = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object') : [])

function parseDetails(raw: unknown): DispatchDetails | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Row
  const recordKey = str(d.record_key)
  if (!recordKey) return null
  return {
    recordKey,
    vehicleNumber: str(d.vehicle_number),
    transporter: str(d.transporter),
    lrNumber: str(d.lr_number),
    driverPhone: str(d.driver_phone),
    packages: num(d.packages),
    deliverTo: str(d.deliver_to),
    invoiceNumber: str(d.invoice_number),
    invoiceDate: str(d.invoice_date),
    invoiceTaxable: num(d.invoice_taxable),
    invoiceGst: num(d.invoice_gst),
    invoiceTotal: num(d.invoice_total),
    ewayBillNumber: str(d.eway_bill_number),
    ewayGeneratedOn: str(d.eway_generated_on),
    ewayValidUntil: str(d.eway_valid_until),
    note: str(d.note),
    recordedAt: str(d.recorded_at),
  }
}

const paperKind = (v: unknown): DispatchPaperKind =>
  DISPATCH_PAPER_KINDS.find(k => k === v) ?? 'other'

/** order_dispatch_read's answer, or null when there is no such Order. */
export function parseDispatchData(raw: unknown): DispatchData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Row
  if (r.found !== true || !r.order || typeof r.order !== 'object') return null
  const order = r.order as Row
  const orderId = str(order.id)
  if (!orderId) return null
  const displayNumber = str(order.display_number)
  return {
    canRecord: r.can_record === true,
    orderId,
    displayNumber,
    orderStatus: str(order.status) ?? '',
    items: rows(r.items).map(i => {
      const boe = num(i.boe_sequence)
      return {
        itemId: String(i.item_id ?? ''),
        itemSequence: String(i.item_sequence ?? ''),
        productName: str(i.product_name) ?? 'Product',
        quantity: num(i.quantity) ?? 0,
        code: boe === null ? null : formatOrderProductCode(displayNumber, boe),
      }
    }),
    lots: rows(r.lots).map(l => ({
      id: String(l.id ?? ''),
      lotNo: num(l.lot_no) ?? 0,
      status: l.status === 'dispatched' ? 'dispatched' as const : 'planned' as const,
      plannedOn: str(l.planned_on),
      dispatchedOn: str(l.dispatched_on),
      lines: rows(l.lines).map(x => ({ itemSequence: String(x.item_sequence ?? ''), quantity: num(x.quantity) ?? 0 })),
      details: parseDetails(l.details),
      recordedByName: str(l.recorded_by_name),
      files: rows(l.files).map(f => ({
        id: String(f.id ?? ''),
        kind: paperKind(f.kind),
        storagePath: String(f.storage_path ?? ''),
        fileName: str(f.file_name) ?? 'Paper',
        mimeType: str(f.mime_type),
        sizeBytes: num(f.size_bytes),
      })),
    })),
  }
}

// ── Dispatched and pending ───────────────────────────────────────────────────

export type DispatchState = 'none' | 'part' | 'all'

export type DispatchChip = { lotId: string; lotNo: number; date: string | null; quantity: number }

export type LedgerLine = {
  ordered: number
  dispatched: number
  pending: number
  state: DispatchState
  percent: number
  chips: DispatchChip[]
}

export type DispatchLedger = {
  /** By the lots' key: item_sequence, or the line's id when it has none. */
  lines: ReadonlyMap<string, LedgerLine>
  /** The same lines by PI line id, which is what the Order page's rows hold. */
  byItemId: ReadonlyMap<string, LedgerLine>
  ordered: number
  dispatched: number
  pending: number
  percent: number
  dispatches: DispatchLot[]
  /** Products per filter: every line, those with anything pending, those fully sent. */
  counts: { all: number; pending: number; done: number }
  /** Dispatches still waiting for an invoice or an e-way bill. */
  needPapers: number
}

/** Two decimals is what the database keeps, so sums never drift. */
const tidy = (n: number): number => Math.round(n * 100) / 100

const percentOf = (part: number, whole: number): number =>
  whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0

export function dispatchedLots(data: DispatchData): DispatchLot[] {
  return data.lots.filter(l => l.status === 'dispatched')
}

export function plannedLot(data: DispatchData): DispatchLot | null {
  return data.lots.find(l => l.status === 'planned') ?? null
}

export function buildDispatchLedger(data: DispatchData): DispatchLedger {
  const dispatches = dispatchedLots(data)
  const lines = new Map<string, LedgerLine>()
  const byItemId = new Map<string, LedgerLine>()
  for (const item of data.items) {
    const chips: DispatchChip[] = []
    for (const lot of dispatches) {
      const quantity = lot.lines.find(l => l.itemSequence === item.itemSequence)?.quantity
      if (quantity) chips.push({ lotId: lot.id, lotNo: lot.lotNo, date: lot.dispatchedOn, quantity })
    }
    const dispatched = tidy(chips.reduce((sum, c) => sum + c.quantity, 0))
    // A later PI revision can lower a quantity below what already left.
    const pending = Math.max(0, tidy(item.quantity - dispatched))
    const state: DispatchState = dispatched <= 0 ? 'none' : pending > 0 ? 'part' : 'all'
    const line = { ordered: item.quantity, dispatched, pending, state, percent: percentOf(dispatched, item.quantity), chips }
    lines.set(item.itemSequence, line)
    byItemId.set(item.itemId, line)
  }
  const all = [...lines.values()]
  const ordered = tidy(all.reduce((sum, l) => sum + l.ordered, 0))
  const dispatched = tidy(all.reduce((sum, l) => sum + l.dispatched, 0))
  const pending = tidy(all.reduce((sum, l) => sum + l.pending, 0))
  return {
    lines, byItemId, ordered, dispatched, pending,
    percent: percentOf(dispatched, ordered),
    dispatches,
    counts: {
      all: all.length,
      pending: all.filter(l => l.pending > 0).length,
      done: all.filter(l => l.state === 'all').length,
    },
    needPapers: dispatches.filter(l => missingPapers(l).length > 0).length,
  }
}

export const DISPATCH_STATE_LABEL: Record<DispatchState, string> = {
  none: 'Not dispatched',
  part: 'Part dispatched',
  all: 'All dispatched',
}

export type DispatchFilter = 'all' | 'pending' | 'done'

export const lineShows = (line: LedgerLine | undefined, filter: DispatchFilter): boolean => {
  if (filter === 'all') return true
  if (!line) return false
  return filter === 'pending' ? line.pending > 0 : line.state === 'all'
}

/** The papers every dispatch should have. A typed number counts, so a paper can follow. */
export function missingPapers(lot: DispatchLot): DispatchPaperKind[] {
  const has = (kind: DispatchPaperKind) => lot.files.some(f => f.kind === kind)
  const missing: DispatchPaperKind[] = []
  if (!has('invoice') && !lot.details?.invoiceNumber) missing.push('invoice')
  if (!has('eway_bill') && !lot.details?.ewayBillNumber) missing.push('eway_bill')
  return missing
}

export function papersText(lot: DispatchLot): { text: string; complete: boolean } {
  const missing = missingPapers(lot)
  if (missing.length === 2) return { text: 'Invoice and e-way bill missing', complete: false }
  if (missing.length === 1) return { text: `${DISPATCH_PAPER_LABEL[missing[0]]} missing`, complete: false }
  return lot.files.length === 0
    ? { text: 'Details typed, no papers', complete: true }
    : { text: `All ${lot.files.length} added`, complete: true }
}

export const piecesText = (n: number): string =>
  `${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${n === 1 ? 'pc' : 'pcs'}`

export const piecesOf = (lot: DispatchLot): number => tidy(lot.lines.reduce((sum, l) => sum + l.quantity, 0))

// ── The form ─────────────────────────────────────────────────────────────────

export type DispatchForm = {
  dispatchedOn: string
  vehicleNumber: string
  transporter: string
  lrNumber: string
  driverPhone: string
  packages: string
  deliverTo: string
  invoiceNumber: string
  invoiceDate: string
  invoiceTaxable: string
  invoiceGst: string
  invoiceTotal: string
  ewayBillNumber: string
  ewayGeneratedOn: string
  ewayValidUntil: string
  note: string
}

export const EMPTY_DISPATCH_FORM: DispatchForm = {
  dispatchedOn: '', vehicleNumber: '', transporter: '', lrNumber: '', driverPhone: '', packages: '', deliverTo: '',
  invoiceNumber: '', invoiceDate: '', invoiceTaxable: '', invoiceGst: '', invoiceTotal: '',
  ewayBillNumber: '', ewayGeneratedOn: '', ewayValidUntil: '', note: '',
}

export function formFromLot(lot: DispatchLot): DispatchForm {
  const d = lot.details
  const text = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return {
    dispatchedOn: text(lot.dispatchedOn),
    vehicleNumber: text(d?.vehicleNumber),
    transporter: text(d?.transporter),
    lrNumber: text(d?.lrNumber),
    driverPhone: text(d?.driverPhone),
    packages: text(d?.packages),
    deliverTo: text(d?.deliverTo),
    invoiceNumber: text(d?.invoiceNumber),
    invoiceDate: text(d?.invoiceDate),
    invoiceTaxable: text(d?.invoiceTaxable),
    invoiceGst: text(d?.invoiceGst),
    invoiceTotal: text(d?.invoiceTotal),
    ewayBillNumber: text(d?.ewayBillNumber),
    ewayGeneratedOn: text(d?.ewayGeneratedOn),
    ewayValidUntil: text(d?.ewayValidUntil),
    note: text(d?.note),
  }
}

/** What the database functions take; a blank clears, and the date lives on the lot. */
export function detailsPayload(form: DispatchForm): Record<string, string> {
  return {
    vehicle_number: form.vehicleNumber,
    transporter: form.transporter,
    lr_number: form.lrNumber,
    driver_phone: form.driverPhone,
    packages: form.packages,
    deliver_to: form.deliverTo,
    invoice_number: form.invoiceNumber,
    invoice_date: form.invoiceDate,
    invoice_taxable: form.invoiceTaxable.replace(/,/g, ''),
    invoice_gst: form.invoiceGst.replace(/,/g, ''),
    invoice_total: form.invoiceTotal.replace(/,/g, ''),
    eway_bill_number: form.ewayBillNumber,
    eway_generated_on: form.ewayGeneratedOn,
    eway_valid_until: form.ewayValidUntil,
    note: form.note,
  }
}

/** Blank or a plain non-negative number with at most two decimals; commas allowed. */
export function amountIsValid(text: string): boolean {
  const t = text.replace(/,/g, '').trim()
  return t === '' || /^\d+(\.\d{1,2})?$/.test(t)
}

/** null while any of the three is blank; a rupee of rounding is allowed. */
export function invoiceAddsUp(form: DispatchForm): boolean | null {
  const [taxable, gst, total] = [form.invoiceTaxable, form.invoiceGst, form.invoiceTotal]
    .map(t => (t.trim() === '' || !amountIsValid(t) ? null : Number(t.replace(/,/g, ''))))
  if (taxable === null || gst === null || total === null) return null
  return Math.abs(taxable + gst - total) <= 1
}

export type GoodsCheck = { lines: { item_sequence: string; quantity: number }[]; problems: Record<string, string>; pieces: number }

/** Reads the typed quantities against what is still pending for each product. */
export function checkGoods(quantities: Record<string, string>, ledger: DispatchLedger): GoodsCheck {
  const lines: GoodsCheck['lines'] = []
  const problems: Record<string, string> = {}
  for (const [itemSequence, line] of ledger.lines) {
    const typed = (quantities[itemSequence] ?? '').trim()
    if (typed === '') continue
    const n = Number(typed)
    if (!Number.isFinite(n) || n < 0 || !/^\d+(\.\d{1,2})?$/.test(typed)) {
      problems[itemSequence] = 'Type a number.'
    } else if (n > line.pending) {
      problems[itemSequence] = `Only ${line.pending} pending.`
    } else if (n > 0) {
      lines.push({ item_sequence: itemSequence, quantity: n })
    }
  }
  return { lines, problems, pieces: tidy(lines.reduce((sum, l) => sum + l.quantity, 0)) }
}

export const ORDER_DISPATCH_ERROR_TEXT: readonly [RegExp, string][] = [
  [/ORDER_DISPATCH_FORBIDDEN/, 'You do not have access to record a dispatch on this Order. An Admin can grant it in Control Center.'],
  [/ORDER_DISPATCH_ORDER_CANCELLED/, 'This Order is cancelled, so it takes no dispatch.'],
  [/ORDER_DISPATCH_GOODS_REQUIRED/, 'Enter how many pieces of at least one product left.'],
  [/DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'A quantity is above what is pending. Someone may have recorded a dispatch just now; reload and check.'],
  [/DISPATCH_DATE_REQUIRED/, 'Choose the dispatch date.'],
  [/DISPATCH_DATE_IN_FUTURE/, 'The dispatch date cannot be in the future.'],
  [/ORDER_DISPATCH_TOO_MANY_FILES/, 'A dispatch can hold 25 papers.'],
]

export function describeDispatchError(message: string): string {
  return ORDER_DISPATCH_ERROR_TEXT.find(([re]) => re.test(message))?.[1]
    ?? 'The dispatch could not be saved. Check the dates and amounts, then try again.'
}
