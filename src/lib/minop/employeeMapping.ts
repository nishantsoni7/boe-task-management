// Mapping a Minop device UserId to exactly one BOE employee.
//
// The canonical field is `users.fingerprint_employee_code`
// (supabase/migrations/20260610_add_fingerprint_employee_code.sql), the same
// field the CSV fingerprint import already matches against in
// src/lib/attendance/employeeMapping.ts. That module compares codes with
// exact string equality and performs no normalisation of its own, so this
// does the same: a Minop UserId of "0014" and a stored code of "14" are
// different codes here exactly as they are on import, until real device data
// proves the machine pads (or does not pad) differently. Guessing a
// normalisation rule from public documentation alone is exactly the kind of
// silent guess Stage 2 must not make.
//
// Nothing here touches the database. It is handed the candidate rows a caller
// already read for one UserId and answers who — or refuses, with a reason a
// caller can record on the delivery and show an admin.

export type MinopEmployeeCandidate = {
  id: string
  fingerprint_employee_code: string
  is_active: boolean
  is_deleted: boolean
}

export type MinopEmployeeMappingResult =
  | { ok: true; userId: string }
  /** No employee — active or not — carries this code at all. */
  | { ok: false; reason: 'unmapped' }
  /** More than one employee row carries this exact code. A data problem in
   *  Employee Master, not something Stage 2 may resolve by guessing. */
  | { ok: false; reason: 'mapping_conflict' }
  /** Exactly one employee carries the code, but they are inactive or
   *  deleted. Punching a badge that used to belong to someone must not post
   *  attendance for them. `userId` is still returned — useful to an admin
   *  deciding whether this is expected. */
  | { ok: false; reason: 'inactive_employee'; userId: string }

/**
 * Resolve one Minop `PunchLog.UserId` against the employees who carry that
 * exact `fingerprint_employee_code`.
 *
 * `candidates` should already be filtered to rows whose code equals
 * `minopUserId` (exact match) — the caller does that read; this function only
 * decides what the result set means, so the decision is unit-testable without
 * a database.
 */
export function resolveMinopEmployee(
  minopUserId: string,
  candidates: MinopEmployeeCandidate[],
): MinopEmployeeMappingResult {
  const matching = candidates.filter(c => c.fingerprint_employee_code === minopUserId)

  if (matching.length === 0) return { ok: false, reason: 'unmapped' }
  if (matching.length > 1) return { ok: false, reason: 'mapping_conflict' }

  const [only] = matching
  if (!only.is_active || only.is_deleted) return { ok: false, reason: 'inactive_employee', userId: only.id }

  return { ok: true, userId: only.id }
}
