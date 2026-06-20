import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Public endpoint — no caller auth required.
// Returns a single active product by product_code for the customer product page.
// Uses service role to read the products table regardless of RLS active-filter.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ product_code: string }> }
) {
  const { product_code } = await params
  const code = decodeURIComponent(product_code).toUpperCase().trim()

  if (!code) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data, error } = await serviceClient
    .from('showroom_products')
    .select('id, product_code, name, category, description, specifications, image_url, mrp, is_active')
    .eq('product_code', code)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  // Inactive products must not be visible to customers
  if (!data.is_active) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  return NextResponse.json({ product: data })
}
