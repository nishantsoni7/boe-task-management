// POST /api/image-credits/settings   (administrators only)
//
// { enabled?, enforce?, monthlyPool?, dailyCap?, inrPerUsd? } : any of them. `enabled` is the pause switch,
// `enforce` turns the limits on (until then every press is recorded and none is refused).

import { NextResponse } from 'next/server'
import { creditCaller } from '@/lib/imageCredits/caller'

export const runtime = 'nodejs'

const whole = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

export async function POST(req: Request) {
  const caller = await creditCaller(req, true)
  if (!caller.ok) return caller.response

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  const bad = (what: string) => NextResponse.json({ error: `${what} is not a valid value.` }, { status: 400 })

  for (const key of ['enabled', 'enforce'] as const) {
    if (!(key in body)) continue
    if (typeof body[key] !== 'boolean') return bad(key)
    patch[key] = body[key]
  }
  if ('monthlyPool' in body) { const v = whole(body.monthlyPool, 0, 1_000_000); if (v === null) return bad('The monthly pool'); patch.monthly_pool = v }
  if ('dailyCap' in body) { const v = whole(body.dailyCap, 1, 10_000); if (v === null) return bad('The daily cap'); patch.daily_cap = v }
  if ('inrPerUsd' in body) {
    const v = body.inrPerUsd
    if (typeof v !== 'number' || !(v >= 1 && v <= 1000)) return bad('The rupees per dollar')
    patch.inr_per_usd = Math.round(v * 100) / 100
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

  const { error } = await caller.svc.from('image_credit_settings')
    .update({ ...patch, updated_by: caller.userId, updated_at: new Date().toISOString() }).eq('id', true)
  if (error) {
    console.error('[image-credits/settings] write failed:', error.message)
    return NextResponse.json({ error: 'The setting could not be saved.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
