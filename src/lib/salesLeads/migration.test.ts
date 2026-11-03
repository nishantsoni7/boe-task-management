/**
 * Sales, Lead Master (20270524000000): the migration says what the code says, and keeps the doors it promises.
 *
 * These are source checks. The behaviour itself (the unique number, the allotment guard, the history, the gate) is
 * proved by running the real migration in an in-memory Postgres:
 *   node supabase/tests/sales_lead_master_pglite.mjs <dir with @electric-sql/pglite installed>
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/migration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import '@/lib/permissions/modules'
import { getRegisteredModule } from '@/lib/permissions/registry'
import { isProtectedAction } from '@/lib/permissions/levels'
import { LEAD_SOURCE_VALUES, MAX_EMAIL, MAX_LOCATION, MAX_NAME, MAX_REQUIREMENT } from './constants'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270524000000_sales_lead_master.sql')
const BOARD_SQL = read('supabase/migrations/20270525000000_sales_lead_board.sql') + read('supabase/migrations/20270526000100_sales_go_live.sql')
  + read('supabase/migrations/20270527000000_sales_review_fixes.sql')
  + read('supabase/migrations/20270530000000_sales_sheet_import.sql')
  + read('supabase/migrations/20270602000000_sales_auto_allot.sql')
const API = read('src/lib/salesLeads/api.ts')

// The six functions a browser may call, and the two internals it may not.
const CLIENT_FUNCTIONS = [
  'sales_lead_phone_check', 'sales_leads_page', 'get_sales_lead', 'create_sales_lead', 'update_sales_lead', 'allot_sales_lead',
]
const INTERNAL_FUNCTIONS = ['sales_leads_require', 'sales_lead_json']

describe('registration', () => {
  test('Sales registers view, create, edit and assign, and the migration adds exactly the three new ones', () => {
    const sales = getRegisteredModule('sales')
    assert.ok(sales)
    assert.deepEqual(sales.actions.map(a => a.actionKey), ['view', 'view_all', 'create', 'edit', 'assign'])
    assert.ok(BOARD_SQL.includes("join public.permission_actions pa on pa.action_key = 'view_all'"), 'the Lead Board adds view_all')
    assert.ok(SQL.includes("pa.action_key in ('create', 'edit', 'assign')"))
    assert.equal((SQL.match(/pa\.action_key in \('create', 'edit', 'assign'\)/g) ?? []).length, 2, 'the action link and the Admin row')
  })

  test('assign is a protected action, so a preset never hands it out; create and edit are ordinary', () => {
    assert.equal(isProtectedAction('assign'), true)
    assert.equal(isProtectedAction('create'), false)
    assert.equal(isProtectedAction('edit'), false)
  })

  test('nothing is on by default, and the Admin role holds all four', () => {
    assert.ok(SQL.includes('insert into public.module_permission_actions (module_id, action_id, default_allowed)'))
    assert.ok(/select pm\.id, pa\.id, false\b/.test(SQL))
    assert.ok(SQL.includes("select 'admin', mpa.module_id, mpa.action_id, true"))
    assert.ok(SQL.includes('<> 4 then'), 'the self-check counts four Admin rows')
    assert.ok(SQL.includes('no Sales action may be on by default'))
  })

  test('the description is the one the code registers, in both tables', () => {
    const description = getRegisteredModule('sales')!.description
    assert.equal(BOARD_SQL.split(`set description = '${description}'`).length - 1, 2)
  })
})

describe('the register', () => {
  test('one lead per number: a unique index on the stored number', () => {
    assert.ok(SQL.includes('create unique index sales_leads_phone_key on public.sales_leads (phone_e164)'))
    assert.ok(SQL.includes("check (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$')"))
  })

  test('the received day is the database\'s, in India, and never changes', () => {
    assert.ok(SQL.includes("received_on date not null default ((now() at time zone 'Asia/Kolkata')::date)"))
    assert.ok(SQL.includes('new.received_on is distinct from old.received_on'))
    assert.ok(SQL.includes('new.lead_no is distinct from old.lead_no'))
  })

  test('a new lead is not allotted: the holder column is empty by default and nothing sets it on insert', () => {
    assert.ok(/assigned_to uuid references public\.users \(id\) on delete set null,/.test(SQL))
    const create = SQL.slice(SQL.indexOf('create function public.create_sales_lead'), SQL.indexOf('create function public.update_sales_lead'))
    assert.ok(!/assigned_to/.test(create), 'create_sales_lead never touches who holds the lead')
    assert.ok(create.includes('on conflict (phone_e164) do nothing'))
    assert.ok(create.includes("'duplicate'"))
  })

  test('a duplicate does not use up a lead number: the register is looked at before anything is inserted', () => {
    const create = SQL.slice(SQL.indexOf('create function public.create_sales_lead'), SQL.indexOf('create function public.update_sales_lead'))
    const look = create.indexOf('select * into v_row from public.sales_leads where phone_e164 = v_phone;')
    const insert = create.indexOf('insert into public.sales_leads')
    assert.ok(look > 0 && insert > look, 'the look comes first')
    assert.ok(create.includes('on conflict (phone_e164) do nothing'), 'the conflict clause stays for two people adding the same number at once')
  })

  test('an edit is refused if the lead changed since the person started: it carries the version', () => {
    assert.ok(SQL.includes("'updated_at', l.updated_at"))
    const update = SQL.slice(SQL.indexOf('create function public.update_sales_lead'), SQL.indexOf('create function public.allot_sales_lead'))
    assert.ok(update.includes('p_expected_updated_at timestamptz default null'))
    assert.ok(update.includes('v_old.updated_at is distinct from p_expected_updated_at'))
    assert.ok(update.indexOf('SALES_CHANGED') < update.indexOf('select * into v_other'), 'refused before anything is compared or written')
    assert.ok(update.includes('array_append(v_changed'), 'text[] || \'literal\' fails in PL/pgSQL')
  })

  test('search finds a number however it is typed', () => {
    assert.ok(SQL.includes('v_norm text := public.normalize_lead_phone(btrim(coalesce(p_q, \'\')))'))
    assert.ok(SQL.includes('or (v_norm is not null and l.phone_e164 = v_norm)'))
  })

  test('the source list in the database is the one the form offers (the latest list, 20270530000000)', () => {
    const list = /sales_leads_source_check check \(source in \(([\s\S]*?)\)\)/.exec(read('supabase/migrations/20270530000000_sales_sheet_import.sql'))
    assert.ok(list)
    const inSql = [...list[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual(inSql, [...LEAD_SOURCE_VALUES])
  })

  test('the limits in the database are the ones the form checks', () => {
    assert.ok(SQL.includes(`length(name) between 1 and ${MAX_NAME}`))
    assert.ok(SQL.includes(`length(email) <= ${MAX_EMAIL}`))
    assert.ok(SQL.includes(`length(location) between 1 and ${MAX_LOCATION}`))
    assert.ok(SQL.includes(`length(requirement) between 1 and ${MAX_REQUIREMENT}`))
  })

  test('the history is append-only, and keeps people as plain ids so removing a person cannot be blocked by it', () => {
    assert.ok(SQL.includes('before update or delete on public.sales_lead_events'))
    const table = SQL.slice(SQL.indexOf('create table public.sales_lead_events'), SQL.indexOf('create index sales_lead_events_lead_idx'))
    assert.ok(!/references public\.users/.test(table), 'no foreign key to users on the history')
    assert.ok(/kind text not null check \(kind in \('added', 'allotted', 'reassigned', 'edited'\)\)/.test(table))
  })
})

describe('the doors', () => {
  test('both tables are closed to browser writes and open to reads only through the module gate', () => {
    assert.ok(SQL.includes("array['sales_leads', 'sales_lead_events']"))
    assert.ok(SQL.includes("execute format('alter table public.%I enable row level security', t)"))
    assert.ok(SQL.includes("execute format('revoke all on table public.%I from public, anon, authenticated', t)"))
    assert.ok(SQL.includes("execute format('grant select on table public.%I to authenticated', t)"))
    assert.ok(SQL.includes("using (public.module_entry_open(''sales''))"))
    assert.ok(!/grant (insert|update|delete)/i.test(SQL))
  })

  test('every function pins its search_path', () => {
    const blocks = SQL.split('create function public.').slice(1)
    assert.equal(blocks.length, 10, 'two triggers, two internals and the six a browser may call')
    for (const block of blocks) {
      const name = /^(\w+)/.exec(block)![1]
      assert.ok(block.includes('set search_path = public, pg_temp'), `${name} must pin its search_path`)
    }
  })

  test('the six client functions are for signed-in people only; the two internals are for nobody outside the database', () => {
    for (const fn of CLIENT_FUNCTIONS) {
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon;`).test(SQL), `${fn}: revoked from anon`)
      assert.ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`).test(SQL), `${fn}: granted to authenticated`)
    }
    for (const fn of INTERNAL_FUNCTIONS) {
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`).test(SQL), `${fn}: closed to browsers`)
    }
  })

  test('each write checks its own right, and reads check the module gate', () => {
    assert.ok(SQL.includes("v_uid uuid := public.sales_leads_require('create')"))
    assert.ok(SQL.includes("v_uid uuid := public.sales_leads_require('edit')"))
    assert.ok(SQL.includes("v_uid uuid := public.sales_leads_require('assign')"))
    assert.equal((SQL.match(/perform public\.sales_leads_require\(null\)/g) ?? []).length, 3, 'the three reads')
    assert.ok(SQL.includes("public.resolve_permission(v_uid, 'sales', p_action)"))
    assert.ok(SQL.includes("raise exception 'SALES_FORBIDDEN' using errcode = '42501'"))
  })

  test('allotting: only a sales candidate, and only when the caller saw the current holder', () => {
    const allot = SQL.slice(SQL.indexOf('create function public.allot_sales_lead'), SQL.indexOf('-- ═══ 6.'))
    assert.ok(allot.includes('public.is_eligible_order_assignee(p_to)'))
    assert.ok(allot.includes('v_row.assigned_to is distinct from p_expected_from'))
    assert.ok(allot.includes("raise exception 'SALES_CHANGED"))
    assert.ok(allot.includes("case when p_expected_from is null then 'allotted' else 'reassigned' end"))
    assert.ok(allot.includes('for update'), 'the lead is locked while it is decided')
  })
})

describe('the app calls what exists', () => {
  test('every function the API wrapper calls is defined in a Sales migration', () => {
    const called = [...API.matchAll(/s\.rpc\('([a-z_]+)'/g)].map(m => m[1])
    assert.ok(called.length >= 7)
    assert.ok(!called.includes('list_eligible_order_assignees'), 'who can hold a lead follows the Sales job, not the Orders rule')
    for (const fn of called) {
      assert.ok(SQL.includes(`create function public.${fn}(`) || BOARD_SQL.includes(`create function public.${fn}(`), `${fn} must exist in a migration`)
    }
  })

  test('the parameter names the wrapper sends are the ones the functions declare', () => {
    for (const p of ['p_period', 'p_holder', 'p_source', 'p_q', 'p_limit', 'p_offset', 'p_id', 'p_phone', 'p_name', 'p_email', 'p_location', 'p_requirement', 'p_to', 'p_expected_from', 'p_expected_updated_at']) {
      assert.ok(API.includes(p), `${p} is sent by the wrapper`)
      assert.ok(SQL.includes(p), `${p} is declared by the migration`)
    }
  })
})
