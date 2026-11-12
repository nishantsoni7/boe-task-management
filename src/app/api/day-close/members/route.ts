// GET  /api/day-close/members   everybody active, and who takes part in Day Close
// POST /api/day-close/members   { action: 'add' | 'remove', employee_id } | { action: 'add_everyone' }
//                               | { action: 'become_reviewer' } (an administrator, while nobody holds it)
// Administrators and the Day Close reviewer only.

import { NextRequest } from 'next/server'
import { dayCloseRoute, jsonBody } from '@/lib/dayClose/route'
import { changeMembers, loadMembers } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  return dayCloseRoute(req, 'members', caller => loadMembers(caller))
}

export async function POST(req: NextRequest) {
  const body = await jsonBody(req)
  return dayCloseRoute(req, 'members', caller => changeMembers(caller, body))
}
