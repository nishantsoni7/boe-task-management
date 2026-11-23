import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { answerJson, closedSchema } from '@/lib/ai/structuredOutput'
import { parseDraft } from '@/lib/pricing/training/draft'
import { DRAFT_INSTRUCTION, DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT } from '@/lib/pricing/training/draftPrompt'

// Pricing > Training, "In your words": turns ONE pricing note into rows of a price. The caller must be signed in and
// allowed to teach (Pricing: Create, or Admin): pricing_training_access decides. The note is sent to the AI service
// once, is not stored here and is never logged. THE NOTE IS DATA: the model fills a fixed schema (draftPrompt.ts),
// only copies numbers out of the note, and parseDraft keeps only that shape. The screen does every sum.

export const runtime = 'nodejs'
export const maxDuration = 60

const MODELS = [process.env.PRICING_TRAINING_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'].filter((m): m is string => !!m)
const PROVIDER_TIMEOUT_MS = 55_000
const MAX_NOTE = 4000

// shortcut: per-instance memory, so the limit is per server instance, not global; move to the database if abused.
const hits = new Map<string, number[]>()
function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (hits.get(userId) ?? []).filter(t => now - t < 60_000)
  recent.push(now)
  hits.set(userId, recent)
  return recent.length > 10
}

type Reply = { ok: true; draft: ReturnType<typeof parseDraft> } | { ok: false; error: string }
const reply = (body: Reply, status = 200) => NextResponse.json(body, { status })

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, error: 'Sign in again to draft from a note.' }, 401)
  const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, error: 'Sign in again to draft from a note.' }, 401)
  const { data: access, error: accessErr } = await asUser.rpc('pricing_training_access')
  const a = (access ?? {}) as { create?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.admin)) return reply({ ok: false, error: 'You may not teach cases in Pricing.' }, 403)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return reply({ ok: false, error: 'Drafting from a note is not set up yet. You can still type the elements yourself.' }, 503)
  if (rateLimited(who.user.id)) return reply({ ok: false, error: 'Too many drafts in a minute. Wait a little, then try again.' }, 429)

  const body = await req.json().catch(() => null) as { note?: unknown } | null
  const note = typeof body?.note === 'string' ? body.note.trim() : ''
  if (note.length < 10) return reply({ ok: false, error: 'Write the note first: how the price is worked out.' }, 400)
  if (note.length > MAX_NOTE) return reply({ ok: false, error: `The note is over ${MAX_NOTE.toLocaleString('en-IN')} characters. Shorten it to the price workings.` }, 413)

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
          model, max_tokens: 3000, system: DRAFT_SYSTEM_PROMPT,
          // Every field required (an empty value meaning "not in the note"): see closedSchema on schemas with many optional fields.
          output_config: { format: { type: 'json_schema', schema: closedSchema(DRAFT_SCHEMA, true) } },
          messages: [{ role: 'user', content: [{ type: 'text', text: `${DRAFT_INSTRUCTION}\n\n<note>\n${note}\n</note>` }] }],
        }),
      })
    } catch {
      return reply({ ok: false, error: 'Drafting took too long. Try again, or type the elements yourself.' }, 504)
    }
    lastStatus = res.status
    if (res.ok) break
    const detail = await res.json().catch(() => null) as { error?: { type?: string; message?: string } } | null
    console.error('pricing training draft: provider refused', { model, status: res.status, type: detail?.error?.type })
    why = `${res.status} ${detail?.error?.type ?? 'error'}${detail?.error?.message ? `: ${detail.error.message.slice(0, 200)}` : ''}`
    if (res.status !== 404) break // only an unknown model moves on to the next one
  }
  if (!res || !res.ok) {
    if (lastStatus === 401 || lastStatus === 403) return reply({ ok: false, error: 'The drafting service refused its key. Ask the admin to check ANTHROPIC_API_KEY.' }, 502)
    if (lastStatus === 429 || lastStatus === 529) return reply({ ok: false, error: 'The drafting service is busy. Try again in a minute.' }, 503)
    return reply({ ok: false, error: `Could not draft from the note. The service answered: ${why || lastStatus}. You can still type the elements yourself.` }, 502)
  }
  const draft = parseDraft(answerJson(await res.json().catch(() => null)))
  if (!draft) return reply({ ok: false, error: 'I could not find a price worked out in this note. Add the amounts or rates, or type the elements yourself.' })
  return reply({ ok: true, draft })
}
