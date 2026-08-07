// Server-side identity and authorisation for the attendance and payroll API
// routes.
//
// Every one of those routes runs on the SERVICE ROLE, which bypasses RLS
// entirely. That is intentional — attendance import, payroll generation and the
// day-level views all need to read across employees — but it means the route
// itself is the whole boundary. A service-role route that takes an employee id
// from the query string and does not check who is asking is a full read of
// everybody's attendance, whatever the RLS policies say.
//
// So the rule these helpers exist to enforce is: the caller's identity comes
// from the bearer token, never from the request body or query string. A
// client-supplied employee id is only ever a *filter*, and it is authorised
// against the token before it reaches a query.
//
// Responses are deliberately flat 401/403 with no detail. "Employee not found"
// and "not your employee" must not be distinguishable, or the error itself
// becomes a way to enumerate who exists.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { resolveModuleAccess } from '@/lib/moduleAccess'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceClient = SupabaseClient<any, any, any>

export type Caller = {
  svc:     ServiceClient
  id:      string
  role:    string
  team:    string | null
  isAdmin: boolean
}

export function serviceClient(): ServiceClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Resolve the caller from the Authorization header. Returns null when there is
 * no usable session or no profile — the route turns that into a 401.
 */
export async function resolveCaller(req: NextRequest): Promise<Caller | null> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null

  const svc = serviceClient()
  const { data: { user }, error } = await svc.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await svc.from('users').select('role, team').eq('id', user.id).single()
  if (!profile) return null

  const role = String(profile.role)
  const team = profile.team == null ? null : String(profile.team)
  return { svc, id: user.id, role, team, isAdmin: role === 'admin' }
}

export const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
export const FORBIDDEN    = () => NextResponse.json({ error: 'Forbidden' },    { status: 403 })

/** Admin-only route. Returns the caller, or the response to send back. */
export async function requireAdmin(req: NextRequest): Promise<Caller | NextResponse> {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  if (!caller.isAdmin) return FORBIDDEN()
  return caller
}

/**
 * Whether this caller may open a module, decided by exactly the rule the
 * launcher and the client route guard use — src/lib/moduleAccess.ts.
 *
 * The point of routing this through the shared resolver rather than restating
 * `role === 'admin'` here is that a card, a route guard and the API behind them
 * must never be able to disagree: the launcher only shows what the route will
 * open, and the route only opens what the API will answer. Control Center's
 * Custom mode names members individually, and this is what makes that grant
 * real rather than cosmetic.
 *
 * A missing app_modules row denies. These modules are always seeded, so no row
 * means the registry is not in the state this code expects, and that is not a
 * moment to hand out the company's attendance.
 */
export async function callerCanAccessModule(caller: Caller, moduleKey: string): Promise<boolean> {
  if (caller.isAdmin) return true

  const { data: mod } = await caller.svc
    .from('app_modules')
    .select('visibility_type, allowed_department, allowed_user_ids')
    .eq('module_key', moduleKey)
    .single()

  return resolveModuleAccess(
    moduleKey,
    mod,
    { id: caller.id, role: caller.role, team: caller.team },
    false,
  )
}

/**
 * A route that serves a module's whole-company screens. Admin, or a member the
 * module has been explicitly granted to.
 *
 * This replaces requireAdmin on the READ routes only. Every route that writes —
 * attendance import, payroll generation, locking, unlocking, adjustments and
 * attendance corrections — stays admin-only, because module access is
 * permission to look at payroll, not permission to move money.
 */
export async function requireModuleAccess(
  req: NextRequest,
  moduleKey: string,
): Promise<Caller | NextResponse> {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  if (!(await callerCanAccessModule(caller, moduleKey))) return FORBIDDEN()
  return caller
}

/**
 * A route an employee may call for their own data and an admin may call for
 * anyone's. Returns the employee id the query must be constrained to — never
 * the raw parameter.
 *
 * A missing employee id means "mine" for an employee, and is rejected for an
 * admin only if the route needs one; callers decide by passing `required`.
 */
export async function requireSelfOrAdmin(
  req: NextRequest,
  requestedEmployeeId: string | null,
): Promise<{ caller: Caller; employeeId: string } | NextResponse> {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  if (caller.isAdmin) {
    // An admin without an explicit target is asking about themselves.
    return { caller, employeeId: requestedEmployeeId ?? caller.id }
  }

  // Same 403 whether the id belongs to a real colleague, a deleted user or
  // nobody at all — the response must not confirm that a person exists.
  if (requestedEmployeeId && requestedEmployeeId !== caller.id) return FORBIDDEN()

  return { caller, employeeId: caller.id }
}

/**
 * Same contract as requireSelfOrAdmin, widened by module access: a member the
 * module has been granted to may query anyone, exactly as an admin can. Anyone
 * else is still pinned to their own id, so a cross-employee read remains
 * inexpressible rather than merely refused.
 */
export async function requireSelfOrModuleAccess(
  req: NextRequest,
  moduleKey: string,
  requestedEmployeeId: string | null,
): Promise<{ caller: Caller; employeeId: string; canReadAll: boolean } | NextResponse> {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  const canReadAll = await callerCanAccessModule(caller, moduleKey)
  if (canReadAll) {
    return { caller, employeeId: requestedEmployeeId ?? caller.id, canReadAll }
  }

  if (requestedEmployeeId && requestedEmployeeId !== caller.id) return FORBIDDEN()
  return { caller, employeeId: caller.id, canReadAll }
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse
}
