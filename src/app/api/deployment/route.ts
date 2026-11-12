// GET /api/deployment — which deployment is live, so a tab left open across a
// deploy can refresh itself before the next click (src/lib/navigation/tabRecovery.ts).
// Public, tiny, never cached. It reveals only the deployment id, which every
// page already carries in its script URLs (?dpl=…).

import { NextResponse } from 'next/server'
import { parseDeploymentId } from '@/lib/navigation/tabRecovery'

export const dynamic = 'force-dynamic'

export function GET() {
  const id = parseDeploymentId(process.env.VERCEL_DEPLOYMENT_ID ?? process.env.NEXT_DEPLOYMENT_ID ?? null)
  return NextResponse.json({ id }, { headers: { 'cache-control': 'no-store' } })
}
