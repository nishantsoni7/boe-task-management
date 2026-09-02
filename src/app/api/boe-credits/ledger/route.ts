// GET /api/boe-credits/ledger?employee_id=...&limit=...
//
// One employee's BOE Credits: the available balance and the transaction
// history, newest first, in one round trip.
//
// An employee may ask about themselves and nobody else; an admin may ask about
// anyone. The employee id the query is constrained to comes from
// requireSelfOrAdmin — never from the query string directly — so a non-admin
// asking for a colleague gets the same 403 as asking for nobody. The route runs
// on the service role, which bypasses RLS, so this pin IS the boundary; the
// own-rows SELECT policy on boe_credit_transactions is the second line for any
// caller that reaches the table without going through here.

import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { getCreditBalance, getCreditTransactions, CreditServiceError, creditErrorStatus } from '@/lib/boeCredits/service'

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get('employee_id')
  const limitRaw  = req.nextUrl.searchParams.get('limit')
  const limit     = limitRaw == null ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    return NextResponse.json({ error: 'limit must be a positive number' }, { status: 400 })
  }

  const auth = await requireSelfOrAdmin(req, requested)
  if (isResponse(auth)) return auth
  const { caller, employeeId } = auth

  try {
    const [available, transactions] = await Promise.all([
      getCreditBalance(caller.svc, employeeId),
      getCreditTransactions(caller.svc, employeeId, { limit }),
    ])

    // Who posted each entry, resolved in one read rather than per row. A null
    // created_by is the system, and stays null.
    const actorIds = [...new Set(transactions.map(t => t.created_by).filter((v): v is string => v != null))]
    const names = new Map<string, string>()
    if (actorIds.length > 0) {
      const { data } = await caller.svc.from('users').select('id, full_name').in('id', actorIds)
      for (const u of (data ?? []) as { id: string; full_name: string }[]) names.set(u.id, u.full_name)
    }

    return NextResponse.json({
      employee_id: employeeId,
      available_credits: available,
      transactions: transactions.map(t => ({
        ...t,
        created_by_name: t.created_by ? names.get(t.created_by) ?? null : null,
      })),
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
