// /api/sales/capture/whatsapp
//
// A chat on the business WhatsApp number becomes a lead. Meta posts every message to this address; nothing is sent back.
//
//   GET   Meta's one-time check when the address is saved in the app dashboard: it sends hub.mode, hub.verify_token and
//         hub.challenge, and wants the challenge back when the token is the one we hold (WA_VERIFY_TOKEN).
//   POST  A delivery. It must carry `X-Hub-Signature-256`, an HMAC of the body made with the app secret
//         (META_APP_SECRET); anything else is refused before the body is read as JSON. All of the logic is in the database
//         function capture_sales_chats (20270609000000), service role only: a new number becomes a lead, given by the same
//         rule as a website lead, a known number is ignored unless it was quiet for 3 days or came from an ad, and a
//         message delivered twice counts once. Meta resends for up to 36 hours when it is not answered 200, so a failure to
//         save answers 500 and the retry is safe.
//
//         IS IT A LEAD? (20270613000000) Before saving, the database says which numbers are already leads
//         (sales_chat_context). Those are not judged and nothing about them leaves BOE One. A chat opened from an ad is a
//         lead. Every other new number's words are judged (src/lib/salesLeads/classify.ts, ANTHROPIC_API_KEY) and the
//         verdict goes with the row: a lead, not a lead (held in Filtered chats), or unclear (a lead tagged Check). Without
//         the key, or when judging fails, every new chat is unclear: nothing is lost.
//
// With either Meta setting missing the route answers 503 and does nothing. It never logs a number, a name or a message.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { FALLBACK, FROM_AD, judgeChat, type Verdict } from '@/lib/salesLeads/classify'
import { chatRows, MAX_ROWS, mergeByPhone, safeEqual, signatureMatches, type CaptureRow } from '@/lib/salesLeads/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_BODY_BYTES = 2_000_000
// Judging runs side by side, each with its own 8 s limit, inside maxDuration.
const MAX_JUDGED = 20

export async function GET(req: Request) {
  const expected = process.env.WA_VERIFY_TOKEN
  if (!expected) {
    console.error('[sales/capture/whatsapp] WA_VERIFY_TOKEN is not set - refusing to run')
    return NextResponse.json({ error: 'Capture is not configured.' }, { status: 503 })
  }
  const q = new URL(req.url).searchParams
  const challenge = q.get('hub.challenge') ?? ''
  // The challenge is a number; it is sent back only as one, so nothing else can be made to come out of this address.
  if (q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') ?? '', expected) && /^[0-9]{1,20}$/.test(challenge)) {
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

export async function POST(req: Request) {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    console.error('[sales/capture/whatsapp] META_APP_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'Capture is not configured.' }, { status: 503 })
  }

  const raw = Buffer.from(await req.arrayBuffer())
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Too large.' }, { status: 413 })
  if (!signatureMatches(raw, req.headers.get('x-hub-signature-256'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return NextResponse.json({ error: 'Send JSON.' }, { status: 400 })
  }

  // Delivery receipts, reactions and the like arrive here too: they are answered 200 and dropped.
  const rows = chatRows(body)
  if (rows.length === 0) return NextResponse.json({ received: 0 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // One chat per client: several messages from the same number in one delivery are judged and saved together.
  const chats = mergeByPhone(rows)

  type Known = { known: boolean; check?: boolean; words?: string; held?: string[] }
  const context: Record<string, Known> = {}
  for (let i = 0; i < chats.length; i += MAX_ROWS) {
    const { data, error } = await svc.rpc('sales_chat_context', { p_phones: chats.slice(i, i + MAX_ROWS).map(c => c.phone) })
    if (error) {
      console.error('[sales/capture/whatsapp] context failed:', error.message)
      return NextResponse.json({ error: 'The chats could not be saved.' }, { status: 500 })
    }
    Object.assign(context, data as Record<string, Known>)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) console.error('[sales/capture/whatsapp] ANTHROPIC_API_KEY is not set - new chats are saved as Check')
  const toSave: CaptureRow[] = await Promise.all(chats.map(async (c, i): Promise<CaptureRow> => {
    const known = context[c.phone]
    if (known?.known && !known.check) return c.row
    let verdict: Verdict
    if (c.row.ad_id) verdict = FROM_AD
    // A spend guard per delivery; past it a chat is a Check lead, never dropped.
    else if (i >= MAX_JUDGED) verdict = FALLBACK
    else {
      verdict = await judgeChat({
        name: c.row.name,
        earlier: known?.check ? [known.words ?? ''] : (known?.held ?? []),
        messages: c.rows.map(r => ({ kind: r.kind, text: r.message, file: r.file })),
      }, { apiKey })
    }
    return { ...c.row, verdict }
  }))

  const total = { created: 0, repeat: 0, ignored: 0, already: 0, allotted: 0, held: 0, promoted: 0, failed: 0 }
  for (let i = 0; i < toSave.length; i += MAX_ROWS) {
    const { data, error } = await svc.rpc('capture_sales_chats', { p_rows: toSave.slice(i, i + MAX_ROWS) })
    if (error) {
      console.error('[sales/capture/whatsapp] capture failed:', error.message)
      return NextResponse.json({ error: 'The chats could not be saved.' }, { status: 500 })
    }
    const r = data as { created: number; repeat: number; ignored: number; already: number; allotted: number; held?: number; promoted?: number; failed: unknown[] }
    total.created += r.created
    total.repeat += r.repeat
    total.ignored += r.ignored
    total.already += r.already
    total.allotted += r.allotted
    total.held += r.held ?? 0
    total.promoted += r.promoted ?? 0
    total.failed += r.failed.length
  }
  return NextResponse.json(total)
}
