// POST /api/image-credits/allowance   (administrators only)
//
// { userId, monthlyCredits } sets one person's credits for each month (0 is allowed: switched on, nothing to spend).
// { userId, monthlyCredits: null } removes the person's allowance. Allowances only matter while limits are on.

import { NextResponse } from 'next/server'
import { creditCaller } from '@/lib/imageCredits/caller'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request) {
  const caller = await creditCaller(req, true)
  if (!caller.ok) return caller.response

  const body = (await req.json().catch(() => null)) as { userId?: unknown; monthlyCredits?: unknown } | null
  const credits = body?.monthlyCredits
  const valid = typeof body?.userId === 'string' && UUID.test(body.userId)
    && (credits === null || (typeof credits === 'number' && Number.isInteger(credits) && credits >= 0 && credits <= 1_000_000))
  if (!valid) return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 })

  const userId = body!.userId as string
  const { error } = credits === null
    ? await caller.svc.from('image_credit_allowances').delete().eq('user_id', userId)
    : await caller.svc.from('image_credit_allowances').upsert({
      user_id: userId, monthly_credits: credits as number, updated_by: caller.userId, updated_at: new Date().toISOString(),
    })
  if (error) {
    console.error('[image-credits/allowance] write failed:', error.message)
    return NextResponse.json({ error: 'The allowance could not be saved.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
