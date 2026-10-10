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
import { MAX_SCAN_BYTES, parseScanResult, scanIsEmpty, type ScanApiResponse, type ScanKind } from '@/lib/exhibitionLeads/scan'
import { SCAN_SYSTEM_PROMPT, SCAN_TOOL, scanInstruction } from '@/lib/exhibitionLeads/scanPrompt'

export const runtime = 'nodejs'
export const maxDuration = 30

const MODEL = process.env.EXHIBITION_SCAN_MODEL || 'claude-sonnet-5-5'
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
  const kind: ScanKind = form.get('kind') === 'visitor_form' ? 'visitor_form' : 'visiting_card'
  if (!(file instanceof File)) return reply({ ok: false, code: 'failed', error: 'Choose a photo to scan.' }, 400)
  const mediaType = MEDIA_TYPES[file.type]
  if (!mediaType) return reply({ ok: false, code: 'failed', error: 'Use a JPG, PNG or WebP photo.' }, 415)
  if (file.size > MAX_SCAN_BYTES) return reply({ ok: false, code: 'too_large', error: 'That photo is too large. Take it again a little further back.' }, 413)

  const data = Buffer.from(await file.arrayBuffer()).toString('base64')

  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SCAN_SYSTEM_PROMPT,
        tools: [SCAN_TOOL],
        tool_choice: { type: 'tool', name: SCAN_TOOL.name },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: scanInstruction(kind) },
          ],
        }],
      }),
    })
  } catch {
    return reply({ ok: false, code: 'failed', error: 'Scanning took too long. Try again, or type the details.' }, 504)
  }

  if (!res.ok) {
    return reply({ ok: false, code: 'failed', error: 'Could not read the photo right now. Try again, or type the details.' }, 502)
  }

  const body = await res.json().catch(() => null) as { content?: { type: string; input?: unknown }[] } | null
  const tool = body?.content?.find(c => c.type === 'tool_use')
  const result = parseScanResult(tool?.input, kind)
  if (scanIsEmpty(result)) {
    return reply({ ok: false, code: 'unreadable', error: 'Could not find contact details in that photo. Hold the camera steady, fill the frame, and try again.' }, 200)
  }
  return reply({ ok: true, result })
}
