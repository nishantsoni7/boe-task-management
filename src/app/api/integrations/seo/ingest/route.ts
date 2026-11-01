// POST /api/integrations/seo/ingest
//
// The door the scheduled sessions on the owner's PC use to send SEO results to BOE One, with
// `Authorization: Bearer $SEO_INGEST_SECRET`. Results are upserted on keys the sender chooses, so a delivery that
// fails half way is simply sent again. With SEO_INGEST_SECRET unset the route answers 503 and writes nothing.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { refuseWithoutSeoSecret } from '@/lib/seo/doorSecret'
import { SEO_MAX_INGEST_BYTES, SeoIngestError, parseSeoIngest } from '@/lib/seo/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: Request) {
  const refusal = refuseWithoutSeoSecret(req)
  if (refusal) return refusal

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > SEO_MAX_INGEST_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw) > SEO_MAX_INGEST_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  let batches
  try {
    batches = parseSeoIngest(JSON.parse(raw), new Date().toISOString())
  } catch (error) {
    if (error instanceof SeoIngestError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'The body is not JSON.' }, { status: 400 })
    throw error
  }

  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const written: Record<string, number> = {}
  for (const batch of batches) {
    if (!batch.rows.length) continue
    const { error } = await svc.from(batch.table).upsert(batch.rows, { onConflict: batch.onConflict })
    if (error) {
      console.error(`[seo/ingest] ${batch.table}: ${error.message}`)
      return NextResponse.json({ error: `Could not save ${batch.table}.`, written }, { status: 500 })
    }
    written[batch.table] = batch.rows.length
  }
  return NextResponse.json({ ok: true, written })
}
