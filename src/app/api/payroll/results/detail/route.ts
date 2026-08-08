// GET /api/payroll/results/detail?period_id=...&employee_id=...
//
// The ADMIN view of one employee's payroll result: the stored totals, the
// deduction ledger, and the day-level breakdown recomputed from the engine.
//
// Admin-only. The employee's own view of the same document is served by
// /api/payroll/my-result, which substitutes the caller's id and cannot be
// pointed at anyone else — both build their payload from the same module, so
// the two readers can never drift apart.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { canCorrectAttendance } from '@/lib/payroll/correctionRules'
import { buildResultDetailPayload } from '@/lib/payroll/resultDetailPayload'

export async function GET(req: NextRequest) {
  const periodId   = req.nextUrl.searchParams.get('period_id')
  const employeeId = req.nextUrl.searchParams.get('employee_id')
  if (!periodId || !employeeId)
    return NextResponse.json({ error: 'period_id and employee_id are required' }, { status: 400 })

  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  // The period's own status decides whether correcting is possible at all, so
  // the permission is resolved before the payload is built.
  const { data: period } = await svc
    .from('payroll_periods')
    .select('status')
    .eq('id', periodId)
    .maybeSingle()

  const permission = canCorrectAttendance(auth.role, period?.status)

  const outcome = await buildResultDetailPayload(svc, {
    periodId,
    employeeId,
    canEdit:     permission.allowed,
    editBlocked: permission.allowed ? null : permission.message,
  })

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  return NextResponse.json(outcome.payload)
}
