import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// Deletes a specific set of notifications for the authenticated user.
// Body: { ids: string[] }
// Scoped strictly to user_id = caller — never touches another user's rows.
export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ids } = await req.json() as { ids: string[] }
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', user.id)
    .in('id', ids)

  if (error) {
    console.error('[notifications/delete-selected] failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
