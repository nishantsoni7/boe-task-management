// POST /api/exhibition-leads/scan
//
// Reads one photograph of a visiting card or a visitor form and returns the
// contact details on it. Backs the Scan buttons on Add Lead and nothing else.
//
// AUTH
// ----
// The caller's own Supabase session (bearer token). Module access is not
// re-implemented here: the exhibitions table carries the RESTRICTIVE
// module_entry_open('exhibition_leads') policy, so a user-scoped read of it
// succeeds only for someone who may use Exhibition Leads. No service credential
// is involved.
//
// STORAGE
// -------
// The photograph is read into memory, sent to the provider, and dropped. It is
// not stored and not logged.
//
// THE KEY
// -------
// ANTHROPIC_API_KEY, server-side only. When it is not set the route answers
// `not_configured` and the screen falls back to typing — scanning is an aid,
// never a gate on capturing a lead.
//
// THE PHOTOGRAPH IS DATA
// ----------------------
// Whatever is printed on a card or written on a form is read as text to copy,
// never as an instruction. The model is asked only to fill a fixed schema, and
// parseScanResult discards anything outside it.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { MAX_SCAN_BYTES, parseScanResult, scanIsEmpty, type ScanApiResponse } from '@/lib/exhibitionLeads/scan'
import { SCAN_INSTRUCTION, SCAN_SYSTEM_PROMPT, SCAN_TOOL } from '@/lib/exhibitionLeads/scanPrompt'

export const runtime = 'nodejs'
export const maxDuration = 30

// Tried in order: the first one this key can use answers. A model name the account
// does not have (404) falls through to the next instead of failing the scan.
const MODELS = [process.env.EXHIBITION_SCAN_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
  .filter((m, i, all): m is string => !!m && all.indexOf(m) === i)
const PROVIDER_TIMEOUT_MS = 25_000

// A spend guard, not a security control: per person, in memory.
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 20
const recent = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const hits = (recent.get(userId) ?? []).filter(t => now - t < RATE_WINDOW_MS)
  hits.push(now)
  recent.set(userId, hits)
  if (recent.size > 500) for (const [k, v] of recent) if (v.every(t => now - t >= RATE_WINDOW_MS)) recent.delete(k)
  return hits.length > RATE_MAX
}

const reply = (body: ScanApiResponse, status = 200) => NextResponse.json(body, { status })

const MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp',
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, code: 'auth', error: 'Sign in again to scan.' }, 401)

  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, code: 'auth', error: 'Sign in again to scan.' }, 401)
  const { error: accessErr } = await asUser.from('exhibitions').select('id').limit(1)
  if (accessErr) return reply({ ok: false, code: 'auth', error: 'You do not have access to Exhibition Leads.' }, 403)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return reply({ ok: false, code: 'not_configured', error: 'Scanning is not switched on yet. Type the details instead — the photo is not needed.' }, 503)
  }

  if (rateLimited(who.user.id)) {
    return reply({ ok: false, code: 'rate_limited', error: 'Too many scans in a minute. Wait a few seconds and try again.' }, 429)
  }

  let form: FormData
  try { form = await req.formData() } catch { return reply({ ok: false, code: 'failed', error: 'The photo did not arrive. Try again.' }, 400) }
  const file = form.get('image')
  if (!(file instanceof File)) return reply({ ok: false, code: 'failed', error: 'Choose a photo to scan.' }, 400)
  const mediaType = MEDIA_TYPES[file.type]
  if (!mediaType) return reply({ ok: false, code: 'failed', error: 'Use a JPG, PNG or WebP photo.' }, 415)
  if (file.size > MAX_SCAN_BYTES) return reply({ ok: false, code: 'too_large', error: 'That photo is too large. Take it again a little further back.' }, 413)

  const data = Buffer.from(await file.arrayBuffer()).toString('base64')

  type Answer = { content?: { type: string; text?: string; input?: unknown }[] }
  let answer: Answer | null = null
  let lastStatus = 0
  let timedOut = false

  for (const model of MODELS) {
    let res: Response
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system: SCAN_SYSTEM_PROMPT,
          tools: [SCAN_TOOL],
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
              { type: 'text', text: SCAN_INSTRUCTION },
            ],
          }],
        }),
      })
    } catch {
      timedOut = true
      break
    }
    lastStatus = res.status
    if (res.ok) { answer = await res.json().catch(() => null) as Answer | null; break }
    // Only a model this account does not have moves on to the next; a bad key or a busy service would fail them all.
    const detail = await res.json().catch(() => null) as { error?: { type?: string; message?: string } } | null
    console.error('exhibition-leads scan: provider refused', { model, status: res.status, type: detail?.error?.type, message: detail?.error?.message })
    if (res.status !== 404) break
  }

  if (!answer) {
    if (timedOut) return reply({ ok: false, code: 'failed', error: 'Scanning took too long. Try again, or type the details.' }, 504)
    if (lastStatus === 401 || lastStatus === 403) {
      return reply({ ok: false, code: 'not_configured', error: 'Scanning is switched on, but its key was refused. Ask the admin to check ANTHROPIC_API_KEY. Type the details for now.' }, 502)
    }
    if (lastStatus === 429 || lastStatus === 529) {
      return reply({ ok: false, code: 'rate_limited', error: 'The scanning service is busy. Wait a few seconds and try again.' }, 503)
    }
    return reply({ ok: false, code: 'failed', error: 'Could not read the photo right now. Try again, or type the details.' }, 502)
  }

  // The reading comes back as the tool call; if a model answered in plain text instead, take the JSON from it.
  const tool = answer.content?.find(c => c.type === 'tool_use')
  let raw: unknown = tool?.input
  if (!raw) {
    const text = answer.content?.find(c => c.type === 'text')?.text ?? ''
    const m = /\{[\s\S]*\}/.exec(text)
    if (m) { try { raw = JSON.parse(m[0]) } catch { /* nothing usable */ } }
  }
  const result = parseScanResult(raw)
  if (scanIsEmpty(result)) {
    return reply({ ok: false, code: 'unreadable', error: 'Could not find contact details in that photo. Hold the camera steady, fill the frame, and try again.' }, 200)
  }
  return reply({ ok: true, result })
}
