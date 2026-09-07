// Wires the pure decision in ./processDelivery to real reads and writes.
//
// Called two ways:
//   - inline, once, right after the webhook route stores a fresh delivery
//     (when MINOP_ATTENDANCE_PROCESSING_ENABLED is on);
//   - from the admin "retry processing" action on an already-stored delivery,
//     regardless of that flag — an admin who explicitly asks for one delivery
//     to be reprocessed after fixing a mapping is not asking for auto-capture
//     to be turned on for everyone else.
//
// Either way this never runs twice usefully on its own: it is only ever
// invoked once per delivery by the webhook route, and the retry action is a
// deliberate admin trigger, so there is no background poller here to race
// with itself. What DOES need to be safe against repetition is a genuine
// Minop retry of the same physical punch arriving as a SEPARATE delivery row
// (Stage 1 deliberately does not deduplicate by body hash) — that safety
// comes from computeMinopAttendanceOutcome's own idempotent merge, not from
// anything here.

import type { SupabaseClient } from '@supabase/supabase-js'
import { istDateOf } from '../istDate'
import { parseMinopPunchEvent } from './punchEvent'
import {
  computeMinopAttendanceOutcome,
  type ExistingAttendanceRow,
  type MinopAttendanceOutcome,
} from './processDelivery'
import type { MinopEmployeeCandidate } from './employeeMapping'

export type MinopDeliveryToProcess = {
  id: string
  payload: unknown
}

export type ProcessingRunResult =
  | { outcome: MinopAttendanceOutcome | null; deliveryUpdate: Record<string, unknown> }

/**
 * Process one stored, authenticated Minop delivery. Reads whatever the
 * decision needs, applies it, and returns the exact columns the caller should
 * write back onto `minop_webhook_deliveries` for that delivery id.
 *
 * Never throws for a business outcome (unmapped, conflict, lock, malformed
 * event, unsupported type) — those are all valid, recorded results. It can
 * still reject on a genuine database failure, which the caller should treat
 * as "processing did not run" rather than any of the above.
 */
export async function runMinopAttendanceProcessing(
  svc: SupabaseClient,
  delivery: MinopDeliveryToProcess,
): Promise<ProcessingRunResult> {
  const now = new Date().toISOString()
  const parsed = parseMinopPunchEvent(delivery.payload)

  if (!parsed.ok) {
    return {
      outcome: null,
      deliveryUpdate: {
        attendance_status: 'malformed_event',
        attendance_error: `Delivery does not match the published callback shape: ${parsed.reason}`,
        attendance_processed_at: now,
      },
    }
  }

  const { event } = parsed

  if (!event.supportedType) {
    return {
      outcome: null,
      deliveryUpdate: {
        attendance_status: 'ignored_unsupported_type',
        attendance_error: null,
        attendance_processed_at: now,
        punch_type: event.type,
        punch_time_utc: event.logTimeUtc,
      },
    }
  }

  const { data: candidateRows, error: candidateErr } = await svc
    .from('users')
    .select('id, fingerprint_employee_code, is_active, is_deleted')
    .eq('fingerprint_employee_code', event.minopUserId)
  if (candidateErr) throw new Error(`Could not read employee mapping: ${candidateErr.message}`)

  const candidates: MinopEmployeeCandidate[] = (candidateRows ?? []).map(r => ({
    id: r.id,
    fingerprint_employee_code: r.fingerprint_employee_code as string,
    is_active: Boolean(r.is_active),
    is_deleted: Boolean(r.is_deleted),
  }))

  // The lock check and the existing-row read both need the attendance date,
  // which only depends on the punch time — so compute it the same way the
  // decision itself will, before knowing whether the employee even resolves.
  const attendanceDate = istDateOf(event.logTimeUtc)
  const [year, monthStr] = attendanceDate.split('-')
  const month = Number(monthStr)
  const yearNum = Number(year)

  const { data: periodRow, error: periodErr } = await svc
    .from('payroll_periods')
    .select('status')
    .eq('payroll_month', month)
    .eq('payroll_year', yearNum)
    .maybeSingle()
  if (periodErr) throw new Error(`Could not read payroll lock status: ${periodErr.message}`)

  // Only one employee can possibly resolve (exact code match, checked above),
  // so the existing-row read is scoped to that one candidate when there is
  // exactly one — a conflict or an unmapped code never reaches this read.
  let existingRow: ExistingAttendanceRow | null = null
  if (candidates.length === 1) {
    const { data: existing, error: existingErr } = await svc
      .from('attendance_records')
      .select('check_in_at, check_out_at, punch_direction_source')
      .eq('user_id', candidates[0].id)
      .eq('attendance_date', attendanceDate)
      .maybeSingle()
    if (existingErr) throw new Error(`Could not read existing attendance: ${existingErr.message}`)
    existingRow = existing ?? null
  }

  const outcome = computeMinopAttendanceOutcome({
    minopUserId: event.minopUserId,
    type: event.supportedType,
    logTimeUtc: event.logTimeUtc,
    candidates,
    existingRow,
    payrollLock: { locked: periodRow?.status === 'locked' },
  })

  if (outcome.status === 'processed' && outcome.write) {
    const { error: upsertErr } = await svc
      .from('attendance_records')
      .upsert(
        { user_id: outcome.userId, attendance_date: outcome.attendanceDate, ...outcome.row },
        { onConflict: 'user_id,attendance_date' },
      )
    if (upsertErr) throw new Error(`Could not write attendance: ${upsertErr.message}`)
  }

  const mappedUserId =
    outcome.status === 'processed' || outcome.status === 'payroll_locked' || outcome.status === 'inactive_employee'
      ? outcome.userId
      : null

  return {
    outcome,
    deliveryUpdate: {
      attendance_status: outcome.status,
      attendance_error: null,
      attendance_processed_at: now,
      mapped_user_id: mappedUserId,
      punch_type: event.type,
      punch_time_utc: event.logTimeUtc,
    },
  }
}
