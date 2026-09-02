// POST /api/boe-credits/adjustments
//   { employee_id, credits, reason }
//
// An administrator's correction to one employee's BOE Credits: a signed whole
// number of credits and a mandatory reason. It posts ONE new admin_adjustment
// row to the ledger; nothing is edited and nothing is deleted, because the
// ledger is append-only and corrections are counter-entries.
//
// Admin only, through requireAdmin. The actor recorded on the row is the
// caller resolved from the bearer token — never anything in the body — and
// post_boe_credit_transaction() re-verifies that actor is an active admin
// before it writes, so the database refuses this even if the route were
// bypassed. No browser session can call the posting function at all: EXECUTE
// is granted to the service role alone.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { postAdminAdjustment, getCreditBalance, CreditServiceError, creditErrorStatus } from '@/lib/boeCredits/service'
import { creditAmountIssue, creditReasonIssue } from '@/lib/boeCredits/ledger'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as { employee_id?: unknown; credits?: unknown; reason?: unknown }

  const employeeId = typeof payload.employee_id === 'string' ? payload.employee_id.trim() : ''
  if (!employeeId) return NextResponse.json({ error: 'employee_id is required' }, { status: 400 })

  // Validated with the SAME functions the form uses, so the form cannot accept
  // something the server will reject, or refuse something it would allow.
  const credits = typeof payload.credits === 'string' ? Number(payload.credits.trim()) : payload.credits
  const amountIssue = creditAmountIssue(credits)
  if (amountIssue) return NextResponse.json({ error: amountIssue }, { status: 422 })

  const reasonIssue = creditReasonIssue(payload.reason)
  if (reasonIssue) return NextResponse.json({ error: reasonIssue }, { status: 422 })
  const reason = (payload.reason as string).trim()

  try {
    const { id } = await postAdminAdjustment(auth.svc, {
      employeeId,
      credits: credits as number,
      reason,
      // From the token, never from the body.
      actorId: auth.id,
    })
    const available = await getCreditBalance(auth.svc, employeeId)
    return NextResponse.json({ transaction_id: id, employee_id: employeeId, available_credits: available })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
