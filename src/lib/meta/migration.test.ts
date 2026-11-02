/**
 * The two Marketing migrations, read as text. This pins the shape; the real proof is the executed rehearsal
 * (PGlite: row security on, no browser write, the function refusing a person without `edit`, and the rollback).
 *
 * Run: npx tsx --test src/lib/meta/migration.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const REGISTER = read('supabase/migrations/20270522000000_marketing_meta_edit_action.sql')
const TABLES = read('supabase/migrations/20270522000100_meta_ads_tables.sql')
const MODULES = read('src/lib/permissions/modules.ts')

const NAMES = ['meta_ad_accounts', 'meta_campaigns', 'meta_ad_sets', 'meta_insights_daily', 'meta_sync_runs', 'meta_settings']

describe('the registration', () => {
  test('adds only `edit`, off by default, and gives the Admin role view and edit', () => {
    assert.match(REGISTER, /pa\.action_key = 'edit'/)
    assert.match(REGISTER, /pm\.module_key = 'marketing'/)
    assert.match(REGISTER, /select pm\.id, pa\.id, false/)
    assert.match(REGISTER, /select 'admin', mpa\.module_id, mpa\.action_id, true/)
    assert.match(REGISTER, /rp\.allowed\)\s*<> 2/)
  })

  test('says the same thing about the module as src/lib/permissions/modules.ts', () => {
    const description = 'Marketing, starting with Meta Ads.'
    assert.ok(REGISTER.includes(`'${description}'`))
    assert.ok(MODULES.includes(`description: '${description}'`))
    assert.match(MODULES, /moduleKey: 'marketing'[\s\S]*actionKey: 'edit'/)
  })
})

describe('the tables', () => {
  test('there are six, every one with row security on', () => {
    for (const name of NAMES) assert.ok(TABLES.includes(`create table public.${name} (`), name)
    assert.equal((TABLES.match(/create table public\./g) ?? []).length, 6)
    assert.match(TABLES, /alter table public\.%I enable row level security/)
    assert.match(TABLES, /foreach t in array array\['meta_ad_accounts', 'meta_campaigns', 'meta_ad_sets', 'meta_insights_daily', 'meta_sync_runs', 'meta_settings'\]/)
  })

  test('a browser can read through module_entry_open and can never write', () => {
    assert.match(TABLES, /for select to authenticated using \(public\.module_entry_open\(''marketing''\)\)/)
    assert.match(TABLES, /revoke all on table public\.%I from public, anon, authenticated/)
    assert.match(TABLES, /grant select on table public\.%I to authenticated/)
    assert.ok(!/grant (insert|update|delete|all)[^;]*to authenticated/i.test(TABLES.replace(/grant all on table public\.%I to service_role/g, '')))
    assert.ok(!/create policy[^;]*for (insert|update|delete|all)/i.test(TABLES))
  })

  test('the Meta rows are never seeded: the repository is public', () => {
    const inserts = [...TABLES.matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(inserts, ['meta_settings'])
    assert.match(TABLES, /insert into public\.meta_settings \(id\) values \(true\);/)
  })

  test('money is whole numbers and results are kept as Meta sent them', () => {
    assert.ok(!/numeric|double precision|real\b|money/i.test(TABLES.replace(/--[^\n]*/g, '')))
    assert.match(TABLES, /spend_paise bigint not null/)
    assert.match(TABLES, /actions jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(actions\) = 'array'\)/)
  })

  test('a day of results has no foreign key, because Meta keeps results for an ad set it no longer lists', () => {
    const insights = TABLES.slice(TABLES.indexOf('create table public.meta_insights_daily'), TABLES.indexOf('create table public.meta_sync_runs'))
    assert.ok(!/references/i.test(insights))
  })
})

describe('the one write function', () => {
  test('is security definer with a pinned search_path, checks Admin or `edit`, and is closed to anon', () => {
    const fn = TABLES.slice(TABLES.indexOf('create function public.meta_set_targets'), TABLES.indexOf('revoke all on function'))
    assert.match(fn, /security definer/)
    assert.match(fn, /set search_path = public, pg_temp/)
    assert.match(fn, /auth\.uid\(\) is null/)
    assert.match(fn, /u\.role = 'admin'/)
    assert.match(fn, /public\.resolve_permission\(auth\.uid\(\), 'marketing', 'edit'\)/)
    assert.match(fn, /raise exception 'MARKETING_FORBIDDEN'/)
    assert.match(fn, /raise exception 'MARKETING_INVALID'/)
    assert.match(TABLES, /revoke all on function public\.meta_set_targets\(bigint, bigint\) from public, anon;/)
    assert.match(TABLES, /grant execute on function public\.meta_set_targets\(bigint, bigint\) to authenticated;/)
  })

  test('the file asserts its own result, so an apply that left a table open aborts', () => {
    assert.match(TABLES, /raise exception 'META_TABLES: a browser could write to %'/)
    assert.match(TABLES, /raise exception 'META_TABLES: anon can read %'/)
    assert.match(TABLES, /raise exception 'META_TABLES: anon can run meta_set_targets'/)
  })
})
