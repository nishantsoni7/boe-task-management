/**
 * Repository check: no browser-authenticated query may `select('*')` on
 * public.users, and none may name an Admin-only HR column.
 *
 * Why a repo check and not just a review habit
 * -------------------------------------------
 * `authenticated` holds SELECT on public.users column by column
 * (20260813000000), so `select('*')` no longer returns a wide row — it returns
 * a 42501 permission error and the screen breaks. That failure is a runtime
 * one: TypeScript cannot see it, and the page that breaks may be one nobody
 * opens during review. Catching it here turns a production 500 into a failing
 * test, and simultaneously stops anyone quietly re-adding `monthly_salary` to a
 * browser query.
 *
 * Avoiding false positives
 * ------------------------
 * Only files that actually run with an end-user's token are scanned: a file is
 * browser-authenticated if it is a `'use client'` component or imports the
 * browser Supabase factory. Server code holding SUPABASE_SERVICE_ROLE_KEY is
 * exempt, because the service role bypasses both RLS and column privileges by
 * design and legitimately reads salary for payroll. A file that does both (a
 * client component that also builds a service client — none today) is treated
 * as browser, which is the conservative direction.
 *
 * Run:
 *   npx tsx --test src/lib/users/noStarSelect.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { USER_PRIVATE_COLUMNS } from './safeColumns'

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
    }
  }
  walk(dir)
  return out
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

type Site = { file: string; line: number; select: string }

/** Files whose Supabase calls carry an end-user token rather than the service key. */
function isBrowserAuthenticated(src: string): boolean {
  const usesBrowserClient = /@\/lib\/supabase\/client|createBrowserClient/.test(src)
  const isClientComponent = /^['"]use client['"]/m.test(src)
  if (!usesBrowserClient && !isClientComponent) return false
  return true
}

/** Every `from('users')` call in browser-authenticated code, with its select. */
function browserUserQueries(): Site[] {
  const sites: Site[] = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8')
    if (!/from\(['"]users['"]\)/.test(src)) continue
    if (!isBrowserAuthenticated(src)) continue
    // A client component that ALSO builds a service-role client would be a bug
    // in itself (the key would ship to the browser); flagged rather than exempt.
    const lines = src.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!/from\(['"]users['"]\)/.test(line)) return
      const window = lines.slice(i, i + 4).join(' ')
      const m = window.match(/\.select\(\s*(`|'|")([\s\S]*?)\1/)
      sites.push({ file: rel(file), line: i + 1, select: m ? m[2].replace(/\s+/g, ' ').trim() : '' })
    })
  }
  return sites
}

describe('browser queries against public.users', () => {
  test("never use select('*')", () => {
    const offenders = browserUserQueries().filter(s => s.select === '*')
    assert.deepEqual(
      offenders.map(o => `${o.file}:${o.line}`),
      [],
      "select('*') on public.users fails at runtime with a permission error — "
      + 'name the columns, or use USER_PROFILE_COLUMNS from @/lib/users/safeColumns',
    )
  })

  test('never name an Admin-only HR column', () => {
    const offenders = browserUserQueries().filter(s =>
      USER_PRIVATE_COLUMNS.some(c => new RegExp(`\\b${c}\\b`).test(s.select)),
    )
    assert.deepEqual(
      offenders.map(o => `${o.file}:${o.line} → ${o.select}`),
      [],
      'monthly_salary and payroll_notes are not selectable by an end-user token; '
      + 'read them through an admin-verified server route instead',
    )
  })

  test('the check actually found the browser queries it is meant to guard', () => {
    // A refactor that renames the Supabase factory would silently empty the
    // scan and leave both assertions above passing on zero rows.
    const sites = browserUserQueries()
    assert.ok(sites.length > 50, `expected the scan to find the app's user queries, found ${sites.length}`)
  })

  test('no client component builds a service-role client', () => {
    const leaked: string[] = []
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      if (!/^['"]use client['"]/m.test(src)) continue
      if (/SUPABASE_SERVICE_ROLE_KEY/.test(src)) leaked.push(rel(file))
    }
    assert.deepEqual(leaked, [], 'the service-role key must never be referenced in client code')
  })
})
