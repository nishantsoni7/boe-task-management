/**
 * THE CONFIRMED ORDERS LIST'S BATCH ADVANCE PERCENTAGE (20270517000100), read as text.
 *
 * Holds the migration to its promises without a database:
 *   * it is read-only: one function and no other change;
 *   * it copies no rule: the figure is order_advance_position()'s own percent;
 *   * it asks what order_advance_readiness() asks, the unscoped rule, so a
 *     visibility scope never reveals money;
 *   * it needs a signed-in caller, pins its search_path, and is executable by
 *     authenticated only.
 *
 * Run:
 *   npx tsx --test src/lib/orders/ordersAdvancePercentSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20270517000100_orders_advance_percent.sql')
  .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

describe('orders_advance_percent', () => {
  test('is read-only: it creates one function and writes nothing', () => {
    assert.equal((SQL.match(/create\s+(or\s+replace\s+)?function/gi) ?? []).length, 1)
    assert.ok(!/\b(insert|update|delete|alter|drop|truncate)\b/i.test(SQL.replace(/revoke[^;]*;|grant[^;]*;/gi, '')),
      'no DML or DDL beyond the function itself')
  })

  test('the figure is the position\'s own, so it cannot drift from the Payment card', () => {
    assert.ok(SQL.includes("(public.order_advance_position(o.id) ->> 'percent')::numeric"))
    assert.ok(!/finance_payment_allocations|round\s*\(|trunc\s*\(/i.test(SQL), 'no second copy of the rule')
  })

  test('asks the unscoped rule, as order_advance_readiness does: a scope reveals no money', () => {
    assert.ok(SQL.includes('where public.can_view_order_as_actor(o.id);'))
    assert.ok(!SQL.includes('can_read_order_detail'))
  })

  test('needs a signed-in caller, pins its search_path, and is for authenticated only', () => {
    assert.ok(SQL.includes('auth.uid() is null'))
    assert.ok(SQL.includes('security definer'))
    assert.ok(/set search_path = public, pg_temp/.test(SQL))
    assert.ok(SQL.includes('revoke execute on function public.orders_advance_percent() from public, anon;'))
    assert.ok(/grant\s+execute on function public\.orders_advance_percent\(\) to authenticated;/.test(SQL))
  })
})
