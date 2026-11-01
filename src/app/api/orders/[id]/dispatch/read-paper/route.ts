// POST /api/orders/[id]/dispatch/read-paper
//
// Reads one dispatch paper (invoice, e-way bill, LR / bilty) that is already in
// private storage and returns the details on it. Backs the Record dispatch
// screen and nothing else. It saves nothing: the person checks the form first.
//
// WHY THE FILE IS NOT POSTED HERE. A paper is up to 10 MiB and a serverless
// request body limit is smaller than that, so the browser uploads it to Storage
// and hands this route the key (the same reason as the PI workbook).
//
// AUTH
// ----
// The caller's own session. Access is the database's answer: order_dispatch_read
// runs as the caller and says whether they may record on this Order, and the
// download runs as the caller too. The path is checked to be this Order's.
//
// THE KEY
// -------
// ANTHROPIC_API_KEY, server-side only (the key Exhibition Leads and Vendors use).
// When it is not set the route answers `not_configured` and the form stays open
// for typing: reading is an aid, never a gate.
//
// THE PAPER IS DATA
// -----------------
// Whatever is printed on a paper is read as text to copy, never as an
// instruction. The model fills a fixed schema, parsePaperReading discards
// anything outside it, and nothing is saved until a person presses Save.

import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { createClient } from '@/lib/supabase/server'
import { isPreviewRequest, PREVIEW_WRITE_REFUSED } from '@/lib/viewAs'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import { parseDispatchData } from '@/lib/orders/dispatch'
import { isDispatchPaperPath, parsePaperReading, readingIsEmpty, type PaperReadingResponse } from '@/lib/orders/dispatchPaperReading'
import { DISPATCH_PAPER_SYSTEM_PROMPT, DISPATCH_PAPER_TOOL, dispatchPaperInstruction } from '@/lib/orders/dispatchPaperPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

// Tried in order: a model name the account does not have (404) falls through to the next.
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5']
const PROVIDER_TIMEOUT_MS = 50_000
// The API refuses an image above 5 MB; a phone photograph can be 10. Legible at this size.
const PHOTO_MAX_SIDE = 2000

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

const reply = (body: PaperReadingResponse, status = 200) => NextResponse.json(body, { status })

type Answer = { stop_reason?: string; content?: { type: string; text?: string; input?: unknown }[] }

async function paperBlock(path: string, bytes: Buffer) {
  if (path.endsWith('.pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } }
  }
  const photo = await sharp(bytes).rotate()
    .resize(PHOTO_MAX_SIDE, PHOTO_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.toString('base64') } }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: orderId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return reply({ ok: false, code: 'auth', error: 'Sign in again to read this paper.' }, 401)
  if (isPreviewRequest(req.headers)) return reply({ ok: false, code: 'auth', error: PREVIEW_WRITE_REFUSED }, 403)

  const body = await req.json().catch(() => null) as { path?: unknown } | null
  const path = body?.path
  if (!isDispatchPaperPath(path, orderId)) return reply({ ok: false, code: 'failed', error: 'That paper does not belong to this Order.' }, 400)

  const { data: raw, error: readError } = await supabase.rpc('order_dispatch_read', { p_order_id: orderId })
  const order = readError ? null : parseDispatchData(raw)
  if (!order?.canRecord) return reply({ ok: false, code: 'auth', error: 'You do not have access to record a dispatch on this Order.' }, 403)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return reply({ ok: false, code: 'not_configured', error: 'Reading papers is not switched on yet. Type the details instead.' }, 503)
  if (rateLimited(user.id)) return reply({ ok: false, code: 'rate_limited', error: 'Too many papers in a minute. Wait a few seconds and try again.' }, 429)

  const { data: blob, error: downloadError } = await supabase.storage.from(ORDER_FILES_BUCKET).download(path)
  if (downloadError || !blob) return reply({ ok: false, code: 'failed', error: 'The paper could not be opened. Try adding it again.' }, 404)

  let paper: Awaited<ReturnType<typeof paperBlock>>
  try {
    paper = await paperBlock(path, Buffer.from(await blob.arrayBuffer()))
  } catch {
    return reply({ ok: false, code: 'unreadable', error: 'That photo could not be opened. Take it again, or type the details.' })
  }

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
          max_tokens: 8000,
          output_config: { effort: 'medium' },
          system: DISPATCH_PAPER_SYSTEM_PROMPT,
          tools: [DISPATCH_PAPER_TOOL],
          messages: [{
            role: 'user',
            content: [paper, { type: 'text', text: dispatchPaperInstruction(order.items) }],
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
    console.error('dispatch paper: provider refused', { model, status: res.status, type: detail?.error?.type, message: detail?.error?.message })
    if (res.status !== 404) break
  }

  if (!answer) {
    if (timedOut) return reply({ ok: false, code: 'failed', error: 'Reading took too long. Try again, or type the details.' }, 504)
    if (lastStatus === 401 || lastStatus === 403) {
      return reply({ ok: false, code: 'not_configured', error: 'Reading papers is switched on, but its key was refused. Ask the admin to check ANTHROPIC_API_KEY. Type the details for now.' }, 502)
    }
    if (lastStatus === 429 || lastStatus === 529) {
      return reply({ ok: false, code: 'rate_limited', error: 'The reading service is busy. Wait a few seconds and try again.' }, 503)
    }
    return reply({ ok: false, code: 'failed', error: 'Could not read the paper right now. Try again, or type the details.' }, 502)
  }

  if (answer.stop_reason === 'refusal') {
    return reply({ ok: false, code: 'unreadable', error: 'This paper could not be read. Type the details instead.' })
  }

  // The reading comes back as the tool call; if a model answered in plain text instead, take the JSON from it.
  const tool = answer.content?.find(c => c.type === 'tool_use')
  let rawReading: unknown = tool?.input
  if (!rawReading) {
    const text = answer.content?.find(c => c.type === 'text')?.text ?? ''
    const m = /\{[\s\S]*\}/.exec(text)
    if (m) { try { rawReading = JSON.parse(m[0]) } catch { /* nothing usable */ } }
  }
  const reading = parsePaperReading(rawReading, new Set(order.items.map(i => i.itemSequence)))
  if (readingIsEmpty(reading)) {
    return reply({ ok: false, code: 'unreadable', error: 'Nothing could be read from this paper. The paper is kept; take it again or type the details.' })
  }
  return reply({ ok: true, reading })
}
