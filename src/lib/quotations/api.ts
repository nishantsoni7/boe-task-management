import type { createClient } from '@/lib/supabase/client'
import { toJpeg } from '@/lib/inventory/images'
import type { GstMode, QtyMode, QuoteArea, QuoteLine } from './math'

// Thin typed wrappers over the database functions of 20270614000000. No API route in between: every function
// reads auth.uid() itself, so the browser's own session is the identity. The client link uses the same client
// signed out (anon), which may only call quotation_public.

type Supabase = ReturnType<typeof createClient>

export const QUOTATIONS_MODULE_KEY = 'quotations'
export const QUOTATION_BUCKET = 'quotation-images'

export type QuotationStatus = 'draft' | 'sent' | 'negotiating' | 'confirmed' | 'lost' | 'archived'
export const STATUS_LABEL: Record<QuotationStatus, string> = {
  draft: 'Draft', sent: 'Sent', negotiating: 'Negotiating', confirmed: 'Confirmed', lost: 'Lost', archived: 'Archived',
}
export const CLIENT_TYPES = [
  ['architect', 'Architect'], ['interior_designer', 'Interior designer'], ['property_owner', 'Property owner'],
  ['fnb_consultant', 'F&B consultant'], ['other', 'Other'],
] as const

export type QuotationAccess = { create: boolean; edit: boolean; view_all: boolean; admin: boolean }
export const NO_ACCESS: QuotationAccess = { create: false, edit: false, view_all: false, admin: false }

export type ListRow = {
  id: string; quote_no: string; status: QuotationStatus; client_name: string; project_name: string | null
  owner_id: string; owner_name: string | null; created_at: string; updated_at: string; sent_at: string | null
  valid_days: number; shared: boolean; line_count: number; first_image: string | null; value_before_gst: number
  last_opened_at: string | null
}

export type Header = {
  client_name: string; project_name: string; contact_name: string; contact_phone: string; contact_role: string
  client_type: string; supply_state: string; gst_mode: GstMode; discount_pct: number; fabric_amount: number
  packing_amount: number; transport_note: string; valid_days: number; notes: string; internal_notes: string
}

export type QuotationEvent = { kind: string; detail: Record<string, unknown>; at: string; actor_name: string | null }

export type Quotation = {
  id: string; quote_no: string; status: QuotationStatus; share_token: string | null; sent_at: string | null
  created_at: string; updated_at: string; owner_name: string | null; may_edit: boolean
  header: Header; areas: QuoteArea[]; lines: QuoteLine[]; events: QuotationEvent[]
  /** The PI draft this quotation was confirmed into (20270615000000), or null. */
  pi: { id: string; draft_reference: string | null; status: string } | null
  /** Price approval (20270617000000); absent before that migration. */
  price: PriceState | null
}

export type PriceReason =
  | { kind: 'discount'; pct: number; limit: number }
  | { kind: 'below'; line: string; price: number; last: number; pct: number; limit: number }
export type PriceState = {
  needed: boolean; reasons: PriceReason[]; state: 'not_needed' | 'to_ask' | 'requested' | 'approved' | 'returned'
  blocked: boolean; note: string | null; by: string | null; at: string | null; may_decide: boolean
}
export type PriceHint = {
  name: string
  ordered: { last: number; last_at: string; min: number; max: number; count: number } | null
  quoted: { last: number; last_at: string } | null
  /** Every price point the suggestion learns from (20270620000000); absent before that migration. */
  points?: import('@/lib/pricing/suggest').PricePoint[]
}
export type QueueRow = {
  id: string; quote_no: string; client_name: string; project_name: string | null; owner_name: string | null
  value_before_gst: number; requested_at: string; reasons: PriceReason[]
}
export type PriceSettings = { max_discount_pct: number | null; min_price_pct: number | null; updated_at: string; may_change: boolean }

export type PublicQuotation = {
  quote_no: string; status: QuotationStatus; client_name: string; project_name: string | null; contact_name: string | null
  gst_mode: GstMode; discount_pct: number; fabric_amount: number; packing_amount: number; transport_note: string | null
  valid_days: number; notes: string | null; issued_at: string; salesperson: string | null
  areas: QuoteArea[]; lines: QuoteLine[]
}

// ── errors ────────────────────────────────────────────────────────────────

export type QuotationErrorKind = 'not_set_up' | 'forbidden' | 'not_found' | 'stale' | 'locked' | 'invalid' | 'network' | 'unknown'

export class QuotationError extends Error {
  constructor(public kind: QuotationErrorKind, message: string) { super(message) }
}

type Raw = { message?: string; code?: string; status?: number }

export function classifyError(err: Raw): QuotationError {
  const m = err.message ?? ''
  if (err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01' || /Could not find the function|does not exist/i.test(m)) {
    return new QuotationError('not_set_up', 'Quotations is being set up: its database part has not been applied yet.')
  }
  if (/QUOTATIONS_FORBIDDEN/.test(m) || err.code === '42501') return new QuotationError('forbidden', m.replace(/^.*QUOTATIONS_FORBIDDEN:\s*/, '') || 'You do not have access to this.')
  if (/QUOTATION_NOT_FOUND/.test(m)) return new QuotationError('not_found', 'This quotation does not exist or is not yours to see.')
  if (/QUOTATION_STALE/.test(m)) return new QuotationError('stale', 'Somebody saved this quotation after you opened it. Reload to see their changes; your edits are still on screen.')
  if (/QUOTATION_LOCKED/.test(m)) return new QuotationError('locked', m.replace(/^.*QUOTATION_LOCKED:\s*/, ''))
  if (/QUOTATION_INVALID/.test(m)) return new QuotationError('invalid', 'Check the quotation: ' + m.replace(/^.*QUOTATION_INVALID:\s*/, ''))
  if (err.status === 0 || /Failed to fetch|NetworkError|Load failed/i.test(m)) return new QuotationError('network', 'No connection. Your changes are still on screen; try again.')
  return new QuotationError('unknown', m || 'Something went wrong.')
}

type RpcResult<T> = { data: T | null; error: Raw | null }
async function call<T>(run: () => PromiseLike<RpcResult<T>>): Promise<T> {
  let res: RpcResult<T>
  try { res = await run() } catch (e) { throw classifyError({ message: e instanceof Error ? e.message : 'Failed to fetch', status: 0 }) }
  if (res.error) throw classifyError(res.error)
  return res.data as T
}

export const errorText = (e: unknown) => (e instanceof QuotationError ? e.message : e instanceof Error ? e.message : 'Something went wrong.')
export const errorKind = (e: unknown): QuotationErrorKind => (e instanceof QuotationError ? e.kind : 'unknown')

// ── reads ─────────────────────────────────────────────────────────────────

export const quotationKeys = {
  access: ['quotations', 'access'] as const,
  list: (scope: 'mine' | 'all') => ['quotations', 'list', scope] as const,
  one: (id: string) => ['quotations', 'one', id] as const,
}

export const fetchAccess = (s: Supabase) => call<QuotationAccess>(() => s.rpc('quotation_my_access'))
export const fetchList = (s: Supabase, scope: 'mine' | 'all') => call<ListRow[]>(() => s.rpc('quotation_list', { p_scope: scope }))

type DbArea = { id: string; name: string; style: string | null; multiplier: number; unit_label: string }
type DbLine = {
  id?: string; area_id: string | null; name: string; size_text: string | null; spec?: string | null; material: string | null
  finish: string | null; category?: string | null; qty_per_unit: number | string | null; qty_fixed: number | string | null
  unit_price: number | string | null; tax_rate: number | string; image_path: string | null; is_optional: boolean
  client_note: string | null; internal_note?: string | null
}

export function toAreas(rows: DbArea[]): QuoteArea[] {
  return rows.map(a => ({ key: a.id, name: a.name, style: a.style ?? '', multiplier: Number(a.multiplier) || 1, unit_label: a.unit_label || 'rooms' }))
}

export function toLines(rows: DbLine[]): QuoteLine[] {
  return rows.map((l, i) => {
    const fixed = l.qty_fixed !== null && l.qty_fixed !== undefined
    return {
      key: l.id ?? `l${i}`, area_key: l.area_id, name: l.name, size_text: l.size_text ?? '', spec: l.spec ?? '',
      material: l.material ?? '', finish: l.finish ?? '', category: l.category ?? '',
      qty_mode: (fixed ? 'fixed' : 'per_unit') as QtyMode, qty: Number(fixed ? l.qty_fixed : l.qty_per_unit) || null,
      unit_price: l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price),
      tax_rate: Number.isFinite(Number(l.tax_rate)) ? Number(l.tax_rate) : 18, image_path: l.image_path, is_optional: !!l.is_optional,
      client_note: l.client_note ?? '', internal_note: l.internal_note ?? '',
    }
  })
}

export async function fetchQuotation(s: Supabase, id: string): Promise<Quotation> {
  const r = await call<{ quotation: Record<string, unknown>; owner_name: string | null; may_edit: boolean; areas: DbArea[]; lines: DbLine[]; events: QuotationEvent[]; pi?: Quotation['pi']; price?: PriceState }>(
    () => s.rpc('quotation_get', { p_id: id }))
  const q = r.quotation as Record<string, string | number | null>
  const str = (k: string) => (q[k] as string | null) ?? ''
  return {
    id: str('id'), quote_no: str('quote_no'), status: q.status as QuotationStatus, share_token: (q.share_token as string | null) ?? null,
    sent_at: (q.sent_at as string | null) ?? null, created_at: str('created_at'), updated_at: str('updated_at'),
    owner_name: r.owner_name, may_edit: r.may_edit,
    header: {
      client_name: str('client_name'), project_name: str('project_name'), contact_name: str('contact_name'),
      contact_phone: str('contact_phone'), contact_role: str('contact_role'), client_type: str('client_type'),
      supply_state: str('supply_state'), gst_mode: (q.gst_mode as GstMode) || 'igst', discount_pct: Number(q.discount_pct) || 0,
      fabric_amount: Number(q.fabric_amount) || 0, packing_amount: Number(q.packing_amount) || 0, transport_note: str('transport_note'),
      valid_days: Number(q.valid_days) || 7, notes: str('notes'), internal_notes: str('internal_notes'),
    },
    areas: toAreas(r.areas), lines: toLines(r.lines), events: r.events, pi: r.pi ?? null, price: r.price ?? null,
  }
}

export async function fetchPublic(s: Supabase, token: string): Promise<PublicQuotation | null> {
  const r = await call<(Omit<PublicQuotation, 'areas' | 'lines'> & { areas: DbArea[]; lines: DbLine[] }) | null>(
    () => s.rpc('quotation_public', { p_token: token }))
  if (!r) return null
  return { ...r, discount_pct: Number(r.discount_pct) || 0, fabric_amount: Number(r.fabric_amount) || 0, packing_amount: Number(r.packing_amount) || 0, areas: toAreas(r.areas), lines: toLines(r.lines) }
}

// ── writes ────────────────────────────────────────────────────────────────

export const createQuotation = (s: Supabase, data: Partial<Header> & { client_name: string; source?: string }) =>
  call<string>(() => s.rpc('quotation_create', { p_data: data }))

/** The whole quotation in one go; the database refuses it if somebody saved after `expectedUpdatedAt`. */
export function saveDoc(header: Header, areas: QuoteArea[], lines: QuoteLine[], expectedUpdatedAt: string) {
  return {
    expected_updated_at: expectedUpdatedAt,
    header,
    areas: areas.map(a => ({ key: a.key, name: a.name, style: a.style, multiplier: a.multiplier, unit_label: a.unit_label })),
    lines: lines.map(l => ({
      area_key: l.area_key, name: l.name, size_text: l.size_text, spec: l.spec, material: l.material, finish: l.finish,
      category: l.category, qty_per_unit: l.qty_mode === 'per_unit' ? l.qty : null, qty_fixed: l.qty_mode === 'fixed' ? l.qty : null,
      unit_price: l.unit_price, tax_rate: l.tax_rate, image_path: l.image_path, is_optional: l.is_optional,
      client_note: l.client_note, internal_note: l.internal_note,
    })),
  }
}

export const saveQuotation = (s: Supabase, id: string, doc: ReturnType<typeof saveDoc>) =>
  call<{ updated_at: string; value_before_gst: number }>(() => s.rpc('quotation_save', { p_id: id, p_doc: doc }))

export const setStatus = (s: Supabase, id: string, status: QuotationStatus, note?: string) =>
  call<string>(() => s.rpc('quotation_set_status', { p_id: id, p_status: status, p_note: note ?? null }))

export const shareQuotation = (s: Supabase, id: string, on: boolean) =>
  call<string | null>(() => s.rpc('quotation_share', { p_id: id, p_on: on }))

// ── pictures ──────────────────────────────────────────────────────────────

export async function uploadPicture(s: Supabase, userId: string, file: Blob): Promise<string> {
  const jpeg = await toJpeg(file)
  const path = `${userId}/${crypto.randomUUID()}.jpg`
  const { error } = await s.storage.from(QUOTATION_BUCKET).upload(path, jpeg, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
  if (error) throw new QuotationError('unknown', error.message || 'The picture could not be uploaded')
  return path
}

/** An absolute, public address: the client link shows pictures without a session. */
export const pictureUrl = (s: Supabase, path: string) => s.storage.from(QUOTATION_BUCKET).getPublicUrl(path).data.publicUrl

// ── pricing desk (20270617000000) ──────────────────────────────────────────
export const fetchHints = (s: Supabase, names: string[], exclude: string | null) =>
  call<PriceHint[]>(() => s.rpc('quotation_price_hints', { p_names: names, p_exclude: exclude }))
export const requestPriceApproval = (s: Supabase, id: string) => call<PriceState>(() => s.rpc('quotation_price_request', { p_id: id }))
export const decidePrice = (s: Supabase, id: string, approve: boolean, note: string | null) =>
  call<PriceState>(() => s.rpc('quotation_price_decide', { p_id: id, p_approve: approve, p_note: note }))
export const fetchPriceQueue = (s: Supabase) => call<QueueRow[]>(() => s.rpc('quotation_price_queue'))
export const fetchPriceSettings = (s: Supabase) => call<PriceSettings>(() => s.rpc('quotation_price_settings_get'))
export const savePriceSettings = (s: Supabase, maxDiscount: number | null, minPrice: number | null) =>
  call<PriceSettings>(() => s.rpc('quotation_price_settings_set', { p_max_discount_pct: maxDiscount, p_min_price_pct: minPrice }))
