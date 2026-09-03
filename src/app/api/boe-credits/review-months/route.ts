// GET  /api/boe-credits/review-months?month=YYYY-MM   — one month across every employee (admin)
// POST /api/boe-credits/review-months                  { review_month, employee_id? } — finalize (admin)
//
// THE MONTH CLOSE (Phase 1D). After a review month has ended, an administrator
// finalizes it: a month that reached the minimum stays qualified; a month
// below it lapses, with ONE ledger row removing exactly that month's still-valid
// reward credits. Nothing is scheduled — this is an explicit admin action, and
// it is idempotent: finalizing a finalized month changes nothing and posts
// nothing, under the per-employee lock and the ledger's one-row-per-source
// index.
//
// THE WARNING. Before closing, the GET says which employees still have
// SUBMITTED reviews attributed to that month — work handed over and not yet
// verified. Closing while those wait would lapse credits the employee may
// still earn. The screen shows the warning and requires the admin to close
// deliberately; nothing here classifies an unverified review as failed.
//
// Admin only, both verbs: a whole-company read, and a write that moves
// credits. requireAdmin resolves the caller from the bearer token; the
// database re-verifies the actor is an active admin before it writes.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import {
  getCreditReviewMonthsFor,
  finalizeReviewMonth,
  fetchActiveCreditSettings,
  CreditServiceError,
  creditErrorStatus,
} from '@/lib/boeCredits/service'
import { istToday, istMonthStart, istMonthStartOffset, istDayStartUtc, istMonthEnd, istDayEndUtc } from '@/lib/istDate'
import type { CreditReviewMonth } from '@/lib/boeCredits/types'

const MONTH_PARAM = /^\d{4}-(0[1-9]|1[0-2])$/

/** "YYYY-MM" → the first day, or null. */
function firstOfMonth(param: string | null): string | null {
  if (!param || !MONTH_PARAM.test(param)) return null
  return `${param}-01`
}

/** Submitted, live reviews attributed to the month, grouped by holder. */
async function unresolvedByEmployee(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  reviewMonth: string,
): Promise<Map<string, number>> {
  const from = istDayStartUtc(istMonthStart(reviewMonth))
  const to   = istDayEndUtc(istMonthEnd(reviewMonth))
  const { data, error } = await svc
    .from('customer_review_test_cards')
    .select('booked_by')
    .eq('status', 'submitted')
    .is('deleted_at', null)
    .gte('submitted_at', from)
    .lte('submitted_at', to)
  if (error) throw new Error(`unresolved reviews: ${error.message}`)
  const out = new Map<string, number>()
  for (const row of (data ?? []) as { booked_by: string | null }[]) {
    if (!row.booked_by) continue
    out.set(row.booked_by, (out.get(row.booked_by) ?? 0) + 1)
  }
  return out
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const today = istToday()
  // Default: the previous month — the one that has just ended and can be closed.
  const reviewMonth = firstOfMonth(req.nextUrl.searchParams.get('month')) ?? istMonthStartOffset(today, 1)
  const currentMonth = istMonthStart(today)

  try {
    const [months, unresolved, settings] = await Promise.all([
      getCreditReviewMonthsFor(svc, reviewMonth),
      unresolvedByEmployee(svc, reviewMonth).catch(err => {
        console.error('[boe-credits/review-months] unresolved reviews:', err)
        return new Map<string, number>()
      }),
      fetchActiveCreditSettings(svc),
    ])

    const employeeIds = [...new Set([...months.map(m => m.employee_id), ...unresolved.keys()])]
    const names = new Map<string, { full_name: string; employee_code: string | null }>()
    if (employeeIds.length > 0) {
      const { data } = await svc.from('users').select('id, full_name, employee_code').in('id', employeeIds)
      for (const u of (data ?? []) as { id: string; full_name: string; employee_code: string | null }[]) {
        names.set(u.id, { full_name: u.full_name, employee_code: u.employee_code ?? null })
      }
    }

    const byEmployee = new Map<string, CreditReviewMonth>(months.map(m => [m.employee_id, m]))
    const rows = employeeIds.map(id => {
      const m = byEmployee.get(id) ?? null
      return {
        employee_id: id,
        full_name: names.get(id)?.full_name ?? 'Unknown',
        employee_code: names.get(id)?.employee_code ?? null,
        month: m,
        unresolved_reviews: unresolved.get(id) ?? 0,
      }
    }).sort((a, b) => a.full_name.localeCompare(b.full_name))

    return NextResponse.json({
      review_month: reviewMonth,
      // A month can be finalized only once it has ended (IST).
      can_finalize: reviewMonth < currentMonth,
      minimum_monthly_reviews: settings.settings.minimum_monthly_reviews,
      rows,
      open_count: rows.filter(r => r.month?.status === 'open').length,
      unresolved_count: rows.reduce((n, r) => n + r.unresolved_reviews, 0),
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as { review_month?: unknown; employee_id?: unknown }
  const monthParam = typeof payload.review_month === 'string' ? payload.review_month.trim() : ''
  const reviewMonth = /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : firstOfMonth(monthParam || null)
  if (!reviewMonth) return NextResponse.json({ error: 'review_month must be YYYY-MM' }, { status: 400 })

  const onlyEmployee = typeof payload.employee_id === 'string' && payload.employee_id.trim() !== ''
    ? payload.employee_id.trim()
    : null

  try {
    // Every OPEN month row for the month (or the one named). Each employee is
    // finalized in its own database transaction under its own lock; a refusal
    // for one is reported and does not stop the rest.
    const months = (await getCreditReviewMonthsFor(svc, reviewMonth))
      .filter(m => onlyEmployee ? m.employee_id === onlyEmployee : m.finalized_at == null)

    const results: { employee_id: string; ok: boolean; status?: string; lapsed_credits?: number; already_finalized?: boolean; error?: string }[] = []
    for (const m of months) {
      try {
        const r = await finalizeReviewMonth(svc, { employeeId: m.employee_id, reviewMonth, actorId: auth.id })
        results.push({ employee_id: m.employee_id, ok: true, status: r.status, lapsed_credits: r.lapsed_credits, already_finalized: r.already_finalized })
      } catch (e) {
        const message = e instanceof CreditServiceError ? e.message : String(e)
        results.push({ employee_id: m.employee_id, ok: false, error: message })
        // A month that cannot be finalized at all (still open) stops the run:
        // every other employee would be refused for the same reason.
        if (e instanceof CreditServiceError && e.marker === 'BOE_CREDITS_MONTH_OPEN') break
      }
    }

    return NextResponse.json({
      review_month: reviewMonth,
      finalized: results.filter(r => r.ok && !r.already_finalized).length,
      lapsed_credits: results.reduce((n, r) => n + (r.lapsed_credits ?? 0), 0),
      results,
    })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
