import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isPubliclyShareableImageUrl, pickPrimaryImage } from '@/lib/showroom/quotationImages'

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
          category,
          images,
          image_url
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

  // ── Product images ──────────────────────────────────────────────────────────
  //
  // The customer's own copy of the list showed a code, a name and a category and
  // nothing else — for a furniture list, the one thing that matters most was
  // missing. It is added here rather than in the page so the shape of the public
  // payload stays decided in one place.
  //
  // This endpoint has NO AUTH, so only a URL that is already public by
  // construction may be published — see isPubliclyShareableImageUrl. Every
  // product image in production qualifies (BOE's own site); a private storage
  // coordinate does not, and the card shows its placeholder instead.
  //
  // The raw `images` array never leaves the server: one resolved URL is
  // published per product, so the payload cannot carry a second, unvetted one.
  const items = (safeInquiry.showroom_inquiry_items ?? []) as Array<{
    showroom_products: { images?: unknown; image_url?: unknown } | null
  }>
  for (const item of items) {
    const product = item.showroom_products
    if (!product) continue
    const primary = pickPrimaryImage(product)
    const publishable =
      primary && isPubliclyShareableImageUrl(primary, process.env.NEXT_PUBLIC_SUPABASE_URL)
        ? primary
        : null
    delete (product as Record<string, unknown>).images
    ;(product as Record<string, unknown>).image_url = publishable
  }

  return NextResponse.json({ inquiry: safeInquiry })
}
