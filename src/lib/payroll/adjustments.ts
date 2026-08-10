// Manual payroll adjustments — storage shape → engine shape.
//
// The database and the engine disagree on how an adjustment is represented, and
// that disagreement is the whole reason this module exists:
//
//   storage (payroll_pending_adjustments, since migration 20260636)
//     amount           always POSITIVE
//     adjustment_type  'addition' | 'deduction' — carries the direction
//
//   engine (EnginePendingAdjustment)
//     amount           SIGNED: positive adds to salary, negative deducts
//
// Reading `amount` straight out of the table therefore turns every manual
// deduction into a pay rise. Both the generation path and the preview path go
// through the one conversion below so they cannot interpret a row differently.
//
// No rounding happens here. The engine sums adjustments into net salary at full
// precision and the existing payroll rounding rules apply downstream, unchanged.

import type { EnginePendingAdjustment } from './types'

export const ADJUSTMENT_TYPES = ['addition', 'deduction'] as const
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number]

/** A row as `payroll_pending_adjustments` stores it. */
export type StoredAdjustment = {
  id: string
  adjustment_type: string | null
  /** What the adjustment is. NULL on every row predating the category column. */
  adjustment_category?: unknown
  amount: number
  description: string | null
}

/**
 * One stored row as the engine expects it.
 *
 * The magnitude is taken with Math.abs so the stored sign — which since
 * migration 20260636 is meant to be positive always — cannot contradict
 * `adjustment_type` and silently flip a deduction back into an addition.
 * A row with no type is treated as an addition, matching the column default.
 */
export function toSignedAdjustment(row: StoredAdjustment): EnginePendingAdjustment {
  const magnitude = Math.abs(row.amount)
  return {
    id: row.id,
    amount: row.adjustment_type === 'deduction' ? -magnitude : magnitude,
    description: row.description ?? '',
  }
}

export function toSignedAdjustments(rows: StoredAdjustment[]): EnginePendingAdjustment[] {
  return rows.map(toSignedAdjustment)
}
