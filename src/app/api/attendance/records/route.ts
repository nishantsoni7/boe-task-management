import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employee_id')
  const fromDate   = searchParams.get('from')
  const toDate     = searchParams.get('to')

  let query = svc
    .from('attendance_records')
    .select('id, attendance_date, check_in_at, check_out_at, status, user_id, users(full_name, employee_code)')
    .order('attendance_date', { ascending: false })
    .limit(500)

  if (employeeId) query = query.eq('user_id', employeeId)
  if (fromDate)   query = query.gte('attendance_date', fromDate)
  if (toDate)     query = query.lte('attendance_date', toDate)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ records: data ?? [] })
}
