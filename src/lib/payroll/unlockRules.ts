// Payroll unlock guards.
//
// Pure, for the same reason canCorrectAttendance is pure (correctionRules.ts):
// the two questions that decide whether a finalised payroll month may be
// reopened — who is asking, and what state is the period actually in — are
// answered once here, so the API route and the dashboard cannot disagree about
// them.

import type { PeriodStatus } from './correctionRules'

export type { PeriodStatus }

/**
 * Where a locked period goes when it is reopened.
 *
 * Not a new status. A period can only be locked FROM 'generated' (see
 * /api/payroll/lock), and locking never touches payroll_results, so 'generated'
 * is the state the period was in a moment before it was locked and the state it
 * is genuinely in the moment it stops being locked: results exist, regeneration
 * and locking are both available again.
 */
export const UNLOCK_TARGET_STATUS = 'generated' as const

export type UnlockDenial =
  | { allowed: false; reason: 'not_authorised'; message: string }
  | { allowed: false; reason: 'not_locked'; message: string }

export type UnlockPermission =
  | { allowed: true; targetStatus: typeof UNLOCK_TARGET_STATUS }
  | UnlockDenial

/**
 * Whether this caller may unlock this payroll period.
 *
 * Unlocking reopens attendance correction, regeneration and payroll-result
 * changes for a month that was declared final, so it is an admin action and
 * nothing else. It reuses `users.role === 'admin'` rather than introducing a
 * second notion of who runs payroll, exactly as every other payroll route does.
 */
export function canUnlockPayroll(
  role: string | null | undefined,
  periodStatus: PeriodStatus | null | undefined,
): UnlockPermission {
  if (role !== 'admin') {
    return {
      allowed: false,
      reason: 'not_authorised',
      message: 'Only payroll administrators can unlock a payroll period.',
    }
  }
  if (periodStatus !== 'locked') {
    return {
      allowed: false,
      reason: 'not_locked',
      message: 'This payroll period is not locked, so there is nothing to unlock.',
    }
  }
  return { allowed: true, targetStatus: UNLOCK_TARGET_STATUS }
}

// ─── Reason ───────────────────────────────────────────────────────────────────

/** Long enough for a real explanation, short enough that the column stays readable. */
export const UNLOCK_REASON_MAX_LENGTH = 500

export type UnlockReasonResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

/**
 * The stated reason for reopening the month.
 *
 * Mandatory and trimmed: a reason made of whitespace is not a reason, and the
 * audit row is the only thing that will explain this decision to whoever reads
 * the payroll history later.
 */
export function validateUnlockReason(input: unknown): UnlockReasonResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'A reason for unlocking is required.' }
  }
  const value = input.trim()
  if (value === '') {
    return { ok: false, error: 'A reason for unlocking is required.' }
  }
  if (value.length > UNLOCK_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `The reason for unlocking must be ${UNLOCK_REASON_MAX_LENGTH} characters or fewer.`,
    }
  }
  return { ok: true, value }
}
