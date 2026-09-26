// A payment's typed Reference / UTR survives verification (20270111500000).
//
// record_pi_submission_payment_core and record_payment_with_allocations_core put
// the reference in finance_payment_requests.order_number; verification
// (approve_finance_payment_request, 20261118000000) rewrites that column, and
// the verification modal reads proof_note. The migration keeps a copy in
// proof_note. These pins hold its three rules; the behaviour was proved end to
// end on a disposable stack with the real doors (entry, verification,
// allocation after verification, rejection, the PI card), recorded in the PR.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'supabase/migrations')
const FILE = '20270111500000_finance_payment_reference_survives_verification.sql'
const sql = readFileSync(join(DIR, FILE), 'utf8').replace(/\r/g, '')
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

describe('20270111500000 — a payment reference survives verification', () => {
  test('it sits after production\'s latest migration and before #209\'s first', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
    assert.ok(files.includes(FILE))
    assert.ok(FILE > '20270110000000_announcements.sql')
    assert.ok(FILE < '20270112000000')
  })

  test('the trigger copies the reference only into an EMPTY proof_note, only when there is no order_id, and never moves it', () => {
    assert.match(code, /create trigger finance_payment_requests_keep_reference\s+before insert on public\.finance_payment_requests/)
    assert.match(code, /if new\.proof_note is null\s+and new\.order_id is null\s+and nullif\(btrim\(coalesce\(new\.order_number, ''\)\), ''\) is not null then\s+new\.proof_note := btrim\(new\.order_number\);/)
    assert.doesNotMatch(code, /new\.order_number\s*:=/, 'order_number is left exactly as written')
  })

  test('the carry-forward touches only UNVERIFIED rows, and invents nothing for verified ones', () => {
    const start = code.indexOf('update public.finance_payment_requests')
    const update = code.slice(start, code.indexOf(';', start) + 1)
    assert.match(update, /set proof_note = btrim\(f\.order_number\)/)
    assert.match(update, /f\.proof_note is null/)
    assert.match(update, /f\.order_id is null/)
    assert.match(update, /f\.status in \('pending_approval', 'needs_clarification', 'rejected'\)/)
    assert.doesNotMatch(update, /approved/, 'no verified status is carried')
  })

  test('the PI card reads the reference from proof_note, and the trigger function is not callable by clients', () => {
    assert.match(code, /'reference',\s+f\.proof_note,/)
    assert.doesNotMatch(code, /'reference',\s+f\.order_number,/)
    assert.match(code, /revoke execute on function public\.finance_payment_requests_keep_reference\(\) from public, anon, authenticated;/)
  })
})
