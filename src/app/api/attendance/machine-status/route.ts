import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { readMachineHealth } from '@/lib/minop/machineHealth'

/**
 * Admin-only, read-only: whether the attendance machine is sending, for the
 * Modules launcher's For you card.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  try {
    return NextResponse.json(await readMachineHealth(auth.svc))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read the machine' }, { status: 500 })
  }
}
