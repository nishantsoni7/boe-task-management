/**
 * EVERY SECURITY DEFINER IN public PINS pg_temp LAST (20270118000000), read as
 * text, plus the guard that keeps it true.
 *
 * Executing it was done against a disposable local stack. It applies with and
 * without the production-only handle_new_auth_user(), and re-applies. Every
 * repository SQL suite gave the same outcome before and after. As a signed-in
 * SQL session, has_permission() could be made to answer true through a temp
 * table before the migration, and cannot after. This file holds the migration
 * to its promises without a database, and holds EVERY LATER MIGRATION to the
 * same rule, so a new definer cannot quietly reopen it.
 *
 * Run:
 *   npx tsx --test src/lib/securityDefinerSearchPath.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const NAME = '20270118000000_security_definer_search_path_pins_pg_temp.sql'
const MIGRATION = read(`supabase/migrations/${NAME}`)
const SQL = stripSql(MIGRATION)

const ALTERS = [...SQL.matchAll(/alter function (public\.[a-z0-9_]+\([^)]*\)) set search_path = ([^;]+);/g)]
  .map(m => ({ fn: m[1], path: m[2] }))

describe('the audit migration', () => {
  test('it pins all ninety-four functions production named, plus the drift one where present', () => {
    // 93 direct statements, plus handle_new_auth_user() inside its if-present
    // block (§1d), plus cleanup_top_tasks_on_completion() (§1b).
    const direct = ALTERS.filter(a => a.fn !== 'public.handle_new_auth_user()')
    assert.equal(direct.length, 94, 'every function the production read returned, assert_order_amender included')
    assert.equal(new Set(direct.map(a => a.fn)).size, direct.length, 'no function is listed twice')
    assert.ok(ALTERS.some(a => a.fn === 'public.handle_new_auth_user()'))
    assert.match(SQL, /if to_regprocedure\('public\.handle_new_auth_user\(\)'\) is not null then\s+alter function/)
  })

  test('every path it sets ends with pg_temp, and only the pg_catalog one differs from public, pg_temp', () => {
    for (const { fn, path } of ALTERS) {
      assert.match(path, /, pg_temp$/, `${fn} must end with pg_temp`)
      if (fn === 'public.cleanup_top_tasks_on_completion()') assert.equal(path, 'pg_catalog, public, pg_temp')
      else assert.equal(path, 'public, pg_temp', fn)
    }
  })

  test('each required function is checked before anything runs; the drift one is not required', () => {
    const deps = SQL.slice(0, SQL.indexOf("raise exception 'DEPENDENCY MISSING"))
    for (const { fn } of ALTERS) {
      if (fn === 'public.handle_new_auth_user()') assert.ok(!deps.includes(`'${fn}'`), 'a fresh replay has no such function')
      else assert.ok(deps.includes(`'${fn}'`), `${fn} is a dependency`)
    }
  })

  test('no body is redefined, nothing else changes, and the only grant change is the quotation number', () => {
    assert.doesNotMatch(SQL, /create\s+(or\s+replace\s+)?function/i)
    assert.doesNotMatch(SQL, /\b(create|drop|alter)\s+(table|trigger|policy|index|type|view)\b/i)
    assert.doesNotMatch(SQL, /\b(insert\s+into|delete\s+from|update\s+public\.)/i, 'no DML')
    // Statements only: anchored at the start of a line, so the word "grant"
    // inside an exception message is not mistaken for one.
    const grants = [...SQL.matchAll(/^\s*(grant|revoke)\b[^;]*;/gim)].map(m => m[0].trim().replace(/\s+/g, ' '))
    assert.deepEqual(grants, [
      'revoke execute on function public.get_or_create_quotation_no(uuid) from public, anon, authenticated;',
      'grant execute on function public.get_or_create_quotation_no(uuid) to service_role;',
    ])
  })

  test('it proves at apply time that NO definer in public is left without pg_temp last', () => {
    assert.ok(SQL.includes("'definer search_path: these definers do not end their search_path with pg_temp: %'"))
    assert.ok(SQL.includes("and c like '%pg_temp'"))
    assert.ok(SQL.includes("'definer search_path: not exactly public, pg_temp: %'"))
    assert.ok(SQL.includes("'definer search_path: get_or_create_quotation_no is still executable by a client role'"))
    assert.ok(SQL.includes("'definer search_path: service_role LOST get_or_create_quotation_no; the quotation route would fail'"))
    assert.ok(SQL.includes("'definer search_path: a permission resolver lost its grant to authenticated'"))
  })
})

describe('get_or_create_quotation_no belongs to the server', () => {
  test('its only caller is the quotation route, and that route calls it with the service-role client', () => {
    const route = read('src/app/api/showroom/quotation/[id]/route.ts')
    assert.ok(route.includes("client.rpc('get_or_create_quotation_no'"))
    assert.match(route, /function svc\(\) \{\s+return createClient\(\s+process\.env\.NEXT_PUBLIC_SUPABASE_URL!,\s+process\.env\.SUPABASE_SERVICE_ROLE_KEY!/)
    assert.ok(route.includes('const client = svc()'))
  })
})

describe('EVERY LATER MIGRATION keeps it true', () => {
  // A later CREATE OR REPLACE that states `set search_path = public` undoes
  // this file silently — exactly how assert_order_amender lost pg_temp in
  // 20260901000000. So every migration sorting after this one is read here.
  const later = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter(f => f.endsWith('.sql') && f > NAME)
    .sort()

  test('every SECURITY DEFINER function a later migration creates ends its search_path with pg_temp', () => {
    for (const file of later) {
      const sql = stripSql(read(`supabase/migrations/${file}`))
      const heads = sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_.]+)\s*\([\s\S]*?\bas\s+\$[a-z_]*\$/gi)
      for (const m of heads) {
        if (!/security\s+definer/i.test(m[0])) continue
        assert.match(m[0], /set\s+search_path\s*=\s*[^\n;]*\bpg_temp\s*\n/i,
          `${file}: ${m[1]} is a definer without pg_temp last in its search_path`)
      }
    }
  })

  test('and no later ALTER sets a search_path without pg_temp last', () => {
    for (const file of later) {
      const sql = stripSql(read(`supabase/migrations/${file}`))
      for (const m of sql.matchAll(/alter\s+function\s+[^;]*?set\s+search_path\s*(?:=|to)\s*([^;]+);/gi)) {
        assert.match(m[1].trim(), /\bpg_temp$/, `${file}: ${m[0].slice(0, 80)}`)
      }
    }
  })
})
