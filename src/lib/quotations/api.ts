import type { createClient } from '@/lib/supabase/client'
import { toJpeg } from '@/lib/inventory/images'
import { ORIGINALS_BUCKET } from './pictureStore'
import { cleanChoices, toDimensionUnit, type DimensionUnit, type GstMode, type LineChoices, type LineRef, type QtyMode, type QuoteArea, type QuoteLine } from './math'

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
  /** 20270714000000. The email stays internal (never printed or shown on the client link); company name and GSTIN print under "Prepared for". */
  client_email: string; company_name: string; client_gstin: string; dimension_unit: DimensionUnit
  /** 20270717000000. The kind of venue ('' = not set; see documentPlan.PROJECT_TYPES), its seats (restaurant, cafe, brewery) and the lead time in
   *  weeks. The weeks are worked out from the owner's rules and stored; a reason present means a person changed them (the reason stays internal). */
  project_type: string; seats: number | null; lead_time_weeks: number | null; lead_time_reason: string
  /** 20270806000100. The city it is delivered to, asked on the Client card in place of the state; the state (it decides CGST + SGST or IGST) sits under Advanced client details. */
  delivery_city: string
}

export type QuotationEvent = { kind: string; detail: Record<string, unknown>; at: string; actor_name: string | null }

export type Quotation = {
  id: string; quote_no: string; status: QuotationStatus; share_token: string | null; sent_at: string | null
  created_at: string; updated_at: string; owner_name: string | null; may_edit: boolean
  /** The salesperson's mobile and e-mail, printed on the client document (20270717000000, owner 14 Nov 2026). */
  owner_phone: string | null; owner_email: string | null
  /** The salesperson's own details for the document, once they have filled them in (20270801000000); before that the name is owner_name. */
  owner_id: string; owner_display_name: string | null; owner_title: string | null; owner_card_saved: boolean
  header: Header; areas: QuoteArea[]; lines: QuoteLine[]; events: QuotationEvent[]
  /** The PI draft this quotation was confirmed into (20270615000000), or null. */
  pi: { id: string; draft_reference: string | null; status: string } | null
  /** Price approval (20270617000000); absent before that migration. */
  price: PriceState | null
  /** The quotation request this answers (20270629000000), or null. */
  request: { id: string; title: string; status: string; created_by: string | null; assigned_to: string | null; created_at: string; last_update_at: string | null; asked_by: string | null; may_send: boolean } | null
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
/** Who sees the suggested prices (20270731000000): everyone, or only the people listed. */
/** The salesperson's details printed on their quotations, filled in once and editable (20270801000000). */
export type MyCard = { saved: boolean; name: string; title: string; phone: string; email: string; updated_at?: string }
export type SuggestionSettings = { everyone: boolean; desk: boolean; for_me: boolean; shown_to: string[]; may_change: boolean; updated_at: string }
export type PriceSettings = { max_discount_pct: number | null; min_price_pct: number | null; updated_at: string; may_change: boolean }

export type PublicQuotation = {
  quote_no: string; status: QuotationStatus; client_name: string; project_name: string | null; contact_name: string | null
  gst_mode: GstMode; discount_pct: number; fabric_amount: number; packing_amount: number; transport_note: string | null
  valid_days: number; notes: string | null; issued_at: string; salesperson: string | null
  /** Set only when filled in / not inches (a copy sent before 20270714000000 has none: inches). */
  company_name?: string | null; client_gstin?: string | null; dimension_unit?: DimensionUnit | null
  /** The version the client is seeing (20270623000000); null for a link shared before versions existed. */
  version_no?: number | null
  /** Set only when set (20270717000000); a copy sent before has none. The salesperson's contact is live, not frozen. */
  project_type?: string | null; seats?: number | null; lead_time_weeks?: number | null
  salesperson_phone?: string | null; salesperson_email?: string | null; salesperson_title?: string | null
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
  // The lead link (20270811000000) also answers with the Sales module's own errors.
  if (/SALES_FORBIDDEN/.test(m)) return new QuotationError('forbidden', 'Your account has no access to Sales, so it cannot link a lead.')
  if (/SALES_NOT_FOUND/.test(m)) return new QuotationError('not_found', 'This lead does not exist or is not yours to see.')
  // A quotation starts from a Sales lead (20270814000000 / 20270814000100).
  if (/QUOTATION_LEAD_REQUIRED/.test(m)) return new QuotationError('invalid', 'Choose the Sales lead this quotation is for.')
  if (/QUOTATION_LEAD_CLOSED/.test(m)) return new QuotationError('invalid', m.replace(/^.*QUOTATION_LEAD_CLOSED:\s*/, ''))
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
  myCard: ['quotations', 'my-card'] as const,
}

export const fetchAccess = (s: Supabase) => call<QuotationAccess>(() => s.rpc('quotation_my_access'))
export const fetchList = (s: Supabase, scope: 'mine' | 'all') => call<ListRow[]>(() => s.rpc('quotation_list', { p_scope: scope }))

type DbArea = { id: string; name: string; style: string | null; multiplier: number; unit_label: string }
type DbLine = {
  id?: string; area_id: string | null; name: string; size_text: string | null; spec?: string | null; material: string | null
  finish: string | null; category?: string | null; qty_per_unit: number | string | null; qty_fixed: number | string | null
  unit_price: number | string | null; tax_rate: number | string; image_path: string | null; is_optional: boolean
  client_note: string | null; internal_note?: string | null; reference_images?: LineRef[] | null
  client_choices?: LineChoices | null
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
      tax_rate: 18, // everything is billed at 18% (owner, 18 Nov 2026); an older line stored at 12% is read as 18% and saved so
      image_path: l.image_path, is_optional: !!l.is_optional,
      client_note: l.client_note ?? '', internal_note: l.internal_note ?? '',
      ...(Array.isArray(l.reference_images) && l.reference_images.length ? { references: l.reference_images } : {}),
      ...(l.client_choices && Object.keys(l.client_choices).length ? { choices: l.client_choices } : {}),
    }
  })
}

export async function fetchQuotation(s: Supabase, id: string): Promise<Quotation> {
  const r = await call<{ quotation: Record<string, unknown>; owner_name: string | null; owner_phone?: string | null; owner_email?: string | null; owner_display_name?: string | null; owner_title?: string | null; owner_card_saved?: boolean; may_edit: boolean; areas: DbArea[]; lines: DbLine[]; events: QuotationEvent[]; pi?: Quotation['pi']; price?: PriceState; request?: Quotation['request'] }>(
    () => s.rpc('quotation_get', { p_id: id }))
  const q = r.quotation as Record<string, string | number | null>
  const str = (k: string) => (q[k] as string | null) ?? ''
  return {
    id: str('id'), quote_no: str('quote_no'), status: q.status as QuotationStatus, share_token: (q.share_token as string | null) ?? null,
    sent_at: (q.sent_at as string | null) ?? null, created_at: str('created_at'), updated_at: str('updated_at'),
    owner_name: r.owner_name, owner_phone: r.owner_phone ?? null, owner_email: r.owner_email ?? null, may_edit: r.may_edit,
    owner_id: str('owner_id'), owner_display_name: r.owner_display_name ?? null, owner_title: r.owner_title ?? null, owner_card_saved: !!r.owner_card_saved,
    header: {
      client_name: str('client_name'), project_name: str('project_name'), contact_name: str('contact_name'),
      contact_phone: str('contact_phone'), contact_role: str('contact_role'), client_type: str('client_type'),
      supply_state: str('supply_state'), gst_mode: (q.gst_mode as GstMode) || 'igst', discount_pct: Number(q.discount_pct) || 0,
      fabric_amount: Number(q.fabric_amount) || 0, packing_amount: Number(q.packing_amount) || 0, transport_note: str('transport_note'),
      valid_days: Number(q.valid_days) || 7, notes: str('notes'), internal_notes: str('internal_notes'),
      client_email: str('client_email'), company_name: str('company_name'), client_gstin: str('client_gstin'), dimension_unit: toDimensionUnit(q.dimension_unit),
      project_type: str('project_type'), seats: q.seats === null || q.seats === undefined ? null : Number(q.seats) || null,
      lead_time_weeks: q.lead_time_weeks === null || q.lead_time_weeks === undefined ? null : Number(q.lead_time_weeks) || null, lead_time_reason: str('lead_time_reason'),
      delivery_city: str('delivery_city'),
    },
    areas: toAreas(r.areas), lines: toLines(r.lines), events: r.events, pi: r.pi ?? null, price: r.price ?? null, request: r.request ?? null,
  }
}

export async function fetchPublic(s: Supabase, token: string): Promise<PublicQuotation | null> {
  const r = await call<(Omit<PublicQuotation, 'areas' | 'lines'> & { areas: DbArea[]; lines: DbLine[] }) | null>(
    () => s.rpc('quotation_public', { p_token: token }))
  if (!r) return null
  return { ...r, discount_pct: Number(r.discount_pct) || 0, fabric_amount: Number(r.fabric_amount) || 0, packing_amount: Number(r.packing_amount) || 0, areas: toAreas(r.areas), lines: toLines(r.lines) }
}

// ── writes ────────────────────────────────────────────────────────────────

/**
 * Start a quotation FROM a Sales lead (20270814000000): the client's name, phone, e-mail, city, venue and requirement are copied from the lead by
 * the database, nothing is typed. `ownerId` puts it on somebody else's page (an administrator or the pricing desk only).
 */
export const startQuotation = (s: Supabase, leadId: string, o: { ownerId?: string | null; source?: string } = {}) =>
  call<string>(() => s.rpc('quotation_start', { p_lead: leadId, p_data: { ...(o.ownerId ? { owner_id: o.ownerId } : {}), ...(o.source ? { source: o.source } : {}) } }))

/** The people a quotation may be put on (administrator or pricing desk only), the caller first. */
export type Maker = { id: string; full_name: string | null }
export const makersKey = ['quotations', 'makers'] as const
export const fetchMakers = (s: Supabase) => call<Maker[]>(() => s.rpc('quotation_makers'))

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
      client_note: l.client_note, internal_note: l.internal_note, reference_images: l.references ?? [],
      client_choices: cleanChoices(l.choices),
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

// The clean picture goes to the PRIVATE originals bucket; the server then writes the logo-marked copy to the public
// bucket at the same path (owner, 18 Nov 2026: pictures the client sees carry the Best of Exports mark).
export async function uploadPicture(s: Supabase, userId: string, file: Blob): Promise<string> {
  const jpeg = await toJpeg(file)
  const path = `${userId}/${crypto.randomUUID()}.jpg`
  const { error } = await s.storage.from(ORIGINALS_BUCKET).upload(path, jpeg, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
  if (error) throw new QuotationError('unknown', error.message || 'The picture could not be uploaded')
  const res = await fetch('/api/quotations/picture-mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).catch(() => null)
  if (!res || !res.ok) {
    const why = res ? ((await res.json().catch(() => null)) as { error?: string } | null)?.error : null
    throw new QuotationError('unknown', why || 'The picture could not be prepared. Check your connection and try again.')
  }
  return path
}

// ── the logo mark switch (20270806000200): on unless somebody who may edit the quotation turned it off ──────────────
export const pictureMarkKey = (id: string) => ['quotations', 'pictureMark', id] as const
export const fetchPictureMark = (s: Supabase, id: string) => call<boolean | null>(() => s.rpc('quotation_picture_mark_get', { p_id: id }))
export const setPictureMark = (s: Supabase, id: string, on: boolean) => call<boolean>(() => s.rpc('quotation_picture_mark_set', { p_id: id, p_on: on }))

/**
 * Where a picture is shown from. On the client link (a token) every picture goes through the server, which redirects to
 * the marked copy or, with the mark OFF, returns the clean one. For staff: the marked public copy, or with the mark OFF
 * the same server route (signed in). markOn is undefined until the switch has loaded, which counts as on.
 */
export function pictureSrc(s: Supabase, path: string, o: { token?: string; quotationId?: string; markOn?: boolean } = {}): string {
  const q = `path=${encodeURIComponent(path)}`
  if (o.token) return `/api/quotations/picture-file?${q}&t=${encodeURIComponent(o.token)}`
  if (o.markOn === false && o.quotationId) return `/api/quotations/picture-file?${q}&q=${encodeURIComponent(o.quotationId)}`
  return pictureUrl(s, path)
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
export const fetchMyCard = (s: Supabase) => call<MyCard>(() => s.rpc('quotation_my_card'))
export const saveMyCard = (s: Supabase, card: Pick<MyCard, 'name' | 'title' | 'phone' | 'email'>) => call<MyCard>(() => s.rpc('quotation_my_card_save', { p: card }))
export const fetchSuggestionSettings = (s: Supabase) => call<SuggestionSettings>(() => s.rpc('quotation_suggestions_get'))
export const saveSuggestionSettings = (s: Supabase, everyone: boolean) => call<SuggestionSettings>(() => s.rpc('quotation_suggestions_set', { p_everyone: everyone }))
/** The bank account and UPI QR printed on a quotation (20270807000000). The Customer ID is only in the administrator's own read. */
export type PaymentDetails = { account_holder: string; bank: string; account_no: string; ifsc: string; branch: string; upi_id: string; qr_image: string | null }
export type PaymentSettings = PaymentDetails & { customer_id: string; updated_at: string }
/** For the printed quotation: pass the client link's token on the public page, nothing on the signed-in one. Null when not allowed. */
export const fetchPaymentDetails = (s: Supabase, token?: string) => call<PaymentDetails | null>(() => s.rpc('quotation_payment_details', { p_token: token ?? null }))
export const fetchPaymentSettings = (s: Supabase) => call<PaymentSettings>(() => s.rpc('quotation_payment_get'))
export const savePaymentSettings = (s: Supabase, data: Partial<Omit<PaymentSettings, 'updated_at'>>) => call<PaymentSettings>(() => s.rpc('quotation_payment_set', { p_data: data }))

/**
 * The Sales lead a quotation came from (20270811000000). `lead` is null when nothing is linked, when the lead is not one the caller may
 * see, or when the caller has no Sales access (`sales_open` false): the card then says only that a lead is linked. `suggest` is the lead
 * with the quotation's contact phone. `version_no` and `value` are the latest SENT version (the current saved value before any is sent).
 */
export type LeadSummary = { id: string; lead_no: number; name: string | null; stage: string; holder_name: string | null }
export type LeadInfo = {
  sales_open: boolean; linked: boolean
  lead: (LeadSummary & { dead_reason: string | null; next_step: string | null; next_due_on: string | null; may_work: boolean; last_logged_at: string | null }) | null
  suggest: LeadSummary | null
  version_no: number | null; value: number
}
export const leadInfoKey = (id: string) => ['quotations', 'lead', id] as const
export const fetchLeadInfo = (s: Supabase, id: string) => call<LeadInfo>(() => s.rpc('quotation_lead_info', { p_id: id }))
/** Link a quotation to a lead the caller can see, or pass null to unlink. */
export const linkLead = (s: Supabase, id: string, leadId: string | null) => call<null>(() => s.rpc('quotation_link_lead', { p_id: id, p_lead: leadId }))

/**
 * The quotations linked to a lead, for the lead popup (20270812000000). `open` is false for somebody with no Quotations access (the popup
 * shows no section), `may_create` offers "Make quotation". `version_no` and `value` are the latest sent version's.
 */
export type LeadQuotation = { id: string; quote_no: string; status: QuotationStatus; updated_at: string; owner_name: string | null; version_no: number | null; value: number }
export type LeadQuotations = { open: boolean; may_create: boolean; quotations: LeadQuotation[] }
export const leadQuotationsKey = (leadId: string) => ['quotations', 'for-lead', leadId] as const
export const fetchLeadQuotations = (s: Supabase, leadId: string) => call<LeadQuotations>(() => s.rpc('quotation_for_lead', { p_lead: leadId }))

export const savePriceSettings = (s: Supabase, maxDiscount: number | null, minPrice: number | null) =>
  call<PriceSettings>(() => s.rpc('quotation_price_settings_set', { p_max_discount_pct: maxDiscount, p_min_price_pct: minPrice }))

// ── quotation requests inside Quotations (20270814000200) ─────────────────────────────────────────────────
/** A quotation sent to a senior: to take the prices ('price') or to have the salesperson's prices checked ('verify'). */
export type AskKind = 'price' | 'verify'
export const ASK_LABEL: Record<AskKind, string> = { price: 'Needs prices', verify: 'Check my prices' }
export type AskRequest = {
  id: string; kind: AskKind; note: string | null; status: 'pending' | 'answered' | 'withdrawn'; created_at: string
  answered_at: string | null; answer_note: string | null; from_id: string; from_name: string | null; to_id: string; to_name: string | null; answered_by_name: string | null
}
export type AskState = { open: AskRequest | null; last: AskRequest | null; may_ask: boolean; may_answer: boolean; may_withdraw: boolean }
export type RequestRow = AskRequest & { quotation_id: string; quote_no: string; client_name: string; project_name: string | null; quotation_status: QuotationStatus; value: number; lead_no: number | null }
export const askKeys = {
  state: (id: string) => ['quotations', 'ask', id] as const,
  list: ['quotations', 'requests'] as const,
  count: ['quotations', 'requests-count'] as const,
  desk: ['quotations', 'desk-people'] as const,
}
export const fetchAskState = (s: Supabase, id: string) => call<AskState>(() => s.rpc('quotation_ask_state', { p_quotation: id }))
export const fetchDeskPeople = (s: Supabase) => call<Maker[]>(() => s.rpc('quotation_desk_people'))
export const fetchRequests = (s: Supabase) => call<RequestRow[]>(() => s.rpc('quotation_requests_list'))
export const fetchRequestCount = (s: Supabase) => call<number>(() => s.rpc('quotation_requests_count'))
export const sendRequest = (s: Supabase, id: string, to: string, kind: AskKind, note: string) =>
  call<string>(() => s.rpc('quotation_request_send', { p_quotation: id, p_to: to, p_kind: kind, p_note: note.trim() || null }))
export const answerRequest = (s: Supabase, id: string, note: string) => call<null>(() => s.rpc('quotation_request_answer', { p_id: id, p_note: note.trim() || null }))
export const withdrawRequest = (s: Supabase, id: string) => call<null>(() => s.rpc('quotation_request_withdraw', { p_id: id }))

// ── report cards and the price brief (20270814000300) ─────────────────────────────────────────────────────────
export type CardsMe = { person: string; name: string | null; open_count: number; open_value: number; waiting_senior: number; made: number; sent: number; confirmed: number; value_made: number; value_confirmed: number }
export type CardsDesk = { waiting: number; oldest_at: string | null; answered: number; avg_hours: number | null }
export type CardsPerson = { id: string; name: string | null; made: number; sent: number; confirmed: number; value_made: number; value_confirmed: number }
export type CardsTeam = { made: number; sent: number; confirmed: number; value_made: number; value_confirmed: number; top: { id: string; name: string | null; made: number } | null; people: CardsPerson[] }
export type Cards = { me: CardsMe; desk: CardsDesk | null; team: CardsTeam | null; from: string; to: string }
export const cardsKey = (from: string, to: string, person: string | null) => ['quotations', 'cards', from, to, person] as const
export const fetchCards = (s: Supabase, from: string, to: string, person: string | null) =>
  call<Cards>(() => s.rpc('quotation_cards', { p_from: from, p_to: to, p_person: person }))

export type BriefLine = { name: string; size?: string; material?: string; finish?: string; qty?: number | null; price: number; reason: string }
export const briefKey = (id: string) => ['quotations', 'brief', id] as const
export const fetchBriefs = (s: Supabase, id: string) => call<Record<string, string>>(() => s.rpc('quotation_price_briefs_get', { p_id: id }))
export const saveBriefs = (s: Supabase, id: string, items: BriefLine[]) => call<number>(() => s.rpc('quotation_price_briefs_save', { p_id: id, p_items: items }))
