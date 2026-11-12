// The /api/day-close/* routes share one shape: the caller from the bearer token, the handler in
// src/lib/dayClose/server.ts, and a failed read answered 500 with the reason kept in the server log only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED, type Caller } from '@/lib/security/attendancePayrollApiAuth'
import type { Result } from './server'

export async function dayCloseRoute(
  req: NextRequest,
  label: string,
  run: (caller: Caller) => Promise<Result>,
): Promise<NextResponse> {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  try {
    const r = await run(caller)
    return NextResponse.json(r.body, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error(`[day-close/${label}]`, error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}

export async function jsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}
