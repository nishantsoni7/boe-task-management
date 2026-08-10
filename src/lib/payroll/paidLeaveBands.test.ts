/**
 * Editing the paid-leave bands.
 *
 *   npx tsx --test src/lib/payroll/paidLeaveBands.test.ts
 *
 * The bands decide how much paid leave an employee earns, so the failures worth
 * engineering against are the quiet ones:
 *
 *   · a DUPLICATE threshold. The engine awards the first band an employee
 *     reaches, so a second band at the same threshold can never apply to
 *     anybody — it sits in the settings page looking like a rule.
 *   · a NON-MONOTONIC allowance, where being present more days earns less
 *     leave. It short-changes the better-attending employee, which is the
 *     direction nobody thinks to check.
 *   · an EMPTY list. computePaidLeaveEntitlement would fall through every band
 *     and return 0 for everybody, silently withdrawing paid leave company-wide.
 *
 * The last group asserts the thing that makes all of this safe to ship: the
 * defaults still award exactly what they awarded before, and a saved change
 * cannot reach a month that has already been generated.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  orderBands,
  addBand,
  updateBand,
  removeBand,
  canAddBand,
  canRemoveBand,
  allowanceForDaysPresent,
} from './paidLeaveBands'
import {
  DEFAULT_PAYROLL_SETTINGS,
  MAX_PAID_LEAVE_BANDS,
  parsePayrollSettings,
  type PaidLeaveTier,
  type PayrollSettings,
} from './settings'
import { settingsForPeriod, pinSettingsToPeriod, saveSettings } from './settingsStore'
import { generatePayrollForEmployee } from './engine'
import { isSkip } from './types'
import type { EngineEmployee, EnginePeriod, EngineResult } from './types'

const DEFAULT_BANDS = DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers

function bands(...pairs: Array<[number, number]>): PaidLeaveTier[] {
  return pairs.map(([min_days_present, leave]) => ({ min_days_present, leave }))
}

function withBands(list: PaidLeaveTier[]): PayrollSettings {
  return { ...DEFAULT_PAYROLL_SETTINGS, paid_leave_tiers: list }
}

// ─── Ordering ─────────────────────────────────────────────────────────────────

describe('ordering follows the threshold, because the engine does', () => {
  test('bands are shown highest days-present first', () => {
    const out = orderBands(bands([0, 0], [16, 1], [11, 0.5]))
    assert.deepEqual(out.map(b => b.min_days_present), [16, 11, 0])
  })

  test('ordering does not mutate the input', () => {
    const input = bands([0, 0], [16, 1])
    orderBands(input)
    assert.deepEqual(input.map(b => b.min_days_present), [0, 16])
  })

  test('the displayed order is the order payroll evaluates in', () => {
    // 16 must be checked before 11, or an employee present 16 days would match
    // the 11 band first and earn 0.5 instead of 1.
    const ordered = orderBands(DEFAULT_BANDS)
    assert.equal(allowanceForDaysPresent(ordered, 20), 1)
    assert.equal(allowanceForDaysPresent(ordered, 16), 1)
    assert.equal(allowanceForDaysPresent(ordered, 15), 0.5)
    assert.equal(allowanceForDaysPresent(ordered, 11), 0.5)
    assert.equal(allowanceForDaysPresent(ordered, 10), 0)
    assert.equal(allowanceForDaysPresent(ordered, 0), 0)
  })

  test('the lookup mirrors the engine exactly, whatever order it is given', () => {
    const shuffled = bands([0, 0], [11, 0.5], [16, 1])
    for (const days of [0, 5, 10, 11, 15, 16, 26]) {
      assert.equal(
        allowanceForDaysPresent(shuffled, days),
        allowanceForDaysPresent(DEFAULT_BANDS, days),
        `days=${days}`,
      )
    }
  })
})

// ─── Add ──────────────────────────────────────────────────────────────────────

describe('adding a band', () => {
  test('adds a band at the lowest UNUSED threshold', () => {
    // 0 is free here, so the new band takes it.
    const out = addBand(bands([16, 1], [11, 0.5], [5, 0]))
    assert.equal(out.length, 4)
    assert.deepEqual(out[3], { min_days_present: 0, leave: 0 })
  })

  test('when 0 is already taken the new band goes above it, not on top of it', () => {
    // A valid list always has a 0-day band, so this is the ordinary case —
    // and "one below the lowest" would have collided with it.
    const out = addBand(DEFAULT_BANDS)
    const thresholds = out.map(b => b.min_days_present)
    assert.equal(new Set(thresholds).size, thresholds.length, 'thresholds must stay distinct')
    assert.ok(thresholds.includes(1), `expected a band at 1, got ${thresholds.join(', ')}`)
  })

  test('a new band never collides with an existing threshold', () => {
    // Colliding would meet the duplicate rule on a row the admin had not typed
    // into yet.
    let list = bands([16, 1], [0, 0])
    for (let i = 0; i < 5; i++) {
      list = addBand(list)
      const thresholds = list.map(b => b.min_days_present)
      assert.equal(new Set(thresholds).size, thresholds.length, `collision after add ${i + 1}`)
    }
  })

  test('the suggested threshold never goes below zero', () => {
    const out = addBand(bands([0, 0]))
    assert.equal(out[1]!.min_days_present, 0)
  })

  test('adding is refused at the cap, without throwing', () => {
    const full = Array.from({ length: MAX_PAID_LEAVE_BANDS }, (_, i) => ({
      min_days_present: MAX_PAID_LEAVE_BANDS - i,
      leave: 0,
    }))
    assert.equal(canAddBand(full), false)
    assert.equal(addBand(full).length, MAX_PAID_LEAVE_BANDS)
  })

  test('canAddBand allows a list below the cap', () => {
    assert.equal(canAddBand(DEFAULT_BANDS), true)
  })
})

// ─── Edit ─────────────────────────────────────────────────────────────────────

describe('editing a band', () => {
  test('changes only the band at the displayed position', () => {
    const out = updateBand(DEFAULT_BANDS, 1, { leave: 0.5 })
    assert.deepEqual(out.map(b => b.leave), [1, 0.5, 0])
  })

  test('the index means the DISPLAYED row, not the stored slot', () => {
    // Given an unordered list, index 0 must edit the highest threshold — the
    // row the admin actually clicked.
    const unordered = bands([0, 0], [16, 1], [11, 0.5])
    const out = updateBand(unordered, 0, { leave: 3 })
    const changed = out.find(b => b.min_days_present === 16)
    assert.equal(changed!.leave, 3)
    assert.equal(out.find(b => b.min_days_present === 0)!.leave, 0)
  })

  test('editing a threshold does not re-sort mid-edit', () => {
    // Re-sorting here would move the row out from under the cursor as soon as
    // a digit was typed. The save path sorts instead.
    const out = updateBand(DEFAULT_BANDS, 0, { min_days_present: 2 })
    assert.deepEqual(out.map(b => b.min_days_present), [2, 11, 0])
  })

  test('an out-of-range index changes nothing', () => {
    assert.deepEqual(updateBand(DEFAULT_BANDS, 9, { leave: 5 }), orderBands(DEFAULT_BANDS))
    assert.deepEqual(updateBand(DEFAULT_BANDS, -1, { leave: 5 }), orderBands(DEFAULT_BANDS))
  })

  test('the original list is not mutated', () => {
    const input = bands([16, 1], [0, 0])
    updateBand(input, 0, { leave: 9 })
    assert.equal(input[0]!.leave, 1)
  })
})

// ─── Remove ───────────────────────────────────────────────────────────────────

describe('removing a band', () => {
  test('removes the band at the displayed position', () => {
    const out = removeBand(DEFAULT_BANDS, 1)
    assert.deepEqual(out.map(b => b.min_days_present), [16, 0])
  })

  test('the LAST band can never be removed', () => {
    // An empty list makes computePaidLeaveEntitlement return 0 for everybody,
    // withdrawing paid leave company-wide without any error being raised.
    const one = bands([0, 0])
    assert.equal(canRemoveBand(one), false)
    assert.deepEqual(removeBand(one, 0), one)
  })

  test('canRemoveBand allows removal while more than one band remains', () => {
    assert.equal(canRemoveBand(DEFAULT_BANDS), true)
  })

  test('an out-of-range index removes nothing', () => {
    assert.equal(removeBand(DEFAULT_BANDS, 9).length, DEFAULT_BANDS.length)
  })
})

// ─── Validation: what must be refused ─────────────────────────────────────────

describe('duplicate and overlapping thresholds are refused', () => {
  test('two bands at the same threshold are rejected', () => {
    const parsed = parsePayrollSettings(withBands(bands([16, 1], [16, 0.5], [0, 0])))
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => /both start at 16/.test(i.message)))
  })

  test('the message says why, not just that it is invalid', () => {
    const parsed = parsePayrollSettings(withBands(bands([5, 1], [5, 0], [0, 0])))
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => /could never apply/.test(i.message)))
  })

  test('duplicates were previously accepted — this is the gap being closed', () => {
    // Equal values sort as "sorted", so the descending check passed them.
    const dupes = bands([16, 1], [16, 0.5], [0, 0])
    const sorted = [...dupes].sort((a, b) => b.min_days_present - a.min_days_present)
    assert.deepEqual(dupes, sorted, 'the old descending check could not see this')
    assert.equal(parsePayrollSettings(withBands(dupes)).ok, false, 'but it is refused now')
  })

  test('distinct thresholds are accepted', () => {
    assert.equal(parsePayrollSettings(withBands(bands([20, 2], [10, 1], [0, 0]))).ok, true)
  })
})

describe('more attendance can never earn less leave', () => {
  test('a lower threshold paying more is rejected', () => {
    const parsed = parsePayrollSettings(withBands(bands([16, 0.5], [11, 1], [0, 0])))
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => /More attendance cannot earn less leave/.test(i.message)))
  })

  test('equal allowances across bands are allowed', () => {
    assert.equal(parsePayrollSettings(withBands(bands([16, 1], [11, 1], [0, 0]))).ok, true)
  })

  test('a strictly increasing curve is allowed', () => {
    assert.equal(parsePayrollSettings(withBands(bands([20, 3], [10, 2], [0, 1]))).ok, true)
  })
})

describe('invalid numeric values are refused', () => {
  test('a negative threshold or allowance is rejected', () => {
    assert.equal(parsePayrollSettings(withBands(bands([-1, 1], [0, 0]))).ok, false)
    assert.equal(parsePayrollSettings(withBands(bands([16, -1], [0, 0]))).ok, false)
  })

  test('a fractional threshold is rejected — days present are whole days', () => {
    assert.equal(parsePayrollSettings(withBands(bands([16.5, 1], [0, 0]))).ok, false)
  })

  test('an allowance off the half-day grid is rejected', () => {
    assert.equal(parsePayrollSettings(withBands(bands([16, 0.3], [0, 0]))).ok, false)
  })

  test('NaN, Infinity and strings are rejected', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.equal(parsePayrollSettings(withBands(bands([16, bad], [0, 0]))).ok, false, String(bad))
    }
    const parsed = parsePayrollSettings({
      ...DEFAULT_PAYROLL_SETTINGS,
      paid_leave_tiers: [{ min_days_present: '16', leave: 1 }, { min_days_present: 0, leave: 0 }],
    })
    assert.equal(parsed.ok, false)
  })

  test('a threshold beyond a month is rejected', () => {
    assert.equal(parsePayrollSettings(withBands(bands([32, 1], [0, 0]))).ok, false)
  })

  test('an empty list is rejected — the engine cannot work without one', () => {
    assert.equal(parsePayrollSettings(withBands([])).ok, false)
  })

  test('a list without a 0-day band is rejected, so everybody falls into one', () => {
    assert.equal(parsePayrollSettings(withBands(bands([16, 1], [11, 0.5]))).ok, false)
  })

  test('more bands than the cap are rejected', () => {
    const tooMany = Array.from({ length: MAX_PAID_LEAVE_BANDS + 1 }, (_, i) => ({
      min_days_present: MAX_PAID_LEAVE_BANDS - i,
      leave: 0,
    }))
    assert.equal(parsePayrollSettings(withBands(tooMany)).ok, false)
  })

  test('every problem is reported at once, not one at a time', () => {
    const parsed = parsePayrollSettings(withBands(bands([16, 1], [16, 0.5], [5, 1], [0, 0])))
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    const tierIssues = parsed.issues.filter(i => i.key === 'paid_leave_tiers')
    assert.ok(tierIssues.length >= 2, `expected several issues, got ${tierIssues.length}`)
  })
})

// ─── Round trip through save ──────────────────────────────────────────────────

describe('a valid edit survives the save path', () => {
  test('add, edit and remove produce a settings object the API accepts', () => {
    let list = orderBands(DEFAULT_BANDS)
    list = addBand(list)                                   // 4 bands
    list = updateBand(list, 3, { min_days_present: 5, leave: 0.5 })
    list = removeBand(list, 2)                             // drop the old 0-band
    list = updateBand(list, 2, { min_days_present: 0 })    // keep a 0-day band

    const parsed = parsePayrollSettings(withBands(list))
    assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.issues))
    if (!parsed.ok) return
    assert.deepEqual(parsed.settings.paid_leave_tiers.map(b => b.min_days_present), [16, 11, 0])
  })

  test('an UNORDERED list is rejected rather than quietly re-sorted', () => {
    // Silently accepting an ascending list would mean the settings page could
    // show one priority order while the engine used another. The editor always
    // sends ordered bands (orderBands runs before every change), so this is a
    // guard against some other caller, not against the form.
    const parsed = parsePayrollSettings(withBands(bands([0, 0], [16, 1], [11, 0.5])))
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => /ordered from the highest days-present down/.test(i.message)))
  })

  test('the editor’s own output is always accepted, because it orders first', () => {
    const edited = orderBands(bands([0, 0], [16, 1], [11, 0.5]))
    const parsed = parsePayrollSettings(withBands(edited))
    assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.issues))
    if (!parsed.ok) return
    assert.deepEqual(parsed.settings.paid_leave_tiers.map(b => b.min_days_present), [16, 11, 0])
  })
})

// ─── Authorization ────────────────────────────────────────────────────────────

describe('authorization is unchanged by this work', () => {
  const route = readFileSync(join(process.cwd(), 'src/app/api/payroll/settings/route.ts'), 'utf8')

  test('both verbs are admin-only through the shared helper', () => {
    assert.equal((route.match(/requireAdmin\(req\)/g) ?? []).length, 2, 'GET and PUT')
    assert.match(route, /export async function GET/)
    assert.match(route, /export async function PUT/)
  })

  test('there is no employee or self-service path to settings', () => {
    assert.doesNotMatch(route, /requireSelfOrAdmin/)
    assert.doesNotMatch(route, /employee_id/)
  })

  test('the saved bands are the VALIDATED ones, never the raw body', () => {
    assert.match(route, /const parsed = parsePayrollSettings\(payload\.settings\)/)
    assert.match(route, /saveSettings\(svc, parsed\.settings, auth\.id, note\)/)
    assert.doesNotMatch(route, /saveSettings\(svc, payload\.settings/)
  })

  test('the actor comes from the token, not the request body', () => {
    assert.match(route, /auth\.id/)
    assert.doesNotMatch(route, /payload\.created_by/)
  })

  test('the database still refuses non-admins, as a second line', () => {
    const migration = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260828000000_payroll_settings.sql'),
      'utf8',
    )
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
    assert.doesNotMatch(migration, /employees_read_payroll_settings/)
  })
})

// ─── Audit / version record ───────────────────────────────────────────────────

describe('saving a band change writes an audit row', () => {
  function stubInsert() {
    const inserts: Record<string, unknown>[] = []
    const svc = {
      from(table: string) {
        assert.equal(table, 'payroll_settings')
        return {
          insert(row: Record<string, unknown>) {
            inserts.push(row)
            return {
              select: () => ({
                single: async () => ({ data: { id: 'row-1', created_at: '2026-08-10T00:00:00Z' }, error: null }),
              }),
            }
          },
        }
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { svc: svc as any, inserts }
  }

  test('an INSERT is performed, never an UPDATE — the table is append-only', async () => {
    const { svc, inserts } = stubInsert()
    await saveSettings(svc, withBands(bands([20, 2], [0, 0])), 'admin-1', 'raised the allowance')
    assert.equal(inserts.length, 1)
  })

  test('the row records who changed it and why', async () => {
    const { svc, inserts } = stubInsert()
    await saveSettings(svc, withBands(bands([20, 2], [0, 0])), 'admin-1', 'raised the allowance')
    assert.equal(inserts[0]!.created_by, 'admin-1')
    assert.equal(inserts[0]!.note, 'raised the allowance')
  })

  test('the stored settings carry the new bands', async () => {
    const { svc, inserts } = stubInsert()
    await saveSettings(svc, withBands(bands([20, 2], [0, 0])), 'admin-1')
    const stored = inserts[0]!.settings as PayrollSettings
    assert.deepEqual(stored.paid_leave_tiers, bands([20, 2], [0, 0]))
  })

  test('invalid bands are refused before anything is written', async () => {
    const { svc, inserts } = stubInsert()
    await assert.rejects(
      () => saveSettings(svc, withBands(bands([16, 1], [16, 0], [0, 0])), 'admin-1'),
      /invalid settings/,
    )
    assert.equal(inserts.length, 0, 'nothing may be stored when validation fails')
  })
})

// ─── Snapshot receives the saved bands ────────────────────────────────────────

describe('the period snapshot carries the bands', () => {
  function stubPeriod(row: { status: 'draft' | 'generated' | 'locked'; settings_snapshot: unknown }) {
    const updates: Record<string, unknown>[] = []
    const svc = {
      from() {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
          update(patch: Record<string, unknown>) {
            updates.push(patch)
            if ('settings_snapshot' in patch) row.settings_snapshot = patch.settings_snapshot
            return { eq: async () => ({ error: null }) }
          },
        }
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { svc: svc as any, updates }
  }

  test('generating pins the bands that were active', async () => {
    const { svc, updates } = stubPeriod({ status: 'draft', settings_snapshot: null })
    const active = withBands(bands([20, 2], [10, 1], [0, 0]))

    const used = await pinSettingsToPeriod(svc, 'per-1', active)

    const pinned = updates[0]!.settings_snapshot as PayrollSettings
    assert.deepEqual(pinned.paid_leave_tiers, bands([20, 2], [10, 1], [0, 0]))
    assert.deepEqual(used.paid_leave_tiers, bands([20, 2], [10, 1], [0, 0]))
  })

  test('a later band change does not reach a period already pinned', async () => {
    const { svc, updates } = stubPeriod({
      status: 'generated',
      settings_snapshot: withBands(DEFAULT_BANDS),
    })

    const used = await pinSettingsToPeriod(svc, 'per-1', withBands(bands([20, 3], [0, 0])))

    assert.equal(updates.length, 0, 'a regeneration must not rewrite the snapshot')
    assert.deepEqual(used.paid_leave_tiers, DEFAULT_BANDS)
  })

  test('an intentional recalculation adopts the new bands', async () => {
    const { svc } = stubPeriod({ status: 'draft', settings_snapshot: withBands(DEFAULT_BANDS) })
    const used = await pinSettingsToPeriod(svc, 'per-1', withBands(bands([20, 3], [0, 0])), { replace: true })
    assert.deepEqual(used.paid_leave_tiers, bands([20, 3], [0, 0]))
  })
})

// ─── Existing payroll is unaffected ───────────────────────────────────────────

describe('a band change cannot restate generated payroll', () => {
  test('a generated period reads its own bands, not the new ones', () => {
    const chosen = settingsForPeriod(
      { status: 'generated', settings_snapshot: withBands(DEFAULT_BANDS) },
      withBands(bands([20, 3], [0, 0])),
    )
    assert.deepEqual(chosen.paid_leave_tiers, DEFAULT_BANDS)
  })

  test('a locked period reads its own bands too', () => {
    const chosen = settingsForPeriod(
      { status: 'locked', settings_snapshot: withBands(DEFAULT_BANDS) },
      withBands(bands([20, 3], [0, 0])),
    )
    assert.deepEqual(chosen.paid_leave_tiers, DEFAULT_BANDS)
  })

  test('a legacy generated period keeps the legacy bands, not today’s', () => {
    const chosen = settingsForPeriod(
      { status: 'generated', settings_snapshot: null },
      withBands(bands([20, 3], [0, 0])),
    )
    assert.deepEqual(chosen.paid_leave_tiers, DEFAULT_BANDS)
  })
})

// ─── The defaults still pay what they always paid ─────────────────────────────

describe('default bands reproduce current payroll behaviour', () => {
  const EMPLOYEE: EngineEmployee = {
    id: 'emp-1',
    monthly_salary: 26_000,
    payroll_active: true,
    joining_date: null,
    employment_type: 'permanent',
  }
  const PERIOD: EnginePeriod = { id: 'per-1', payroll_month: 7, payroll_year: 2026, status: 'draft' }

  /** July 2026 with `presentDays` working days punched full and on time. */
  function run(presentDays: number, settings: PayrollSettings): EngineResult {
    const records = []
    let added = 0
    for (let d = 1; d <= 31 && added < presentDays; d++) {
      const date = `2026-07-${String(d).padStart(2, '0')}`
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
      records.push({
        id: `r-${d}`,
        attendance_date: date,
        check_in_at:  new Date(Date.UTC(2026, 6, d, 4, 30)).toISOString(),  // 10:00 IST
        check_out_at: new Date(Date.UTC(2026, 6, d, 13, 0)).toISOString(),  // 18:30 IST
        direction_source: 'confirmed' as const,
      })
      added++
    }
    const outcome = generatePayrollForEmployee(EMPLOYEE, PERIOD, records, [], [], [], settings)
    assert.equal(isSkip(outcome), false)
    return outcome as EngineResult
  }

  test('the seeded bands award exactly what they awarded before', () => {
    // 16+ present → 1 day, 11–15 → 0.5, below 11 → 0. The figures the module
    // has produced since it was written.
    assert.equal(run(20, DEFAULT_PAYROLL_SETTINGS).paid_leave_available, 1)
    assert.equal(run(16, DEFAULT_PAYROLL_SETTINGS).paid_leave_available, 1)
    assert.equal(run(15, DEFAULT_PAYROLL_SETTINGS).paid_leave_available, 0.5)
    assert.equal(run(11, DEFAULT_PAYROLL_SETTINGS).paid_leave_available, 0.5)
    assert.equal(run(10, DEFAULT_PAYROLL_SETTINGS).paid_leave_available, 0)
  })

  test('the engine and the editor’s lookup never disagree', () => {
    for (const days of [0, 10, 11, 15, 16, 20]) {
      assert.equal(
        run(days, DEFAULT_PAYROLL_SETTINGS).paid_leave_available,
        allowanceForDaysPresent(DEFAULT_BANDS, days),
        `days=${days}`,
      )
    }
  })

  test('an edited band actually changes the allowance a new run awards', () => {
    // Proof the setting is live rather than decorative.
    const generous = withBands(bands([10, 2], [0, 0]))
    assert.equal(run(12, DEFAULT_PAYROLL_SETTINGS).paid_leave_available, 0.5)
    assert.equal(run(12, generous).paid_leave_available, 2)
  })

  test('removing every band but the 0-day one withdraws the allowance, visibly', () => {
    const none = withBands(bands([0, 0]))
    assert.equal(run(20, none).paid_leave_available, 0)
  })
})

// ─── The page uses the shared helpers ─────────────────────────────────────────

describe('the settings page edits through these helpers', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/payroll/settings/page.tsx'), 'utf8')

  test('it imports the shared band operations rather than reimplementing them', () => {
    assert.match(page, /from '@\/lib\/payroll\/paidLeaveBands'/)
    for (const fn of ['orderBands', 'addBand', 'updateBand', 'removeBand', 'canAddBand', 'canRemoveBand']) {
      assert.match(page, new RegExp(`\\b${fn}\\b`), `page does not use ${fn}`)
    }
  })

  test('the bands count toward the form being dirty', () => {
    // Without this an admin who only changed a band found Save disabled.
    assert.match(page, /draft\.paid_leave_tiers !== saved\.paid_leave_tiers/)
  })

  test('every band problem is rendered, not just the first', () => {
    assert.match(page, /issuesFor\('paid_leave_tiers'\)/)
    assert.match(page, /issues\.filter\(i => i\.key === key\)/)
  })

  test('the rule is explained in words beside the editor', () => {
    assert.match(page, /first one the employee reaches/)
    assert.match(page, /last band must start at 0 days/)
  })

  test('there are no reorder controls, because order is derived', () => {
    // Order is entirely determined by the threshold and re-sorted on save;
    // drag handles would offer a choice that does not exist.
    assert.doesNotMatch(page, /moveBandUp|moveBandDown|draggable/)
  })

  test('save still goes through the same validator the API runs', () => {
    assert.match(page, /settingsFromDraft\(draft\)/)
    assert.match(page, /parsePayrollSettings\(candidate\)/)
  })
})
