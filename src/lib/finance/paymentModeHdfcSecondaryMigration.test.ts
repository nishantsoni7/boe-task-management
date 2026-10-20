/**
 * 20270324000000 — two HDFC accounts: 'hdfc' is HDFC PRI, 'hdfc_sec' is new.
 * Text pins on the migration; the SQL itself carries executed self-assertions.
 *
 * Run: npx tsx --test src/lib/finance/paymentModeHdfcSecondaryMigration.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAYMENT_MODE_VALUES } from './paymentEntry'

const NAME = '20270324000000_payment_mode_hdfc_secondary.sql'
const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', NAME), 'utf8')

describe('the database accepts exactly the modes the browser offers', () => {
  test('the CHECK names every current mode and every legacy one', () => {
    for (const mode of PAYMENT_MODE_VALUES) {
      assert.ok(sql.includes(`'${mode}'`), `${mode} is missing from the migration`)
    }
    for (const legacy of ['bank_transfer', 'cash', 'upi', 'cheque', 'other']) {
      assert.ok(sql.includes(`'${legacy}'`), `${legacy} must stay storable`)
    }
  })

  test('payment_mode_is_current lists the same five as the browser', () => {
    const fn = /create or replace function public\.payment_mode_is_current[\s\S]*?in \(([^)]*)\)/.exec(sql)
    assert.ok(fn, 'the function body is present')
    const listed = [...fn![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual(listed, [...PAYMENT_MODE_VALUES])
  })
})

describe('what it leaves alone', () => {
  test('no existing row is rewritten', () => {
    assert.equal(/\bupdate\s+public\./i.test(sql), false)
    assert.equal(/\bdelete\s+from\b/i.test(sql), false)
  })

  test('the entry RPCs and the custody rule are not redefined', () => {
    assert.equal(/create or replace function public\.(record_|submit_|edit_|payment_mode_requires_custody)/.test(sql), false)
  })

  test('it asserts its own result when it runs', () => {
    assert.match(sql, /do \$assert\$/)
    assert.match(sql, /hdfc_sec must not require a custody trail/)
  })
})
