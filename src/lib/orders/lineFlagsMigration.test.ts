// 20270616000000_order_line_flags.sql, read as text. The BEHAVIOUR is proved by executing the real migration on
// an in-memory Postgres: supabase/tests/order_line_flags_pglite.mjs (13 checks; not part of npm test). These pin
// what the text must keep saying, so a later edit cannot quietly widen it.
//
// Run with: npm run test:file -- src/lib/orders/lineFlagsMigration.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20270616000000_order_line_flags.sql'), 'utf8').replace(/\r/g, '')
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const fn = (name: string) => {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `${name} is defined`)
  return code.slice(start, code.indexOf('$$;', code.indexOf('as $$', start)) + 3)
}

describe('20270616000000 order_line_flags', () => {
  test('creates one table and three functions, and changes nothing else', () => {
    assert.equal((code.match(/create table/g) ?? []).length, 1)
    assert.equal((code.match(/create or replace function/g) ?? []).length, 3)
    assert.equal(/create policy|create trigger|alter type|alter table public\.(?!order_line_flags)/i.test(code), false)
    assert.equal(code.includes('create or replace function public.decide_order_operations_handoff'), false,
      'the decision function is called, never re-emitted')
  })

  test('the table is closed to every client role; only the functions read and write it', () => {
    assert.match(code, /alter table public\.order_line_flags enable row level security;/)
    assert.match(code, /revoke all on table public\.order_line_flags from public, anon, authenticated;/)
    assert.equal(/grant [a-z, ]+ on table public\.order_line_flags/i.test(code), false)
  })

  test('flag_order_lines is security definer, fixed search_path, signed-in only, and decides through the existing door', () => {
    const body = fn('flag_order_lines')
    assert.match(body, /security definer/)
    assert.match(body, /set search_path = public, pg_temp/)
    assert.match(body, /v_actor\s+uuid := public\.assert_order_submission_actor\(\)/)
    assert.match(body, /h\.assigned_to <> v_actor/)
    assert.match(body, /v_decision := case when cardinality\(v_cannot\) > 0 then 'clarification_needed' else 'accepted' end/)
    assert.match(body, /public\.decide_order_operations_handoff\(p_handoff_id, v_decision, public\.order_line_flags_reason\(v_cannot, v_comments\)\)/)
    assert.ok(body.indexOf('decide_order_operations_handoff(') < body.indexOf('insert into public.order_line_flags'),
      'the decision (and its locks) comes before any flag is written')
    assert.match(code, /revoke execute on function public\.flag_order_lines\(uuid, jsonb\) from public, anon;/)
    assert.match(code, /grant\s+execute on function public\.flag_order_lines\(uuid, jsonb\) to authenticated;/)
  })

  test('only items of the PI version under review can be flagged', () => {
    assert.match(fn('flag_order_lines'), /where i\.id = v_item and i\.submission_id = h\.submission_id/)
  })

  test('the reader follows Order visibility and never raises', () => {
    const body = fn('order_line_flags_for')
    assert.match(body, /\bstable\b/)
    assert.match(body, /security definer/)
    assert.match(body, /not public\.can_read_order_detail\(p_order_id\)/)
    assert.match(body, /h\.superseded_at is null/)
    assert.equal(/\b(insert|update|delete)\b/i.test(body), false)
    assert.equal(/raise /i.test(body), false)
  })

  test('the reason helper is pure and no client may call it', () => {
    assert.match(fn('order_line_flags_reason'), /\bimmutable\b/)
    assert.match(code, /revoke all on function public\.order_line_flags_reason\(text\[\], text\[\]\) from public, anon, authenticated;/)
  })
})
