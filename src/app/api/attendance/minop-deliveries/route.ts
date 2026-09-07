import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'

const PAGE_SIZE = 100

/**
 * Admin diagnostics for the Minop rollout (Phase F): the recent raw
 * deliveries and what attendance processing did with each one, so an admin
 * can see an unmapped device code or a mapping conflict without reading the
 * database directly. Read-only — this never touches attendance or payroll.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status') // optional: filter by attendance_status

  let query = svc
    .from('minop_webhook_deliveries')
    .select(`
      id,
      received_at,
      service_tag_id,
      auth_method,
      processing_status,
      error_text,
      attendance_status,
      attendance_error,
      attendance_processed_at,
      mapped_user_id,
      punch_type,
      punch_time_utc,
      mapped_employee:mapped_user_id ( full_name, employee_code )
    `)
    .order('received_at', { ascending: false })
    .limit(PAGE_SIZE)

  if (status) {
    query = query.eq('attendance_status', status)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const deliveries = (data ?? []).map(row => {
    const employee = Array.isArray(row.mapped_employee) ? row.mapped_employee[0] : row.mapped_employee
    return {
      id: row.id,
      received_at: row.received_at,
      service_tag_id: row.service_tag_id,
      auth_method: row.auth_method,
      processing_status: row.processing_status,
      error_text: row.error_text,
      attendance_status: row.attendance_status,
      attendance_error: row.attendance_error,
      attendance_processed_at: row.attendance_processed_at,
      punch_type: row.punch_type,
      punch_time_utc: row.punch_time_utc,
      mapped_employee_name: employee?.full_name ?? null,
      mapped_employee_code: employee?.employee_code ?? null,
    }
  })

  return NextResponse.json({ deliveries })
}
