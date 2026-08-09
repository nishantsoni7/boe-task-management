// POST /api/payroll/ask
//
// Answers an employee's question about how BOE payroll works, from BOE's own
// payroll rules. Backs the "Ask About Your Salary" section of
// /payroll/how-it-works.
//
// AUTH
// ----
// Any authenticated BOE user. Deliberately not admin-only: the guide is the one
// payroll surface every employee may read, and the answers contain no employee
// data — see below. An unauthenticated caller gets a 401, so this is never an
// open endpoint on the internet.
//
// WHAT THIS ROUTE NEVER TOUCHES
// -----------------------------
// It reads no payroll record. Not the caller's, not anybody's. The request body
// carries a question and nothing else — there is no employee_id parameter to
// tamper with, and none is accepted — so there is no path by which one employee
// could ask about another's pay. The grounding is rules and definitions only
// (src/lib/payroll/askGrounding.ts), which is what makes that guarantee
// structural rather than a matter of prompt wording.
//
// PROVIDER
// --------
// Anthropic, called server-side over HTTPS with the key held in
// ANTHROPIC_API_KEY. Same provider, same transport and the same env var as the
// existing /api/performance-audit route — no second provider, no new dependency,
// and the key never reaches the browser.
//
// WHEN NO KEY IS CONFIGURED
// -------------------------
// The route reports `configured: false` and answers nothing. It does not fall
// back to a canned or rule-based reply: a fabricated answer about somebody's pay
// would be indistinguishable from a real one, and the page renders an honest
// disabled state instead.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  validateQuestion,
  buildSystemPrompt,
  buildUserPrompt,
} from '@/lib/payroll/askGrounding'

/** Answers are short by instruction; this is a ceiling, not a target. */
const MAX_ANSWER_TOKENS = 700

// ─── Rate limiting ────────────────────────────────────────────────────────────
//
// Per user, in memory. Deliberately modest: this is a spend and abuse guard on a
// route that costs money per call, not a security control. In-process state
// means the window is per server instance and resets on deploy — acceptable for
// an internal tool with a small headcount, and the alternative (a table plus a
// migration) is more machinery than the risk warrants. Revisit if BOE ever runs
// several instances behind a load balancer.

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 8

const askTimes = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const recent = (askTimes.get(userId) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)

  if (recent.length >= RATE_LIMIT_MAX) {
    askTimes.set(userId, recent)
    return true
  }

  recent.push(now)
  askTimes.set(userId, recent)

  // The map only ever holds users who asked in the last window; without this it
  // grows for the life of the process.
  if (askTimes.size > 500) {
    for (const [id, times] of askTimes) {
      if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) askTimes.delete(id)
    }
  }
  return false
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Confirms the caller is a real BOE user, not merely a holder of a valid
  // Supabase token. Nothing from this row reaches the model.
  const { data: profile } = await svc.from('users').select('id').eq('id', user.id).single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validation = validateQuestion((body as { question?: unknown } | null)?.question)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  // Only the question is read. Any other field a caller sends — a system prompt,
  // extra "rules", an employee id — is ignored by never being looked at.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ configured: false }, { status: 200 })
  }

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: 'That is a lot of questions at once. Please wait a moment and try again.' },
      { status: 429 },
    )
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-opus-5',
        max_tokens: MAX_ANSWER_TOKENS,
        system:     buildSystemPrompt(),
        messages:   [{ role: 'user', content: buildUserPrompt(validation.question) }],
      }),
    })

    if (!response.ok) {
      // The provider's error text can carry request details; it goes to the
      // server log, never to the browser.
      console.error('[payroll/ask] Anthropic error:', response.status, await response.text())
      return NextResponse.json(
        { error: 'The assistant is unavailable right now. Please try again in a moment.' },
        { status: 502 },
      )
    }

    const data = await response.json()

    // A safety decline arrives as a normal 200 with stop_reason 'refusal' and no
    // content, so the answer has to be read defensively rather than indexed into.
    if (data?.stop_reason === 'refusal') {
      return NextResponse.json({
        configured: true,
        answer: 'I can’t answer that one. Try asking about attendance, deductions, adjustments or salary settlement — or ask your admin.',
      })
    }

    const answer = (data?.content ?? [])
      .filter((block: { type?: string }) => block?.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join('')
      .trim()

    if (!answer) {
      return NextResponse.json(
        { error: 'The assistant did not return an answer. Please try again.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ configured: true, answer })
  } catch (e) {
    console.error('[payroll/ask] request failed:', e)
    return NextResponse.json(
      { error: 'The assistant is unavailable right now. Please try again in a moment.' },
      { status: 502 },
    )
  }
}
