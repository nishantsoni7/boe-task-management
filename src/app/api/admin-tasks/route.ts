import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

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
  const relation = searchParams.get('relation') ?? 'all'
  const status   = searchParams.get('status')   ?? ''

  const TASK_COLUMNS = [
    'id', 'title', 'note', 'status', 'priority', 'type',
    'is_urgent', 'due_date', 'acknowledged_at',
    'created_at', 'last_update_at', 'blocker_reason',
    'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text',
    'assigned_to', 'created_by', 'delegated_by', 'team',
  ].join(', ')

  let query = serviceClient.from('tasks').select(TASK_COLUMNS)

  if (memberId) {
    if (relation === 'created_by')   query = query.eq('created_by', memberId)
    else if (relation === 'assigned_to') query = query.eq('assigned_to', memberId)
    else if (relation === 'delegated_by') query = query.eq('delegated_by', memberId)
    else query = query.or(`created_by.eq.${memberId},assigned_to.eq.${memberId},delegated_by.eq.${memberId}`)
  }

  if (status) query = query.eq('status', status)

  query = query.order('created_at', { ascending: false })

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ tasks: data ?? [] })
}
