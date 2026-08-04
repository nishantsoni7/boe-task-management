import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'

// Returns today's date string (YYYY-MM-DD) in IST (UTC+5:30)
function todayIST(): string {
  const now = new Date()
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  return ist.toISOString().slice(0, 10)
}

// Company-wide headcount for today: how many are present, still clocked in, or
// absent. Aggregate rather than per-person, but it is still a statement about
// the workforce and belongs to the admin attendance dashboard, so it is gated
// the same way as the rest of that screen.
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const today = todayIST()

  const [activeUsersRes, todayRecordsRes] = await Promise.all([
    // All active employees — head:false so we get the IDs for absent calc
    svc.from('users')
      .select('id')
      .eq('is_active', true),

    // Today's attendance records — only what we need for the 4 cards
    svc.from('attendance_records')
      .select('user_id, check_in_at, check_out_at, status')
      .eq('attendance_date', today),
  ])

  if (activeUsersRes.error) return NextResponse.json({ error: activeUsersRes.error.message }, { status: 500 })
  if (todayRecordsRes.error) return NextResponse.json({ error: todayRecordsRes.error.message }, { status: 500 })

  const activeUserIds = new Set((activeUsersRes.data ?? []).map(u => u.id))
  const total         = activeUserIds.size

  // Only count records belonging to active users
  const todayRecords  = (todayRecordsRes.data ?? []).filter(r => activeUserIds.has(r.user_id))

  // present = status is 'present'
  const presentToday  = todayRecords.filter(r => r.status === 'present').length

  // checked_in = has check_in_at but no check_out_at yet (still clocked in)
  const checkedIn     = todayRecords.filter(r => r.check_in_at && !r.check_out_at).length

  // absent = active users with no attendance record at all today
  const usersWithRecord = new Set(todayRecords.map(r => r.user_id)).size
  const absentToday     = Math.max(0, total - usersWithRecord)

  return NextResponse.json({
    counts: { total, present_today: presentToday, checked_in: checkedIn, absent_today: absentToday },
  })
}
