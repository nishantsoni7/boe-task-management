// Who is asking, for the picture-credit routes. SERVER ONLY.
//
// The pages that show credits sign in two ways: Studio Image sends a bearer token, the quotation builder and Edit PI
// send the session cookie. Both are accepted here, so one note component works in all three places.
// `adminOnly` is the founders' tracking page and its settings: the admin role, nothing broader.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient, type AdminSupabaseClient } from '@/lib/supabase/admin'
import { isAdminRole } from '@/lib/permissions/moduleVisibility'

export type CreditCaller =
  | { ok: true; userId: string; svc: AdminSupabaseClient }
  | { ok: false; response: NextResponse }

const refuse = (error: string, status: number): { ok: false; response: NextResponse } =>
  ({ ok: false, response: NextResponse.json({ error }, { status }) })

export async function creditCaller(req: Request, adminOnly = false): Promise<CreditCaller> {
  const admin = adminClient()
  if (!admin.ok) return refuse('Picture credits are not available on this deployment.', 503)
  const svc = admin.client

  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const { data: { user } } = token ? await svc.auth.getUser(token) : await (await createClient()).auth.getUser()
  if (!user) return refuse('Unauthorized', 401)

  const { data: profile } = await svc.from('users').select('role').eq('id', user.id).maybeSingle()
  if (!profile) return refuse('Unauthorized', 401)
  if (adminOnly && !isAdminRole(profile.role)) return refuse('Only an administrator can open this.', 403)

  return { ok: true, userId: user.id, svc }
}
