import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { parseReading } from '@/lib/pricing/training/doc'
import { PRODUCT_INSTRUCTION, PRODUCT_SYSTEM_PROMPT, PRODUCT_TOOL } from '@/lib/pricing/training/readPrompt'

// Pricing > Training: reads ONE product photo and says what kind of product it is and which materials it can see.
// The caller must be signed in and allowed to teach (Pricing: Create, or Admin): pricing_training_access decides.
// The photo is sent to the AI service once, is not stored here and is never logged. It is a product photo:
// no client name, phone or document (owner decision 2026-11-15, D4).
// THE PHOTO IS DATA: the model fills a fixed schema (readPrompt.ts) and parseReading keeps only that.
// Nothing here sets or suggests a price.

export const runtime = 'nodejs'
export const maxDuration = 60

const MODELS = [process.env.PRICING_TRAINING_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].filter((m): m is string => !!m)
const PROVIDER_TIMEOUT_MS = 55_000
const MAX_BYTES = 4 * 1024 * 1024
const MEDIA = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

// shortcut: per-instance memory, so the limit is per server instance, not global; move to the database if abused.
const hits = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (hits.get(userId) ?? []).filter(t => now - t < 60_000)
  recent.push(now)
  hits.set(userId, recent)
  return recent.length > 10
}

type Reply = { ok: true; reading: ReturnType<typeof parseReading> } | { ok: false; error: string }
const reply = (body: Reply, status = 200) => NextResponse.json(body, { status })

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, error: 'Sign in again to read a photo.' }, 401)
  const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, error: 'Sign in again to read a photo.' }, 401)
  const { data: access, error: accessErr } = await asUser.rpc('pricing_training_access')
  const a = (access ?? {}) as { create?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.admin)) return reply({ ok: false, error: 'You may not teach cases in Pricing.' }, 403)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return reply({ ok: false, error: 'Photo reading is not set up yet. You can still add the materials yourself.' }, 503)
  if (rateLimited(who.user.id)) return reply({ ok: false, error: 'Too many photos in a minute. Wait a little, then try again.' }, 429)

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return reply({ ok: false, error: 'No photo was sent.' }, 400)
  if (!MEDIA.has(file.type)) return reply({ ok: false, error: 'Send a JPEG, PNG or WebP photo.' }, 415)
  if (file.size > MAX_BYTES) return reply({ ok: false, error: 'This photo is over 4 MB.' }, 413)

  const data = Buffer.from(await file.arrayBuffer()).toString('base64')
  const source = { type: 'image', source: { type: 'base64', media_type: file.type === 'image/jpg' ? 'image/jpeg' : file.type, data } }

  let res: Response | null = null
  let lastStatus = 0
  let why = '' // the service's own words (status, error type, message: never a key), so the screen can say what to fix
  for (const model of MODELS) {
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 2000, system: PRODUCT_SYSTEM_PROMPT, tools: [PRODUCT_TOOL], tool_choice: { type: 'tool', name: PRODUCT_TOOL.name },
          messages: [{ role: 'user', content: [source, { type: 'text', text: PRODUCT_INSTRUCTION }] }],
        }),
      })
    } catch {
      return reply({ ok: false, error: 'Reading the photo took too long. Try again, or add the materials yourself.' }, 504)
    }
    lastStatus = res.status
    if (res.ok) break
    const detail = await res.json().catch(() => null) as { error?: { type?: string; message?: string } } | null
    console.error('pricing training read: provider refused', { model, status: res.status, type: detail?.error?.type })
    why = `${res.status} ${detail?.error?.type ?? 'error'}${detail?.error?.message ? `: ${detail.error.message.slice(0, 200)}` : ''}`
    if (res.status !== 404) break // only an unknown model moves on to the next one
  }
  if (!res || !res.ok) {
    if (lastStatus === 401 || lastStatus === 403) return reply({ ok: false, error: 'The reading service refused its key. Ask the admin to check ANTHROPIC_API_KEY.' }, 502)
    if (lastStatus === 429 || lastStatus === 529) return reply({ ok: false, error: 'The reading service is busy. Try again in a minute.' }, 503)
    return reply({ ok: false, error: `Could not read the photo. The reading service answered: ${why || lastStatus}. You can still add the materials yourself.` }, 502)
  }
  const json = await res.json().catch(() => null) as { content?: { type: string; input?: unknown }[] } | null
  const reading = parseReading(json?.content?.find(c => c.type === 'tool_use')?.input)
  if (!reading) return reply({ ok: false, error: 'I could not read this photo. Try one with the whole product in view, or add the materials yourself.' })
  return reply({ ok: true, reading })
}
