// The database read behind the payslip's review credits card.
//
// Kept apart from reviewCredits.ts (pure: the types, the builder, the wording)
// the way settlement.ts is kept apart from settlementStore.ts, so the card and
// the payslip view, which run in the browser, import none of the credits service.

import { getCreditBalance } from '@/lib/boeCredits/service'
import { buildPayslipReviewCredits, type PayslipReviewCreditsBlock, type PayslipReviewType } from './reviewCredits'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

function fail(what: string, error: { message?: string }): never {
  throw new Error(`${what}: ${error.message ?? 'unknown error'}`)
}

/**
 * Reads one employee's review credits for a payroll month. Throws on a read
 * error; the payload builder catches it, because a payslip must open even when
 * this explanation cannot be built.
 *
 * Trusts its caller for authority: the employee id has already been pinned by
 * the route (admin, or the caller's own token), exactly like the rest of the
 * payload.
 */
export async function fetchPayslipReviewCredits(
  svc: Svc,
  input: {
    employeeId: string
    month: number
    year: number
    creditValue: number
  },
): Promise<PayslipReviewCreditsBlock | null> {
  const reviewMonth = `${input.year}-${String(input.month).padStart(2, '0')}-01`

  const { data: rewards, error: rErr } = await svc
    .from('boe_credit_review_rewards')
    .select('transaction_id, card_id, card_ref, submitted_at')
    .eq('employee_id', input.employeeId)
    .eq('review_month', reviewMonth)
  if (rErr) fail('Could not read the review rewards', rErr)
  if (!rewards || rewards.length === 0) return null

  const txIds   = rewards.map((r: { transaction_id: string }) => r.transaction_id)
  const cardIds = rewards.map((r: { card_id: string }) => r.card_id)

  const [ledgerRead, reversalRead, typeRead, monthRead, balance] = await Promise.all([
    svc.from('boe_credit_transactions').select('id, credits').in('id', txIds),
    svc.from('boe_credit_transactions').select('source_id').eq('transaction_type', 'reversal').in('source_id', txIds),
    svc.from('customer_review_custom_submissions').select('id, review_type').in('id', cardIds),
    svc.from('boe_credit_review_months')
      .select('status, qualifying_review_count, minimum_reviews_snapshot')
      .eq('employee_id', input.employeeId)
      .eq('review_month', reviewMonth)
      .maybeSingle(),
    getCreditBalance(svc, input.employeeId),
  ])
  if (ledgerRead.error)   fail('Could not read the credit ledger', ledgerRead.error)
  if (reversalRead.error) fail('Could not read the credit reversals', reversalRead.error)
  if (typeRead.error)     fail('Could not read the review types', typeRead.error)
  if (monthRead.error)    fail('Could not read the review month', monthRead.error)

  return buildPayslipReviewCredits({
    reviewMonth,
    rewards,
    ledger: new Map((ledgerRead.data ?? []).map((t: { id: string; credits: number | string }) => [t.id, { credits: Number(t.credits) }])),
    reversedIds: new Set((reversalRead.data ?? []).map((t: { source_id: string }) => t.source_id)),
    reviewTypes: new Map((typeRead.data ?? []).map((s: { id: string; review_type: PayslipReviewType }) => [s.id, s.review_type])),
    month: monthRead.data
      ? {
          status: monthRead.data.status,
          qualifying_review_count: Number(monthRead.data.qualifying_review_count),
          minimum_reviews_snapshot: Number(monthRead.data.minimum_reviews_snapshot),
        }
      : null,
    creditValue: input.creditValue,
    balance,
  })
}
