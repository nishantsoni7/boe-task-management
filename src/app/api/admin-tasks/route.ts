import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function getPeriodRange(period: string): { from: string; to: string } {
  const now = new Date()
  if (period === 'today') {
    const from = new Date(now); from.setHours(0, 0, 0, 0)
    const to   = new Date(now); to.setHours(23, 59, 59, 999)
    return { from: from.toISOString(), to: to.toISOString() }
  }
  if (period === 'this_week') {
    const day  = now.getDay()
    const from = new Date(now); from.setDate(now.getDate() - day); from.setHours(0, 0, 0, 0)
    const to   = new Date(now); to.setDate(now.getDate() + (6 - day)); to.setHours(23, 59, 59, 999)
    return { from: from.toISOString(), to: to.toISOString() }
  }
  // this_month
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  return { from: from.toISOString(), to: to.toISOString() }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: callerError } = await serviceClient.auth.getUser(callerToken)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const memberId = searchParams.get('memberId') ?? ''
  const period   = searchParams.get('period') ?? 'today'

  const TASK_COLUMNS = [
    'id', 'title', 'note', 'status', 'priority', 'type',
    'is_urgent', 'due_date', 'acknowledged_at',
    'created_at', 'last_update_at', 'blocker_reason',
    'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
    'assigned_to', 'created_by', 'delegated_by', 'team',
  ].join(', ')

  let query = serviceClient.from('tasks').select(TASK_COLUMNS)

  if (memberId) {
    query = query.eq('created_by', memberId)
  }

  const { from, to } = getPeriodRange(period)
  query = query.gte('created_at', from).lte('created_at', to)

  query = query.order('created_at', { ascending: false })

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ tasks: data ?? [] })
}
