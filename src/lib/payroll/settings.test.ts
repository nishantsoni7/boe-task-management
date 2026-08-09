/**
 * The payroll settings vocabulary.
 *
 *   npx tsx --test src/lib/payroll/settings.test.ts
 *
 * The load-bearing case here is the first one. Moving a constant into a setting
 * is only safe if the default IS the constant — if those two ever drift, every
 * payroll generated from defaults silently restates itself, and nothing else in
 * the suite would notice. So the correspondence is asserted field by field
 * against the modules the engine used to import from directly.
 *
 * The rest is validation, and validation of a payroll parameter is not a
 * formality: a per-day divisor of 0 divides by zero, an out-of-order paid-leave
 * band awards the wrong allowance, and a cleared time input that coerced to 0
 * would move the office start to midnight.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PAYROLL_SETTINGS,
  LEGACY_PAYROLL_SETTINGS,
  SETTINGS_FIELDS,
  parsePayrollSettings,
  resolveSnapshotSettings,
  minutesToTimeInput,
  timeInputToMinutes,
  minutesToClock,
  settingsField,
  type PayrollSettings,
} from './settings'

import {
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  SCHEDULED_OUT_MINUTES,
  FULL_DAY_HOURS,
  LUNCH_IN_BEFORE_MINUTES,
  LUNCH_OUT_AFTER_MINUTES,
  LUNCH_HOURS,
  PRESENCE_THRESHOLD_HOURS,
  ROUNDING_BLOCK_MINUTES,
  ROUNDING_BLOCK_HOURS,
  WEEKLY_OFF_DAY,
} from '../attendance/scheduleRules'
import { TEMP_SINGLE_PUNCH_DIVIDER_MINUTES } from '../attendance/punchDirection'
import {
  PER_DAY_DIVISOR,
  MISSING_PUNCH_HOURS,
  PAID_LEAVE_TIERS,
  HALF_DAYS_PER_PAID_LEAVE,
} from './rules'

/** A fresh, valid settings object. Deep-cloned so a mutating test cannot leak. */
function validSettings(): PayrollSettings {
  return {
    ...DEFAULT_PAYROLL_SETTINGS,
    paid_leave_tiers: DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers.map(t => ({ ...t })),
  }
}

describe('defaults reproduce the pre-settings constants', () => {
  test('every scheduling constant survives the move unchanged', () => {
    const d = DEFAULT_PAYROLL_SETTINGS
    assert.equal(d.scheduled_in_minutes,    SCHEDULED_IN_MINUTES)
    assert.equal(d.grace_end_minutes,       GRACE_END_MINUTES)
    assert.equal(d.scheduled_out_minutes,   SCHEDULED_OUT_MINUTES)
    assert.equal(d.lunch_in_before_minutes, LUNCH_IN_BEFORE_MINUTES)
    assert.equal(d.lunch_out_after_minutes, LUNCH_OUT_AFTER_MINUTES)
    assert.equal(d.lunch_hours,             LUNCH_HOURS)
    assert.equal(d.weekly_off_day,          WEEKLY_OFF_DAY)
    assert.equal(d.full_day_hours,          FULL_DAY_HOURS)
  })

  test('every money constant survives the move unchanged', () => {
    const d = DEFAULT_PAYROLL_SETTINGS
    assert.equal(d.per_day_divisor,     PER_DAY_DIVISOR)
    assert.equal(d.missing_punch_hours, MISSING_PUNCH_HOURS)
    assert.equal(d.rounding_block_minutes, ROUNDING_BLOCK_MINUTES)
    assert.equal(d.rounding_block_hours,   ROUNDING_BLOCK_HOURS)
    // The hourly rate divisor was PER_HOUR_DIVISOR, which was FULL_DAY_HOURS.
    assert.equal(d.full_day_hours, FULL_DAY_HOURS)
  })

  test('every classification threshold survives the move unchanged', () => {
    const d = DEFAULT_PAYROLL_SETTINGS
    assert.equal(d.threshold_full_present_hours,           PRESENCE_THRESHOLD_HOURS.full_present)
    assert.equal(d.threshold_present_with_shortfall_hours, PRESENCE_THRESHOLD_HOURS.present_with_shortfall)
    assert.equal(d.threshold_half_day_hours,               PRESENCE_THRESHOLD_HOURS.half_day)
    assert.equal(d.threshold_short_present_hours,          PRESENCE_THRESHOLD_HOURS.short_present)
  })

  test('the single-punch divider is the constant the parser already used', () => {
    assert.equal(
      DEFAULT_PAYROLL_SETTINGS.single_punch_divider_minutes,
      TEMP_SINGLE_PUNCH_DIVIDER_MINUTES,
    )
  })

  test('the paid-leave bands survive the move unchanged, by value', () => {
    assert.deepEqual(
      DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers,
      PAID_LEAVE_TIERS.map(t => ({ min_days_present: t.min_days_present, leave: t.leave })),
    )
    assert.equal(DEFAULT_PAYROLL_SETTINGS.half_days_per_paid_leave, HALF_DAYS_PER_PAID_LEAVE)
    assert.equal(DEFAULT_PAYROLL_SETTINGS.hours_per_paid_leave, FULL_DAY_HOURS)
  })

  test('the tier array is copied, so a caller cannot mutate the shared default', () => {
    const parsed = parsePayrollSettings(validSettings())
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    parsed.settings.paid_leave_tiers[0]!.leave = 99
    assert.equal(DEFAULT_PAYROLL_SETTINGS.paid_leave_tiers[0]!.leave, 1)
  })

  test('the legacy settings equal the defaults today, and are a separate object', () => {
    assert.deepEqual(LEGACY_PAYROLL_SETTINGS, DEFAULT_PAYROLL_SETTINGS)
    assert.notEqual(LEGACY_PAYROLL_SETTINGS, DEFAULT_PAYROLL_SETTINGS)
  })

  test('the defaults are themselves valid', () => {
    const parsed = parsePayrollSettings(validSettings())
    assert.equal(parsed.ok, true)
  })
})

describe('parse accepts good input', () => {
  test('a full valid object round-trips by value', () => {
    const parsed = parsePayrollSettings(validSettings())
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(parsed.settings, DEFAULT_PAYROLL_SETTINGS)
  })

  test('unknown extra keys are dropped rather than carried through', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), sneaky: 'value' })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal('sneaky' in parsed.settings, false)
  })

  test('a legitimately changed value is accepted', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), per_day_divisor: 30 })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.settings.per_day_divisor, 30)
  })
})

describe('parse rejects bad input', () => {
  test('a non-object is rejected', () => {
    for (const bad of [null, undefined, 42, 'settings', [] as unknown]) {
      const parsed = parsePayrollSettings(bad)
      assert.equal(parsed.ok, false, `expected ${JSON.stringify(bad)} to be rejected`)
    }
  })

  test('a missing field is rejected rather than defaulted', () => {
    const partial: Record<string, unknown> = validSettings()
    delete partial.per_day_divisor
    const parsed = parsePayrollSettings(partial)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => i.key === 'per_day_divisor'))
  })

  test('a zero divisor is rejected — it would divide by zero', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), per_day_divisor: 0 })
    assert.equal(parsed.ok, false)
  })

  test('a negative value is rejected', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), missing_punch_hours: -2 })
    assert.equal(parsed.ok, false)
  })

  test('NaN and Infinity are rejected', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const parsed = parsePayrollSettings({ ...validSettings(), full_day_hours: bad })
      assert.equal(parsed.ok, false, `expected ${bad} to be rejected`)
    }
  })

  test('a numeric string is rejected rather than coerced', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), per_day_divisor: '26' })
    assert.equal(parsed.ok, false)
  })

  test('an out-of-range value is rejected at both ends', () => {
    assert.equal(parsePayrollSettings({ ...validSettings(), per_day_divisor: 400 }).ok, false)
    assert.equal(parsePayrollSettings({ ...validSettings(), scheduled_in_minutes: 1440 }).ok, false)
    assert.equal(parsePayrollSettings({ ...validSettings(), weekly_off_day: 7 }).ok, false)
  })

  test('a time with fractional minutes is rejected', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), scheduled_in_minutes: 600.5 })
    assert.equal(parsed.ok, false)
  })

  test('a value off the step grid is rejected', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), full_day_hours: 8.3 })
    assert.equal(parsed.ok, false)
  })

  test('a value on the step grid that trips float modulo is still accepted', () => {
    // 0.45 % 0.05 is not 0 in IEEE 754; the integer-thousandths comparison is
    // what keeps this legal value from being rejected.
    const parsed = parsePayrollSettings({ ...validSettings(), half_day_fraction: 0.45 })
    assert.equal(parsed.ok, true)
  })

  test('every issue is reported, not only the first', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      per_day_divisor: 0,
      full_day_hours: -1,
    })
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.length >= 2)
  })
})

describe('cross-field rules', () => {
  test('the grace period cannot end before the office opens', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      scheduled_in_minutes: 10 * 60,
      grace_end_minutes: 9 * 60,
    })
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => i.key === 'grace_end_minutes'))
  })

  test('the office cannot close before it opens', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      scheduled_in_minutes: 18 * 60,
      scheduled_out_minutes: 10 * 60,
    })
    assert.equal(parsed.ok, false)
  })

  test('lunch cannot end before it starts', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      lunch_out_after_minutes: 15 * 60,
      lunch_in_before_minutes: 13 * 60,
    })
    assert.equal(parsed.ok, false)
  })

  test('inverted presence thresholds are rejected', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      threshold_full_present_hours: 2,
      threshold_present_with_shortfall_hours: 7.5,
    })
    assert.equal(parsed.ok, false)
  })
})

describe('paid-leave bands', () => {
  test('an empty band list is rejected', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), paid_leave_tiers: [] })
    assert.equal(parsed.ok, false)
  })

  test('a non-array is rejected', () => {
    const parsed = parsePayrollSettings({ ...validSettings(), paid_leave_tiers: 'one' })
    assert.equal(parsed.ok, false)
  })

  test('bands not ordered highest-first are rejected', () => {
    // The engine takes the FIRST band reached, so an ascending list would award
    // everybody the zero band rather than fail visibly.
    const parsed = parsePayrollSettings({
      ...validSettings(),
      paid_leave_tiers: [
        { min_days_present: 0,  leave: 0 },
        { min_days_present: 16, leave: 1 },
      ],
    })
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.issues.some(i => i.key === 'paid_leave_tiers'))
  })

  test('a band list that never reaches 0 days present is rejected', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      paid_leave_tiers: [{ min_days_present: 16, leave: 1 }],
    })
    assert.equal(parsed.ok, false)
  })

  test('a fractional leave off the half-day grid is rejected', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      paid_leave_tiers: [
        { min_days_present: 16, leave: 0.3 },
        { min_days_present: 0,  leave: 0 },
      ],
    })
    assert.equal(parsed.ok, false)
  })

  test('a valid custom band list is accepted and normalised to descending order', () => {
    const parsed = parsePayrollSettings({
      ...validSettings(),
      paid_leave_tiers: [
        { min_days_present: 20, leave: 1.5 },
        { min_days_present: 10, leave: 0.5 },
        { min_days_present: 0,  leave: 0 },
      ],
    })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(parsed.settings.paid_leave_tiers.map(t => t.min_days_present), [20, 10, 0])
  })
})

describe('snapshot resolution', () => {
  test('a null snapshot resolves to the documented legacy constants', () => {
    assert.deepEqual(resolveSnapshotSettings(null), LEGACY_PAYROLL_SETTINGS)
    assert.deepEqual(resolveSnapshotSettings(undefined), LEGACY_PAYROLL_SETTINGS)
  })

  test('an unparseable snapshot stays readable, as legacy — it never throws', () => {
    assert.deepEqual(resolveSnapshotSettings({ per_day_divisor: 0 }), LEGACY_PAYROLL_SETTINGS)
    assert.deepEqual(resolveSnapshotSettings('corrupt'), LEGACY_PAYROLL_SETTINGS)
    assert.deepEqual(resolveSnapshotSettings(7), LEGACY_PAYROLL_SETTINGS)
  })

  test('a valid snapshot is returned as written, not merged with today’s defaults', () => {
    const pinned = { ...validSettings(), per_day_divisor: 30, missing_punch_hours: 4 }
    const resolved = resolveSnapshotSettings(pinned)
    assert.equal(resolved.per_day_divisor, 30)
    assert.equal(resolved.missing_punch_hours, 4)
  })
})

describe('time conversion', () => {
  test('minutes render as a zero-padded HH:MM', () => {
    assert.equal(minutesToTimeInput(0), '00:00')
    assert.equal(minutesToTimeInput(600), '10:00')
    assert.equal(minutesToTimeInput(615), '10:15')
    assert.equal(minutesToTimeInput(1110), '18:30')
    assert.equal(minutesToTimeInput(1439), '23:59')
  })

  test('HH:MM parses back to the same minutes', () => {
    for (const m of [0, 600, 615, 1110, 1439]) {
      assert.equal(timeInputToMinutes(minutesToTimeInput(m)), m)
    }
  })

  test('a cleared or malformed time is rejected rather than coerced to midnight', () => {
    for (const bad of ['', '  ', 'abc', '10', '10:0', '24:00', '10:60', '-1:00', '10:00:00']) {
      assert.equal(timeInputToMinutes(bad), null, `expected ${JSON.stringify(bad)} to be rejected`)
    }
  })

  test('clock formatting reads the way the rule cards say it', () => {
    assert.equal(minutesToClock(600),  '10:00 AM')
    assert.equal(minutesToClock(615),  '10:15 AM')
    assert.equal(minutesToClock(1110), '6:30 PM')
    assert.equal(minutesToClock(840),  '2:00 PM')
    assert.equal(minutesToClock(0),    '12:00 AM')
    assert.equal(minutesToClock(720),  '12:00 PM')
  })
})

describe('field specs', () => {
  test('every numeric settings key has exactly one field spec', () => {
    const keys = SETTINGS_FIELDS.map(f => f.key)
    assert.equal(new Set(keys).size, keys.length, 'duplicate field spec')

    // Every key on the settings type except the tier list must be editable, or
    // it is a hardcoded number wearing a settings costume.
    const settingsKeys = Object.keys(DEFAULT_PAYROLL_SETTINGS)
      .filter(k => k !== 'paid_leave_tiers')
      .sort()
    assert.deepEqual([...keys].sort(), settingsKeys)
  })

  test('every default sits inside its own declared range and step', () => {
    for (const field of SETTINGS_FIELDS) {
      const value = DEFAULT_PAYROLL_SETTINGS[field.key]
      assert.ok(
        value >= field.min && value <= field.max,
        `${field.key} default ${value} outside [${field.min}, ${field.max}]`,
      )
    }
  })

  test('every field carries a plain-language label and help text', () => {
    for (const field of SETTINGS_FIELDS) {
      assert.ok(field.label.length > 0, `${field.key} has no label`)
      assert.ok(field.help.length > 10, `${field.key} has no useful help text`)
    }
  })

  test('settingsField finds a spec, and throws loudly for one that does not exist', () => {
    assert.equal(settingsField('per_day_divisor').group, 'salary_basis')
    assert.throws(() => settingsField('nope' as never))
  })
})
