import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Public endpoint — no caller auth required.
// Returns only the salesperson name so the customer join page can show it.
// Uses service role to bypass RLS on the users table.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ user_id: string }> }
) {
  const { user_id } = await params

  // Basic UUID shape check before hitting the DB
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(user_id)) {
    return NextResponse.json({ error: 'Invalid QR code' }, { status: 400 })
  }

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data, error } = await serviceClient
    .from('users')
    .select('full_name, is_active, is_deleted')
    .eq('id', user_id)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Invalid QR code' }, { status: 404 })
  }

  if (!data.is_active || data.is_deleted) {
    return NextResponse.json({ error: 'Invalid QR code' }, { status: 404 })
  }

  // Return only the name — no id, no role, no sensitive fields
  return NextResponse.json({ full_name: data.full_name })
}
