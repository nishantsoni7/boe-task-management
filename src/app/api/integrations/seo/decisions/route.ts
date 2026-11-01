// GET /api/integrations/seo/decisions
//
// What people changed in BOE One, for the scheduled sessions to take back to the website folder before they send
// anything, so the folder's older copy never overwrites an edit or an answer. Same secret as the ingest door.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { refuseWithoutSeoSecret } from '@/lib/seo/doorSecret'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: Request) {
  const refusal = refuseWithoutSeoSecret(req)
  if (refusal) return refusal

  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const [items, proposals] = await Promise.all([
    svc.from('seo_plan_items').select('id, status, evidence, edited_at').not('edited_at', 'is', null),
    svc.from('seo_log').select('id, decision, decision_note, decided_at').eq('kind', 'proposal').not('decision', 'is', null),
  ])
  if (items.error || proposals.error) {
    console.error(`[seo/decisions] ${items.error?.message ?? proposals.error?.message}`)
    return NextResponse.json({ error: 'Could not read the decisions.' }, { status: 500 })
  }
  return NextResponse.json({
    items: items.data,
    proposals: proposals.data.map(p => ({ id: p.id, decision: p.decision, note: p.decision_note, decided_at: p.decided_at })),
  })
}
