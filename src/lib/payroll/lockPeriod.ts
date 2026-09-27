// Locking a payroll month — with the attendance review checked by the SERVER.
//
// A month with no open attendance items locks exactly as before: one update,
// one status event. A month WITH open items (unresolved salary items, or
// decisions the draft disagrees with) is refused until the request carries an
// acknowledgement of the exact state the admin saw:
//
//   1. POST { payroll_period_id }                       → 409 attendance_unresolved
//      with the summary and a server-computed fingerprint
//   2. POST { payroll_period_id, attendance_acknowledgement: { fingerprint, reason } }
//      → locked, and the acknowledgement recorded (actor, time, counts,
//        fingerprint, per-employee counts, reason) in the same transaction
//      → 409 attendance_ack_stale if anything changed since step 1
//
// If the review cannot be read at all, the lock is refused with
// attendance_check_failed unless the admin deliberately overrides it with
// { unverified: true, reason } — recorded as check_failed. Payroll is never
// blocked forever, and never locked past open items without a record.
//
// A direct call to /api/payroll/lock goes through this module too, so the
// browser's confirmation is no longer the only thing standing in the way.

import { createHash } from 'node:crypto'
import { loadReconciliation } from '@/lib/attendance/requestHandlers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

export type LockResult = { status: number; body: Record<string, unknown> }

export type AttendanceLockState =
  | {
      ok: true
      unresolved: number
      conflicts: number
      fingerprint: string
      employees: { employee_id: string; full_name: string | null; unresolved: number; conflicts: number }[]
    }
  | { ok: false; error: string }

/**
 * The month's open attendance items, and a fingerprint of exactly which ones.
 * The fingerprint covers every unresolved event's identity AND status, so a
 * decision saved, a punch corrected or a new event appearing all change it.
 */
export async function attendanceLockState(svc: Svc, year: number, month: number, today: string): Promise<AttendanceLockState> {
  try {
    const { result } = await loadReconciliation(svc, year, month, today)
    const open: string[] = []
    const employees: Extract<AttendanceLockState, { ok: true }>['employees'] = []
    for (const e of result.employees) {
      for (const ev of e.events) {
        if (!ev.upcoming && !ev.resolved) open.push(`${e.employee.id}|${ev.date}|${ev.event_key}|${ev.salary_status}`)
      }
      if (e.unresolved_count > 0 || e.conflict_count > 0) {
        employees.push({ employee_id: e.employee.id, full_name: e.employee.full_name, unresolved: e.unresolved_count, conflicts: e.conflict_count })
      }
    }
    open.sort()
    return {
      ok: true,
      unresolved: result.totals.unresolved,
      conflicts: result.totals.conflicts,
      fingerprint: createHash('sha256').update(open.join('\n')).digest('hex'),
      employees,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

type Ack = { fingerprint?: unknown; reason?: unknown; unverified?: unknown }

export async function lockPayrollPeriod(
  svc: Svc,
  actor: { id: string; name: string | null },
  body: Record<string, unknown>,
  today: string,
): Promise<LockResult> {
  const periodId = typeof body.payroll_period_id === 'string' ? body.payroll_period_id : ''
  if (!periodId) return { status: 400, body: { error: 'payroll_period_id is required' } }

  const { data: period } = await svc
    .from('payroll_periods')
    .select('status, payroll_month, payroll_year')
    .eq('id', periodId)
    .single()

  if (!period) return { status: 404, body: { error: 'Period not found' } }
  if (period.status === 'locked') return { status: 422, body: { error: 'Period is already locked' } }
  if (period.status !== 'generated') return { status: 422, body: { error: 'Only generated periods can be locked' } }

  const state = await attendanceLockState(svc, period.payroll_year, period.payroll_month, today)
  const ack = (body.attendance_acknowledgement ?? null) as Ack | null
  const reason = typeof ack?.reason === 'string' ? ack.reason.trim() : ''

  // ── Nothing open: the existing simple lock, unchanged ──────────────────────
  if (state.ok && state.unresolved === 0 && state.conflicts === 0) {
    const { error: updateErr } = await svc
      .from('payroll_periods')
      .update({ status: 'locked', locked_at: new Date().toISOString(), locked_by: actor.id })
      .eq('id', periodId)
    if (updateErr) return { status: 500, body: { error: updateErr.message } }
    await recordStatusEvent(svc, periodId, actor)
    return { status: 200, body: { success: true } }
  }

  // ── The review could not be read: only a deliberate override locks ─────────
  if (!state.ok) {
    if (ack?.unverified !== true || !reason) {
      return {
        status: 409,
        body: {
          code: 'attendance_check_failed',
          requires_acknowledgement: true,
          error: 'The attendance review for this month could not be checked. Lock only with a stated reason, as an override.',
          detail: state.error,
        },
      }
    }
    return lockWithAck(svc, periodId, actor, { unresolved: 0, conflicts: 0, fingerprint: null, summary: [], reason, checkFailed: true })
  }

  // ── Open items: an acknowledgement of THIS state is required ───────────────
  const fresh = {
    requires_acknowledgement: true,
    unresolved: state.unresolved,
    conflicts: state.conflicts,
    fingerprint: state.fingerprint,
    employees: state.employees,
  }
  if (!ack) {
    return { status: 409, body: { code: 'attendance_unresolved', error: `${state.unresolved} attendance salary item(s) are unresolved for this month.`, ...fresh } }
  }
  if (ack.fingerprint !== state.fingerprint) {
    return { status: 409, body: { code: 'attendance_ack_stale', error: 'The attendance review changed since you looked. Review the current open items and acknowledge again.', ...fresh } }
  }
  if (!reason) return { status: 400, body: { error: 'Give a reason for locking with open attendance items.' } }

  return lockWithAck(svc, periodId, actor, {
    unresolved: state.unresolved,
    conflicts: state.conflicts,
    fingerprint: state.fingerprint,
    summary: state.employees.map(e => ({ employee_id: e.employee_id, unresolved: e.unresolved, conflicts: e.conflicts })),
    reason,
    checkFailed: false,
  })
}

async function lockWithAck(
  svc: Svc,
  periodId: string,
  actor: { id: string; name: string | null },
  a: { unresolved: number; conflicts: number; fingerprint: string | null; summary: unknown[]; reason: string; checkFailed: boolean },
): Promise<LockResult> {
  // One transaction: the acknowledgement record and the lock land together.
  const { data, error } = await svc.rpc('lock_payroll_period_with_attendance_ack', {
    p_period_id: periodId,
    p_actor_id: actor.id,
    p_unresolved: a.unresolved,
    p_conflicts: a.conflicts,
    p_fingerprint: a.fingerprint,
    p_summary: a.summary,
    p_reason: a.reason,
    p_check_failed: a.checkFailed,
  })
  if (error) {
    const m = String(error.message)
    if (m.includes('PAYROLL_LOCK_ALREADY')) return { status: 422, body: { error: 'Period is already locked' } }
    if (m.includes('PAYROLL_LOCK_NOT_GENERATED')) return { status: 422, body: { error: 'Only generated periods can be locked' } }
    return { status: 500, body: { error: m } }
  }
  await recordStatusEvent(svc, periodId, actor)
  return { status: 200, body: { success: true, acknowledgement_id: data, locked_with_open_items: true } }
}

/**
 * The append-only lock trail, as the route always wrote it. Best-effort:
 * locked_at / locked_by (and, for an acknowledged lock, the acknowledgement
 * row) already record that the lock happened.
 */
async function recordStatusEvent(svc: Svc, periodId: string, actor: { id: string; name: string | null }) {
  const { error } = await svc
    .from('payroll_period_status_events')
    .insert({
      payroll_period_id: periodId,
      event:           'locked',
      previous_status: 'generated',
      new_status:      'locked',
      actor_id:        actor.id,
      actor_name:      actor.name,
    })
  if (error) console.error('[payroll/lock] status event insert:', error.message)
}
