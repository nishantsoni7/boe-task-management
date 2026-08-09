// "Is this payroll month locked?" — asked once, for every route that writes money.
//
// WHY THIS EXISTS
// ---------------
// Locking already stopped regeneration and attendance correction, each with its
// own check in its own route. Two paths never had one at all:
// POST /api/payroll/adjustments and DELETE /api/payroll/adjustments/[id]. An
// admin could add or remove a salary adjustment against a locked month — the
// exact thing locking is for — and the only reason it was not obvious is that
// the UI does not offer the button.
//
// A disabled button is not an enforcement boundary. Every settlement and
// adjustment write now resolves the period through this module first, and the
// database carries a trigger for settlements on top of it, so a locked month is
// immutable to a caller that skips the UI entirely.
//
// Adjustments are addressed by (payroll_year, payroll_month) rather than by
// period id, so both lookups live here and neither route has to know how the
// other finds its period.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any

export type PeriodLockState =
  | { found: true; periodId: string; locked: boolean }
  /** No period row for that month. Nothing is locked, because nothing exists. */
  | { found: false }

export const LOCKED_PERIOD_MESSAGE =
  'This payroll period is locked. Unlock it before changing adjustments or settlement records.'

export async function periodLockStateById(svc: Svc, periodId: string): Promise<PeriodLockState> {
  const { data, error } = await svc
    .from('payroll_periods')
    .select('id, status')
    .eq('id', periodId)
    .maybeSingle()

  if (error) throw new Error(`periodLockStateById: ${error.message}`)
  if (!data) return { found: false }
  return { found: true, periodId: data.id, locked: data.status === 'locked' }
}

/**
 * The period a month-scoped adjustment belongs to.
 *
 * An adjustment can be created for a month that has no payroll period yet —
 * that is normal, and it is what "pending" means. Such a row cannot be locked,
 * because there is nothing to lock, so `found: false` is a pass rather than an
 * error.
 */
export async function periodLockStateByMonth(
  svc: Svc,
  month: number,
  year: number,
): Promise<PeriodLockState> {
  const { data, error } = await svc
    .from('payroll_periods')
    .select('id, status')
    .eq('payroll_month', month)
    .eq('payroll_year', year)
    .maybeSingle()

  if (error) throw new Error(`periodLockStateByMonth: ${error.message}`)
  if (!data) return { found: false }
  return { found: true, periodId: data.id, locked: data.status === 'locked' }
}

/** True when a write must be refused. Absent periods are writable. */
export function isLocked(state: PeriodLockState): boolean {
  return state.found && state.locked
}
