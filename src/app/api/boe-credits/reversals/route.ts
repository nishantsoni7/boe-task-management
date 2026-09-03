// POST /api/boe-credits/reversals
//   { transaction_id, reason }
//
// An administrator's reversal of ONE ledger row — the way an individual
// review's reward is withdrawn when the review turns out not to count. It
// posts ONE compensating 'reversal' row through reverse_boe_credit_transaction();
// the original is never edited, and the database allows exactly one reversal
// per row.
//
// WHAT THE DATABASE DECIDES on top of that (Phase 1D): a reward whose review
// month has LAPSED cannot be reversed (its credit is already gone with the
// lapse); a redemption inside a LOCKED payroll month cannot be reversed; a
// reward reversed before its month is finalized stops counting toward the
// month; a reward reversed after a qualified month closed does not reopen it.
//
// Admin only, through requireAdmin. The actor recorded on the row is the
// caller resolved from the bearer token — never anything in the body — and
// the posting function re-verifies that actor is an active admin.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { reverseCreditTransaction, getCreditBalance, CreditServiceError, creditErrorStatus } from '@/lib/boeCredits/service'
import { creditReasonIssue } from '@/lib/boeCredits/ledger'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as { transaction_id?: unknown; reason?: unknown }
  const transactionId = typeof payload.transaction_id === 'string' ? payload.transaction_id.trim() : ''
  if (!transactionId) return NextResponse.json({ error: 'transaction_id is required' }, { status: 400 })

  const reasonIssue = creditReasonIssue(payload.reason)
  if (reasonIssue) return NextResponse.json({ error: reasonIssue }, { status: 422 })
  const reason = (payload.reason as string).trim()

  // The row's owner, so the response can carry their balance afterwards. The
  // route runs on the service role; requireAdmin above IS the boundary.
  const { data: original } = await auth.svc
    .from('boe_credit_transactions')
    .select('id, employee_id')
    .eq('id', transactionId)
    .maybeSingle()
  if (!original) return NextResponse.json({ error: 'That credit entry does not exist.' }, { status: 404 })

  try {
    const { id } = await reverseCreditTransaction(auth.svc, {
      transactionId,
      reason,
      // From the token, never from the body.
      actorId: auth.id,
    })
    const balance = await getCreditBalance(auth.svc, (original as { employee_id: string }).employee_id)
    return NextResponse.json({
      reversal_transaction_id: id,
      employee_id: (original as { employee_id: string }).employee_id,
      available_credits:   balance.available_credits,
      provisional_credits: balance.provisional_credits,
      spendable_credits:   balance.spendable_credits,
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message, marker: e.marker }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
