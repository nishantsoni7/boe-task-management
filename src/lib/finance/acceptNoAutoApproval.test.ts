/**
 * 20270417000000 — accepting a cash handover never approves a payment.
 *
 * It removes the automatic approval 20270416000000 added. The behaviour is
 * proven on PGlite by supabase/tests/handover_accept_no_auto_approval_pglite.mjs
 * (Nishant, Nitish and an ordinary employee accept; every payment stays
 * Pending; Finance then approves on its own). This pins the migration so the
 * restored body cannot drift from the one it restores.
 *
 * Run: npx tsx --test src/lib/finance/acceptNoAutoApproval.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270417000000_finance_accept_handover_no_auto_approval.sql')
const SOURCE = read('supabase/migrations/20270413000000_finance_cash_journeys.sql')

function acceptBody(sql: string): string {
  const start = sql.search(/^create or replace function public\.accept_cash_handover\(p_handover_id uuid\)/m)
  assert.ok(start >= 0, 'accept_cash_handover is defined')
  const rest = sql.slice(start)
  const end = rest.indexOf('$$', rest.indexOf('as $$') + 5)
  return rest.slice(0, end + 2)
}

describe('20270417000000 — custody acceptance only', () => {
  test('the restored body is the 20270413000000 body, character for character', () => {
    assert.equal(acceptBody(SQL), acceptBody(SOURCE))
  })

  test('it never calls the approval door and writes no payment status', () => {
    const body = acceptBody(SQL)
    assert.doesNotMatch(body, /approve_finance_payment_request/)
    assert.doesNotMatch(body, /update public\.finance_payment_requests/i)
  })

  test('the apply-time assertion refuses an accept that still approves', () => {
    assert.match(SQL, /if position\('approve_finance_payment_request' in v_accept\) > 0 then\n\s+raise exception 'ASSERTION FAILED: accept_cash_handover still approves payments'/)
  })

  test('grants are restated exactly: signed-in users only', () => {
    assert.match(SQL, /revoke all on function public\.accept_cash_handover\(uuid\) from public, anon;\ngrant execute on function public\.accept_cash_handover\(uuid\) to authenticated;/)
  })

  test('nothing else is touched', () => {
    const code = SQL.replace(/^--.*$/gm, '')
    assert.equal((code.match(/create or replace function/gi) ?? []).length, 1)
    assert.doesNotMatch(code, /\b(alter|drop)\s+(table|function|policy|trigger)\b|\bcreate\s+(table|policy|trigger)\b/i)
  })
})
