// Pricing > Training: the browser's calls. Every read and write is one database function (20270720000000);
// the tables themselves are closed.
import type { createClient } from '@/lib/supabase/client'
import { toJpeg } from '@/lib/inventory/images'
import { parseReading, type CaseForm, type Line, type Reading, saveDoc } from './doc'

type Supabase = ReturnType<typeof createClient>
export const TRAINING_BUCKET = 'pricing-training'
export const trainingKeys = { access: ['pricing', 'training', 'access'] as const, list: ['pricing', 'training', 'list'] as const, woods: ['pricing', 'woods'] as const, metals: ['pricing', 'metals'] as const, rateHistory: ['pricing', 'rates', 'history'] as const, library: ['pricing', 'training', 'library'] as const, quotes: ['pricing', 'training', 'quotes'] as const, one: (id: string) => ['pricing', 'training', 'case', id] as const }

export type Status = 'draft' | 'submitted'
export type Access = { uid: string; admin: boolean; create: boolean }
export type CaseRow = { id: string; case_no: number; name: string; variant: string | null; status: Status; image_path: string | null; created_by: string; created_by_name: string | null; submitted_by_name: string | null; submit_count: number; submitted_at: string | null; created_at: string; updated_at: string; total: number; line_count: number; sold_price: number | null }
export type SavedLine = { element: string; kind: string; material: string | null; quantity: number | null; unit: string | null; rate: number | null; amount: number; reasoning: string | null; from_ai: boolean; wood_amount: number | null; calc?: unknown }
export type Message = { id: string; body: string; created_at: string; created_by: string; created_by_name: string | null }
export type CaseEvent = { what: 'saved' | 'submitted'; created_at: string; created_by: string; created_by_name: string | null; total: number }
export type CaseFull = Omit<CaseRow, 'total' | 'line_count'> & { width_in: number | null; depth_in: number | null; height_in: number | null; notes: string | null; ai_reading: unknown; updated_by_name: string | null; may_edit: boolean; lines: SavedLine[]; messages: Message[]; events: CaseEvent[]
  /** 20270823000000; absent until that migration is applied. */
  price_level?: unknown; includes?: unknown; per_set?: unknown }

export class TrainingError extends Error {
  constructor(public kind: 'not_set_up' | 'forbidden' | 'invalid' | 'locked' | 'not_found' | 'network' | 'unknown', message: string) { super(message) }
}
type RpcError = { message?: string; code?: string } | null
function classify(e: NonNullable<RpcError>): TrainingError {
  const m = e.message ?? ''
  const said = m.replace(/^.*PRICING_TRAINING_[A-Z_]+:\s*/, '')
  if (/PRICING_(WOODS|METALS)_FORBIDDEN/.test(m)) return new TrainingError('forbidden', m.replace(/^.*PRICING_(WOODS|METALS)_[A-Z_]+:\s*/, ''))
  if (/PRICING_(WOODS|METALS)_INVALID/.test(m)) return new TrainingError('invalid', m.replace(/^.*PRICING_(WOODS|METALS)_[A-Z_]+:\s*/, ''))
  if (/PRICING_TRAINING_FORBIDDEN/.test(m)) return new TrainingError('forbidden', said)
  if (/PRICING_TRAINING_LOCKED/.test(m)) return new TrainingError('locked', said)
  if (/PRICING_TRAINING_INVALID/.test(m)) return new TrainingError('invalid', said)
  if (/PRICING_TRAINING_NOT_FOUND/.test(m)) return new TrainingError('not_found', said)
  if (e.code === 'PGRST202' || e.code === '42883' || /Could not find the function|does not exist/i.test(m)) return new TrainingError('not_set_up', 'Training is being set up: its database part has not been applied yet.')
  if (e.code === '42501') return new TrainingError('forbidden', 'Pricing is not open to you.')
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return new TrainingError('network', 'No connection. Check the network and try again.')
  return new TrainingError('unknown', m || 'Something went wrong. Try again.')
}
async function call<T>(run: () => PromiseLike<{ data: unknown; error: RpcError }>): Promise<T> {
  let res: { data: unknown; error: RpcError }
  try { res = await run() } catch (e) { throw classify({ message: e instanceof Error ? e.message : 'Failed to fetch' }) }
  if (res.error) throw classify(res.error)
  return res.data as T
}

export const fetchAccess = (s: Supabase) => call<Access>(() => s.rpc('pricing_training_access'))
export const fetchCases = (s: Supabase) => call<CaseRow[]>(() => s.rpc('pricing_training_list'))
export const fetchCase = (s: Supabase, id: string) => call<CaseFull>(() => s.rpc('pricing_training_get', { p_id: id }))
export const saveCase = (s: Supabase, id: string | null, form: CaseForm, lines: readonly Line[]) => call<string>(() => s.rpc('pricing_training_save', { p_id: id, p_doc: saveDoc(form, lines) }))
export const submitCase = (s: Supabase, id: string) => call<null>(() => s.rpc('pricing_training_submit', { p_id: id }))

export const sendMessage = (s: Supabase, id: string, body: string) => call<string>(() => s.rpc('pricing_training_message', { p_id: id, p_body: body }))

export const photoUrl = (s: Supabase, path: string) => s.storage.from(TRAINING_BUCKET).getPublicUrl(path).data.publicUrl

/** Shrinks the photo to a JPEG, stores it under the uploader's folder, and returns its path and the JPEG. */
export async function uploadPhoto(s: Supabase, userId: string, file: Blob): Promise<{ path: string; jpeg: Blob }> {
  let jpeg: Blob
  try { jpeg = await toJpeg(file) } catch { throw new TrainingError('invalid', 'This file is not a picture I can open. Choose a JPEG or PNG photo.') }
  const path = `${userId}/${crypto.randomUUID()}.jpg`
  const { error } = await s.storage.from(TRAINING_BUCKET).upload(path, jpeg, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
  if (error) throw new TrainingError(/bucket/i.test(error.message) ? 'not_set_up' : 'unknown', /bucket/i.test(error.message) ? 'Training is being set up: its database part has not been applied yet.' : 'The photo could not be uploaded. Try again.')
  return { path, jpeg }
}

/** Asks the server to read the photo. A failure is a sentence to show; the person can always add materials by hand. */
export async function readPhoto(s: Supabase, jpeg: Blob): Promise<Reading> {
  const { data: { session } } = await s.auth.getSession()
  if (!session) throw new TrainingError('forbidden', 'Your session ended. Sign in again.')
  const body = new FormData()
  body.set('file', new File([jpeg], 'product.jpg', { type: 'image/jpeg' }))
  let res: Response
  try { res = await fetch('/api/pricing/training/read', { method: 'POST', body, headers: { Authorization: `Bearer ${session.access_token}` } }) } catch { throw new TrainingError('network', 'No connection. Check the network and try again.') }
  const json = await res.json().catch(() => null) as { ok: true; reading: unknown } | { ok: false; error: string } | null
  if (!json) throw new TrainingError('unknown', `Could not read the photo right now (the server answered ${res.status}). You can still add the materials yourself.`)
  if (!json.ok) throw new TrainingError('unknown', json.error)
  const reading = parseReading(json.reading)
  if (!reading) throw new TrainingError('unknown', 'I could not read this photo. You can still add the materials yourself.')
  return reading
}

export type Wood = { name: string; rate: number | null; updated_at: string; updated_by_name: string | null }
export const fetchWoods = (s: Supabase) => call<Wood[]>(() => s.rpc('pricing_woods_list'))
export const saveWood = (s: Supabase, name: string, rate: number | null) => call<null>(() => s.rpc('pricing_wood_save', { p_name: name, p_rate: rate }))
export const removeWood = (s: Supabase, name: string) => call<null>(() => s.rpc('pricing_wood_remove', { p_name: name }))
/** Metals and what they cost per kg (20270823000000): a metal frame row picks one. */
export type Metal = { name: string; density: number; rate: number | null; updated_at: string; updated_by_name: string | null }
export const fetchMetals = (s: Supabase) => call<Metal[]>(() => s.rpc('pricing_metals_list'))
/** A null density or rate leaves it as it is (a new metal takes mild steel's 7,850). */
export const saveMetal = (s: Supabase, name: string, density: number | null, rate: number | null) => call<null>(() => s.rpc('pricing_metal_save', { p_name: name, p_density: density, p_rate: rate }))
export const removeMetal = (s: Supabase, name: string) => call<null>(() => s.rpc('pricing_metal_remove', { p_name: name }))
/** Every rate ever set, newest first: a rate is never lost when it changes. */
export type RateChange = { kind: 'wood' | 'metal'; name: string; rate: number | null; set_at: string; set_by_name: string | null }
export const fetchRateHistory = (s: Supabase) => call<RateChange[]>(() => s.rpc('pricing_rate_history_list'))
/** Submitted cases for the quotation screen to pick from (20270726000000). Open to Quotations people too. */
export const fetchLibrary = (s: Supabase) => call<import('./match').Library>(() => s.rpc('pricing_training_library'))
/** Priced quotation lines that picked a taught product (20270729000000). Pricing people only. */
export const fetchTaughtQuotes = (s: Supabase) => call<import('./match').TaughtQuote[]>(() => s.rpc('pricing_taught_quotes'))
