/**
 * Sales, Lead Master (20270606000000): the migration says what the screen sends, and keeps the doors closed.
 *
 * These are source checks. The behaviour (Yesterday, a range, open-ended sides, who holds how many, the old six-argument
 * call still answering) is proved by running the real migrations in an in-memory Postgres:
 *   node supabase/tests/sales_full_flow_pglite.mjs <dir with @electric-sql/pglite installed>
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/dateRangeMigration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const FILE = '20270606000000_sales_lead_master_date_range.sql'
const SQL = read(`supabase/migrations/${FILE}`)
const API = read('src/lib/salesLeads/api.ts')

const SIX = 'public.sales_leads_page(text, text, text, text, integer, integer)'
const EIGHT = 'public.sales_leads_page(text, text, text, text, integer, integer, date, date)'

describe('the function that reads the list', () => {
  test('the six-argument function is dropped in the same file, because two would be ambiguous for a call with six', () => {
    assert.ok(SQL.includes('drop function if exists public.sales_leads_page(text, text, text, text, integer, integer);'))
    assert.match(SQL, /raise exception 'SALES_RANGE: the six-argument sales_leads_page is still there/)
  })

  test('the two new arguments have defaults, so the screen that is live now keeps working', () => {
    assert.match(SQL, /p_offset integer default 0,\s+p_from date default null,\s+p_to date default null\s+\)/)
  })

  test('the names the wrapper sends are the ones the function declares', () => {
    for (const p of ['p_from', 'p_to']) {
      assert.ok(API.includes(p), `${p} is sent by the wrapper`)
      assert.ok(SQL.includes(`${p} date default null`), `${p} is declared by the migration`)
    }
  })

  test('chosen days win, a pair the wrong way round is read as the range between, and Yesterday is counted', () => {
    assert.ok(SQL.includes('if p_from is not null or p_to is not null then'))
    assert.ok(SQL.includes('least(p_from, p_to)') && SQL.includes('greatest(p_from, p_to)'))
    assert.ok(SQL.includes("'yesterday', count(*) filter (where received_on = v_today - 1)"))
    assert.ok(SQL.includes('and (v_to is null or l.received_on <= v_to)'))
  })

  test('it is still a read-only India-time function behind the same visibility rule', () => {
    assert.ok(SQL.includes("v_today date := (now() at time zone 'Asia/Kolkata')::date;"))
    assert.ok(SQL.includes('security definer') && SQL.includes('set search_path = public, pg_temp'))
    assert.ok(SQL.includes('v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors) or (l.assigned_to is null and l.created_by = v_uid)'))
    assert.ok(!/\b(insert|update|delete)\b\s+(into|from)?\s*public\./i.test(SQL.replace(/--.*$/gm, '')), 'a read-only migration')
  })

  test('only a signed-in person may call it: closed to public and anon, granted to authenticated, and the file checks it', () => {
    assert.ok(SQL.includes(`revoke all on function ${EIGHT} from public, anon;`))
    assert.ok(SQL.includes(`grant execute on function ${EIGHT} to authenticated;`))
    assert.ok(SQL.includes("has_function_privilege('anon'"))
  })

  test('nothing later puts the six-argument function back', () => {
    const later = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter(f => f > FILE)
    for (const f of later) {
      assert.ok(!read(`supabase/migrations/${f}`).includes(SIX), `${f} would bring back the six-argument sales_leads_page`)
    }
  })
})
