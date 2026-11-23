// Photo facts (phase 3B): the browser's calls. Reading goes through the server route (it downloads the photo and asks
// the AI service); the list, the queue and corrections are database functions (20270825000000).
import type { createClient } from '@/lib/supabase/client'
import type { Facts, PhotoResult } from './photoFacts'

type Supabase = ReturnType<typeof createClient>
export const photoKeys = { queue: ['pricing', 'photos', 'queue'] as const, list: ['pricing', 'photos', 'list'] as const }

export type PhotoQueue = { total: number; read: number; waiting: { key: string; source: 'quotation' | 'pi' | 'training'; label: string | null }[] }
export type PhotoFactRow = { key: string; label: string | null; facts: Facts; corrected: boolean; read_at: string; model: string | null; by_name: string | null }

const said = (m: string) => m.replace(/^.*PRICING_(PHOTO|TRAINING)_[A-Z_]+:\s*/, '')
async function rpc<T>(run: () => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await run()
  if (error) throw new Error(/Could not find the function|does not exist/i.test(error.message ?? '') ? 'Photo facts are being set up: their database part has not been applied yet.' : said(error.message ?? 'Something went wrong.'))
  return data as T
}

export const fetchPhotoQueue = (s: Supabase, limit = 10) => rpc<PhotoQueue>(() => s.rpc('pricing_photo_queue', { p_limit: limit }))
export const fetchPhotoFacts = (s: Supabase) => rpc<PhotoFactRow[]>(() => s.rpc('pricing_photo_facts_list'))
export const correctPhotoFact = (s: Supabase, key: string, facts: Facts) => rpc<null>(() => s.rpc('pricing_photo_fact_correct', { p_key: key, p_facts: facts }))
/** The facts of these photos ("<bucket>/<path>", at most 200), for pricing quotation lines (20270826000000). Read photos only. */
export const fetchFactsFor = (s: Supabase, keys: string[]) => rpc<Record<string, Partial<Facts>>>(() => s.rpc('pricing_photo_facts_for', { p_keys: keys }))

/** Reads up to five photos on the server. A failure of the whole call throws a sentence; each photo has its own result. */
export async function readPhotos(s: Supabase, photos: readonly { key: string; label: string | null }[]): Promise<PhotoResult[]> {
  const { data: { session } } = await s.auth.getSession()
  if (!session) throw new Error('Your session ended. Sign in again.')
  let res: Response
  try { res = await fetch('/api/pricing/photo-facts/read', { method: 'POST', body: JSON.stringify({ photos }), headers: { 'content-type': 'application/json', Authorization: `Bearer ${session.access_token}` } }) } catch { throw new Error('No connection. Check the network and try again.') }
  const json = await res.json().catch(() => null) as { ok: true; results: PhotoResult[] } | { ok: false; error: string } | null
  if (!json) throw new Error(`The server answered ${res.status}.`)
  if (!json.ok) throw new Error(json.error)
  return json.results
}

/** A photo's public address, for the two public stores; null for an approved PI's photo (a private store). */
export function publicPhoto(s: Supabase, key: string): string | null {
  const m = /^(quotation-images|pricing-training)\/(.+)$/.exec(key)
  return m ? s.storage.from(m[1]).getPublicUrl(m[2]).data.publicUrl : null
}
