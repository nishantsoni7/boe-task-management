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

// There are exactly two shapes of authorisation here, and nothing in between:
//
//   requireAdmin        the whole-company screens and every write. Attendance
//                       and Payroll management is admins only — a Control Center
//                       visibility setting cannot widen it. See
//                       SELF_SERVICE_MODULE_KEYS in src/lib/moduleAccess.ts.
//
//   requireSelfOrAdmin  an employee's own record. A non-admin is pinned to
//                       caller.id, so asking for a colleague is not a request
//                       the route can express.
//
// A previous version had a third helper that widened self-service routes by
// module access, which let a Control Center "Custom" member read every
// employee's attendance. That is gone and must not return.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

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
): Promise<{ caller: Caller; employeeId: string; canReadAll: boolean } | NextResponse> {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  if (caller.isAdmin) {
    // An admin without an explicit target is asking about themselves.
    return { caller, employeeId: requestedEmployeeId ?? caller.id, canReadAll: true }
  }

  // Same 403 whether the id belongs to a real colleague, a deleted user or
  // nobody at all — the response must not confirm that a person exists.
  if (requestedEmployeeId && requestedEmployeeId !== caller.id) return FORBIDDEN()

  return { caller, employeeId: caller.id, canReadAll: false }
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse
}
