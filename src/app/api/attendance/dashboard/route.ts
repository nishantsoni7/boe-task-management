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

  const today = new Date().toISOString().slice(0, 10)

  const [totalRes, todayRes] = await Promise.all([
    svc.from('users')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .or('is_deleted.eq.false,is_deleted.is.null'),

    svc.from('attendance_records')
      .select('id, status')
      .eq('attendance_date', today),
  ])

  if (totalRes.error) return NextResponse.json({ error: totalRes.error.message }, { status: 500 })
  if (todayRes.error) return NextResponse.json({ error: todayRes.error.message }, { status: 500 })

  const total        = totalRes.count ?? 0
  const checkedIn    = todayRes.data?.length ?? 0
  const checkedOut   = todayRes.data?.filter(r => r.status === 'present').length ?? 0
  const notCheckedIn = Math.max(0, total - checkedIn)

  return NextResponse.json({
    counts: { total, checked_in: checkedIn, checked_out: checkedOut, not_checked_in: notCheckedIn },
  })
}
