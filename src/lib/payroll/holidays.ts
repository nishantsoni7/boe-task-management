// Payroll holiday lookup helper.
// Fetches all payroll_holidays for a given month and returns a Set of ISO date strings
// so per-day lookups are O(1) during calendar building.

import { createClient } from '@supabase/supabase-js'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function fetchHolidaySet(
  month: number,
  year: number
): Promise<Set<string>> {
  const svc = serviceClient()

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const nextMonth  = month === 12 ? 1 : month + 1
  const nextYear   = month === 12 ? year + 1 : year
  const monthEnd   = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const { data, error } = await svc
    .from('payroll_holidays')
    .select('holiday_date')
    .gte('holiday_date', monthStart)
    .lt('holiday_date', monthEnd)

  if (error) throw new Error(`Failed to fetch payroll holidays: ${error.message}`)

  const holidays: { holiday_date: string }[] = data ?? []
  return new Set(holidays.map(h => h.holiday_date))
}
