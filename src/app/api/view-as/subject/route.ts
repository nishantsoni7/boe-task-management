/**
 * GET /api/view-as/subject?userId=<employee>
 *
 * The display subject's interface, resolved SERVER-SIDE.
 *
 * Returns the profile and the effective permissions of the employee an
 * administrator is previewing, so the launcher, the route guards, the sidebar
 * and the badges can all render that person's screen from one authorized
 * answer instead of each asking the database for somebody else's permissions
 * on their own authority.
 *
 * WHY THIS IS A ROUTE AND NOT A CLIENT QUERY. The client could call
 * resolve_effective_permissions_for_user(<any id>) directly — it is
 * SECURITY DEFINER and takes a user id — and DashboardLayout's View As branch
 * did exactly that. That places the "may this person preview that person"
 * decision in the browser, which is where it must never be. Here the decision is
 * made from the session:
 *
 *   1. authenticated caller           auth.getUser() on the session cookie
 *   2. caller may use View As         users.role = 'admin', active, not deleted
 *   3. subject exists and is eligible active, not deleted
 *   4. scope                          profile + effective permissions, and
 *                                     nothing else — no salary, no phone, no
 *                                     private column, no other employee's data
 *
 * Nothing in the request body or query string is trusted as authorization. The
 * `userId` parameter says WHICH employee is wanted; whether that is allowed is
 * decided entirely from the caller's own row.
 *
 * READ-ONLY. There is no POST, PUT, PATCH or DELETE here, and this route grants
 * no authority of any kind — it returns a description of an interface.
 */

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { getEffectivePermissionsForUser } from '@/lib/permissions/resolver'
import { resolveViewAsSubject } from '@/lib/viewAs'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { isValidUUID } from '@/lib/ui'

export async function GET(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requested = req.nextUrl.searchParams.get('userId')
  // Reject a malformed id before it reaches a query, rather than letting
  // PostgREST answer with a 400 that says more about the schema than the caller
  // needs to know.
  if (requested !== null && !isValidUUID(requested)) {
    return NextResponse.json({ error: 'Invalid userId' }, { status: 400 })
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const decision = await resolveViewAsSubject(svc, user.id, requested)
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: decision.status })
  }

  const [{ data: profile }, permissions] = await Promise.all([
    svc.from('users').select(USER_PROFILE_COLUMNS).eq('id', decision.subjectId).maybeSingle(),
    getEffectivePermissionsForUser(svc, decision.subjectId).catch(() => new Map()),
  ])

  if (!profile) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // Serialised as a plain object because a Map does not survive JSON. The shape
  // matches what usePermissionContext already hands every display helper, so the
  // subject's interface is derived by exactly the same functions as the actor's
  // — there is no second, View-As-only permission engine.
  const permissionsByModule: Record<string, { actionKey: string; allowed: boolean; source: string }[]> = {}
  for (const [moduleKey, list] of permissions.entries()) permissionsByModule[moduleKey] = [...list]

  return NextResponse.json({
    subject: profile,
    permissionsByModule,
    /** False when the caller resolved themselves — the ordinary, non-preview case. */
    isPreview: decision.isPreview,
  })
}
