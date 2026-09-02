// GET /api/boe-credits/ledger?employee_id=...&limit=...
//
// One employee's BOE Credits in one round trip: the three balances (recorded,
// provisional, spendable), the transaction history newest first — each row
// explained in words, with the balance after it — and the review months the
// history belongs to.
//
// An employee may ask about themselves and nobody else; an admin may ask about
// anyone. The employee id the query is constrained to comes from
// requireSelfOrAdmin — never from the query string directly — so a non-admin
// asking for a colleague gets the same 403 as asking for nobody. The route runs
// on the service role, which bypasses RLS, so this pin IS the boundary; the
// own-rows SELECT policies are the second line for any caller that reaches the
// tables without going through here.
//
// WHY THE ROWS ARE EXPLAINED HERE. A ledger row carries a type, a source and
// the description written at posting time. The Phase 1C/1D record tables say
// what it was FOR — which day, which payroll month, which review month and
// whether that month has qualified — and those are read here in three batched
// lookups (never per row) so the screen shows "Half Day covered · 12 Aug" and
// "Pending monthly target" without ever seeing a database code.

import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import {
  getCreditBalance,
  getCreditTransactions,
  getCreditReviewMonths,
  getCreditReviewRewards,
  getCreditPayrollApplicationsByTransaction,
  getAttendanceRedemptionsByTransaction,
  CreditServiceError,
  creditErrorStatus,
} from '@/lib/boeCredits/service'
import {
  describeCreditTransaction,
  withRunningBalance,
  type CreditTransactionMeta,
} from '@/lib/boeCredits/ledger'
import type { CreditTransaction } from '@/lib/boeCredits/types'

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
  const svc = caller.svc

  try {
    const [balance, transactions, months] = await Promise.all([
      getCreditBalance(svc, employeeId),
      getCreditTransactions(svc, employeeId, { limit }),
      getCreditReviewMonths(svc, employeeId, 24),
    ])

    // The records behind the rows, in three batched reads plus one for names.
    const byId = new Map(transactions.map(t => [t.id, t]))
    const rewardIds     = transactions.filter(t => t.transaction_type === 'review_reward').map(t => t.id)
    const reversalOf    = transactions.filter(t => t.transaction_type === 'reversal' && t.source_id).map(t => t.source_id as string)
    const attendanceIds = transactions.filter(t => t.transaction_type === 'redemption' && t.source_type === 'attendance_redemption').map(t => t.id)
    const payrollIds    = transactions.filter(t => t.transaction_type === 'redemption' && t.source_type === 'payroll_redemption').map(t => t.id)
    // A reversal's original may be older than the page; its record is still
    // looked up by the original's transaction id.
    const originals = reversalOf.filter(id => !byId.has(id))
    const actorIds = [...new Set(transactions.map(t => t.created_by).filter((v): v is string => v != null))]

    const [rewards, applications, redemptions, olderOriginals, people] = await Promise.all([
      getCreditReviewRewards(svc, [...rewardIds, ...reversalOf]),
      getCreditPayrollApplicationsByTransaction(svc, [...payrollIds, ...reversalOf]),
      getAttendanceRedemptionsByTransaction(svc, [...attendanceIds, ...reversalOf]),
      originals.length > 0
        ? svc.from('boe_credit_transactions')
            .select('id, employee_id, transaction_type, credits, source_type, source_id, payroll_period_id, description, created_by, created_at')
            .eq('employee_id', employeeId)
            .in('id', originals)
        : Promise.resolve({ data: [] as CreditTransaction[] }),
      actorIds.length > 0
        ? svc.from('users').select('id, full_name').in('id', actorIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    ])
    for (const t of ((olderOriginals.data ?? []) as CreditTransaction[])) byId.set(t.id, t)

    // Payroll months for the payroll applications, one read.
    const periodIds = [...new Set(
      [...applications.values()].map(a => a.payroll_period_id),
    )]
    const periods = new Map<string, { payroll_month: number; payroll_year: number }>()
    if (periodIds.length > 0) {
      const { data } = await svc.from('payroll_periods').select('id, payroll_month, payroll_year').in('id', periodIds)
      for (const p of (data ?? []) as { id: string; payroll_month: number; payroll_year: number }[]) {
        periods.set(p.id, { payroll_month: p.payroll_month, payroll_year: p.payroll_year })
      }
    }

    const reversed = new Set(reversalOf)
    const monthsById = new Map(months.map(m => [m.id, m]))
    const names = new Map<string, string>()
    for (const u of ((people.data ?? []) as { id: string; full_name: string }[])) names.set(u.id, u.full_name)

    const metaFor = (t: CreditTransaction): CreditTransactionMeta => {
      switch (t.transaction_type) {
        case 'review_reward': {
          const r = rewards.get(t.id)
          const m = r ? monthsById.get(r.review_month_id) : undefined
          return {
            kind: 'review_reward',
            card_ref: r?.card_ref ?? null,
            review_month: r?.review_month ?? null,
            // A reward with no record predates Phase 1D: it belongs to no month
            // and is simply available.
            month_status: r ? (m?.status ?? 'open') : 'qualified',
            reversed: reversed.has(t.id),
          }
        }
        case 'redemption': {
          const a = applications.get(t.id)
          if (a) {
            const p = periods.get(a.payroll_period_id)
            return {
              kind: 'payroll_redemption',
              payroll_month: p?.payroll_month ?? null,
              payroll_year: p?.payroll_year ?? null,
              credit_amount: a.credit_amount_snapshot,
              reversed: a.reversal_transaction_id != null,
            }
          }
          const d = redemptions.get(t.id)
          if (d) {
            return { kind: 'attendance_redemption', deduction_type: d.deduction_type, attendance_date: d.attendance_date, reversed: d.reversal_transaction_id != null }
          }
          return { kind: 'none' }
        }
        case 'reversal': {
          const original = t.source_id ? byId.get(t.source_id) : undefined
          return {
            kind: 'reversal_of',
            original_type: original?.transaction_type ?? null,
            original: original ? metaFor(original) : null,
          }
        }
        case 'review_month_lapse': {
          const m = t.source_id ? monthsById.get(t.source_id) : undefined
          return { kind: 'review_month_lapse', review_month: m?.review_month ?? null }
        }
        default:
          return { kind: 'none' }
      }
    }

    const rows = withRunningBalance(transactions, balance.available_credits).map(t => {
      const meta = metaFor(t)
      const described = describeCreditTransaction(t, meta)
      return {
        ...t,
        created_by_name: t.created_by ? names.get(t.created_by) ?? null : null,
        title: described.title,
        detail: described.detail,
        status: described.status,
      }
    })

    return NextResponse.json({
      employee_id: employeeId,
      // The three figures. `available_credits` is the RECORDED total, kept
      // under its Phase 1A name; `spendable_credits` is what may be spent.
      available_credits:   balance.available_credits,
      provisional_credits: balance.provisional_credits,
      spendable_credits:   balance.spendable_credits,
      transactions: rows,
      review_months: months,
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
