import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminClient } from '@/lib/supabase/admin'
import { answerJson, jsonFormat } from '@/lib/ai/structuredOutput'
import { FACTS_INSTRUCTION, FACTS_SCHEMA, FACTS_SYSTEM_PROMPT, parseFacts, storageOf, type Facts, type PhotoResult } from '@/lib/pricing/photoFacts'
import { photoRateLimiter, sniffMedia } from '@/lib/pricing/photoRun'

// Pricing, photo facts (Price Brain v2, phase 3B): reads up to five product photos BOE One holds into facts from a fixed
// list. The caller must be signed in and allowed to teach in Pricing (create, or Admin); the database decides again when
// the reading is saved AS THE PERSON (pricing_photo_fact_save), and refuses a photo BOE One does not hold. The photos sit
// in three stores, one of them private (approved PIs), so they are downloaded here with the server credential. Each photo
// goes to the AI service once, is not stored here and is never logged. THE PHOTO IS DATA: the reader fills a fixed schema
// and parseFacts keeps only that. Nothing here sets or suggests a price.

export const runtime = 'nodejs'
export const maxDuration = 60

const MODELS = [process.env.PRICING_TRAINING_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].filter((m): m is string => !!m)
const PER_CALL = 5
const MAX_BYTES = 3_700_000 // the AI service takes at most about 5 MB once encoded
const MEDIA: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

// shortcut: per-instance memory, so the limit is per server instance, not global; move to the database if abused.
const rateLimited = photoRateLimiter()

type Reply = { ok: true; results: PhotoResult[] } | { ok: false; error: string }
const reply = (body: Reply, status = 200) => NextResponse.json(body, { status })

async function readOne(apiKey: string, media: string, data: string): Promise<{ facts: Facts | null; model: string; error?: string }> {
  let why = ''
  for (const model of MODELS) {
    let res: Response
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(50_000),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 800, system: FACTS_SYSTEM_PROMPT, output_config: { format: jsonFormat(FACTS_SCHEMA) },
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media, data } }, { type: 'text', text: FACTS_INSTRUCTION }] }],
        }),
      })
    } catch { return { facts: null, model, error: 'Reading took too long.' } }
    if (res.ok) return { facts: parseFacts(answerJson(await res.json().catch(() => null))), model }
    const detail = await res.json().catch(() => null) as { error?: { type?: string; message?: string } } | null
    // The service's own words (24 Nov 2026: "400 invalid_request_error" alone could not tell an empty credit balance from a bad photo).
    const said = String(detail?.error?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    console.error('photo facts: provider refused', { model, status: res.status, type: detail?.error?.type, message: said })
    why = `${res.status} ${detail?.error?.type ?? 'error'}${said ? `: ${said}` : ''}`
    if (res.status !== 404) break // only an unknown model moves on to the next one
  }
  return { facts: null, model: '', error: `The reading service answered ${why}` }
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, error: 'Sign in again.' }, 401)
  const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, error: 'Sign in again.' }, 401)
  const { data: access, error: accessErr } = await asUser.rpc('pricing_training_access')
  const a = (access ?? {}) as { create?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.admin)) return reply({ ok: false, error: 'You may not read photos in Pricing.' }, 403)

  const body = await req.json().catch(() => null) as { photos?: unknown } | null
  const asks = (Array.isArray(body?.photos) ? body!.photos : []).slice(0, PER_CALL).flatMap((x): { key: string; label: string | null }[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    return typeof o.key === 'string' && storageOf(o.key) ? [{ key: o.key, label: typeof o.label === 'string' ? o.label.slice(0, 160) : null }] : []
  })
  if (asks.length === 0) return reply({ ok: true, results: [] })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return reply({ ok: false, error: 'Photo reading is not set up yet.' }, 503)
  if (rateLimited(who.user.id, asks.length)) return reply({ ok: false, error: 'Too many photos in a minute. Wait a little, then go on.' }, 429)
  const admin = adminClient()
  if (!admin.ok) { console.error('photo facts: server credential missing', admin.missing); return reply({ ok: false, error: 'Photo reading is not set up on the server yet.' }, 503) }

  const results = await Promise.all(asks.map(async ({ key, label }): Promise<PhotoResult> => {
    const where = storageOf(key)!
    if (!MEDIA[(where.path.split('.').pop() ?? '').toLowerCase()]) return { key, ok: false, error: 'Not a JPEG, PNG or WebP photo.' }
    const file = await admin.client.storage.from(where.bucket).download(where.path)
    if (file.error || !file.data) return { key, ok: false, error: 'The photo could not be opened.' }
    if (file.data.size > MAX_BYTES) return { key, ok: false, error: 'The photo is too large to read (over 3.7 MB).' }
    const bytes = Buffer.from(await file.data.arrayBuffer())
    const media = sniffMedia(bytes)
    if (!media) return { key, ok: false, error: 'Not a JPEG, PNG or WebP photo.' }
    const read = await readOne(apiKey, media, bytes.toString('base64'))
    if (!read.facts) return { key, ok: false, error: read.error ?? 'Nothing could be read from this photo.' }
    // Saved as the person: the database checks again that they may, and that the photo is one BOE One holds.
    const saved = await asUser.rpc('pricing_photo_fact_save', { p_key: key, p_label: label, p_facts: read.facts, p_model: read.model })
    if (saved.error) return { key, ok: false, error: (saved.error.message ?? '').replace(/^.*PRICING_PHOTO_[A-Z_]+:\s*/, '') || 'The reading could not be saved.' }
    return { key, ok: true, facts: read.facts }
  }))
  return reply({ ok: true, results })
}
