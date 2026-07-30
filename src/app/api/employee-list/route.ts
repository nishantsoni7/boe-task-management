import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Base columns guaranteed to exist in users table (no migration dependency)
const BASE_COLUMNS = 'id, full_name, team, position, is_active'
// Extended columns added by 20260608_add_employee_fields migration
// performance_tracking_enabled (20260719000000) is included so the employee
// configuration screen can show the real state of the Performance toggle.
// performance_tracking_note is deliberately NOT selected here: this endpoint is
// open to any authenticated user, and the note records management's reason for
// holding an account out ("administrative/test account"), which ordinary
// employees have no business reading. The note is returned only by the
// admin-gated Team Performance coverage payload.
const FULL_COLUMNS  = BASE_COLUMNS + ', employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code, performance_tracking_enabled'

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Verify the caller has a valid session — any authenticated user may view the list
  const { data: { user: caller }, error: callerError } = await serviceClient.auth.getUser(callerToken)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Try with employee fields first. If the migration hasn't been applied yet the
  // columns won't exist and Supabase returns an error — fall back to base columns
  // so users always appear in the list.
  const full = await serviceClient
    .from('users')
    .select(FULL_COLUMNS)
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('full_name')

  let employees: Record<string, unknown>[] | null = full.data as Record<string, unknown>[] | null
  let queryError = full.error

  if (queryError?.message?.includes('column')) {
    const fallback = await serviceClient
      .from('users')
      .select(BASE_COLUMNS)
      .or('is_deleted.eq.false,is_deleted.is.null')
      .order('full_name')
    employees  = fallback.data as Record<string, unknown>[] | null
    queryError = fallback.error
  }

  if (queryError) return NextResponse.json({ error: queryError.message }, { status: 500 })

  return NextResponse.json({ employees: employees ?? [] })
}
