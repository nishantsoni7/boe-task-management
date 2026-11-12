// GET /api/day-close/prompt   the strip on the Modules page: what the caller must do about their day now
// (file the plan, close the day). Silent for anybody not switched on. The caller's own, from the token.

import { NextRequest } from 'next/server'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { loadMyPrompt } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'prompt', caller => loadMyPrompt(caller))
}
