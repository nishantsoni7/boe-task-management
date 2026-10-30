import { NextRequest, NextResponse } from 'next/server'
import { istToday } from '@/lib/istDate'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { isMachineDayParam, readMachineDay } from '@/lib/minop/machineDayView'

/**
 * Admin-only, read-only: one day on the attendance machine, for the Today tab.
 * `?date=YYYY-MM-DD`, today when left out. Never touches attendance or payroll.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const today = istToday()
  const date = req.nextUrl.searchParams.get('date') ?? today
  if (!isMachineDayParam(date, today)) {
    return NextResponse.json({ error: 'Pick a day the machine covers.' }, { status: 400 })
  }

  try {
    return NextResponse.json(await readMachineDay(auth.svc, date))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read the machine day' }, { status: 500 })
  }
}
