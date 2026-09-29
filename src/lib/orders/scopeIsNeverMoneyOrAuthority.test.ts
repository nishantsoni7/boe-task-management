// A VISIBILITY SCOPE REVEALS ORDER DETAIL, NEVER MONEY OR AUTHORITY (20270221000000).
//
// The rule is the database's (supabase/tests/orders_dashboard_assertions.sql, section 8, drives every
// persona through direct calls). These pin the application side: Finance never reads the orders
// table under the caller's scope, and the notify route refuses before it reads.
//
// Run with: npx tsx --test "src/lib/orders/scopeIsNeverMoneyOrAuthority.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const migration = read('supabase/migrations/20270221000000_orders_dashboard_factory_focus.sql')

describe('Finance screens read Orders through the pre-scope functions', () => {
  for (const file of [
    'src/app/finance/received/AllocatePaymentModal.tsx',
    'src/app/finance/received/ReceivedPaymentsView.tsx',
    'src/app/finance/paymentIntents.ts',
  ]) {
    test(`${file} does not read the orders table`, () => {
      assert.doesNotMatch(read(file), /\.from\('orders'\)/)
    })
  }
  test('the picker searches with finance_order_search and the lookups use finance_order_lookup', () => {
    assert.match(read('src/app/finance/received/AllocatePaymentModal.tsx'), /rpc\('finance_order_search'/)
    assert.match(read('src/app/finance/received/ReceivedPaymentsView.tsx'), /rpc\('finance_order_lookup'/)
    assert.match(read('src/app/finance/paymentIntents.ts'), /rpc\('finance_order_lookup'/)
  })
})

describe('the notify route', () => {
  test('asks the unscoped rule before reading the Order', () => {
    const src = read('src/app/api/orders/[id]/notify/route.ts')
    const gate = src.indexOf("rpc('can_view_order_unscoped'")
    const readOrder = src.indexOf('1. The Order, AS THE CALLER')
    assert.ok(gate > 0 && readOrder > gate, 'the unscoped gate must come first')
  })
})

describe('the migration', () => {
  test('can_view_order_as_actor is the unscoped rule, so readiness and decisions ignore a scope', () => {
    assert.match(migration, /create or replace function public\.can_view_order_as_actor[\s\S]*?select public\.can_view_order_unscoped\(p_order_id\);/)
  })
  test('only the three PI detail RPCs are moved to can_read_order_detail', () => {
    assert.match(migration, /'order_pi_version_detail', 'order_pi_version_pdf_detail', 'order_pi_revision_differences'/)
    assert.doesNotMatch(migration, /order_advance_readiness[^\n]*can_read_order_detail/)
  })
  test('document generation and both Finance views are pinned', () => {
    assert.match(migration, /request_order_document_generation[\s\S]*can_view_order_unscoped/)
    assert.match(migration, /finance_received_payments', 'finance_payment_destinations'/)
  })
})
