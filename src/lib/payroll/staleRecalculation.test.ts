/**
 * Stale payroll, and bringing it back into line.
 *
 *   npx tsx --test src/lib/payroll/staleRecalculation.test.ts
 *
 * The 20 July report had a second half: the page said attendance had changed
 * after generation and that the day rows were current while the salary figures
 * were stale. That warning was right, and it must stay right — but a warning
 * with no route out of it is a dead end, so these assert both directions.
 *
 * Staleness is decided by re-running the engine over live attendance and
 * comparing its total to the STORED total (buildDayView in
 * ./resultDetailPayload). That comparison is only meaningful if both sides used
 * the same settings, which is why the live run now takes the period's snapshot —
 * it previously ran on defaults, so a settings edit could masquerade as an
 * attendance change.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineAttendanceRecord, EngineResult } from './types'
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from './settings'
import { settingsForPeriod, pinSettingsToPeriod } from './settingsStore'

const S = DEFAULT_PAYROLL_SETTINGS
const ist = (d: number, h: number, m: number) =>
  new Date(Date.UTC(2026, 6, d, h - 5, m - 30)).toISOString()

const EMPLOYEE: EngineEmployee = {
  id: 'emp-1', monthly_salary: 20_000, payroll_active: true,
  joining_date: null, employment_type: 'permanent',
}
const draft: EnginePeriod = { id: 'p', payroll_month: 7, payroll_year: 2026, status: 'draft' }

function july(overrides: Record<number, [number, number, number, number] | null>): EngineAttendanceRecord[] {
  const out: EngineAttendanceRecord[] = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-07-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    if (d in overrides) {
      const o = overrides[d]
      if (o === null) continue
      out.push({ id: `r${d}`, attendance_date: date, check_in_at: ist(d, o[0], o[1]), check_out_at: ist(d, o[2], o[3]), direction_source: 'confirmed' })
    } else {
      out.push({ id: `r${d}`, attendance_date: date, check_in_at: ist(d, 10, 0), check_out_at: ist(d, 18, 30), direction_source: 'confirmed' })
    }
  }
  return out
}

function run(records: EngineAttendanceRecord[], settings: PayrollSettings = S, period = draft): EngineResult {
  const o = generatePayrollForEmployee(EMPLOYEE, period, records, [], [], [], settings)
  assert.equal(isSkip(o), false)
  return o as EngineResult
}

/** The staleness rule, exactly as buildDayView applies it. */
const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005
const isStale = (storedTotal: number | null, live: EngineResult) =>
  storedTotal != null && !sameMoney(storedTotal, live.total_deductions)

const linesOn = (r: EngineResult, date: string) => r.deduction_lines.filter(l => l.line_date === date)

// The month as it stood when payroll was generated: 20 July was a full day.
const BEFORE = july({ 7: null, 20: [10, 0, 18, 30], 21: null })
// …and after the attendance import corrected it to the real punches.
const AFTER  = july({ 7: null, 20: [10, 5, 13, 33], 21: null })

describe('20. a changed attendance row marks an existing result stale', () => {
  const stored = run(BEFORE)

  test('the stored result did not include 20 July', () => {
    assert.equal(linesOn(stored, '2026-07-20').length, 0)
    assert.equal(stored.total_deductions, 769)
  })

  test('re-running over the CHANGED attendance disagrees with the stored total', () => {
    const live = run(AFTER)
    assert.equal(live.total_deductions, 1_154)
    assert.equal(isStale(stored.total_deductions, live), true)
  })

  test('an unchanged month is not stale', () => {
    assert.equal(isStale(stored.total_deductions, run(BEFORE)), false)
  })

  test('staleness compares deduction totals, not net salary', () => {
    // Net salary includes adjustments, which the day view deliberately omits;
    // comparing it would report every adjusted month as stale.
    const live = run(AFTER)
    assert.notEqual(stored.net_salary, live.net_salary)
    assert.equal(isStale(stored.total_deductions, run(BEFORE)), false)
  })
})

describe('21–22. intentional recalculation fixes it', () => {
  const stored = run(BEFORE)
  const recalculated = run(AFTER)

  test('21. recalculation ADDS the previously missing 20 July row', () => {
    assert.equal(linesOn(stored, '2026-07-20').length, 0)
    assert.equal(linesOn(recalculated, '2026-07-20').length, 1)
    assert.equal(linesOn(recalculated, '2026-07-20')[0]!.amount_deducted, 385)
  })

  test('22. it preserves the unrelated 21 July absence', () => {
    assert.equal(linesOn(recalculated, '2026-07-21')[0]!.deduction_type, 'absent')
    assert.equal(linesOn(recalculated, '2026-07-21')[0]!.amount_deducted, 769)
  })

  test('22b. and the unrelated company-paid 07 July stays at ₹0', () => {
    const july7 = linesOn(recalculated, '2026-07-07')[0]!
    assert.equal(july7.waived_by, 'paid_leave')
    assert.equal(july7.amount_deducted, 0)
  })

  test('totals come from the rounded stored lines', () => {
    const sum = recalculated.deduction_lines.reduce((s, l) => s + l.amount_deducted, 0)
    assert.equal(recalculated.total_deductions, sum)
    assert.equal(recalculated.total_deductions, 1_154)
  })

  test('24. after recalculation the result is no longer stale', () => {
    assert.equal(isStale(recalculated.total_deductions, run(AFTER)), false)
  })
})

describe('23. repeated recalculation does not duplicate anything', () => {
  test('three runs give one 20 July line and the same total each time', () => {
    for (let i = 0; i < 3; i++) {
      const r = run(AFTER)
      assert.equal(linesOn(r, '2026-07-20').length, 1, `run ${i + 1}`)
      assert.equal(r.deduction_lines.filter(l => l.deduction_type === 'absent').length, 2)
      assert.equal(r.total_deductions, 1_154)
    }
  })
})

describe('25. a failed recalculation leaves the stored result alone', () => {
  test('the engine SKIPS rather than returning a partial result', () => {
    // A skip carries no figures at all, so a caller cannot half-write one.
    const noSalary = { ...EMPLOYEE, monthly_salary: null as unknown as number }
    const o = generatePayrollForEmployee(noSalary, draft, AFTER, [], [], [], S)
    assert.equal(isSkip(o), true)
    if (!isSkip(o)) return
    assert.equal(o.reason, 'no_salary_configured')
    assert.equal('total_deductions' in o, false)
    assert.equal('deduction_lines' in o, false)
  })

  test('an excluded employee also skips, leaving anything stored untouched', () => {
    const inactive = { ...EMPLOYEE, payroll_active: false }
    const o = generatePayrollForEmployee(inactive, draft, AFTER, [], [], [], S)
    assert.equal(isSkip(o), true)
  })

  test('so the stale comparison still reports stale — the warning is not cleared', () => {
    const stored = run(BEFORE)
    // Nothing was written, so the stored total is unchanged and still disagrees.
    assert.equal(isStale(stored.total_deductions, run(AFTER)), true)
  })
})

describe('26. locked payroll is not recalculated', () => {
  test('the engine refuses a locked period outright', () => {
    const locked: EnginePeriod = { ...draft, status: 'locked' }
    const o = generatePayrollForEmployee(EMPLOYEE, locked, AFTER, [], [], [], S)
    assert.equal(isSkip(o), true)
    if (!isSkip(o)) return
    assert.equal(o.reason, 'period_locked')
  })

  test('a locked period keeps its own settings snapshot for display', () => {
    const chosen = settingsForPeriod(
      { status: 'locked', settings_snapshot: { ...S, per_day_divisor: 30 } },
      S,
    )
    assert.equal(chosen.per_day_divisor, 30)
  })
})

describe('27. the day view and the stored money use the SAME settings', () => {
  test('a generated period resolves to its snapshot, not to today’s defaults', () => {
    const snapshot: PayrollSettings = { ...S, lunch_out_after_minutes: 13 * 60, lunch_in_before_minutes: 13 * 60 + 30 }
    const chosen = settingsForPeriod({ status: 'generated', settings_snapshot: snapshot }, S)
    assert.equal(chosen.lunch_in_before_minutes, 13 * 60 + 30)
    assert.notEqual(chosen.lunch_in_before_minutes, S.lunch_in_before_minutes)
  })

  test('running the day view under the wrong settings would invent staleness', () => {
    // The defect this guards: the live run used defaults while the stored money
    // came from a snapshot, so a settings difference read as an attendance change.
    const snapshot: PayrollSettings = { ...S, per_day_divisor: 30 }
    const storedUnderSnapshot = run(AFTER, snapshot)
    const liveUnderDefaults   = run(AFTER, S)
    const liveUnderSnapshot   = run(AFTER, snapshot)

    assert.equal(isStale(storedUnderSnapshot.total_deductions, liveUnderDefaults), true,
      'defaults vs snapshot look stale even though attendance never moved')
    assert.equal(isStale(storedUnderSnapshot.total_deductions, liveUnderSnapshot), false,
      'the same settings agree, so nothing is reported stale')
  })

  test('a draft period with no snapshot uses the active settings', () => {
    assert.deepEqual(settingsForPeriod({ status: 'draft', settings_snapshot: null }, S), S)
  })
})

describe('recalculation keeps the period’s pinned settings', () => {
  function stubPeriod(row: { status: 'draft' | 'generated' | 'locked'; settings_snapshot: unknown }) {
    const updates: Record<string, unknown>[] = []
    const svc = {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
        update(patch: Record<string, unknown>) {
          updates.push(patch)
          if ('settings_snapshot' in patch) row.settings_snapshot = patch.settings_snapshot
          return { eq: async () => ({ error: null }) }
        },
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { svc: svc as any, updates }
  }

  test('an attendance-driven recalculation does not adopt new settings', () => {
    const pinned: PayrollSettings = { ...S, per_day_divisor: 26 }
    const { svc, updates } = stubPeriod({ status: 'generated', settings_snapshot: pinned })
    return pinSettingsToPeriod(svc, 'p', { ...S, per_day_divisor: 30 }).then(used => {
      assert.equal(updates.length, 0)
      assert.equal(used.per_day_divisor, 26)
    })
  })

  test('so the corrected 20 July is charged under the ORIGINAL rules', () => {
    const pinned: PayrollSettings = { ...S }
    const recalculated = run(AFTER, pinned)
    assert.equal(linesOn(recalculated, '2026-07-20')[0]!.amount_deducted, 385)
  })
})

describe('28–30. every reader shows the same stored figures', () => {
  const recalculated = run(AFTER)

  test('28/29. the day breakdown and the ledger agree on 20 July', () => {
    const day = recalculated.day_results.find(d => d.date === '2026-07-20')!
    const ledger = linesOn(recalculated, '2026-07-20')
    assert.equal(day.classification, 'half_day')
    assert.equal(day.total_deduction_amount, 385)
    assert.equal(day.total_deduction_amount, ledger.reduce((s, l) => s + l.amount_deducted, 0))
  })

  test('30. the report total is the stored total, not a re-derivation', () => {
    const sum = recalculated.deduction_lines.reduce((s, l) => s + l.amount_deducted, 0)
    assert.equal(recalculated.total_deductions, sum)
    assert.equal(recalculated.gross_salary - recalculated.total_deductions, 18_846)
  })

  test('the aggregate half-day count includes the corrected day', () => {
    assert.equal(recalculated.half_day_count, 1)
  })

  test('the corrected day still counts as PRESENT, not absent', () => {
    const before = run(BEFORE)
    assert.equal(recalculated.days_present, before.days_present,
      'a half day is still a day present — only its cost changed')
  })
})
