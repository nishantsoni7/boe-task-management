/**
 * The machine record shown in the correction modal.
 *
 * Regression cover for a defect found in browser testing: a date whose machine
 * record had NO punch-out displayed the corrected punch-out as if the machine
 * had recorded it, because the lookup used `?? dayPunches.check_out_at` and a
 * legitimately-null raw punch fell through to the effective value.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/correctionContext.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMachineRecord } from './correctionContext'

const MACHINE_IN  = '2026-07-21T13:18:00.000Z'   // 18:48 IST — the single stray punch
const CORRECTED_IN  = '2026-07-21T04:30:00.000Z' // 10:00 IST
const CORRECTED_OUT = '2026-07-21T13:00:00.000Z' // 18:30 IST

describe('resolveMachineRecord', () => {
  test('an uncorrected date shows the day’s own punches', () => {
    const day = { check_in_at: MACHINE_IN, check_out_at: null }
    assert.deepEqual(resolveMachineRecord(null, day), { check_in_at: MACHINE_IN, check_out_at: null })
  })

  test('a corrected date shows the correction’s raw punches, not the corrected ones', () => {
    const correction = { raw_check_in_at: MACHINE_IN, raw_check_out_at: null }
    const day = { check_in_at: CORRECTED_IN, check_out_at: CORRECTED_OUT }
    assert.deepEqual(resolveMachineRecord(correction, day), {
      check_in_at: MACHINE_IN,
      check_out_at: null,
    })
  })

  test('a null raw punch stays null — the machine really had none', () => {
    // The defect: this returned CORRECTED_OUT, so the modal claimed the machine
    // had recorded an 18:30 punch-out that never existed.
    const correction = { raw_check_in_at: MACHINE_IN, raw_check_out_at: null }
    const day = { check_in_at: CORRECTED_IN, check_out_at: CORRECTED_OUT }
    assert.equal(resolveMachineRecord(correction, day).check_out_at, null)
  })

  test('a date the machine has nothing at all for reports both punches missing', () => {
    const correction = { raw_check_in_at: null, raw_check_out_at: null }
    const day = { check_in_at: CORRECTED_IN, check_out_at: CORRECTED_OUT }
    assert.deepEqual(resolveMachineRecord(correction, day), { check_in_at: null, check_out_at: null })
  })

  test('a correction that kept both machine punches shows them unchanged', () => {
    const correction = { raw_check_in_at: MACHINE_IN, raw_check_out_at: CORRECTED_OUT }
    const day = { check_in_at: CORRECTED_IN, check_out_at: CORRECTED_OUT }
    assert.deepEqual(resolveMachineRecord(correction, day), {
      check_in_at: MACHINE_IN,
      check_out_at: CORRECTED_OUT,
    })
  })

  test('undefined is treated as "no correction", like null', () => {
    const day = { check_in_at: MACHINE_IN, check_out_at: null }
    assert.deepEqual(resolveMachineRecord(undefined, day), day)
  })
})
