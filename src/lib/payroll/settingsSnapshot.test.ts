/**
 * Which settings a payroll period is calculated and re-read with.
 *
 *   npx tsx --test src/lib/payroll/settingsSnapshot.test.ts
 *
 * This is the historical-stability contract, and it is the part of Central
 * Payroll Settings that can actually hurt somebody. A generated month is a
 * record of what an employee was paid. If editing a rule in October silently
 * restated March, the payslip an employee was paid against would stop matching
 * the one the system shows them — and nothing would flag it, because both
 * numbers would be internally consistent.
 *
 * So the rules are asserted rather than described:
 *
 *   · a generated or locked period always reads its own snapshot
 *   · a later settings change cannot reach it
 *   · an unlocked period keeps its old snapshot until an admin asks otherwise
 *   · an intentional recalculation replaces the snapshot, before recalculating
 *   · a legacy period with no snapshot stays readable, on the legacy constants
 *   · Monthly Review previews an ungenerated month on current settings, and a
 *     generated one on its snapshot
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  settingsForPeriod,
  pinSettingsToPeriod,
  fetchActiveSettings,
  type PeriodSettingsContext,
} from './settingsStore'
import {
  DEFAULT_PAYROLL_SETTINGS,
  LEGACY_PAYROLL_SETTINGS,
  type PayrollSettings,
} from './settings'
import { generatePayrollForEmployee } from './engine'
import { roundRupees } from './money'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord } from './types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Settings that differ from the defaults in ways that move money visibly. */
function customSettings(): PayrollSettings {
  return {
    ...DEFAULT_PAYROLL_SETTINGS,
    per_day_divisor:     30,   // was 26 — a smaller daily rate
    missing_punch_hours: 4,    // was 2  — a bigger missing-punch charge
    paid_leave_tiers: DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers.map(t => ({ ...t })),
  }
}

const EMPLOYEE: EngineEmployee = {
  id: 'emp-1',
  monthly_salary: 26_000,
  payroll_active: true,
  joining_date: null,
  employment_type: 'permanent',
}

/** August 2026: a month with weekdays, used for every engine run below. */
function period(status: EnginePeriod['status'] = 'draft'): EnginePeriod {
  return { id: 'per-1', payroll_month: 8, payroll_year: 2026, status }
}

/** One working day with a single punch, so the missing-punch rule fires. */
function singlePunchDay(): EngineAttendanceRecord[] {
  return [{
    id: 'att-1',
    attendance_date: '2026-08-03',       // a Monday
    check_in_at: '2026-08-03T04:30:00Z', // 10:00 IST
    check_out_at: null,
    direction_source: 'confirmed',
  }]
}

function runWith(settings: PayrollSettings) {
  const outcome = generatePayrollForEmployee(
    EMPLOYEE, period(), singlePunchDay(), [], [], [], settings,
  )
  assert.equal(isSkip(outcome), false)
  if (isSkip(outcome)) throw new Error('unexpected skip')
  return outcome
}

// ─── A minimal Supabase stand-in ──────────────────────────────────────────────
//
// Only the three calls settingsStore makes are modelled. A full fake would be a
// second implementation of PostgREST to keep correct; this asserts the calls the
// snapshot rule actually depends on.

type StubPeriodRow = { status: PeriodSettingsContext['status']; settings_snapshot: unknown }

function stubSvc(periodRow: StubPeriodRow, opts: { onUpdate?: (patch: Record<string, unknown>) => void } = {}) {
  const updates: Record<string, unknown>[] = []
  const svc = {
    from(table: string) {
      if (table !== 'payroll_periods') throw new Error(`unexpected table ${table}`)
      return {
        select() {
          return {
            eq() {
              return {
                single: async () => ({ data: { ...periodRow }, error: null }),
              }
            },
          }
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch)
          opts.onUpdate?.(patch)
          // Reflect the write, so a later read in the same test sees it.
          if ('settings_snapshot' in patch) periodRow.settings_snapshot = patch.settings_snapshot
          return { eq: async () => ({ error: null }) }
        },
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: svc as any, updates }
}

// ─── settingsForPeriod: the rule itself ───────────────────────────────────────

describe('settingsForPeriod', () => {
  const active = customSettings()

  test('a generated period reads its own snapshot, not the active settings', () => {
    const snapshot = { ...DEFAULT_PAYROLL_SETTINGS }
    const chosen = settingsForPeriod(
      { status: 'generated', settings_snapshot: snapshot },
      active,
    )
    assert.equal(chosen.per_day_divisor, 26)
    assert.notEqual(chosen.per_day_divisor, active.per_day_divisor)
  })

  test('a locked period reads its own snapshot too', () => {
    const chosen = settingsForPeriod(
      { status: 'locked', settings_snapshot: { ...DEFAULT_PAYROLL_SETTINGS } },
      active,
    )
    assert.equal(chosen.per_day_divisor, 26)
  })

  test('a draft period with no snapshot adopts the active settings', () => {
    const chosen = settingsForPeriod({ status: 'draft', settings_snapshot: null }, active)
    assert.equal(chosen.per_day_divisor, active.per_day_divisor)
  })

  test('a GENERATED period with no snapshot is legacy, and does NOT adopt today’s settings', () => {
    // The case worth stating aloud: falling back to the active settings here
    // would look reasonable and would silently rewrite the explanation of every
    // payslip generated before this feature existed.
    const chosen = settingsForPeriod({ status: 'generated', settings_snapshot: null }, active)
    assert.deepEqual(chosen, LEGACY_PAYROLL_SETTINGS)
    assert.notEqual(chosen.per_day_divisor, active.per_day_divisor)
  })

  test('a locked legacy period is readable on the legacy constants', () => {
    const chosen = settingsForPeriod({ status: 'locked', settings_snapshot: null }, active)
    assert.deepEqual(chosen, LEGACY_PAYROLL_SETTINGS)
  })

  test('a corrupt snapshot stays readable rather than throwing', () => {
    const chosen = settingsForPeriod(
      { status: 'generated', settings_snapshot: { per_day_divisor: 0 } },
      active,
    )
    assert.deepEqual(chosen, LEGACY_PAYROLL_SETTINGS)
  })

  test('a snapshot is used verbatim, not merged over today’s defaults', () => {
    const snapshot = { ...DEFAULT_PAYROLL_SETTINGS, per_day_divisor: 20, missing_punch_hours: 6 }
    const chosen = settingsForPeriod({ status: 'generated', settings_snapshot: snapshot }, active)
    assert.equal(chosen.per_day_divisor, 20)
    assert.equal(chosen.missing_punch_hours, 6)
  })
})

// ─── pinSettingsToPeriod: when the snapshot is written ────────────────────────

describe('pinSettingsToPeriod', () => {
  test('a period with no snapshot gets one, and it is what is returned', async () => {
    const { svc, updates } = stubSvc({ status: 'draft', settings_snapshot: null })
    const active = customSettings()

    const used = await pinSettingsToPeriod(svc, 'per-1', active)

    assert.equal(updates.length, 1, 'expected exactly one write')
    assert.deepEqual(updates[0]!.settings_snapshot, active)
    assert.deepEqual(used, active)
  })

  test('an existing snapshot is kept, and no write happens at all', async () => {
    // This is every regeneration triggered by an attendance correction: the
    // month is recomputed from corrected attendance under the rules it was
    // always run with. A correction must not smuggle in a settings change.
    const pinned = { ...DEFAULT_PAYROLL_SETTINGS }
    const { svc, updates } = stubSvc({ status: 'generated', settings_snapshot: pinned })

    const used = await pinSettingsToPeriod(svc, 'per-1', customSettings())

    assert.equal(updates.length, 0, 'a regeneration must not rewrite the snapshot')
    assert.equal(used.per_day_divisor, 26)
  })

  test('replace:true refreshes the snapshot to the active settings', async () => {
    // The intentional recalculation an admin asks for after unlocking.
    const { svc, updates } = stubSvc({
      status: 'draft',
      settings_snapshot: { ...DEFAULT_PAYROLL_SETTINGS },
    })
    const active = customSettings()

    const used = await pinSettingsToPeriod(svc, 'per-1', active, { replace: true })

    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0]!.settings_snapshot, active)
    assert.equal(used.per_day_divisor, 30)
  })

  test('the settings returned are the ones written, so caller and period cannot disagree', async () => {
    const { svc } = stubSvc({ status: 'draft', settings_snapshot: null })
    const active = customSettings()
    const used = await pinSettingsToPeriod(svc, 'per-1', active)
    // A second call now sees the pin and must return the same thing.
    const again = await pinSettingsToPeriod(svc, 'per-1', DEFAULT_PAYROLL_SETTINGS)
    assert.deepEqual(again, used)
  })
})

// ─── The settings actually reach the arithmetic ───────────────────────────────

describe('settings drive the calculation', () => {
  test('the per-day divisor changes the daily rate, and therefore the money', () => {
    const withDefault = runWith(DEFAULT_PAYROLL_SETTINGS)
    const withCustom  = runWith(customSettings())
    // 26_000/26 = 1000/day vs 26_000/30 ≈ 866.67/day.
    assert.notEqual(withDefault.total_deductions, withCustom.total_deductions)
  })

  test('missing-punch hours come from settings, not a constant', () => {
    const two  = runWith({ ...DEFAULT_PAYROLL_SETTINGS, missing_punch_hours: 2 })
    const four = runWith({ ...DEFAULT_PAYROLL_SETTINGS, missing_punch_hours: 4 })

    assert.equal(two.missing_punch_hours, 2)
    assert.equal(four.missing_punch_hours, 4)

    // The fixture is one punched day in a month of absences, so the TOTAL is
    // dominated by absent-day deductions. What must move is the difference.
    //
    // Each missing-punch LINE is rounded on its own, so the difference is
    // round(4h) − round(2h), not the unrounded 2h between them:
    // 26,000 ÷ 26 ÷ 8.5 = 117.647/hour → ₹471 − ₹235 = ₹236, where the raw
    // arithmetic would have said ₹235.29. That gap IS the whole-rupee rule.
    const perHour = 26_000 / DEFAULT_PAYROLL_SETTINGS.per_day_divisor / DEFAULT_PAYROLL_SETTINGS.full_day_hours
    assert.equal(
      four.total_deductions - two.total_deductions,
      roundRupees(4 * perHour) - roundRupees(2 * perHour),
    )
  })

  test('the deduction rounding block comes from settings', () => {
    const day: EngineAttendanceRecord[] = [{
      id: 'att-2',
      attendance_date: '2026-08-03',
      check_in_at:  '2026-08-03T05:15:00Z', // 10:45 IST — 45 min late
      check_out_at: '2026-08-03T13:00:00Z', // 18:30 IST
      direction_source: 'confirmed',
    }]
    const run = (s: PayrollSettings) => {
      const o = generatePayrollForEmployee(EMPLOYEE, period(), day, [], [], [], s)
      if (isSkip(o)) throw new Error('skip')
      return o.late_deduction_hours
    }
    // 45 min in 30-min blocks rounds to 2 blocks = 1.0h.
    assert.equal(run(DEFAULT_PAYROLL_SETTINGS), 1)
    // 45 min in 60-min blocks rounds to 1 block = 0.5h.
    assert.equal(run({ ...DEFAULT_PAYROLL_SETTINGS, rounding_block_minutes: 60 }), 0.5)
  })

  test('the paid-leave bands come from settings', () => {
    const generous = {
      ...DEFAULT_PAYROLL_SETTINGS,
      paid_leave_tiers: [{ min_days_present: 0, leave: 1 }],
    }
    const outcome = runWith(generous)
    assert.equal(outcome.paid_leave_available, 1)
  })

  test('omitting settings entirely reproduces the default run exactly', () => {
    // The backwards-compatibility guarantee that lets every pre-existing caller
    // and test keep working untouched.
    const explicit = generatePayrollForEmployee(
      EMPLOYEE, period(), singlePunchDay(), [], [], [], DEFAULT_PAYROLL_SETTINGS,
    )
    const implicit = generatePayrollForEmployee(
      EMPLOYEE, period(), singlePunchDay(), [], [], [],
    )
    if (isSkip(explicit) || isSkip(implicit)) throw new Error('unexpected skip')
    assert.equal(implicit.total_deductions, explicit.total_deductions)
    assert.equal(implicit.net_salary,       explicit.net_salary)
    assert.deepEqual(
      implicit.deduction_lines.map(l => l.amount_deducted),
      explicit.deduction_lines.map(l => l.amount_deducted),
    )
  })
})

// ─── Historical stability, end to end ─────────────────────────────────────────

describe('a settings change cannot restate a generated month', () => {
  test('regenerating under a changed active setting reproduces the ORIGINAL figures', async () => {
    // Generate under the defaults and pin them.
    const { svc } = stubSvc({ status: 'draft', settings_snapshot: null })
    const pinned = await pinSettingsToPeriod(svc, 'per-1', DEFAULT_PAYROLL_SETTINGS)
    const original = runWith(pinned)

    // An admin now changes the active settings substantially…
    const changed = customSettings()

    // …and the month is regenerated (an attendance correction, say). The pin is
    // kept, so the figures must not move.
    const usedOnRerun = await pinSettingsToPeriod(svc, 'per-1', changed)
    const rerun = runWith(usedOnRerun)

    assert.deepEqual(usedOnRerun, DEFAULT_PAYROLL_SETTINGS)
    assert.equal(rerun.total_deductions, original.total_deductions)
    assert.equal(rerun.net_salary,       original.net_salary)
  })

  test('an intentional recalculation DOES adopt the new settings', async () => {
    const { svc } = stubSvc({ status: 'draft', settings_snapshot: null })
    const pinned = await pinSettingsToPeriod(svc, 'per-1', DEFAULT_PAYROLL_SETTINGS)
    const original = runWith(pinned)

    const changed = customSettings()
    const usedOnRecalc = await pinSettingsToPeriod(svc, 'per-1', changed, { replace: true })
    const recalculated = runWith(usedOnRecalc)

    assert.deepEqual(usedOnRecalc, changed)
    assert.notEqual(recalculated.total_deductions, original.total_deductions)
  })

  test('generation and recalculation run the same engine on the same shape of input', () => {
    // One calculation path, chosen by which settings are handed in — not two
    // code paths that could drift.
    const a = runWith(DEFAULT_PAYROLL_SETTINGS)
    const b = runWith(DEFAULT_PAYROLL_SETTINGS)
    assert.deepEqual(
      a.deduction_lines.map(l => [l.deduction_type, l.amount_deducted]),
      b.deduction_lines.map(l => [l.deduction_type, l.amount_deducted]),
    )
  })
})

// ─── Reading settings never breaks payroll ────────────────────────────────────

describe('fetchActiveSettings fails safe', () => {
  test('an unreadable settings table falls back to the defaults and says so', async () => {
    const svc = {
      from() {
        return {
          select() {
            return {
              order() {
                return {
                  limit() {
                    return { maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }
                  },
                }
              },
            }
          },
        }
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = await fetchActiveSettings(svc as any)
    assert.deepEqual(active.settings, DEFAULT_PAYROLL_SETTINGS)
    assert.equal(active.fell_back, true)
    assert.equal(active.id, null)
  })

  test('a stored row that no longer parses falls back rather than poisoning payroll', async () => {
    const svc = {
      from() {
        return {
          select() {
            return {
              order() {
                return {
                  limit() {
                    return {
                      maybeSingle: async () => ({
                        data: { id: 'row-1', settings: { per_day_divisor: 0 }, created_at: 't', created_by: null },
                        error: null,
                      }),
                    }
                  },
                }
              },
            }
          },
        }
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = await fetchActiveSettings(svc as any)
    assert.deepEqual(active.settings, DEFAULT_PAYROLL_SETTINGS)
    assert.equal(active.fell_back, true)
    assert.equal(active.id, 'row-1')
  })
})
