import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 20270405000000 — finalize_finance_payment_deletion clears the payment's
// allocation intents before deleting the payment. Seen live on P-AA-0040: the
// release trigger deleted the allocations while an applied intent still named one
// (finance_payment_allocation_intents_applied_allocation_id_fkey).
//
// Source-level only: NOT executed against Postgres.

const FILE = '20270405000000_payment_deletion_clears_allocation_intents.sql'
const sql = readFileSync(join('supabase', 'migrations', FILE), 'utf8').replace(/\r/g, '')
const previous = readFileSync(
  join('supabase', 'migrations', '20270331000000_finance_admin_may_delete_confirmed_payment.sql'),
  'utf8',
).replace(/\r/g, '')

function bodyOf(source: string): string {
  const start = source.indexOf('create or replace function public.finalize_finance_payment_deletion(')
  return source.slice(start, source.indexOf('\n$$;', start) + 4)
}

describe('20270405000000 — a payment applied from an intent can be deleted', () => {
  test('forward-only, a unique version, after 20270404000000', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.ok(files[i - 1] >= '20270404000000')
  })

  test('the intents are deleted before the payment, inside the finalizer', () => {
    const fn = bodyOf(sql)
    const intents = fn.indexOf('delete from public.finance_payment_allocation_intents')
    const payment = fn.indexOf('delete from public.finance_payment_requests where id')
    assert.ok(intents > 0)
    assert.ok(intents < payment)
    assert.ok(/where payment_request_id = p_payment_id/.test(fn.slice(intents, intents + 200)))
  })

  test('nothing else in the finalizer changed from 20270331000000', () => {
    const strip = (s: string) => s.replace(/ {2}-- 20270405000000:[\s\S]*?p_payment_id;\n\n/, '')
    assert.equal(strip(bodyOf(sql)), bodyOf(previous))
  })

  test('signature and grants are restated; the migration asserts itself', () => {
    assert.ok(/grant\s+execute on function public\.finalize_finance_payment_deletion\(uuid, uuid\) to authenticated/.test(sql))
    assert.ok(/revoke execute on function public\.finalize_finance_payment_deletion\(uuid, uuid\) from public, anon/.test(sql))
    assert.ok(sql.includes('ASSERTION FAILED: finalize_finance_payment_deletion'))
  })
})
