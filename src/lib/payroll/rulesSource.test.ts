/**
 * The How Payroll Works page must describe the engine, not a document about it.
 *
 * The rule these protect: /payroll/how-it-works renders src/lib/payroll/rules.ts
 * and nothing else, and rules.ts is assembled from the same constants
 * engine.ts calculates with. A guide that says "45 minutes" while the engine
 * charges an hour is worse than no guide at all, so this suite asserts that the
 * page's numbers are DERIVED — including the worked example, which is the part
 * most likely to be quietly hand-written.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/rulesSource.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PER_DAY_DIVISOR,
  PER_HOUR_DIVISOR,
  SALARY_FLOW,
  RULE_CARDS,
  RULE_GROUP_ORDER,
  RULE_GROUP_LABELS,
  EXAMPLE_MONTHLY_SALARY,
  EXAMPLE_DEDUCTIONS,
  EXAMPLE_DEDUCTION_TOTAL,
  NOT_CALCULATED,
} from './rules'
import { FULL_DAY_HOURS, ROUNDING_BLOCK_HOURS } from '../attendance/scheduleRules'

// ─── The worked example is derived, not typed ─────────────────────────────────

describe('the deduction example', () => {
  const perDay  = EXAMPLE_MONTHLY_SALARY / PER_DAY_DIVISOR
  const perHour = perDay / PER_HOUR_DIVISOR

  test('each line is computed from the engine’s own divisors', () => {
    const byLabel = Object.fromEntries(EXAMPLE_DEDUCTIONS.map(d => [d.label, d.amount]))

    assert.equal(byLabel['Absent'],       perDay)
    assert.equal(byLabel['Half Day'],     perDay / 2)
    assert.equal(byLabel['Late Arrival'], ROUNDING_BLOCK_HOURS * perHour)
  })

  test('the total is the sum of its lines, not a separate figure', () => {
    const sum = EXAMPLE_DEDUCTIONS.reduce((t, d) => t + d.amount, 0)
    assert.equal(EXAMPLE_DEDUCTION_TOTAL, sum)
  })

  test('the per-hour rate follows the full working day, so changing it moves the example', () => {
    assert.equal(PER_HOUR_DIVISOR, FULL_DAY_HOURS)
  })
})

// ─── The salary flow covers what the page promises ────────────────────────────

describe('the salary flow', () => {
  test('names every step from gross salary to closing balance', () => {
    const keys = SALARY_FLOW.map(s => s.key)
    for (const required of [
      'gross_salary',
      'working_days',
      'daily_attendance',
      'attendance_deductions',
      'salary_after_attendance',
      'previous_balance',
      'other_adjustments',
      'salary_payable',
      'amount_paid',
      'closing_balance',
    ]) {
      assert.ok(keys.includes(required), `the guide is missing "${required}"`)
    }
  })

  test('states the two formulas that decide the settlement', () => {
    const byKey = Object.fromEntries(SALARY_FLOW.map(s => [s.key, s]))
    assert.match(byKey['salary_payable'].formula ?? '', /Salary After Attendance \+ Previous Balance \+ Other Adjustments/)
    assert.match(byKey['closing_balance'].formula ?? '', /Salary Payable − Amount Paid/)
  })

  test('the daily rate is stated from the divisor, not written out', () => {
    // If PER_DAY_DIVISOR ever changes, this sentence changes with it.
    assert.match(SALARY_FLOW.find(s => s.key === 'working_days')!.formula ?? '', new RegExp(`÷ ${PER_DAY_DIVISOR}`))
  })

  test('only the balance is two-directional', () => {
    const byKey = Object.fromEntries(SALARY_FLOW.map(s => [s.key, s]))
    assert.equal(byKey['closing_balance'].sign,  'signed')
    assert.equal(byKey['previous_balance'].sign, 'signed')
    assert.equal(byKey['amount_paid'].sign,      'positive')
    assert.equal(byKey['attendance_deductions'].sign, 'negative')
  })
})

// ─── Rule cards ───────────────────────────────────────────────────────────────

describe('rule cards', () => {
  test('every attendance state the engine supports has a card', () => {
    const keys = RULE_CARDS.map(c => c.key)
    for (const required of [
      'full_present', 'half_day', 'absent', 'missing_punch',
      'late_arrival', 'early_checkout', 'paid_leave',
    ]) {
      assert.ok(keys.includes(required), `no rule card for "${required}"`)
    }
  })

  test('the settlement rules are all present', () => {
    const settlement = RULE_CARDS.filter(c => c.group === 'settlement').map(c => c.key)
    for (const required of [
      'previous_balance', 'other_adjustments', 'salary_payable',
      'amount_paid', 'closing_balance',
    ]) {
      assert.ok(settlement.includes(required), `no settlement rule card for "${required}"`)
    }
  })

  test('locking and regeneration are still explained', () => {
    const keys = RULE_CARDS.map(c => c.key)
    assert.ok(keys.includes('locking'))
    assert.ok(keys.includes('regeneration'))
    assert.ok(keys.includes('corrections'))
  })

  test('every group in the reading order has a label and at least one card', () => {
    for (const group of RULE_GROUP_ORDER) {
      assert.ok(RULE_GROUP_LABELS[group], `no label for group "${group}"`)
      assert.ok(RULE_CARDS.some(c => c.group === group), `no cards in group "${group}"`)
    }
  })

  test('every card falls inside the reading order — none can be orphaned', () => {
    for (const card of RULE_CARDS) {
      assert.ok(RULE_GROUP_ORDER.includes(card.group), `"${card.key}" is in unrendered group "${card.group}"`)
    }
  })

  test('the carry-forward is not labelled as coming from the previous MONTH', () => {
    // It comes from the preceding payroll PERIOD, which is not always last
    // month — if June was never run, July's balance comes from May. A label
    // saying "Previous Month Balance" would be wrong on exactly the months
    // where getting it right matters.
    const copy = [
      ...SALARY_FLOW.map(s => `${s.label} ${s.body} ${s.formula ?? ''}`),
      ...RULE_CARDS.map(c => `${c.title} ${c.body} ${c.detail ?? ''}`),
    ].join(' ')

    assert.equal(
      /Previous Month Balance/.test(copy), false,
      'employee-facing copy must say "Previous Balance", not "Previous Month Balance"',
    )
    assert.match(copy, /Previous Balance/)
  })

  test('what payroll does NOT do is stated', () => {
    const all = NOT_CALCULATED.join(' ').toLowerCase()
    assert.match(all, /overtime/)
    assert.match(all, /tax/)
    assert.match(all, /bonus/)
  })
})

// ─── The page hard-codes nothing ──────────────────────────────────────────────

describe('the guide page', () => {
  const PAGE = readFileSync(
    join(process.cwd(), 'src', 'app', 'payroll', 'how-it-works', 'page.tsx'),
    'utf8',
  )

  test('imports its content from the rule source', () => {
    assert.match(PAGE, /from '@\/lib\/payroll\/rules'/)
    assert.match(PAGE, /SALARY_FLOW/)
    assert.match(PAGE, /RULE_CARDS/)
    assert.match(PAGE, /EXAMPLE_DEDUCTIONS/)
  })

  test('does not restate a core payroll threshold as a literal', () => {
    // The values an employee would check the arithmetic against. Any of these
    // appearing as a bare number in the page means the guide has begun to keep
    // its own copy of a rule.
    const codeOnly = PAGE
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')

    for (const literal of ['8.5', '10:15', '18:30', '692.31', '40.72']) {
      assert.equal(
        codeOnly.includes(literal), false,
        `"${literal}" is hard-coded in the guide — it must come from rules.ts`,
      )
    }

    // PER_DAY_DIVISOR is 26 and must be referenced, never written.
    assert.match(codeOnly, /PER_DAY_DIVISOR/)
  })
})
