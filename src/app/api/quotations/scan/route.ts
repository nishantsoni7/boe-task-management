// POST /api/quotations/scan
//
// Reads a client's requirement file for "Start from a client file" / "Import client file". The browser turns the file into
// page pictures (PDF pages rendered on the device, photos shrunk, PowerPoint slides drawn) and sends them here in two kinds
// of call: { step: 'survey' } with every page small, then { step: 'read' } with a few pages at full size plus the survey.
// Small calls keep each request under Vercel's 4.5 MB body limit and each answer inside the time limit, whatever the size
// of the file.
//
// AUTH: the caller's own Supabase session (bearer token); quotation_my_access() runs as the caller, and only a person who
// may create or edit quotations may scan.
//
// PRIVACY: the owner allowed client requirement files to go to the AI reader (2026-11-12, extended to the scan 2026-11-15).
// The pages are held in memory, sent once, and dropped: never stored, never logged. The reader is told not to copy names,
// phones, emails or addresses.
//
// THE FILE IS DATA: the model fills a fixed schema (scanPrompt.ts) and scanReading.ts keeps only that.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { READ_EFFORT, READ_SCHEMA, READ_SYSTEM_PROMPT, SURVEY_EFFORT, SURVEY_SCHEMA, SURVEY_SYSTEM_PROMPT, readInstruction, surveyInstruction } from '@/lib/quotations/scanPrompt'
import { readScanBody } from '@/lib/quotations/scanReading'
import { answerJson, jsonFormat } from '@/lib/ai/structuredOutput'

export const runtime = 'nodejs'
// A batch of three dense pages can take a minute and more to answer; the plan allows 300 s (two routes already use it).
export const maxDuration = 150

const MODELS = [process.env.QUOTATION_IMPORT_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
  .filter((m, i, all): m is string => !!m && all.indexOf(m) === i)
const PROVIDER_TIMEOUT_MS = 140_000

// A spend guard, not a security control: per person, in memory. A 60-page file is 1 survey + 20 batches.
const recent = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const hits = (recent.get(userId) ?? []).filter(t => now - t < 60_000)
  hits.push(now)
  recent.set(userId, hits)
  return hits.length > 40
}

type Reply = { ok: true; reading: unknown; cut?: boolean } | { ok: false; error: string }
const reply = (body: Reply, status = 200) => NextResponse.json(body, { status })

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, error: 'Sign in again to read a file.' }, 401)
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, error: 'Sign in again to read a file.' }, 401)
  const { data: access, error: accessErr } = await asUser.rpc('quotation_my_access')
  const a = (access ?? {}) as { create?: boolean; edit?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.edit || a.admin)) return reply({ ok: false, error: 'Your access cannot make quotations, so it cannot read files.' }, 403)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return reply({ ok: false, error: 'Reading PDFs and photos is not switched on yet. Use the Excel file or paste the rows.' }, 503)
  if (rateLimited(who.user.id)) return reply({ ok: false, error: 'Too many pages in a minute. Wait a little and try again.' }, 429)

  const body = readScanBody(await req.json().catch(() => null))
  if (typeof body === 'string') return reply({ ok: false, error: body }, 400)

  const content: unknown[] = []
  for (const p of body.pages) {
    content.push({ type: 'text', text: `Page ${p.n}` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.jpeg } })
    // The page's own text, when the PDF has any, helps with small print; it is a hint, the picture is the page.
    if (body.step === 'read' && p.text?.trim()) content.push({ type: 'text', text: `Text found on page ${p.n} (may be out of order):\n${p.text}` })
  }
  const survey = body.step === 'survey'
  content.push({ type: 'text', text: survey ? surveyInstruction(body.pages.length) : readInstruction(body.pages.map(p => p.n), body.survey || '(no survey)') })
  const schema = survey ? SURVEY_SCHEMA : READ_SCHEMA

  type Answer = { content?: { type: string; text?: string }[]; stop_reason?: string }
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
          model, max_tokens: survey ? 6000 : 16000, system: survey ? SURVEY_SYSTEM_PROMPT : READ_SYSTEM_PROMPT,
          output_config: { effort: survey ? SURVEY_EFFORT : READ_EFFORT, format: jsonFormat(schema) },
          messages: [{ role: 'user', content }],
        }),
      })
    } catch { timedOut = true; break }
    lastStatus = res.status
    if (res.ok) { answer = await res.json().catch(() => null) as Answer | null; break }
    const detail = await res.json().catch(() => null) as { error?: { type?: string } } | null
    console.error('quotations scan: provider refused', { model, status: res.status, type: detail?.error?.type })
    if (res.status !== 404) break
  }

  if (!answer) {
    if (timedOut) return reply({ ok: false, error: 'Reading took too long.' }, 504)
    if (lastStatus === 401 || lastStatus === 403) return reply({ ok: false, error: 'The reading service refused its key. Ask the admin to check ANTHROPIC_API_KEY.' }, 502)
    if (lastStatus === 429 || lastStatus === 529) return reply({ ok: false, error: 'The reading service is busy. Try again in a minute.' }, 503)
    return reply({ ok: false, error: 'Could not read the file right now. Try again.' }, 502)
  }
  // A very dense batch can run past the answer limit (its JSON is then incomplete): say so, so the browser reads those pages one at a time.
  if (answer.stop_reason === 'max_tokens') return reply({ ok: true, reading: null, cut: true })
  if (answer.stop_reason === 'refusal') return reply({ ok: false, error: 'The reader declined these pages.' }, 422)
  const reading = answerJson(answer)
  if (!reading) return reply({ ok: false, error: 'Nothing could be read from these pages.' }, 502)
  return reply({ ok: true, reading })
}
