import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { readUnmappedMinopIds } from '@/lib/minop/unmapped'

/**
 * Admin-only, read-only: machine IDs that have punched but are not set as any
 * employee's Machine ID. Never touches attendance or payroll.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  try {
    return NextResponse.json({ unmapped: await readUnmappedMinopIds(auth.svc) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read Minop punches' }, { status: 500 })
  }
}
