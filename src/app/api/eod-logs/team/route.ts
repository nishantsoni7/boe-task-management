import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function getCallerProfile(token: string) {
  const client = sb()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null
  const { data } = await client.from('users').select('id, role').eq('id', user.id).single()
  return data as { id: string; role: string } | null
}

// GET /api/eod-logs/team?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['admin', 'manager'].includes(caller.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const today = new Date().toISOString().slice(0, 10)
  const from = searchParams.get('from') ?? today
  const to   = searchParams.get('to')   ?? today

  const fromDate = new Date(from)
  const toDate   = new Date(to)
  const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return NextResponse.json({ error: 'from must be ≤ to' }, { status: 400 })
  if (diffDays > 30) return NextResponse.json({ error: 'Range cannot exceed 30 days' }, { status: 400 })

  const client = sb()

  const [{ data: logs, error: logsErr }, { data: users, error: usersErr }] = await Promise.all([
    client
      .from('daily_work_logs')
      .select('user_id, log_date, summary, highlights, self_score, created_at')
      .gte('log_date', from)
      .lte('log_date', to)
      .order('log_date', { ascending: false })
      .order('created_at', { ascending: false }),
    client
      .from('users')
      .select('id, full_name, team, position')
      .eq('is_active', true)
      .eq('is_deleted', false),
  ])

  if (logsErr)  return NextResponse.json({ error: logsErr.message },  { status: 500 })
  if (usersErr) return NextResponse.json({ error: usersErr.message }, { status: 500 })

  type UserRow = { id: string; full_name: string; team: string; position: string | null }
  const userMap = new Map<string, UserRow>((users ?? []).map((u: UserRow) => [u.id, u]))

  type LogRow = { user_id: string; log_date: string; summary: string; highlights: string | null; self_score: number | null; created_at: string }
  const entries = (logs ?? []).flatMap((log: LogRow) => {
    const user = userMap.get(log.user_id)
    if (!user) return []
    return [{
      user_id:      log.user_id,
      full_name:    user.full_name,
      team:         user.team,
      log_date:     log.log_date,
      summary:      log.summary,
      highlights:   log.highlights,
      self_score:   log.self_score,
      submitted_at: log.created_at,
    }]
  })

  return NextResponse.json({ entries, from, to, total: entries.length })
}
