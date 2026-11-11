// 20270611000000_my_flagged_pis.sql, read as text. The BEHAVIOUR is proved by executing the real migration on an
// in-memory Postgres: supabase/tests/my_flagged_pis_pglite.mjs (16 checks; not part of npm test, PGlite is not an
// app dependency). These pin what the text must keep saying, so a later edit cannot quietly widen it.
//
// Run with: npm run test:file -- src/lib/orders/flaggedPisMigration.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const FILE = '20270611000000_my_flagged_pis.sql'
const sql = readFileSync(join(ROOT, 'supabase', 'migrations', FILE), 'utf8').replace(/\r/g, '')
// The function body only: comments and the closing assertions are not behaviour.
const body = sql.slice(sql.indexOf('create or replace function public.my_flagged_pis()'), sql.indexOf('revoke all     on function'))
const code = body.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

describe('my_flagged_pis()', () => {
  test('is the only thing the migration creates: no table, column, policy, trigger or enum value', () => {
    assert.equal((sql.match(/create or replace function/g) ?? []).length, 1)
    assert.equal(/create table|alter table|create policy|create trigger|alter type/i.test(code), false)
  })

  test('is read-only: it never writes, and it is stable', () => {
    assert.equal(/\b(insert|update|delete|truncate)\b/i.test(code), false)
    assert.match(code, /\bstable\b/)
  })

  test('is security definer with a fixed search_path, and answers only for auth.uid()', () => {
    assert.match(code, /security definer/)
    assert.match(code, /set search_path = public, pg_temp/)
    assert.match(code, /v_actor uuid := auth\.uid\(\)/)
    assert.match(code, /if v_actor is null then\s+return '\[\]'::jsonb;/)
    assert.match(sql, /function public\.my_flagged_pis\(\)\s+returns jsonb/, 'it takes no argument: nobody can ask for somebody else\'s')
  })

  test('answers [] without the Orders module, so the launcher never breaks', () => {
    assert.match(code, /if not public\.module_entry_open\('orders'\) then\s+return '\[\]'::jsonb;/)
  })

  test('asks the answer door\'s own rule and the Order-visibility rule, so nobody is shown what they cannot act on or open', () => {
    assert.match(code, /public\.can_propose_order_pi_edit\(h\.order_id\)/)
    assert.match(code, /public\.can_view_order\(h\.order_id\)/)
  })

  test('lists only a live flag about the approved version on an Order that is not cancelled', () => {
    assert.match(code, /h\.status = 'clarification_needed'/)
    assert.match(code, /h\.superseded_at is null/)
    assert.match(code, /o\.status <> 'cancelled'/)
    assert.match(code, /v\.id = h\.pi_version_id and v\.status = 'approved'/)
    assert.match(code, /not exists \(select 1 from public\.order_pi_versions v2/)
  })

  test('is callable by a signed-in person only', () => {
    assert.match(sql, /revoke all\s+on function public\.my_flagged_pis\(\) from public, anon;/)
    assert.match(sql, /grant\s+execute on function public\.my_flagged_pis\(\) to authenticated;/)
  })

  test('ends with assertions that the function exists, is not open to anon, and asks the door\'s rule', () => {
    const tail = sql.slice(sql.indexOf('-- ═══ Assertions'))
    assert.match(tail, /to_regprocedure\('public\.my_flagged_pis\(\)'\) is null/)
    assert.match(tail, /has_function_privilege\('anon'/)
    assert.match(tail, /has_function_privilege\('authenticated'/)
    assert.match(tail, /can_propose_order_pi_edit/)
  })

  test('says how to roll it back, and mentions nothing the repository forbids', () => {
    assert.match(sql, /Roll-back: drop function public\.my_flagged_pis\(\);/)
    assert.equal(/designation_level/.test(sql), false)
  })
})

describe('the rehearsal that proves it', () => {
  test('exists, applies the real migration and the real answer door, and says how many checks pass', () => {
    const rehearsal = readFileSync(join(ROOT, 'supabase', 'tests', 'my_flagged_pis_pglite.mjs'), 'utf8').replace(/\r/g, '')
    assert.match(rehearsal, /mig\('20270611000000_my_flagged_pis\.sql'\)/)
    assert.match(rehearsal, /20270115000000_order_submission_pi_edit_revisions\.sql/)
    assert.equal((rehearsal.match(/^await check\(/gm) ?? []).length, 16)
    assert.match(rehearsal, /Expected last line: "all 16 checks passed"/)
    assert.match(rehearsal, /my_flagged_pis_rehearsal_footer.sql/)
  })
})
