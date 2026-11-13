// Quotation versions (20270623000000): reading them, and comparing any two (or a version with the unsent saved copy).
// Line ids change on every save, so products are matched by room type + name, in order.

import type { createClient } from '@/lib/supabase/client'
import { classifyError, toAreas, toLines } from './api'
import { computeTotals, lineQty, type GstMode } from './math'

type Supabase = ReturnType<typeof createClient>

export type VersionRow = { version_no: number; note: string | null; value_before_gst: number; created_at: string; by: string | null }
type DocArea = { id: string; name: string; style: string | null; multiplier: number; unit_label: string }
type DocLine = Parameters<typeof toLines>[0][number]
export type VersionDoc = {
  client_name: string; project_name: string | null; gst_mode: GstMode; discount_pct: number; fabric_amount: number
  packing_amount: number; transport_note: string | null; valid_days: number; notes: string | null
  /** Missing in a copy frozen before 20270714000000 (and for an inches quotation without them): none / inches. */
  company_name?: string | null; client_gstin?: string | null; dimension_unit?: string | null
  areas: DocArea[]; lines: DocLine[]
}

async function call<T>(run: () => PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await run()
  if (error) throw classifyError(error)
  return data as T
}
export const fetchVersions = (s: Supabase, id: string) => call<VersionRow[]>(() => s.rpc('quotation_versions', { p_id: id }))
/** version 0 = the quotation as saved now. */
export const fetchVersionDoc = (s: Supabase, id: string, no: number) => call<VersionDoc>(() => s.rpc('quotation_version_get', { p_id: id, p_version_no: no }))
export const sendNewVersion = (s: Supabase, id: string, note: string | null) => call<number>(() => s.rpc('quotation_version_create', { p_id: id, p_note: note }))

export type FieldChange = { label: string; from: string; to: string }
export type LineChange = { room: string; name: string; changes: FieldChange[] }
export type LineRef = { room: string; name: string; qty: number; price: number | null }
export type Comparison = {
  header: FieldChange[]; added: LineRef[]; removed: LineRef[]; changed: LineChange[]
  before: { from: number; to: number }; grand: { from: number; to: number }
}

const inr = (n: number | null) => (n === null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`)
const txt = (v: unknown) => String(v ?? '').trim() || '—'

function prepare(doc: VersionDoc) {
  const areas = toAreas(doc.areas.map(a => ({ ...a, style: a.style ?? '' })))
  const lines = toLines(doc.lines)
  const money = { gst_mode: doc.gst_mode, discount_pct: Number(doc.discount_pct) || 0, fabric_amount: Number(doc.fabric_amount) || 0, packing_amount: Number(doc.packing_amount) || 0 }
  const totals = computeTotals(money, areas, lines)
  const room = (key: string | null) => areas.find(a => a.key === key)?.name ?? ''
  const refs = lines.map(l => ({ l, room: room(l.area_key), name: l.name.trim(), qty: lineQty(l, areas), key: `${room(l.area_key).toLowerCase()}|${l.name.trim().toLowerCase()}` }))
  return { totals, refs }
}

/** What changed from version a to version b. */
export function compareDocs(a: VersionDoc, b: VersionDoc): Comparison {
  const A = prepare(a), B = prepare(b)
  const header: FieldChange[] = []
  const h = (label: string, x: unknown, y: unknown, show: (v: unknown) => string = txt) => { if (String(x ?? '') !== String(y ?? '')) header.push({ label, from: show(x), to: show(y) }) }
  h('Discount', Number(a.discount_pct) || 0, Number(b.discount_pct) || 0, v => `${v}%`)
  h('Fabric', Number(a.fabric_amount) || 0, Number(b.fabric_amount) || 0, v => inr(Number(v)))
  h('Packing', Number(a.packing_amount) || 0, Number(b.packing_amount) || 0, v => inr(Number(v)))
  h('Transport', a.transport_note, b.transport_note)
  h('GST', a.gst_mode, b.gst_mode, v => (v === 'igst' ? 'IGST' : 'CGST + SGST'))
  h('Valid for (days)', a.valid_days, b.valid_days)
  h('Dimensions in', a.dimension_unit === 'cm' ? 'cm' : 'in', b.dimension_unit === 'cm' ? 'cm' : 'in', v => (v === 'cm' ? 'Centimetres' : 'Inches'))
  h('Company name', a.company_name, b.company_name)
  h('GSTIN', a.client_gstin, b.client_gstin)
  h('Notes for the client', a.notes, b.notes)

  const unmatched = [...B.refs]
  const removed: LineRef[] = []
  const changed: LineChange[] = []
  for (const x of A.refs) {
    const i = unmatched.findIndex(y => y.key === x.key)
    if (i < 0) { removed.push({ room: x.room, name: x.name, qty: x.qty, price: x.l.unit_price }); continue }
    const [y] = unmatched.splice(i, 1)
    const changes: FieldChange[] = []
    const c = (label: string, p: unknown, q: unknown, show: (v: unknown) => string = txt) => { if (String(p ?? '') !== String(q ?? '')) changes.push({ label, from: show(p), to: show(q) }) }
    c('Quantity', x.qty, y.qty, v => Number(v).toLocaleString('en-IN'))
    c('Price', x.l.unit_price, y.l.unit_price, v => inr(v === null ? null : Number(v)))
    c('Size', x.l.size_text, y.l.size_text)
    c('Material', x.l.material, y.l.material)
    c('Finish', x.l.finish, y.l.finish)
    c('Remarks / customization', x.l.spec, y.l.spec)
    c('GST rate', x.l.tax_rate, y.l.tax_rate, v => `${v}%`)
    c('Optional', x.l.is_optional, y.l.is_optional, v => (v ? 'yes' : 'no'))
    c('Picture', x.l.image_path ? 'yes' : '', y.l.image_path === x.l.image_path ? (x.l.image_path ? 'yes' : '') : y.l.image_path ? 'changed' : 'removed')
    if (changes.length) changed.push({ room: y.room, name: y.name, changes })
  }
  const added = unmatched.map(y => ({ room: y.room, name: y.name, qty: y.qty, price: y.l.unit_price }))
  return {
    header, added, removed, changed,
    before: { from: A.totals.taxable, to: B.totals.taxable }, grand: { from: A.totals.grand, to: B.totals.grand },
  }
}
