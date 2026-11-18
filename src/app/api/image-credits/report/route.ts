// GET /api/image-credits/report   (administrators only)
//
// Everything the tracking page shows: fal's balance, the settings, the allowances, and spend by day, person and
// tool. Reads only; spends nothing. The fal balance needs FAL_BILLING_KEY and is "not connected" without it.

import { NextResponse } from 'next/server'
import { creditCaller } from '@/lib/imageCredits/caller'
import { readFalBalance } from '@/lib/imageCredits/falBalance'
import type { CreditReport } from '@/lib/imageCredits/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const caller = await creditCaller(req, true)
  if (!caller.ok) return caller.response
  const { svc } = caller

  const [report, settings, allowances, users, balance] = await Promise.all([
    svc.rpc('image_credit_report', { p_days: 14 }),
    svc.from('image_credit_settings').select('enabled, enforce, monthly_pool, daily_cap, inr_per_usd').eq('id', true).single(),
    svc.from('image_credit_allowances').select('user_id, monthly_credits'),
    svc.from('users').select('id, full_name, is_active'),
    readFalBalance(),
  ])

  if (report.error || settings.error || allowances.error || users.error) {
    console.error('[image-credits/report] read failed:', report.error?.message ?? settings.error?.message ?? allowances.error?.message ?? users.error?.message)
    return NextResponse.json({ error: 'The picture credit numbers could not be loaded.' }, { status: 500 })
  }

  const staff = (users.data ?? []) as { id: string; full_name: string | null; is_active: boolean | null }[]
  return NextResponse.json({
    report: report.data as CreditReport,
    settings: settings.data,
    allowances: allowances.data ?? [],
    // Names for everyone who appears; the dropdown offers active staff only.
    names: Object.fromEntries(staff.map(u => [u.id, u.full_name ?? 'Unnamed'])),
    staff: staff.filter(u => u.is_active).map(u => ({ id: u.id, name: u.full_name ?? 'Unnamed' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    balance,
  })
}
