// The one door for every Draft Orders (ClickUp) route (20270713000000): a
// signed-in Administrator. The table and the bucket have RLS on and no policy,
// so this check IS the authorization — nothing below it re-checks, and nothing
// reaches the data without passing it.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'

export const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

export const NOT_SET_UP = () =>
  fail(503, 'DRAFTS_NOT_SET_UP', 'Draft Orders is not set up on this database yet. Ask the owner to apply migration 20270713000000.')

/** The table is missing until the migration is applied (Postgres 42P01, PostgREST PGRST205). */
export const isMissing = (error: { code?: string } | null | undefined) =>
  error?.code === '42P01' || error?.code === 'PGRST205'

export async function requireDraftsAdmin(): Promise<
  { ok: true; userId: string; service: SupabaseClient } | { ok: false; response: NextResponse }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, response: fail(401, 'UNAUTHORIZED', 'Please sign in again.') }
  const { data: me } = await authClient.from('users').select('role').eq('id', user.id).single()
  if (me?.role !== 'admin') return { ok: false, response: fail(403, 'FORBIDDEN', 'Only an Administrator can open Draft Orders.') }
  const admin = adminClient()
  if (!admin.ok) return { ok: false, response: fail(500, 'SERVER_NOT_CONFIGURED', 'This is not configured on this deployment.') }
  return { ok: true, userId: user.id, service: admin.client }
}
