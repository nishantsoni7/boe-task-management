// POST /api/sales/capture/website
//
// New enquiries from the website's Contact Form 7 forms, sent the moment a form is submitted by the WordPress snippet
// (scripts/wordpress/boe-one-lead-capture.php). It sends `Authorization: Bearer $SALES_CAPTURE_SECRET` and
// { rows: [{ key, form_type, name, email, phone, location, message }] }, up to 100 rows. All of the logic is in the
// database function capture_sales_leads (20270602000000), executable by the service role only: a new number becomes a
// lead, given by the allotment rule in working hours or else waiting to be allotted, a known number a repeat enquiry,
// and a row sent twice counts once.
//
// With SALES_CAPTURE_SECRET unset the route answers 503 and does nothing.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { captureRows } from '@/lib/salesLeads/capture'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const expected = process.env.SALES_CAPTURE_SECRET
  if (!expected) {
    console.error('[sales/capture] SALES_CAPTURE_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'Capture is not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Send JSON.' }, { status: 400 })
  }
  const parsed = captureRows(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (parsed.rows.length === 0) return NextResponse.json({ created: 0, repeat: 0, already: 0, failed: [] })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data, error } = await svc.rpc('capture_sales_leads', { p_rows: parsed.rows })
  if (error) {
    console.error('[sales/capture] capture failed:', error.message)
    return NextResponse.json({ error: 'The leads could not be saved.' }, { status: 500 })
  }
  return NextResponse.json(data)
}
