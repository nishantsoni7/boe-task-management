// Who may touch a stored result, and with what client.
//
// SERVER ONLY. Imports the service-role key; never reachable from a bundle.
//
// WHY THE GRANT HERE IS `view`, NOT `view AND create`
// ---------------------------------------------------
// `create` authorizes SPENDING — two billable provider requests per press. The
// studio route checks both because generating costs money. Reading, keeping and
// deleting your OWN already-generated results costs nothing and spends nothing,
// so requiring `create` for them would mean an employee whose Use access was
// withdrawn could no longer reach — or delete — work they had already made.
// That is the wrong answer for a retention feature: the whole point of Delete
// is that a person can get rid of their own material.
//
// So: module entry (`view`) is the gate, and ownership does the rest.
//
// THE SERVICE ROLE, AND WHY OWNERSHIP IS STILL FILTERED IN CODE
// -------------------------------------------------------------
// These routes act with the service role, which BYPASSES row-level security
// entirely. The `user_id = auth.uid()` policies in 20261022000000 therefore do
// NOT protect these routes — they protect the bucket and the table from
// everything else. Inside a route, the `.eq('user_id', userId)` on every query
// is the only thing standing between one employee and another's pictures, and
// it is load-bearing rather than defensive. Every query below has one.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { hasPermission } from '@/lib/permissions/resolver'
import { isAdminRole } from '@/lib/permissions/moduleVisibility'
import { IMAGE_EDITOR_MODULE_KEY } from '@/lib/permissions/imageEditor'

/** Said to somebody without module entry. Same wording the launcher uses. */
export const HISTORY_FORBIDDEN =
  'You do not have permission to use the Image Editor. Ask an administrator for access.'

/** Said instead of "that is not yours". A 404 rather than a 403 on purpose: a
 *  403 would confirm that the id exists, which is a small leak but a real one
 *  when the ids are the only thing separating two people's histories. */
export const NOT_FOUND = 'That result no longer exists.'

export type Authorized = {
  ok: true
  userId: string
  svc: SupabaseClient
}

export type Unauthorized = {
  ok: false
  response: NextResponse
}

/** A service-role client. Bypasses RLS — see the note at the top of this file. */
export function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Resolve the bearer token to a BOE user who may open the Image Editor.
 *
 * The token is resolved SERVER-SIDE against Supabase and then confirmed against
 * the `users` table, exactly as the studio route does: a valid auth token for
 * somebody who is not a BOE user is not a caller.
 */
export async function authorizeHistoryCaller(
  req: Request,
): Promise<Authorized | Unauthorized> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const svc = serviceClient()

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile } = await svc.from('users').select('id, role').eq('id', user.id).single()
  if (!profile) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const allowed = isAdminRole(profile.role)
    ? true
    : Boolean(profile.role) &&
      await hasPermission(svc, user.id, IMAGE_EDITOR_MODULE_KEY, 'view')

  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: HISTORY_FORBIDDEN }, { status: 403 }),
    }
  }

  return { ok: true, userId: user.id, svc }
}
