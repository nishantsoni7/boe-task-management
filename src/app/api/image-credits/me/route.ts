// GET /api/image-credits/me
//
// What the signed-in person can still do, for the small note beside the picture buttons. While limits are off
// (the shipped state) the answer is just { enforce: false } and the note shows nothing.
//
// Spends nothing and calls nobody. Any failure answers { enforce: false }: the note is a courtesy, the press
// routes are what enforce.

import { NextResponse } from 'next/server'
import { creditCaller } from '@/lib/imageCredits/caller'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const caller = await creditCaller(req)
  if (!caller.ok) return caller.response

  const { data, error } = await caller.svc.rpc('image_credit_status', { p_user: caller.userId })
  if (error || !data) return NextResponse.json({ enforce: false })
  return NextResponse.json(data)
}
