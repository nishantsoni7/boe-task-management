/**
 * THE PERMISSION RESOLVERS ARE NOT FOR anon (20270107000000), read as text,
 * plus the guard that keeps it true.
 *
 * Executing it was done against a disposable local stack. Before it, anon read
 * an administrator's full permission map (83 rows) through
 * resolve_effective_permissions_for_user(). After it, anon is refused all six,
 * while authenticated and service_role answer exactly as before. anon reads of
 * RLS-protected tables still filter to nothing rather than erroring, and every
 * repository SQL suite gave the same outcome before and after.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/resolversNotForAnon.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const NAME = '20270107000000_permission_resolvers_are_not_for_anon.sql'
const SQL = stripSql(read(`supabase/migrations/${NAME}`))

const SIX = [
  'public.has_permission(uuid, text)',
  'public.module_entry_open(text)',
  'public.resolve_effective_permissions(uuid, text)',
  'public.resolve_effective_permissions_for_user(uuid)',
  'public.resolve_permission(uuid, text, text)',
  'public.sample_tracking_module_open()',
]
const NAMES = SIX.map(s => s.slice('public.'.length, s.indexOf('(')))
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const CALLS_A_RESOLVER = new RegExp(`\\b(${NAMES.join('|')})\\s*\\(`)

describe('the migration', () => {
  test('each of the six is revoked from PUBLIC and anon, and granted back to authenticated and service_role', () => {
    for (const fn of SIX) {
      assert.match(SQL, new RegExp(`revoke execute on function ${esc(fn)}\\s+from public, anon;`), `${fn}: revoke`)
      assert.match(SQL, new RegExp(`grant execute on function ${esc(fn)}\\s+to authenticated, service_role;`), `${fn}: grant`)
    }
  })

  test('those twelve statements are all it changes', () => {
    const statements = [...SQL.matchAll(/^\s*(grant|revoke)\b[^;]*;/gim)]
    assert.equal(statements.length, 12)
    assert.doesNotMatch(SQL, /create\s+(or\s+replace\s+)?function/i)
    assert.doesNotMatch(SQL, /\balter\s+(function|table|policy)\b/i)
    assert.doesNotMatch(SQL, /\b(create|drop)\s+(policy|table|trigger|view)\b/i)
    assert.doesNotMatch(SQL, /\b(insert\s+into|delete\s+from|update\s+public\.)/i)
  })

  test('it proves at apply time that anon is out, the signed-in user and the server are not, and nothing anon reaches needs them', () => {
    for (const message of [
      "'resolvers not for anon: anon can still execute %'",
      "'resolvers not for anon: PUBLIC still holds EXECUTE on %'",
      "'resolvers not for anon: authenticated LOST %; every module gate would refuse everyone'",
      "'resolvers not for anon: service_role LOST %; server routes would fail'",
      "'resolvers not for anon: policies for anon/public call a resolver: %'",
      "'resolvers not for anon: invoker functions anon can call reach a resolver: %'",
    ]) {
      assert.ok(SQL.includes(message), message)
    }
  })
})

describe('the app never needs them signed out', () => {
  test('the resolver helpers are the only wrappers, and none is on a signed-out surface', () => {
    // The per-call-site table is in the PR. What can be held here is the shape
    // that makes it true: no Edge Functions, and no middleware/proxy that
    // could run before authentication.
    assert.equal(existsSync(join(ROOT, 'supabase/functions')), false, 'an Edge Function would need its own review')
    for (const f of ['middleware.ts', 'proxy.ts', 'src/middleware.ts', 'src/proxy.ts']) {
      if (existsSync(join(ROOT, f))) assert.doesNotMatch(read(f), CALLS_A_RESOLVER, `${f} runs before auth`)
    }
    assert.doesNotMatch(read('src/app/login/page.tsx'), CALLS_A_RESOLVER)
  })
})

describe('EVERY LATER MIGRATION keeps anon out', () => {
  const later = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter(f => f.endsWith('.sql') && f > NAME)
    .sort()

  test('no later migration grants a resolver to anon or PUBLIC', () => {
    for (const file of later) {
      const sql = stripSql(read(`supabase/migrations/${file}`))
      for (const m of sql.matchAll(/\bgrant\b[^;]*;/gi)) {
        if (!CALLS_A_RESOLVER.test(m[0])) continue
        assert.doesNotMatch(m[0], /\bto\b[^;]*\b(anon|public)\b/i, `${file}: ${m[0].slice(0, 120)}`)
      }
    }
  })

  test('no later policy that calls a resolver applies to anon or PUBLIC (a policy with no TO clause is PUBLIC)', () => {
    for (const file of later) {
      const sql = stripSql(read(`supabase/migrations/${file}`))
      for (const m of sql.matchAll(/create\s+policy[^;]*;/gi)) {
        if (!CALLS_A_RESOLVER.test(m[0])) continue
        // `[\s'|]+` also admits dynamic SQL that splits the statement across
        // string literals (… TO authenticated ' 'USING …, as 20260905000000 does).
        const to = m[0].match(/\bto\s+([a-z_,\s]+?)[\s'|]+(using|with\s+check)\b/i)
        assert.ok(to, `${file}: a policy calling a resolver must name its roles`)
        assert.doesNotMatch(to[1], /\b(anon|public)\b/i, `${file}: policy for ${to[1]} calls a resolver`)
      }
    }
  })
})
