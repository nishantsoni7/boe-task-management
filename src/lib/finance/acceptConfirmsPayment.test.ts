/**
 * ACCEPTING A CASH HANDOVER CONFIRMS ITS PAYMENTS (20270416000000).
 *
 * The behaviour was proven by executing the migration against the real schema
 * (rolled-back rehearsal). These tests keep its shape from drifting: the
 * restated accept keeps every step of 20270413000000 and adds one guarded loop.
 *
 * Run: npx tsx --test src/lib/finance/acceptConfirmsPayment.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270416000000_finance_accept_handover_confirms_payment.sql')
const PREV = read('supabase/migrations/20270413000000_finance_cash_journeys.sql')

describe('20270416000000 - accepting confirms the payments', () => {
  test('confirms through the one approval door, never by writing a status itself', () => {
    assert.match(SQL, /perform public\.approve_finance_payment_request\(/)
    assert.equal(/update public\.finance_payment_requests/i.test(SQL), false)
  })
  test('only for a holder of finance approve, only Pending and live payments', () => {
    assert.match(SQL, /actor_has_module_permission\('finance', 'approve'\)/)
    assert.match(SQL, /p\.status = 'pending_approval'/)
    assert.match(SQL, /p\.deleted_at is null/)
  })
  test('a refused confirmation never blocks the acceptance', () => {
    assert.match(SQL, /exception when others then\s+raise warning/)
  })
  test('the confirmation runs after the custody events and before the handover closes', () => {
    const custody = SQL.indexOf("'handed_over'")
    const confirm = SQL.indexOf('perform public.approve_finance_payment_request(')
    const close = SQL.indexOf("set status = 'accepted'")
    assert.ok(custody > 0 && confirm > custody && close > confirm)
  })
  test('every step of the previous accept survives', () => {
    for (const needle of ['append_payment_custody_events_internal', 'finance_cash_lock', "'handover_out'", "'handover_in'",
      "'new_cash'", 'finance_cash_handover_events', "'finance_handover_accepted'::notification_type",
      "boe.cash_handover_accept", 'HANDOVER_NOT_ALLOWED', 'HANDOVER_CLOSED']) {
      assert.ok(PREV.includes(needle), `previous: ${needle}`)
      assert.ok(SQL.includes(needle), `restated: ${needle}`)
    }
  })
  test('requires the lock migration and stays closed to anon', () => {
    assert.match(SQL, /finance_payment_cash_locks\(uuid\[\]\)/)
    assert.match(SQL, /revoke all on function public\.accept_cash_handover\(uuid\) from public, anon/)
  })
})
