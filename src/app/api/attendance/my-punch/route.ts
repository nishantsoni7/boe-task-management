import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { readPunchStrip } from '@/lib/minop/punchStrip'

/**
 * The punch-in strip on the Modules page: the signed-in person's OWN punch today
 * and nothing else. It takes no employee id, no query string and no body: the id
 * comes from the bearer token, so asking about a colleague is not a request this
 * route can express. Read-only; it never touches attendance or payroll.
 */
export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()

  try {
    return NextResponse.json(await readPunchStrip(caller.svc, caller.id), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    // The page shows nothing when this fails; keep the reason in the server log only.
    console.error('[attendance/my-punch]', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'Could not read your punch' }, { status: 500 })
  }
}
