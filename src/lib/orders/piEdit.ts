// ── ONE "EDIT PI" (20270103000000) ────────────────────────────────────────────
//
// The whole PI in one editor — client, bill-to/ship-to, dates, commercial
// terms, fabric, every product (name, code, description, quantity, price,
// photo), added, changed or removed — and the one comparison an Admin reads
// before authorizing it.
//
// WHO PRICES IT. Never the browser. The editor holds WHAT the person changed
// (this module's PiEditState); the server re-reads the PI in force, re-applies
// the edit with priceEdit() and buildEditProposal() below, and only that result
// is stored. A browser that sent its own totals would be ignored.
//
// WHAT CHANGES MONEY, AND WHAT DOES NOT. Renaming a product, correcting an
// address or replacing a photo keeps every stored figure exactly as the
// approved PI has it — the workbook's own arithmetic is not second-guessed.
// Only a change to a quantity, a price, a line added or removed, the discount,
// a cost or the GST rate re-prices the PI, with one visible formula:
//
//   line total          = quantity × price                   (2 decimals)
//   gross               = Σ line totals
//   sub total           = gross − discount
//   total before GST    = sub total + fabric + packing + transportation
//   GST                 = total before GST × GST % / 100      (2 decimals)
//   grand total         = total before GST + GST
//
// No React, no network: every rule is a function a test can pin.

// ── The PI as it stands (the version in force, read from its rows) ───────────

export type PiContentSubmission = Record<string, unknown>

export type PiContentItem = {
  id: string
  source_row: number
  item_sequence: string | null
  source_product_code: string | null
  product_name: string | null
  quantity: number | string | null
  dimensions: string | null
  material: string | null
  customization: string | null
  cost_per_piece: number | string | null
  total_amount: number | string | null
  sort_order: number | null
}

export type PiContentImage = {
  item_id: string
  role: 'representative' | 'customization'
  position: number
  storage_path: string
  mime_type: string | null
  sha256: string | null
  source_media_path?: string | null
  anchor_row: number | null
}

/** Everything a PI version contains, in the shape the rows have. */
export type PiContent = {
  submission: PiContentSubmission
  items: PiContentItem[]
  images: PiContentImage[]
}

/** The PI columns an edit reads and may change, plus what identifies the PI.
 *  One list for the server route and the editor, so they cannot drift. */
export const PI_EDIT_SUBMISSION_COLUMNS = [
  'id', 'status', 'order_id', 'created_by', 'submitted_by', 'deletion_claim_token',
  'client_name', 'client_city', 'creation_date', 'source_created_by', 'boe_gst', 'contact_number',
  'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address', 'ship_to_name', 'ship_to_phone',
  'ship_to_gst', 'shipping_address', 'order_confirmation_date', 'dispatch_commitment', 'due_date',
  'source_order_number', 'source_workbook_path', 'source_workbook_name', 'source_workbook_size_bytes',
  'source_workbook_sha256', 'template_version',
  'gross_product_amount', 'discount_amount', 'subtotal_after_discount', 'fabric_cost', 'fabric_cost_meaning',
  'fabric_cost_text', 'packing_cost', 'packing_cost_meaning', 'packing_cost_text', 'transportation_amount',
  'transportation_text', 'total_before_gst', 'gst_amount', 'grand_total', 'billing_percentage',
  'fabric_responsibility', 'commercial_terms_note', 'payment_terms', 'billing_terms',
].join(', ')

export const PI_EDIT_ITEM_COLUMNS =
  'id, source_row, item_sequence, source_product_code, product_name, quantity, dimensions, material, customization, cost_per_piece, total_amount, sort_order'
export const PI_EDIT_IMAGE_COLUMNS =
  'item_id, role, position, storage_path, mime_type, sha256, source_media_path, anchor_row'

// ── The edit ──────────────────────────────────────────────────────────────────

export const PI_EDIT_HEADER_FIELDS = [
  { key: 'client_name',             label: 'Client name',            kind: 'text',     max: 200, required: true },
  { key: 'client_city',             label: 'Client city',            kind: 'text',     max: 120, required: true },
  { key: 'contact_number',          label: 'Contact number',         kind: 'text',     max: 40 },
  { key: 'bill_to_name',            label: 'Bill-to name',           kind: 'text',     max: 200 },
  { key: 'bill_to_phone',           label: 'Bill-to phone',          kind: 'text',     max: 40 },
  { key: 'bill_to_gst',             label: 'Bill-to GST',            kind: 'text',     max: 40 },
  { key: 'billing_address',         label: 'Billing address',        kind: 'textarea', max: 1000 },
  { key: 'ship_to_name',            label: 'Ship-to name',           kind: 'text',     max: 200 },
  { key: 'ship_to_phone',           label: 'Ship-to phone',          kind: 'text',     max: 40 },
  { key: 'ship_to_gst',             label: 'Ship-to GST',            kind: 'text',     max: 40 },
  { key: 'shipping_address',        label: 'Shipping address',       kind: 'textarea', max: 1000 },
  { key: 'creation_date',           label: 'Date of creation',       kind: 'date' },
  { key: 'order_confirmation_date', label: 'Order confirmation date', kind: 'date' },
  { key: 'due_date',                label: 'Due date',               kind: 'date' },
  { key: 'dispatch_commitment',     label: 'Dispatch commitment',    kind: 'text',     max: 200 },
] as const

export const PI_EDIT_TERMS_FIELDS = [
  { key: 'payment_terms',         label: 'Payment terms',          kind: 'textarea', max: 500 },
  { key: 'billing_terms',         label: 'Billing terms',          kind: 'textarea', max: 500 },
  { key: 'commercial_terms_note', label: 'Commercial terms note',  kind: 'textarea', max: 2000 },
] as const

export type PiEditHeaderKey = typeof PI_EDIT_HEADER_FIELDS[number]['key']
export type PiEditTermsKey = typeof PI_EDIT_TERMS_FIELDS[number]['key']

export type PiEditPhoto =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'new'; storage_path: string; sha256: string; mime_type: string }

export type PiEditItem = {
  /** Stable key for the editor. An existing line's id, or 'new-…'. */
  key: string
  /** The existing line this edits, or null for a line added here. */
  id: string | null
  removed: boolean
  source_product_code: string
  item_sequence: string
  product_name: string
  dimensions: string
  material: string
  customization: string
  /** Typed text, so "1,200" and "" survive until validated. */
  quantity: string
  cost_per_piece: string
  photo: PiEditPhoto
}

export type PiEditState = {
  header: Record<PiEditHeaderKey, string>
  terms: Record<PiEditTermsKey, string> & {
    fabric_responsibility: '' | 'not_selected' | 'boe' | 'client'
    billing_percentage: string
  }
  commercial: {
    discount_amount: string
    fabric_cost: string
    packing_cost: string
    transportation_amount: string
    gst_percent: string
  }
  items: PiEditItem[]
}

// ── Reading numbers the way people type them ─────────────────────────────────

/** "1,20,000.50" → 120000.5; "" → null; anything else → NaN. */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[,\s₹]/g, '').trim()
  if (s === '') return null
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const amountText = (v: unknown): string => {
  const n = num(v)
  return n === null ? '' : String(n)
}

// ── Opening the editor on the version in force ───────────────────────────────

export function initialEditState(current: PiContent): PiEditState {
  const s = current.submission
  const header = Object.fromEntries(PI_EDIT_HEADER_FIELDS.map(f => [f.key, str(s[f.key])])) as Record<PiEditHeaderKey, string>
  const tbg = num(s.total_before_gst)
  const gst = num(s.gst_amount)
  const gstPercent = tbg && tbg > 0 && gst !== null ? round2((gst / tbg) * 100) : 18
  return {
    header,
    terms: {
      payment_terms: str(s.payment_terms),
      billing_terms: str(s.billing_terms),
      commercial_terms_note: str(s.commercial_terms_note),
      fabric_responsibility: (['not_selected', 'boe', 'client'].includes(str(s.fabric_responsibility))
        ? str(s.fabric_responsibility) : '') as PiEditState['terms']['fabric_responsibility'],
      billing_percentage: amountText(s.billing_percentage),
    },
    commercial: {
      discount_amount: amountText(s.discount_amount),
      fabric_cost: s.fabric_cost_meaning === 'numeric' || s.fabric_cost_meaning == null ? amountText(s.fabric_cost) : '',
      packing_cost: s.packing_cost_meaning === 'numeric' || s.packing_cost_meaning == null ? amountText(s.packing_cost) : '',
      transportation_amount: amountText(s.transportation_amount),
      gst_percent: String(gstPercent),
    },
    items: [...current.items]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.source_row - b.source_row)
      .map(i => ({
        key: i.id,
        id: i.id,
        removed: false,
        source_product_code: str(i.source_product_code),
        item_sequence: str(i.item_sequence),
        product_name: str(i.product_name),
        dimensions: str(i.dimensions),
        material: str(i.material),
        customization: str(i.customization),
        quantity: amountText(i.quantity),
        cost_per_piece: amountText(i.cost_per_piece),
        photo: { kind: 'keep' },
      })),
  }
}

export function newEditItem(key: string): PiEditItem {
  return {
    key, id: null, removed: false,
    source_product_code: '', item_sequence: '', product_name: '', dimensions: '', material: '', customization: '',
    quantity: '1', cost_per_piece: '', photo: { kind: 'keep' },
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

export type PiEditProblem = { where: string; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateEdit(state: PiEditState): PiEditProblem[] {
  const problems: PiEditProblem[] = []
  for (const f of PI_EDIT_HEADER_FIELDS) {
    const v = state.header[f.key].trim()
    if ('required' in f && f.required && v === '') problems.push({ where: f.label, message: `${f.label} is required.` })
    if (f.kind === 'date' && v !== '' && !ISO_DATE.test(v)) problems.push({ where: f.label, message: `${f.label} must be a date.` })
    if ('max' in f && v.length > f.max) problems.push({ where: f.label, message: `${f.label} may be at most ${f.max} characters.` })
  }
  for (const f of PI_EDIT_TERMS_FIELDS) {
    if (state.terms[f.key].trim().length > f.max) {
      problems.push({ where: f.label, message: `${f.label} may be at most ${f.max} characters.` })
    }
  }
  if (state.terms.fabric_responsibility === '') {
    problems.push({ where: 'Fabric', message: 'Choose who provides the fabric.' })
  }
  const billing = parseAmount(state.terms.billing_percentage)
  if (billing !== null && (Number.isNaN(billing) || billing < 35 || billing > 100)) {
    problems.push({ where: 'Billing %', message: 'Billing % must be between 35 and 100, or left blank.' })
  }
  for (const [key, label] of [['discount_amount', 'Discount'], ['fabric_cost', 'Fabric cost'],
    ['packing_cost', 'Packing cost'], ['transportation_amount', 'Transportation']] as const) {
    const v = parseAmount(state.commercial[key])
    if (v !== null && (Number.isNaN(v) || v < 0)) problems.push({ where: label, message: `${label} must be a number of at least 0.` })
  }
  const gst = parseAmount(state.commercial.gst_percent)
  if (gst === null || Number.isNaN(gst) || gst < 0 || gst > 28) {
    problems.push({ where: 'GST %', message: 'GST % must be a number from 0 to 28.' })
  }
  const live = state.items.filter(i => !i.removed)
  if (live.length === 0) problems.push({ where: 'Products', message: 'A PI needs at least one product.' })
  live.forEach((item, n) => {
    const at = `Product ${n + 1}`
    if (item.product_name.trim() === '') problems.push({ where: at, message: `${at}: a name is required.` })
    if (item.product_name.length > 300) problems.push({ where: at, message: `${at}: the name may be at most 300 characters.` })
    const q = parseAmount(item.quantity)
    if (q === null || Number.isNaN(q) || q <= 0) problems.push({ where: at, message: `${at}: quantity must be more than 0.` })
    const r = parseAmount(item.cost_per_piece)
    // The database's own rule (order_submission_items): a price is more than 0.
    if (r === null || Number.isNaN(r) || r <= 0) problems.push({ where: at, message: `${at}: price must be more than 0.` })
    for (const [k, label, max] of [['dimensions', 'dimensions', 500], ['material', 'material', 1000],
      ['customization', 'customization', 2000], ['source_product_code', 'code', 100]] as const) {
      if (item[k].length > max) problems.push({ where: at, message: `${at}: ${label} may be at most ${max} characters.` })
    }
  })
  return problems
}

/**
 * A typed item number that belonged to another product on this Order
 * (20270104000000). An added line may not take any number the Order has ever
 * used; a continuing line may keep its own but not move to another's. The
 * database refuses the same at approval; this says it while editing.
 */
export function retiredSequenceProblems(
  state: PiEditState,
  current: PiContent,
  everUsed: readonly string[],
): PiEditProblem[] {
  const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase()
  const taken = new Set([...everUsed.map(norm), ...current.items.map(i => norm(i.item_sequence))].filter(Boolean))
  const own = new Map(current.items.map(i => [i.id, norm(i.item_sequence)]))
  const problems: PiEditProblem[] = []
  state.items.forEach((item, n) => {
    if (item.removed) return
    const seq = norm(item.item_sequence)
    if (!seq || !taken.has(seq)) return
    if (item.id && own.get(item.id) === seq) return
    problems.push({
      where: `Product ${n + 1}`,
      message: `Item number ${item.item_sequence.trim()} already belonged to another product on this Order. Leave it blank for the next free number.`,
    })
  })
  return problems
}

// ── Pricing ───────────────────────────────────────────────────────────────────

export type PricedLine = {
  item: PiEditItem
  quantity: number
  cost_per_piece: number
  total_amount: number
  /** Whether this line changes money: new, or quantity/price edited. */
  moneyChanged: boolean
}

export type PricedEdit = {
  lines: PricedLine[]
  moneyChanged: boolean
  commercial: {
    gross_product_amount: number
    discount_amount: number
    subtotal_after_discount: number | null
    fabric_cost: number | null
    fabric_cost_meaning: string
    fabric_cost_text: string | null
    packing_cost: number | null
    packing_cost_meaning: string
    packing_cost_text: string | null
    transportation_amount: number | null
    transportation_text: string | null
    total_before_gst: number | null
    gst_amount: number | null
    grand_total: number | null
  }
}

/** Assumes validateEdit(state) returned nothing. */
export function priceEdit(current: PiContent, state: PiEditState): PricedEdit {
  const s = current.submission
  const byId = new Map(current.items.map(i => [i.id, i]))
  const removedAny = state.items.some(i => i.removed && i.id !== null)
  const lines: PricedLine[] = state.items.filter(i => !i.removed).map(item => {
    const quantity = parseAmount(item.quantity) as number
    const rate = parseAmount(item.cost_per_piece) as number
    const before = item.id ? byId.get(item.id) : undefined
    const same = before !== undefined && num(before.quantity) === quantity && num(before.cost_per_piece) === rate
    const stored = before ? num(before.total_amount) : null
    return {
      item, quantity, cost_per_piece: rate,
      total_amount: same && stored !== null ? stored : round2(quantity * rate),
      moneyChanged: !same,
    }
  })

  const c = state.commercial
  const fromState = (v: string) => parseAmount(v)
  const commercialChanged =
    fromState(c.discount_amount) !== (num(s.discount_amount) ?? null)
    || (c.fabric_cost !== '' && fromState(c.fabric_cost) !== num(s.fabric_cost))
    || (c.packing_cost !== '' && fromState(c.packing_cost) !== num(s.packing_cost))
    || (c.transportation_amount !== '' && fromState(c.transportation_amount) !== num(s.transportation_amount))
    || (() => {
      const tbg = num(s.total_before_gst); const gst = num(s.gst_amount)
      const stored = tbg && tbg > 0 && gst !== null ? round2((gst / tbg) * 100) : 18
      return fromState(c.gst_percent) !== stored
    })()
  const moneyChanged = removedAny || lines.some(l => l.moneyChanged) || commercialChanged

  // Costs: a typed number is the figure; a blank keeps what the PI stated,
  // including worded ones ("as per actual", "inclusive").
  const cost = (typed: string, amount: unknown, meaning: unknown, text: unknown) => typed.trim() === ''
    ? { amount: num(amount), meaning: str(meaning) || 'numeric', text: str(text) || null }
    : { amount: fromState(typed), meaning: 'numeric', text: null }
  const fabric = cost(c.fabric_cost, s.fabric_cost, s.fabric_cost_meaning, s.fabric_cost_text)
  const packing = cost(c.packing_cost, s.packing_cost, s.packing_cost_meaning, s.packing_cost_text)
  const transport = c.transportation_amount.trim() === ''
    ? { amount: num(s.transportation_amount), text: str(s.transportation_text) || null }
    : { amount: fromState(c.transportation_amount), text: null }

  if (!moneyChanged) {
    return {
      lines, moneyChanged,
      commercial: {
        gross_product_amount: num(s.gross_product_amount) ?? round2(lines.reduce((a, l) => a + l.total_amount, 0)),
        discount_amount: num(s.discount_amount) ?? 0,
        subtotal_after_discount: num(s.subtotal_after_discount),
        fabric_cost: fabric.amount, fabric_cost_meaning: fabric.meaning, fabric_cost_text: fabric.text,
        packing_cost: packing.amount, packing_cost_meaning: packing.meaning, packing_cost_text: packing.text,
        transportation_amount: transport.amount, transportation_text: transport.text,
        total_before_gst: num(s.total_before_gst), gst_amount: num(s.gst_amount), grand_total: num(s.grand_total),
      },
    }
  }

  const gross = round2(lines.reduce((a, l) => a + l.total_amount, 0))
  const discount = fromState(c.discount_amount) ?? 0
  const subtotal = round2(gross - discount)
  const tbg = round2(subtotal + (fabric.amount ?? 0) + (packing.amount ?? 0) + (transport.amount ?? 0))
  const gst = round2(tbg * (fromState(c.gst_percent) as number) / 100)
  return {
    lines, moneyChanged,
    commercial: {
      gross_product_amount: gross, discount_amount: discount, subtotal_after_discount: subtotal,
      fabric_cost: fabric.amount, fabric_cost_meaning: fabric.meaning, fabric_cost_text: fabric.text,
      packing_cost: packing.amount, packing_cost_meaning: packing.meaning, packing_cost_text: packing.text,
      transportation_amount: transport.amount, transportation_text: transport.text,
      total_before_gst: tbg, gst_amount: gst, grand_total: round2(tbg + gst),
    },
  }
}

// ── The proposal the server stores ────────────────────────────────────────────

export type PiEditProposal = {
  payload: Record<string, unknown>
  terms: Record<string, unknown>
  change_summary: string[]
  base_version_id: string | null
}

const blankToNull = (v: string): string | null => (v.trim() === '' ? null : v.trim())
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The complete proposed PI, in the shape #205's staging stores and
 * replace_order_submission_parse writes. SERVER-SIDE: `newId` mints ids for
 * added lines, `fingerprint` hashes the result.
 */
export function buildEditProposal(input: {
  current: PiContent
  state: PiEditState
  priced: PricedEdit
  baseVersionId: string | null
  newId: () => string
  fingerprint: (json: string) => string
  /**
   * Every sequence this Order's lines have ever held (order_item_sequences_ever_used,
   * 20270104000000) — including lines removed in an earlier version. Empty for
   * a PI that is not yet an Order.
   */
  retiredSequences?: readonly string[]
}): PiEditProposal {
  const { current, state, priced } = input
  const s = current.submission
  const byId = new Map(current.items.map(i => [i.id, i]))
  let nextRow = Math.max(0, ...current.items.map(i => i.source_row)) + 1

  // A line needs a sequence (B001 …) to be submittable. One added here gets the
  // next free one after every sequence the PI uses now OR any earlier version
  // of this Order used, in order. Sequences of removed lines stay taken: a
  // number once printed for one product is never handed to another.
  const used = new Set([
    ...priced.lines.map(l => l.item.item_sequence.trim()),
    ...current.items.map(i => (i.item_sequence ?? '').trim()),
    ...(input.retiredSequences ?? []).map(q => q.trim()),
  ].filter(Boolean).map(q => q.toUpperCase()))
  let nextSeq = Math.max(0, ...[...used].map(s => Number(/^B(\d+)$/i.exec(s)?.[1] ?? 0)))
  const sequenceFor = (typed: string): string => {
    if (typed.trim() !== '') return typed.trim()
    let s: string
    do { nextSeq += 1; s = `B${String(nextSeq).padStart(3, '0')}` } while (used.has(s))
    used.add(s)
    return s
  }

  const items: Record<string, unknown>[] = []
  const images: Record<string, unknown>[] = []
  priced.lines.forEach((line, order) => {
    const before = line.item.id ? byId.get(line.item.id) : undefined
    // A line added in the editor carries its own UUID as its key, so a photo
    // uploaded for it before submission already sits under its final path.
    const id = before ? before.id : (UUID.test(line.item.key) && !byId.has(line.item.key) ? line.item.key : input.newId())
    const sourceRow = before ? before.source_row : nextRow++
    const kept = current.images.filter(m => m.item_id === id)
    const photo = line.item.photo
    const representative: Record<string, unknown> | null =
      photo.kind === 'new'
        ? { item_id: id, role: 'representative', position: 0, storage_path: photo.storage_path,
            mime_type: photo.mime_type, sha256: photo.sha256, source_media_path: null, anchor_row: sourceRow }
        : photo.kind === 'remove'
          ? null
          : (() => {
            const r = kept.find(m => m.role === 'representative')
            return r ? { ...r } : null
          })()
    if (representative) images.push(representative)
    for (const m of kept.filter(m => m.role === 'customization')) images.push({ ...m })
    items.push({
      id,
      source_row: sourceRow,
      item_sequence: sequenceFor(line.item.item_sequence),
      source_product_code: blankToNull(line.item.source_product_code),
      product_name: line.item.product_name.trim(),
      quantity: line.quantity,
      dimensions: blankToNull(line.item.dimensions),
      material: blankToNull(line.item.material),
      customization: blankToNull(line.item.customization),
      cost_per_piece: line.cost_per_piece,
      total_amount: line.total_amount,
      image_storage_path: representative ? representative.storage_path : null,
      image_mime_type: representative ? representative.mime_type : null,
      image_sha256: representative ? representative.sha256 : null,
      image_anchor_row: representative ? sourceRow : null,
      sort_order: order,
    })
  })

  const header: Record<string, unknown> = {
    client_name: state.header.client_name.trim(),
    creation_date: blankToNull(state.header.creation_date),
    source_created_by: s.source_created_by ?? null,
    boe_gst: s.boe_gst ?? null,
    contact_number: blankToNull(state.header.contact_number),
    bill_to_name: blankToNull(state.header.bill_to_name),
    bill_to_phone: blankToNull(state.header.bill_to_phone),
    bill_to_gst: blankToNull(state.header.bill_to_gst),
    billing_address: blankToNull(state.header.billing_address),
    ship_to_name: blankToNull(state.header.ship_to_name),
    ship_to_phone: blankToNull(state.header.ship_to_phone),
    ship_to_gst: blankToNull(state.header.ship_to_gst),
    shipping_address: blankToNull(state.header.shipping_address),
    order_confirmation_date: blankToNull(state.header.order_confirmation_date),
    dispatch_commitment: blankToNull(state.header.dispatch_commitment),
    due_date: blankToNull(state.header.due_date),
    source_order_number: s.source_order_number ?? null,
  }

  const terms = {
    fabric_responsibility: state.terms.fabric_responsibility || null,
    commercial_terms_note: blankToNull(state.terms.commercial_terms_note),
    client_city: blankToNull(state.header.client_city),
    payment_terms: blankToNull(state.terms.payment_terms),
    billing_terms: blankToNull(state.terms.billing_terms),
    billing_percentage: parseAmount(state.terms.billing_percentage),
  }

  const body = {
    header,
    commercial: priced.commercial,
    // The ORIGINAL uploaded workbook stays the source of record: an edit makes
    // no new file, and the old file is never relabelled as the revised PI.
    source: {
      workbook_path: s.source_workbook_path ?? null,
      workbook_name: s.source_workbook_name ?? null,
      workbook_size_bytes: s.source_workbook_size_bytes ?? null,
      workbook_sha256: s.source_workbook_sha256 ?? null,
      template_version: s.template_version ?? null,
    },
    // The workbook's own diagnostics describe the file, not this edit.
    parse: { warnings: [], blocking_issues: [] },
    items,
    item_images: images,
    seed_terms: {
      fabric_responsibility: terms.fabric_responsibility,
      commercial_terms_note: terms.commercial_terms_note,
      client_city: terms.client_city,
    },
  }
  const payload = { ...body, fingerprint: input.fingerprint(JSON.stringify(body)) }

  const summary = summarizeChanges(diffPi(normalizePi(current), normalizeProposal({ payload, terms })))
  return { payload, terms, change_summary: summary, base_version_id: input.baseVersionId }
}

// ── One shape for any version, and the comparison between two ────────────────

export type NormalizedLine = {
  id: string
  name: string
  code: string
  description: string
  quantity: number | null
  rate: number | null
  total: number | null
  photo: string | null
}

export type NormalizedPi = {
  fields: Record<string, string>
  lines: NormalizedLine[]
  grandTotal: number | null
}

/** Every field the comparison reads, labelled once. */
export const DIFF_FIELD_LABELS: Record<string, string> = {
  ...Object.fromEntries(PI_EDIT_HEADER_FIELDS.map(f => [f.key, f.label])),
  ...Object.fromEntries(PI_EDIT_TERMS_FIELDS.map(f => [f.key, f.label])),
  fabric_responsibility: 'Fabric',
  billing_percentage: 'Billing %',
  discount_amount: 'Discount',
  gross_product_amount: 'Product value',
  total_before_gst: 'Total before GST',
  gst_amount: 'GST',
  grand_total: 'Grand total',
}

const FABRIC_WORDS: Record<string, string> = {
  boe: 'Provided by BOE', client: 'Provided by the client', not_selected: 'Not selected yet',
}

const fieldText = (key: string, v: unknown): string => {
  if (v == null || v === '') return ''
  if (key === 'fabric_responsibility') return FABRIC_WORDS[str(v)] ?? str(v)
  const n = num(v)
  if (n !== null && typeof v !== 'string') return String(n)
  return str(v).trim()
}

const describe = (i: { dimensions?: unknown; material?: unknown; customization?: unknown }) =>
  [i.dimensions, i.material, i.customization].map(str).map(x => x.trim()).filter(Boolean).join(' · ')

export function normalizePi(content: PiContent): NormalizedPi {
  const photo = new Map(content.images.filter(m => m.role === 'representative').map(m => [m.item_id, m.storage_path]))
  const fields: Record<string, string> = {}
  for (const key of Object.keys(DIFF_FIELD_LABELS)) fields[key] = fieldText(key, content.submission[key])
  return {
    fields,
    grandTotal: num(content.submission.grand_total),
    lines: [...content.items]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map(i => ({
        id: i.id, name: str(i.product_name), code: str(i.source_product_code), description: describe(i),
        quantity: num(i.quantity), rate: num(i.cost_per_piece), total: num(i.total_amount), photo: photo.get(i.id) ?? null,
      })),
  }
}

/** A stored proposal (or a staged workbook parse) read into the same shape. */
export function normalizeProposal(proposal: { payload: Record<string, unknown>; terms?: Record<string, unknown> | null }): NormalizedPi {
  const p = proposal.payload
  const header = (p.header ?? {}) as Record<string, unknown>
  const commercial = (p.commercial ?? {}) as Record<string, unknown>
  const items = (p.items ?? []) as PiContentItem[]
  const images = (p.item_images ?? []) as PiContentImage[]
  return normalizePi({
    submission: { ...header, ...commercial, ...(proposal.terms ?? {}) },
    items, images,
  })
}

export type FieldChange = { key: string; label: string; before: string; after: string }
export type LineChange = {
  id: string
  name: string
  changes: { label: string; before: string; after: string }[]
  quantityDelta: number | null
  rateDelta: number | null
  totalDelta: number | null
  photoChanged: boolean
}
export type PiDiff = {
  fields: FieldChange[]
  added: NormalizedLine[]
  removed: NormalizedLine[]
  changed: LineChange[]
  grandTotalDelta: number | null
}

export function diffPi(before: NormalizedPi, after: NormalizedPi): PiDiff {
  const fields: FieldChange[] = []
  for (const [key, label] of Object.entries(DIFF_FIELD_LABELS)) {
    if ((before.fields[key] ?? '') !== (after.fields[key] ?? '')) {
      fields.push({ key, label, before: before.fields[key] ?? '', after: after.fields[key] ?? '' })
    }
  }
  const beforeById = new Map(before.lines.map(l => [l.id, l]))
  const afterById = new Map(after.lines.map(l => [l.id, l]))
  const added = after.lines.filter(l => !beforeById.has(l.id))
  const removed = before.lines.filter(l => !afterById.has(l.id))
  const changed: LineChange[] = []
  for (const a of after.lines) {
    const b = beforeById.get(a.id)
    if (!b) continue
    const changes: LineChange['changes'] = []
    const cmp = (label: string, x: unknown, y: unknown) => {
      const xs = x == null ? '' : String(x); const ys = y == null ? '' : String(y)
      if (xs !== ys) changes.push({ label, before: xs, after: ys })
    }
    cmp('Name', b.name, a.name)
    cmp('Code', b.code, a.code)
    cmp('Description', b.description, a.description)
    cmp('Quantity', b.quantity, a.quantity)
    cmp('Price', b.rate, a.rate)
    cmp('Line total', b.total, a.total)
    const photoChanged = b.photo !== a.photo
    if (photoChanged) changes.push({ label: 'Photo', before: b.photo ? 'Photo' : 'No photo', after: a.photo ? (b.photo ? 'New photo' : 'Photo') : 'No photo' })
    if (changes.length > 0) {
      const delta = (x: number | null, y: number | null) => (x === null || y === null || x === y ? null : round2(y - x))
      changed.push({
        id: a.id, name: a.name || b.name, changes, photoChanged,
        quantityDelta: delta(b.quantity, a.quantity), rateDelta: delta(b.rate, a.rate), totalDelta: delta(b.total, a.total),
      })
    }
  }
  const grandTotalDelta = before.grandTotal === null || after.grandTotal === null || before.grandTotal === after.grandTotal
    ? null : round2(after.grandTotal - before.grandTotal)
  return { fields, added, removed, changed, grandTotalDelta }
}

/** Rupees the way every BOE screen writes them: ₹1,20,000 (paise only when there are any). */
export const formatRupees = (n: number): string =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** The concise lines the version history shows ("2 products changed · Grand total +₹12,000"). */
export function summarizeChanges(diff: PiDiff, formatMoney: (n: number) => string = formatRupees): string[] {
  const out: string[] = []
  if (diff.fields.length > 0) {
    const names = diff.fields.map(f => f.label)
    out.push(names.length <= 3 ? `Changed ${names.join(', ')}` : `Changed ${names.slice(0, 3).join(', ')} and ${names.length - 3} more`)
  }
  if (diff.added.length > 0) out.push(`${diff.added.length} product${diff.added.length === 1 ? '' : 's'} added`)
  if (diff.removed.length > 0) out.push(`${diff.removed.length} product${diff.removed.length === 1 ? '' : 's'} removed`)
  if (diff.changed.length > 0) out.push(`${diff.changed.length} product${diff.changed.length === 1 ? '' : 's'} changed`)
  const photos = diff.changed.filter(c => c.photoChanged).length
  if (photos > 0) out.push(`${photos} photo${photos === 1 ? '' : 's'} changed`)
  if (diff.grandTotalDelta !== null) {
    out.push(`Grand total ${diff.grandTotalDelta > 0 ? '+' : '−'}${formatMoney(Math.abs(diff.grandTotalDelta))}`)
  }
  return out.length > 0 ? out : ['No changes']
}

/** Whether an edit changes anything at all — an empty proposal is refused. */
export function editChangesSomething(diff: PiDiff): boolean {
  return diff.fields.length + diff.added.length + diff.removed.length + diff.changed.length > 0
}
