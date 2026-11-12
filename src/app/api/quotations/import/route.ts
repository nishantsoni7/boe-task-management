// POST /api/quotations/import
//
// Reads one client BOQ (a PDF or a photo) and returns its room types and products for the Import review table on
// a quotation. Excel, CSV and pasted text are read in the browser and never come here.
//
// AUTH: the caller's own Supabase session (bearer token); quotation_my_access() runs as the caller, and only a
// person who may create or edit quotations may import.
//
// PRIVACY: the owner allowed BOQ PDFs and photos to go to the AI reader on 2026-11-12, although they may carry the
// client's name on a letterhead. The file is held in memory, sent once, and dropped: never stored, never logged.
// The reader is told not to copy names, phones, emails, addresses or prices.
//
// THE FILE IS DATA: the model fills a fixed schema (importPrompt.ts) and parseBoqReading keeps only that.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { BOQ_INSTRUCTION, BOQ_SYSTEM_PROMPT, BOQ_TOOL } from '@/lib/quotations/importPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODELS = [process.env.QUOTATION_IMPORT_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
  .filter((m, i, all): m is string => !!m && all.indexOf(m) === i)
const PROVIDER_TIMEOUT_MS = 55_000
const MAX_BYTES = 4 * 1024 * 1024

// A spend guard, not a security control: per person, in memory.
const recent = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const hits = (recent.get(userId) ?? []).filter(t => now - t < 60_000)
  hits.push(now)
  recent.set(userId, hits)
  return hits.length > 6
}

type Reply = { ok: true; reading: unknown; note?: string } | { ok: false; error: string }
const reply = (body: Reply, status = 200) => NextResponse.json(body, { status })

const MEDIA: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'image', 'image/jpg': 'image', 'image/png': 'image', 'image/webp': 'image',
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, error: 'Sign in again to import.' }, 401)
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, error: 'Sign in again to import.' }, 401)
  const { data: access, error: accessErr } = await asUser.rpc('quotation_my_access')
  const a = (access ?? {}) as { create?: boolean; edit?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.edit || a.admin)) return reply({ ok: false, error: 'Your access cannot make quotations, so it cannot import.' }, 403)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return reply({ ok: false, error: 'Reading PDFs and photos is not switched on yet. Use the Excel file or paste the rows.' }, 503)
  if (rateLimited(who.user.id)) return reply({ ok: false, error: 'Too many files in a minute. Wait a little and try again.' }, 429)

  let form: FormData
  try { form = await req.formData() } catch { return reply({ ok: false, error: 'The file did not arrive. Try again.' }, 400) }
  const file = form.get('file')
  if (!(file instanceof File)) return reply({ ok: false, error: 'Choose a file to import.' }, 400)
  const kind = MEDIA[file.type]
  if (!kind) return reply({ ok: false, error: 'Use a PDF or a JPG, PNG or WebP photo.' }, 415)
  if (file.size > MAX_BYTES) return reply({ ok: false, error: 'This file is over 4 MB. Send the BOQ pages only, or the Excel file.' }, 413)

  const data = Buffer.from(await file.arrayBuffer()).toString('base64')
  const source = kind === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: file.type === 'image/jpg' ? 'image/jpeg' : file.type, data } }

  type Answer = { content?: { type: string; input?: unknown }[]; stop_reason?: string }
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
          model, max_tokens: 16000, system: BOQ_SYSTEM_PROMPT, tools: [BOQ_TOOL], tool_choice: { type: 'tool', name: BOQ_TOOL.name },
          messages: [{ role: 'user', content: [source, { type: 'text', text: BOQ_INSTRUCTION }] }],
        }),
      })
    } catch { timedOut = true; break }
    lastStatus = res.status
    if (res.ok) { answer = await res.json().catch(() => null) as Answer | null; break }
    const detail = await res.json().catch(() => null) as { error?: { type?: string } } | null
    console.error('quotations import: provider refused', { model, status: res.status, type: detail?.error?.type })
    if (res.status !== 404) break
  }

  if (!answer) {
    if (timedOut) return reply({ ok: false, error: 'Reading took too long. Send fewer pages, or the Excel file.' }, 504)
    if (lastStatus === 401 || lastStatus === 403) return reply({ ok: false, error: 'The reading service refused its key. Ask the admin to check ANTHROPIC_API_KEY.' }, 502)
    if (lastStatus === 429 || lastStatus === 529) return reply({ ok: false, error: 'The reading service is busy. Try again in a minute.' }, 503)
    return reply({ ok: false, error: 'Could not read the file right now. Try again.' }, 502)
  }
  const input = answer.content?.find(c => c.type === 'tool_use')?.input
  if (!input) return reply({ ok: false, error: 'No products could be read from this file.' }, 200)
  // A very long BOQ can run past the answer limit: say so, so nobody takes a partial list for the whole.
  const note = answer.stop_reason === 'max_tokens' ? 'Only the first part of this file could be read. Import the rest separately (fewer pages).' : undefined
  return reply({ ok: true, reading: input, note })
}
