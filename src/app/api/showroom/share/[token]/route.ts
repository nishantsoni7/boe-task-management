import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/showroom/share/[token]
// Public — no auth. Uses service role to look up inquiry by share_token.
// Returns only public-safe fields: no salesperson_id, no discount, no internal notes.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const db = svc()

  const { data, error } = await db
    .from('showroom_inquiries')
    .select(`
      id,
      customer_name,
      customer_mobile,
      company,
      city,
      project_name,
      created_at,
      showroom_inquiry_items (
        id,
        quantity,
        mrp_at_time,
        showroom_products (
          product_code,
          name,
          category
        )
      )
    `)
    .eq('share_token', token)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Strip any fields that should not be public before returning
  const { customer_mobile: _mobile, ...safeInquiry } = data

  return NextResponse.json({ inquiry: safeInquiry })
}
