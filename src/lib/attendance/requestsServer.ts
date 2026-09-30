// Server-side helpers shared by the /api/attendance-requests routes.
//
// Every route runs on the service role, so the identity check in the route IS
// the boundary (see src/lib/security/attendancePayrollApiAuth.ts). These
// helpers never take an employee id from a request; callers pass the id they
// have already authorised.

import type { ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { fetchActiveSettings } from '@/lib/payroll/settingsStore'
import type { ShiftWindow } from './requests'
import {
  REQUEST_TYPE_LABEL, REQUEST_STATUS_LABEL, REQUEST_COLUMNS,
  submissionTiming, SUBMISSION_TIMING_LABEL,
  type AttendanceRequestRow,
} from './requests'

/**
 * The company working day used for "informed before shift start". There are no
 * per-employee shifts in BOE: the payroll settings' office start is the shift.
 */
export async function currentShiftWindow(svc: ServiceClient): Promise<ShiftWindow & { grace_end_minutes: number; weekly_off_day: number }> {
  const { settings } = await fetchActiveSettings(svc)
  return {
    scheduled_in_minutes:  settings.scheduled_in_minutes,
    scheduled_out_minutes: settings.scheduled_out_minutes,
    grace_end_minutes:     settings.grace_end_minutes,
    weekly_off_day:        settings.weekly_off_day,
  }
}

/** A request as the attendance views carry it, with the decider's name. */
export type MonthRequest = AttendanceRequestRow & { decider?: { full_name: string | null } | null }

/**
 * Every request of ONE employee that touches [from, to] (IST dates), whatever
 * its status, for the employee's and the admin's attendance views.
 *
 * Independent of the attendance import: a request is a record of what the
 * employee asked and what an admin decided, so it is shown whether or not the
 * machine punches for those dates have arrived. The caller has already
 * authorised `employeeId` against the bearer token.
 */
export async function loadMonthRequests(
  svc: ServiceClient, employeeId: string, from: string, to: string,
): Promise<{ requests: MonthRequest[]; error: string | null }> {
  const { data, error } = await svc
    .from('attendance_requests')
    .select(`${REQUEST_COLUMNS}, decider:users!attendance_requests_decided_by_fkey ( full_name )`)
    .eq('employee_id', employeeId)
    .lte('start_date', to)
    .gte('end_date', from)
    .order('start_date', { ascending: true })
    .order('submitted_at', { ascending: true })
  if (error) return { requests: [], error: error.message }
  return { requests: (data ?? []) as unknown as MonthRequest[], error: null }
}

/** Map a Postgres guard error to something a person can act on. */
export function requestDbError(message: string): { status: number; error: string } {
  if (message.includes('ATTENDANCE_REQUEST_TRANSITION') || message.includes('ATTENDANCE_REQUEST_CLOSED'))
    return { status: 409, error: 'This request has already been decided or closed. Reload to see its current state.' }
  if (message.includes('ATTENDANCE_REQUEST_IMMUTABLE'))
    return { status: 409, error: 'A submitted request cannot be edited. Submit a correction instead.' }
  if (message.includes('ATTENDANCE_REQUEST_NOTE_REQUIRED'))
    return { status: 400, error: 'Give a reason for changing the decision.' }
  if (message.includes('attendance_requests_replaced_once'))
    return { status: 409, error: 'This request was already corrected. Correct the newest version.' }
  return { status: 500, error: message }
}

/**
 * Tell every active admin that a request is waiting. Fire-and-forget in the
 * sense that matters: a notification failure is logged and never fails the
 * submission, which has already been saved.
 *
 * REQUIRES 20270215000100 (the enum values).
 */
export async function notifyAdminsOfRequest(
  svc: ServiceClient,
  row: AttendanceRequestRow,
  employeeName: string | null,
  corrected: boolean,
): Promise<void> {
  try {
    const { data: admins } = await svc.from('users').select('id').eq('role', 'admin').eq('is_active', true)
    const recipients = (admins ?? []).map((a: { id: string }) => a.id).filter((id: string) => id !== row.employee_id)
    if (recipients.length === 0) return
    const who = employeeName?.trim() || 'An employee'
    const what = REQUEST_TYPE_LABEL[row.request_type].toLowerCase()
    const when = row.start_date === row.end_date ? row.start_date : `${row.start_date} to ${row.end_date}`
    const { error } = await svc.from('notifications').insert(recipients.map((id: string) => ({
      user_id:   id,
      type:      'attendance_request_submitted',
      title:     `${who} ${corrected ? 'corrected a' : 'submitted a'} ${what} request for ${when}`,
      body:      `${SUBMISSION_TIMING_LABEL[submissionTiming(row)]}.`,
      entity_id: row.id,
    })))
    if (error) console.error('[attendance-requests] admin notification not delivered:', error.message)
  } catch (e) {
    console.error('[attendance-requests] admin notification failed:', e)
  }
}

/** Tell the employee the decision. The recipient comes from the stored row. */
export async function notifyEmployeeOfDecision(svc: ServiceClient, row: AttendanceRequestRow): Promise<void> {
  try {
    const what = REQUEST_TYPE_LABEL[row.request_type].toLowerCase()
    const { error } = await svc.from('notifications').insert({
      user_id:   row.employee_id,
      type:      'attendance_request_decided',
      title:     `Your ${what} request for ${row.start_date} was ${REQUEST_STATUS_LABEL[row.status].toLowerCase()}`,
      body:      row.decision_note?.trim() || 'Open My Attendance to see the decision.',
      entity_id: row.id,
    })
    if (error) console.error('[attendance-requests] decision notification not delivered:', error.message)
  } catch (e) {
    console.error('[attendance-requests] decision notification failed:', e)
  }
}
