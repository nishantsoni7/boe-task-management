/**
 * THE BILLING-PERCENTAGE RULE, PINNED — including the two values it must never
 * invent.
 *
 * The bounds are stated in three places that have to agree: this module for the
 * form, the RPC for the write, and a CHECK constraint for the table. This file
 * pins the TypeScript half; the SQL half is asserted at the bottom by reading
 * the migration, so an edit to one that is not made to the other fails here.
 *
 * THE CASE THAT MATTERS MOST is that undeclared is neither 0 nor 100. A PI
 * nobody has decided about and a PI somebody decided to bill in full are
 * different facts, and every helper below has to keep them apart.
 *
 * Run:
 *   npx tsx --test src/lib/orders/billingPercentage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatInr } from '@/lib/pi/previewView'
import {
  BILLING_MAX,
  BILLING_MIN,
  BILLING_RANGE_HELP,
  BILLING_UNDECLARED,
  billingValue,
  formatBillingPercentage,
  parseBillingPercentage,
  readBillingPercentage,
} from './billingPercentage'

const ok = (raw: string) => {
  const parsed = parseBillingPercentage(raw)
  assert.equal(parsed.ok, true, `${JSON.stringify(raw)} should be accepted`)
  return parsed.ok ? parsed.value : NaN
}
const no = (raw: string) => {
  const parsed = parseBillingPercentage(raw)
  assert.equal(parsed.ok, false, `${JSON.stringify(raw)} should be refused`)
  return parsed.ok ? '' : parsed.reason
}

describe('a percentage is accepted only inside the declared band', () => {
  test('both ends are valid, and so is everything between', () => {
    assert.equal(ok('35'), 35, 'the floor is a real declaration, not a boundary to clear')
    assert.equal(ok('100'), 100)
    assert.equal(ok('65'), 65)
  })

  test('two decimals are carried, because the column holds them', () => {
    assert.equal(ok('35.50'), 35.5)
    assert.equal(ok('99.99'), 99.99)
    assert.equal(no('35.555'), 'precision', 'numeric(5,2) would round this silently')
  })

  test('below the floor and above the whole are refused, not clamped', () => {
    // A person who typed 30 meant 30. Saving 35 on their behalf would record a
    // decision nobody took.
    assert.equal(no('34.99'), 'range')
    assert.equal(no('0'), 'range')
    assert.equal(no('-5'), 'range')
    assert.equal(no('100.01'), 'range')
    assert.equal(no('1000'), 'range')
  })

  test('nothing, and nothing-shaped, is not a declaration', () => {
    for (const empty of ['', '   ', '%']) assert.equal(no(empty), 'empty')
  })

  test('NaN, infinity and malformed input are refused', () => {
    // 1e999 overflows to Infinity, so it is malformed rather than out of range —
    // it never becomes a number this rule could compare against a bound.
    for (const bad of ['abc', '12abc', 'NaN', 'Infinity', '-Infinity', '1e999', '3..5', '--5']) {
      assert.equal(no(bad), 'malformed', `${bad} is not a percentage`)
    }
  })

  test('a trailing % is what people type, and is accepted', () => {
    assert.equal(ok('65%'), 65)
    assert.equal(ok(' 65 % '.replace(' %', '%')), 65)
  })

  test('the refusal says what to do', () => {
    assert.equal(BILLING_RANGE_HELP, 'Enter a value from 35% to 100%.')
    const refused = parseBillingPercentage('12')
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.equal(refused.message, BILLING_RANGE_HELP)
  })
})

describe('undeclared is a state, not a zero', () => {
  test('nothing prints as Undeclared — never 0%, never a dash', () => {
    assert.equal(BILLING_UNDECLARED, 'Undeclared')
    for (const nothing of [null, undefined]) {
      assert.equal(formatBillingPercentage(nothing), 'Undeclared')
    }
    assert.notEqual(formatBillingPercentage(null), '0%')
    assert.notEqual(formatBillingPercentage(null), '100%')
  })

  test('a declared value prints without trailing zeros', () => {
    assert.equal(formatBillingPercentage(65), '65%')
    assert.equal(formatBillingPercentage(35), '35%')
    assert.equal(formatBillingPercentage(100), '100%')
    assert.equal(formatBillingPercentage(35.5), '35.5%')
    assert.equal(formatBillingPercentage(35.25), '35.25%')
  })

  test('what the database hands back is a STRING, and becomes a number here', () => {
    // PostgREST serialises numeric as text; this is the one place that converts.
    assert.equal(readBillingPercentage('65.00'), 65)
    assert.equal(readBillingPercentage('35.50'), 35.5)
    assert.equal(readBillingPercentage(65), 65)
    assert.equal(readBillingPercentage(null), null)
    assert.equal(readBillingPercentage(undefined), null, 'an older payload has no field at all')
    assert.equal(readBillingPercentage(''), null)
    // Impossible while the constraint holds — and if it ever appeared it would
    // mean the column stopped meaning what this module says.
    assert.equal(readBillingPercentage('0'), null)
    assert.equal(readBillingPercentage('120'), null)
    assert.equal(readBillingPercentage('not a number'), null)
  })
})

describe('the billing value is a share of the PRE-GST total, and of nothing else', () => {
  const TOTAL_BEFORE_GST = 742850
  const GRAND_TOTAL = 876563
  const PRODUCT_VALUE = 733300

  test('it is total before GST × the percentage', () => {
    assert.equal(billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: 65 }), 482852.5)
    assert.equal(billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: 100 }), TOTAL_BEFORE_GST)
    assert.equal(billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: 35 }), 259997.5)
  })

  test('and NOT of the grand total or the product value', () => {
    // Both would give a plausible figure answering a different question: the
    // grand total includes tax this percentage says nothing about, and the
    // product value is before the costs the subtotal already absorbed.
    const billed = billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: 65 })
    assert.notEqual(billed, billingValue({ totalBeforeGst: GRAND_TOTAL, percentage: 65 }))
    assert.notEqual(billed, billingValue({ totalBeforeGst: PRODUCT_VALUE, percentage: 65 }))
  })

  test('no percentage is no value — not a zero', () => {
    assert.equal(billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: null }), null)
    assert.equal(billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: undefined }), null)
  })

  test('and a MISSING TOTAL never becomes ₹0', () => {
    // The trap: 0 × 65 / 100 is 0, and ₹0 is a figure somebody would act on.
    for (const missing of [null, undefined, NaN, Infinity]) {
      assert.equal(billingValue({ totalBeforeGst: missing as number, percentage: 65 }), null,
        `${missing} must produce no value at all`)
    }
    assert.equal(formatInr(billingValue({ totalBeforeGst: null, percentage: 65 })), '—',
      'the shared formatter says missing, and the card shows that')
  })

  test('the figure goes through the existing money formatter, unrounded', () => {
    const billed = billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: 65 })
    assert.equal(formatInr(billed), '₹4,82,852.50')
    assert.equal(formatInr(billingValue({ totalBeforeGst: TOTAL_BEFORE_GST, percentage: 100 })),
      '₹7,42,850')
  })
})

describe('the SQL half of the rule has not drifted from this one', () => {
  const sql = readFileSync(join(process.cwd(),
    'supabase/migrations/20260923000000_order_submission_billing_percentage.sql'), 'utf8')

  test('the same bounds, on both tables, as a CHECK', () => {
    for (const table of ['order_submissions', 'orders']) {
      assert.ok(new RegExp(`${table}_billing_percentage_range`).test(sql),
        `${table} must carry the constraint`)
    }
    const bounds = sql.match(/billing_percentage >= (\d+) and billing_percentage <= (\d+)/g) ?? []
    assert.equal(bounds.length, 2, 'both tables, both bounds')
    for (const bound of bounds) {
      assert.ok(bound.includes(`>= ${BILLING_MIN}`) && bound.includes(`<= ${BILLING_MAX}`),
        'the SQL bounds are the ones this module exports')
    }
  })

  test('nullable, with no default and no backfill', () => {
    assert.match(sql, /add column if not exists billing_percentage numeric\(5,2\);/)
    assert.ok(!/billing_percentage numeric\(5,2\)\s+default/i.test(sql), 'no default, ever')
    assert.ok(!/update public\.order_submissions\s+set billing_percentage\s*=\s*\d/i.test(sql),
      'no backfill of existing rows')
  })

  test('the write path is one RPC, under the authority that already exists', () => {
    assert.match(sql, /create or replace function public\.set_order_submission_billing_percentage/)
    assert.match(sql, /if not public\.can_edit_order_submission\(p_submission_id\) then/)
    assert.ok(!sql.includes('can_declare_billing_percentage'),
      'no new authority function was introduced')
    assert.match(sql, /security definer/)
    assert.match(sql, /set search_path = public, pg_temp/)
    assert.match(sql, /for update/, 'the row is locked before it is read')
  })

  test('an unchanged save writes nothing and logs nothing', () => {
    assert.match(sql, /if v_next is not distinct from v_previous then/,
      'and `is distinct from` is what makes that true for the NULL cases too')
  })

  test('nothing new blocks submission or approval', () => {
    // The one thing that would quietly turn an optional field into a required
    // one is a gate somewhere in this migration.
    assert.ok(!/billing_percentage is null[\s\S]{0,120}raise exception/i.test(sql),
      'an undeclared PI must remain submittable and approvable')
  })
})
