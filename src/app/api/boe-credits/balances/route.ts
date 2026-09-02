// GET /api/boe-credits/balances
//
// Every employee's available BOE Credits, for the management screen. Admin
// only, through the same requireAdmin the rest of the payroll API uses: this
// is a whole-company read, and Attendance/Payroll management is admins only by
// an explicit product decision that a Control Center visibility setting cannot
// widen. The service role bypasses RLS, so requireAdmin here IS the boundary;
// can_manage_boe_credits() in the SELECT policy is the second line.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { getAllCreditBalances, CreditServiceError, creditErrorStatus } from '@/lib/boeCredits/service'

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  try {
    const balances = await getAllCreditBalances(auth.svc)
    return NextResponse.json({ balances })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
